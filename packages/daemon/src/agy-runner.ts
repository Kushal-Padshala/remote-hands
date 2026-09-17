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
  '1. Elite Engineering Intelligence: State a concise 2-sentence strategic plan in text, then execute purposeful, decisive actions. Reason deeply through problems, inspect diagnostics carefully, and drive tasks to complete resolution.\n' +
  '2. Browser Automation & Exploration: For automated web tasks, use `browser-harness <<\'PY\' ... PY` (connected to Chrome via CDP in background):\n' +
  '   - Inspect page: `print(page_info())` and `print(js("document.body.innerText"))`.\n' +
  '   - Navigate: `goto_url("...")` or `new_tab("...")`.\n' +
  '   - Interact: `click_at_xy(x, y)`, `js("document.querySelector(\'...\').click()")`, `fill_input(selector, text)`, `press_key(key)`.\n' +
  '   - Tab management: `for t in list_tabs(): print(t)` and `switch_tab(target_id)`.\n' +
  '   - Screenshots: The daemon streams live visual frames via CDP directly to the user\'s mobile screen.\n' +
  '3. Desktop Chrome vs. Automation Browser:\n' +
  '   - `browser-harness` runs an automated background browser session.\n' +
  '   - If the user specifically asks to open a site or profile in their personal desktop browser, use `open -a "Google Chrome" "<url>"` or `open "<url>"`.\n' +
  '   - If an automated task requires a personal account and hits a login wall, 2FA prompt, or expired session, do NOT attempt to bypass security. Stop cleanly, provide the direct URL, and notify the user.\n' +
  '4. Strictly Forbidden Actions & Anti-Loop Rules:\n' +
  '   - NEVER attempt AppleScript UI automation or menu bar hacking on Chrome (`tell application "System Events"...`). It is blocked by macOS security.\n' +
  '   - NEVER dump binary session files (`Tabs_*`, `Session_*`), decrypt SQLite databases, query macOS Keychain, or scrape credentials.\n' +
  '   - NEVER retry the same failing command in a loop. If a command or script fails, analyze the error output and pivot or conclude.\n' +
  '   - Desktop etiquette: Keep background tasks non-intrusive and never steal focus.\n' +
  '5. Comprehensive Final Report: Always conclude every task with a clear, well-structured markdown summary explaining findings, exact actions taken, and final verified status.]';

export const DEFAULT_REMOTE_HANDS_REMINDER =
  '[Context Reminder: Remote Hands mobile control plane.\n' +
  '1. Strategic Action: State a concise plan and execute decisive, verified actions.\n' +
  '2. Browser Workflow: Use `browser-harness <<\'PY\' ... PY` for automation (`new_tab`, `goto_url`, `click_at_xy`, `fill_input`, `page_info`, `js`). Use `open -a "Google Chrome" "<url>"` to open pages in desktop Chrome.\n' +
  '3. Security & Anti-Loop: Never use AppleScript System Events on Chrome. If authentication or 2FA is needed, report the URL clearly instead of looping. Never repeat failed commands.\n' +
  '4. Final Report: Explain findings, actions taken, and verified outcome in clean markdown.]';

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

export function getDetectedChromeProfiles(): string {
  try {
    const candidatePaths = [
      path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Local State'),
      path.join(os.homedir(), '.config/google-chrome/Local State'),
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data/Local State')
        : '',
    ].filter(Boolean);

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const data = JSON.parse(raw);
        const infoCache = data.profile?.info_cache;
        if (infoCache && typeof infoCache === 'object') {
          const lines: string[] = [];
          for (const [dirName, info] of Object.entries(infoCache) as [string, any][]) {
            const name = info?.name || dirName;
            const email = info?.user_name || '';
            const isPersonal =
              name.toLowerCase().includes('personal') ||
              dirName === 'Profile 4' ||
              (email && !email.includes('business') && !email.includes('info') && !email.includes('edu') && !email.includes('feed'));
            lines.push(
              `- Directory: "${dirName}" | Name: "${name}" | Email: "${email}"${
                isPersonal ? ' [Personal Profile]' : ''
              }`,
            );
          }
          if (lines.length > 0) {
            return (
              'Available Chrome Profiles on this machine:\n' +
              lines.join('\n') +
              '\n\nBrowser SOP:\n' +
              '- Background automation: use `browser-harness <<\'PY\' ... PY` with `new_tab("<url>")`.\n' +
              '- Personal desktop browsing: use `open -a "Google Chrome" "<url>"` to launch the URL in desktop Chrome with the user\'s active personal profile.\n' +
              '- Zero command spam: do not run terminal commands (ls, find, cat Local State, python inspect, ps aux) to search for profiles.'
            );
          }
        }
      }
    }
  } catch {}
  return '';
}

export function getDefaultRemoteHandsSystemPrompt(): string {
  const profileInfo = getDetectedChromeProfiles();
  return profileInfo
    ? `${DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT}\n\n${profileInfo}`
    : DEFAULT_REMOTE_HANDS_SYSTEM_PROMPT;
}

export function getDefaultRemoteHandsReminder(): string {
  const profileInfo = getDetectedChromeProfiles();
  return profileInfo
    ? `${DEFAULT_REMOTE_HANDS_REMINDER}\n\n${profileInfo}`
    : DEFAULT_REMOTE_HANDS_REMINDER;
}

export function buildAgyArgs(task: Task, config: AgyArgConfig): readonly string[] {
  const promptText = config.systemPrompt
    ? (!task.conversation_id
        ? `${config.systemPrompt}\n\n${task.prompt}`
        : `${getDefaultRemoteHandsReminder()}\n\n${task.prompt}`)
    : task.prompt;

  const args = [config.agyCommand, '-p', promptText, '--output-format', 'stream-json'];

  if (task.workspace_path) args.push('--add-dir', task.workspace_path);
  if (task.conversation_id) args.push('--conversation', task.conversation_id);
  if (task.mode && task.mode !== 'default') args.push('--mode', task.mode);

  const model = task.model === null ? null : (task.model || 'claude-sonnet-4-6');
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
    this.systemPrompt = systemPrompt ?? getDefaultRemoteHandsSystemPrompt();
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

