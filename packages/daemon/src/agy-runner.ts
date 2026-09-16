import type { Task } from '@remote-hands/shared';
import { z } from 'zod';
import type { DaemonConfig } from './config.js';
import type { EventInput } from './task-store.js';

export interface AgentRunResult {
  events: readonly EventInput[];
  summary: string;
  conversationId: string | null;
  durationSeconds?: number;
}

export interface AgentRunner {
  run(task: Task): Promise<AgentRunResult>;
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

  if (task.workspace_path !== null) args.push('--add-dir', task.workspace_path);
  if (task.conversation_id !== null) args.push('--conversation', task.conversation_id);
  if (task.mode !== 'default') args.push('--mode', task.mode);
  if (task.model !== null) args.push('--model', task.model);
  if (task.effort !== null) args.push('--effort', task.effort);

  return args;
}

export function parseAgyStreamLine(line: string): AgentStreamRecord | null {
  if (line.trim().length === 0) return null;

  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
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

  async run(): Promise<AgentRunResult> {
    return this.#result;
  }
}

