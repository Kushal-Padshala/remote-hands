import { z } from 'zod';
import { TASK_STATUSES } from './task.js';

export const EVENT_KINDS = [
  'agent_text', 'thinking', 'tool_call', 'tool_result',
  'file_diff', 'command_output', 'browser_action',
  'status', 'approval_requested', 'error', 'result',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

const agentText = z.object({ text: z.string() });
const thinking = z.object({ text: z.string() });
const toolCall = z.object({
  tool: z.string(),
  input: z.unknown().optional(),
  call_id: z.string().optional(),
});
const toolResult = z.object({
  call_id: z.string().optional(),
  ok: z.boolean().default(true),
  output: z.string().optional(),
});
const fileDiff = z.object({
  path: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string(),
});
const commandOutput = z.object({
  command: z.string(),
  exit_code: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});
const browserAction = z.object({
  action: z.enum(['navigate', 'click', 'type', 'scroll', 'screenshot', 'other']),
  label: z.string().optional(),
  url: z.string().optional(),
});
const status = z.object({ status: z.enum(TASK_STATUSES) });
const approvalRequested = z.object({ approval_id: z.uuid() });
const errorPayload = z.object({ message: z.string(), fatal: z.boolean().default(false) });
const result = z.object({
  summary: z.string(),
  conversation_id: z.string().optional(),
  duration_seconds: z.number().optional(),
});

/**
 * Every schema is `.partial()`-tolerant only where a field is genuinely
 * optional. Defaults are applied here so consumers never branch on undefined.
 */
export const eventPayloadSchemas = {
  agent_text: agentText,
  thinking,
  tool_call: toolCall,
  tool_result: toolResult,
  file_diff: fileDiff,
  command_output: commandOutput,
  browser_action: browserAction,
  status,
  approval_requested: approvalRequested,
  error: errorPayload,
  result,
} as const satisfies Record<EventKind, z.ZodType>;

export type EventPayload<K extends EventKind> = z.infer<(typeof eventPayloadSchemas)[K]>;

export type TaskEvent<K extends EventKind = EventKind> = {
  [Kind in K]: {
    id: number;
    task_id: string;
    user_id: string;
    seq: number;
    created_at: string;
    kind: Kind;
    payload: EventPayload<Kind>;
  };
}[K];

const envelope = z.object({
  id: z.number().int(),
  task_id: z.uuid(),
  user_id: z.uuid(),
  seq: z.number().int().nonnegative(),
  created_at: z.string(),
  kind: z.enum(EVENT_KINDS),
  payload: z.unknown(),
});

export function parseEvent(row: unknown): TaskEvent {
  const shell = envelope.parse(row);
  const payload = eventPayloadSchemas[shell.kind].parse(shell.payload);
  return { ...shell, payload } as TaskEvent;
}

export function safeParseEvent(
  row: unknown,
): { ok: true; event: TaskEvent } | { ok: false; error: string } {
  try {
    return { ok: true, event: parseEvent(row) };
  } catch (cause) {
    const message =
      cause instanceof z.ZodError
        ? cause.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : String(cause);
    return { ok: false, error: message };
  }
}
