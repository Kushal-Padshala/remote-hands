import type { Task } from '@remote-hands/shared';
import { spawn } from 'node:child_process';
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
  run(task: Task, onEvent?: (event: EventInput) => Promise<void> | void): Promise<AgentRunResult>;
}

export type AgentStreamRecord = EventInput;

type AgyArgConfig = Pick<DaemonConfig, 'agyCommand'>;

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
  const args = [config.agyCommand, '-p', task.prompt, '--output-format', 'stream-json'];

  if (task.workspace_path) args.push('--add-dir', task.workspace_path);
  if (task.conversation_id) args.push('--conversation', task.conversation_id);
  if (task.mode && task.mode !== 'default') args.push('--mode', task.mode);
  if (task.model) args.push('--model', task.model);
  if (task.effort) args.push('--effort', task.effort);

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

    if (step.step_type === 'agent_response') {
      if (step.text_delta) {
        return {
          kind: 'agent_text',
          payload: { text: step.text_delta },
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
      return {
        kind: 'error',
        payload: {
          message: String(step.error || 'Execution error'),
          fatal: false,
        },
      };
    }

    if (step.thinking) {
      return {
        kind: 'thinking',
        payload: { text: String(step.thinking) },
      };
    }
  }

  if (record.event === 'result' && record.result) {
    const res = record.result;
    const isError = res.status === 'ERROR' || Boolean(res.error);
    const summary = res.response || res.error || (isError ? 'Task failed' : 'Task completed without text output');
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

  async run(_task: Task, onEvent?: (event: EventInput) => Promise<void> | void): Promise<AgentRunResult> {
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

  constructor(agyCommand: string = 'agy') {
    this.agyCommand = agyCommand;
  }

  async run(task: Task, onEvent?: (event: EventInput) => Promise<void> | void): Promise<AgentRunResult> {
    const args = buildAgyArgs(task, { agyCommand: this.agyCommand });
    const binary = args[0] || 'agy';
    const cliArgs = args.slice(1);

    return new Promise((resolve, reject) => {
      const proc = spawn(binary, cliArgs, {
        cwd: task.workspace_path || process.cwd(),
        env: process.env,
      });

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
          if (code !== 0 && events.length === 0) {
            reject(new Error(`Agent process exited with code ${code}`));
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
        }).catch(() => {
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

