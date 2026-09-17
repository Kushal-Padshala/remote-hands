import type { Task } from '@remote-hands/shared';
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { z } from 'zod';
import type { DaemonConfig } from './config.js';
import type { EventInput } from './task-store.js';

export interface AgentRunResult {
  events: readonly EventInput[];
  summary: string;
  conversationId: string | null;
  durationSeconds?: number;
  status?: 'done' | 'failed';
}

export interface AgentRunner {
  run(
    task: Task,
    onEvent?: (event: EventInput) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<AgentRunResult>;
}

export type AgentStreamRecord = EventInput;

export const DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT =
  '[Context: Remote Hands mobile control plane. You are Antigravity, an elite, highly intelligent autonomous AI engineer operating the user\'s computer remotely from their mobile phone.\n' +
  '1. Elite Autonomous Engineering Persona: You are an agent of decisive action. You take initiative, explore thoroughly, and persist until the user\'s objective is completely solved. Do NOT stop after opening a link, do NOT stop after encountering an expired session or error page, and do NOT give up and leave tasks for the user. Explore multiple pages, click through dashboards and menus, and drive the task to complete resolution.\n' +
  '2. Autonomous Browser Navigation & Deep Exploration: Use `browser-harness <<\'PY\' ... PY` (running and connected to Chrome via CDP in memory):\n' +
  '   - Inspect current page text: `print(js("document.body.innerText"))`.\n' +
  '   - Discover interactive elements to click: `print(js("Array.from(document.querySelectorAll(\'a, button, [role=button], input\')).map(e => ({text: (e.innerText||e.value||\'\').trim().slice(0, 40), href: e.href, id: e.id})).filter(x => x.text || x.href)"))`.\n' +
  '   - Click links, buttons, or menu items: `js("document.querySelector(\'...\').click()")` or `click_at_xy(x, y)`.\n' +
  '   - Navigate to subpages: `goto_url("...")` or `new_tab("...")`.\n' +
  '   - Explore other open tabs: `for t in list_tabs(): print(t)` and `switch_tab(target_id)`. If one tab has an expired session token or login wall, inspect all other open tabs to find if the user has an active session on GoDaddy, cPanel, or WordPress, and navigate forward from that active tab.\n' +
  '   - Fill inputs: `fill_input(selector, text)` or `type_text(text)`.\n' +
  '3. Active Problem Solving & End-to-End Fixing:\n' +
  '   - When diagnosing website issues (like HTTP 500), actively locate and inspect the server error log (via cPanel Error Log or File Manager `error_log` / `wp-content/debug.log`).\n' +
  '   - Apply the required fix directly (e.g. switch PHP runtime via MultiPHP Manager, fix `.htaccess`, rename a faulty theme/plugin directory, or update database configs).\n' +
  '   - Verify that the live site returns HTTP 200 before finishing.\n' +
  '4. Gemini 3.8 High Reasoning: State a concise 2-sentence plan in text, then proactively execute steps, explore pages, adapt to errors, and persist.\n' +
  '5. Clean Desktop Etiquette: Keep all background actions non-intrusive without stealing window focus.\n' +
  '6. Clear Final Summary: Always conclude with a comprehensive markdown report detailing what was diagnosed, the exact actions taken to resolve it, and the final verified state.]';

export const DEFAULT_REMOTE_HANDS_REMINDER =
  '[Context Reminder: Remote Hands mobile control plane.\n' +
  '1. Intelligent Action & Persistence: Move forward proactively. Do NOT stop after opening a link or hitting an error. Explore multiple pages, click relevant links and menus, inspect tabs, and persist until solved.\n' +
  '2. Browser Exploration: Use `browser-harness <<\'PY\' ... PY` with `js("document.body.innerText")`, `js("document.querySelector(\'...\').click()")`, `click_at_xy()`, `switch_tab()`, `goto_url()`. Inspect all open tabs if one is logged out.\n' +
  '3. Resolve & Verify: Diagnose root causes from logs, fix configurations/files directly, and verify HTTP 200.\n' +
  '4. Final Summary: Explain your findings, actions taken, and final outcome clearly.]';

export function extractSummaryFromTranscript(conversationId: string): string | null {
  const candidateDirs = [
    path.join(os.homedir(), '.gemini/antigravity-cli/brain', conversationId, '.system_generated/logs'),
    path.join(os.homedir(), '.gemini/antigravity-ide/brain', conversationId, '.system_generated/logs'),
  ];
  for (const dir of candidateDirs) {
    const transcriptFile = path.join(dir, 'transcript.jsonl');
    if (fs.existsSync(transcriptFile)) {
      try {
        const lines = fs.readFileSync(transcriptFile, 'utf-8').split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          const entry = JSON.parse(lines[i]!);
          if (entry.source === 'MODEL' && typeof entry.content === 'string' && entry.content.trim().length > 0) {
            return entry.content.trim();
          }
        }
      } catch {}
    }
  }
  return null;
}

type AgyArgConfig = Pick<DaemonConfig, 'agyCommand'> & {
  systemPrompt?: string | undefined;
};

const textRecord = z.object({ type: z.literal('text'), text: z.string() });
const thinkingRecord = z.object({ type: z.literal('thinking'), text: z.string() });
const toolCallRecord = z.object({
  type: z.literal('tool_call'),
  tool: z.string(),
  input: z.unknown().optional(),
  call_id: z.string().optional(),
});
const toolResultRecord = z.object({
  type: z.literal('tool_result'),
  call_id: z.string().optional(),
  ok: z.boolean().default(true),
  output: z.string().optional(),
});
const statusRecord = z.object({
  type: z.literal('status'),
  status: z.enum(['queued', 'claimed', 'running', 'awaiting_approval', 'done', 'failed', 'cancelled']),
});
const errorRecord = z.object({
  type: z.literal('error'),
  message: z.string(),
  fatal: z.boolean().default(false),
});
const resultRecord = z.object({
  type: z.literal('result'),
  summary: z.string(),
  conversation_id: z.string().optional(),
  duration_seconds: z.number().optional(),
});

export function buildAgyArgs(task: Task, config: AgyArgConfig): readonly string[] {
  const promptText = config.systemPrompt
    ? (!task.conversation_id
        ? `${config.systemPrompt}\n\n${task.prompt}`
        : `${DEFAULT_REMOTE_HANDS_REMINDER}\n\n${task.prompt}`)
    : task.prompt;

  const args = [config.agyCommand, '-p', promptText, '--output-format', 'stream-json'];

  if (task.workspace_path) args.push('--add-dir', task.workspace_path);
  if (task.conversation_id) args.push('--conversation', task.conversation_id);
  if (task.mode && task.mode !== 'default') args.push('--mode', task.mode);

  const model = task.model === null ? null : (task.model || 'gemini-3.8-flash-high');
  const effort = task.effort === null ? null : (task.effort || 'high');

  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);

  return args;
}

export function parseAgyStreamLine(line: string): AgentStreamRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let record: any;
  try {
    record = JSON.parse(trimmed);
  } catch {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return null;
    }
    return { kind: 'agent_text', payload: { text: line + '\n' } };
  }

  if (!record || typeof record !== 'object') return null;

  if (record.event === 'init') {
    return {
      kind: 'status',
      payload: { status: 'running' },
    };
  }

  if (record.event === 'step_update' && record.step_update) {
    const step = record.step_update;

    if (step.step_type === 'tool') {
      if (step.state === 'ACTIVE') {
        return {
          kind: 'tool_call',
          payload: {
            tool: step.tool_name || step.tool_info?.name || 'tool',
            input: step.tool_info?.parameters,
            call_id: String(step.step_index ?? ''),
          },
        };
      }
      if (step.state === 'DONE') {
        const rawOut = step.tool_info?.output;
        const out = typeof rawOut === 'string'
          ? rawOut
          : rawOut !== undefined
            ? JSON.stringify(rawOut)
            : '';
        const isOk = !step.error && step.status !== 'ERROR';
        return {
          kind: 'tool_result',
          payload: {
            call_id: String(step.step_index ?? ''),
            ok: isOk,
            output: out || (step.error ? String(step.error) : ''),
          },
        };
      }
    }

    if (
      step.step_type === 'agent_response' ||
      step.step_type === 'planner_response' ||
      step.step_type === 'model_response' ||
      step.step_type === 'message'
    ) {
      if (step.text_delta) {
        return {
          kind: 'agent_text',
          payload: { text: step.text_delta },
        };
      }
      if (step.content || step.text || step.response) {
        return {
          kind: 'agent_text',
          payload: { text: String(step.content || step.text || step.response) },
        };
      }
      if (step.usage?.thinking_tokens && step.state === 'DONE') {
        const secs = step.duration_seconds ? `${step.duration_seconds.toFixed(1)}s` : '';
        return {
          kind: 'thinking',
          payload: { text: `Reasoned for ${secs || 'a few seconds'}` },
        };
      }
    }

    if (step.step_type === 'error_message' || step.error) {
      if (step.error) {
        return {
          kind: 'error',
          payload: {
            message: String(step.error),
            fatal: false,
          },
        };
      }
      return null;
    }

    if (step.thinking) {
      return {
        kind: 'thinking',
        payload: { text: String(step.thinking) },
      };
    }
  }

  if (record.type === 'PLANNER_RESPONSE' && typeof record.content === 'string' && record.content.trim().length > 0) {
    return {
      kind: 'agent_text',
      payload: { text: record.content.trim() },
    };
  }

  if (record.event === 'result' && record.result) {
    const res = record.result;
    const isError = res.status === 'ERROR' || Boolean(res.error);
    let summary = res.response || res.content || res.summary || res.error || '';
    if (!summary && res.conversation_id) {
      summary = extractSummaryFromTranscript(res.conversation_id) || '';
    }
    if (!summary) {
      summary = isError ? 'Task failed' : 'Task completed';
    }
    return {
      kind: 'result',
      payload: {
        summary,
        conversation_id: res.conversation_id,
        duration_seconds: res.duration_seconds,
      },
    };
  }

  const text = textRecord.safeParse(record);
  if (text.success) return { kind: 'agent_text', payload: { text: text.data.text } };

  const thinking = thinkingRecord.safeParse(record);
  if (thinking.success) return { kind: 'thinking', payload: { text: thinking.data.text } };

  const toolCall = toolCallRecord.safeParse(record);
  if (toolCall.success) {
    return {
      kind: 'tool_call',
      payload: {
        tool: toolCall.data.tool,
        input: toolCall.data.input,
        call_id: toolCall.data.call_id,
      },
    };
  }

  const toolResult = toolResultRecord.safeParse(record);
  if (toolResult.success) {
    return {
      kind: 'tool_result',
      payload: {
        call_id: toolResult.data.call_id,
        ok: toolResult.data.ok,
        output: toolResult.data.output,
      },
    };
  }

  const status = statusRecord.safeParse(record);
  if (status.success) return { kind: 'status', payload: { status: status.data.status } };

  const error = errorRecord.safeParse(record);
  if (error.success) {
    return { kind: 'error', payload: { message: error.data.message, fatal: error.data.fatal } };
  }

  const result = resultRecord.safeParse(record);
  if (result.success) {
    return {
      kind: 'result',
      payload: {
        summary: result.data.summary,
        conversation_id: result.data.conversation_id,
        duration_seconds: result.data.duration_seconds,
      },
    };
  }

  return null;
}

export class StaticAgentRunner implements AgentRunner {
  readonly #result: AgentRunResult;

  constructor(result: AgentRunResult) {
    this.#result = result;
  }

  async run(
    _task: Task,
    onEvent?: (event: EventInput) => Promise<void> | void,
    _signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    if (onEvent) {
      for (const event of this.#result.events) {
        try {
          await onEvent(event);
        } catch {}
      }
    }
    return this.#result;
  }
}

export class ProcessAgentRunner implements AgentRunner {
  private agyCommand: string;
  private systemPrompt?: string;

  constructor(agyCommand: string = 'agy', systemPrompt?: string) {
    this.agyCommand = agyCommand;
    this.systemPrompt = systemPrompt ?? DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT;
  }

  async run(
    task: Task,
    onEvent?: (event: EventInput) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    if (task.workspace_path) {
      try {
        const settingsPath = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
        if (fs.existsSync(settingsPath)) {
          const raw = fs.readFileSync(settingsPath, 'utf-8');
          const obj = JSON.parse(raw);
          const workspaces: string[] = Array.isArray(obj.trustedWorkspaces) ? obj.trustedWorkspaces : [];
          const resolved = path.resolve(task.workspace_path);
          if (!workspaces.includes(resolved)) {
            workspaces.push(resolved);
            obj.trustedWorkspaces = workspaces;
            fs.writeFileSync(settingsPath, JSON.stringify(obj, null, 2), 'utf-8');
          }
        }
      } catch {}
    }

    const args = buildAgyArgs(task, {
      agyCommand: this.agyCommand,
      systemPrompt: this.systemPrompt,
    });
    const binary = args[0] || 'agy';
    const cliArgs = args.slice(1);

    return new Promise((resolve, reject) => {
      const proc = spawn(binary, cliArgs, {
        cwd: task.workspace_path || process.cwd(),
        env: process.env,
        detached: process.platform !== 'win32',
      });

      const killProc = (sig: NodeJS.Signals = 'SIGTERM') => {
        try {
          if (proc.pid) {
            if (process.platform !== 'win32') {
              try {
                process.kill(-proc.pid, sig);
              } catch {
                proc.kill(sig);
              }
            } else {
              proc.kill(sig);
            }
          }
        } catch {}
      };

      if (signal?.aborted) {
        killProc('SIGTERM');
      } else if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            killProc('SIGTERM');
            setTimeout(() => killProc('SIGKILL'), 400);
          },
          { once: true },
        );
      }

      const events: EventInput[] = [];
      let summary = '';
      let conversationId: string | null = null;
      let buffer = '';
      let hasFatalError = false;
      let lastErrorMessage = '';

      let eventQueue: Promise<void> = Promise.resolve();
      const handleEvent = (parsed: EventInput) => {
        events.push(parsed);
        if (parsed.kind === 'error') {
          if ((parsed.payload as any)?.fatal) {
            hasFatalError = true;
          }
          lastErrorMessage = (parsed.payload as any)?.message || lastErrorMessage;
        }
        if (parsed.kind === 'result') {
          summary = (parsed.payload as any).summary || summary;
          conversationId = (parsed.payload as any).conversation_id || conversationId;
        }
        if (onEvent) {
          eventQueue = eventQueue.then(async () => {
            try {
              await onEvent(parsed);
            } catch {}
          });
        }
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const parsed = parseAgyStreamLine(line);
          if (parsed) {
            handleEvent(parsed);
          }
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.trim().length > 0) {
          handleEvent({ kind: 'command_output', payload: { command: 'agy', stderr: text } });
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });

      proc.on('close', (code) => {
        if (buffer.trim()) {
          const parsed = parseAgyStreamLine(buffer);
          if (parsed) handleEvent(parsed);
        }
        eventQueue.then(() => {
          if (signal?.aborted) {
            resolve({
              events,
              summary: 'Task cancelled by user',
              conversationId,
              status: 'done',
            });
            return;
          }
          if (code !== 0 && events.length === 0) {
            reject(new Error(`Agent process exited with code ${code}`));
            return;
          }
          if ((!summary || summary === 'Task completed' || summary === 'Task completed without text output') && conversationId) {
            const transcriptSummary = extractSummaryFromTranscript(conversationId);
            if (transcriptSummary) {
              summary = transcriptSummary;
              const hasText = events.some((e) => e.kind === 'agent_text');
              if (!hasText) {
                const textEvent: EventInput = { kind: 'agent_text', payload: { text: transcriptSummary } };
                events.push(textEvent);
                if (onEvent) {
                  onEvent(textEvent);
                }
              }
            }
          }
          const isFailed = code !== 0 || hasFatalError;
          const defaultSummary = isFailed
            ? (lastErrorMessage || `Task failed (exit code ${code})`)
            : 'Task completed';
          resolve({
            events,
            summary: summary || defaultSummary,
            conversationId,
            status: isFailed ? 'failed' : 'done',
          });
        }).catch(() => {
          if (signal?.aborted) {
            resolve({
              events,
              summary: 'Task cancelled by user',
              conversationId,
              status: 'done',
            });
            return;
          }
          const isFailed = code !== 0 || hasFatalError;
          const defaultSummary = isFailed
            ? (lastErrorMessage || `Task failed (exit code ${code})`)
            : 'Task completed';
          resolve({
            events,
            summary: summary || defaultSummary,
            conversationId,
            status: isFailed ? 'failed' : 'done',
          });
        });
      });
    });
  }
}

