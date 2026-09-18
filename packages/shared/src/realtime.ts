import { z } from 'zod';
import { eventInputSchema } from './event.js';
import { APPROVAL_DECISIONS } from './approval.js';

export const REALTIME_PROTOCOL_VERSION = 1;

export const helloMessageSchema = z.object({
  type: z.literal('hello'),
  role: z.enum(['phone', 'daemon']),
  protocol_version: z.literal(REALTIME_PROTOCOL_VERSION),
});

export const taskEventMessageSchema = z.object({
  type: z.literal('task.event'),
  task_id: z.string().uuid(),
  event: eventInputSchema,
});

export const taskFrameMessageSchema = z.object({
  type: z.literal('task.frame'),
  task_id: z.string().uuid(),
  jpeg_base64: z.string().min(1),
  captured_at: z.string(),
});

export const approvalRequestedMessageSchema = z.object({
  type: z.literal('approval.requested'),
  task_id: z.string().uuid(),
  approval_id: z.string().uuid(),
  summary: z.string().optional(),
  action_kind: z.string().optional(),
  risk: z.string().optional(),
});

export const approvalDecidedMessageSchema = z.object({
  type: z.literal('approval.decided'),
  approval_id: z.string().uuid(),
  decision: z.enum(APPROVAL_DECISIONS),
});

export const heartbeatMessageSchema = z.object({
  type: z.literal('heartbeat'),
  machine_id: z.string().uuid(),
  sent_at: z.string(),
});

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

export const realtimeMessageSchema = z.discriminatedUnion('type', [
  helloMessageSchema,
  taskEventMessageSchema,
  taskFrameMessageSchema,
  approvalRequestedMessageSchema,
  approvalDecidedMessageSchema,
  heartbeatMessageSchema,
  errorMessageSchema,
]);

export type RealtimeMessage = z.infer<typeof realtimeMessageSchema>;

export function parseRealtimeMessage(input: unknown): RealtimeMessage {
  return realtimeMessageSchema.parse(input);
}

export function safeParseRealtimeMessage(
  input: unknown,
): { ok: true; message: RealtimeMessage } | { ok: false; error: string } {
  const result = realtimeMessageSchema.safeParse(input);
  if (result.success) {
    return { ok: true, message: result.data };
  }
  return {
    ok: false,
    error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}
