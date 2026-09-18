import { z } from 'zod';
import { TASK_KINDS, TASK_MODES, TASK_STATUSES } from './task.js';
import { ACTION_KINDS, APPROVAL_DECISIONS, RISK_LEVELS } from './approval.js';
import { EVENT_KINDS, eventInputSchema } from './event.js';

export const setupOwnerRequestSchema = z.object({
  owner_secret: z.string().min(8),
});
export type SetupOwnerRequest = z.infer<typeof setupOwnerRequestSchema>;

export const setupOwnerResponseSchema = z.object({
  ok: z.boolean(),
  owner_id: z.string().uuid(),
});
export type SetupOwnerResponse = z.infer<typeof setupOwnerResponseSchema>;

export const startPairingRequestSchema = z.object({
  machine_name: z.string().min(1).max(128),
});
export type StartPairingRequest = z.infer<typeof startPairingRequestSchema>;

export const startPairingResponseSchema = z.object({
  token_id: z.string().uuid(),
  pairing_code: z.string().min(6),
  expires_at: z.string(),
});
export type StartPairingResponse = z.infer<typeof startPairingResponseSchema>;

export const claimPairingRequestSchema = z.object({
  pairing_code: z.string().min(1),
  hostname: z.string().min(1),
  daemon_version: z.string().optional(),
  agy_version: z.string().optional(),
});
export type ClaimPairingRequest = z.infer<typeof claimPairingRequestSchema>;

export const claimPairingResponseSchema = z.object({
  ok: z.boolean(),
  machine_id: z.string().uuid(),
  session_token: z.string().min(16),
  expires_at: z.string(),
});
export type ClaimPairingResponse = z.infer<typeof claimPairingResponseSchema>;

export const machineRowSchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  name: z.string(),
  hostname: z.string(),
  daemon_version: z.string().nullable(),
  agy_version: z.string().nullable(),
  status: z.enum(['online', 'offline']),
  last_seen_at: z.string().nullable(),
  created_at: z.string(),
});
export type MachineRow = z.infer<typeof machineRowSchema>;

export const machineListResponseSchema = z.object({
  machines: z.array(machineRowSchema),
});
export type MachineListResponse = z.infer<typeof machineListResponseSchema>;

export const createTaskRequestSchema = z.object({
  machine_id: z.string().uuid(),
  prompt: z.string().min(1).max(20000),
  kind: z.enum(TASK_KINDS).default('browser'),
  mode: z.enum(TASK_MODES).default('default'),
  workspace_path: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  conversation_id: z.string().optional(),
  parent_task_id: z.string().uuid().optional(),
});

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const taskRowSchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  machine_id: z.string().uuid(),
  prompt: z.string(),
  kind: z.enum(TASK_KINDS),
  workspace_path: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  mode: z.enum(TASK_MODES),
  status: z.enum(TASK_STATUSES),
  conversation_id: z.string().nullable(),
  parent_task_id: z.string().uuid().nullable(),
  result_summary: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
export type TaskRow = z.infer<typeof taskRowSchema>;

export const createTaskResponseSchema = z.object({
  task: taskRowSchema,
});
export type CreateTaskResponse = z.infer<typeof createTaskResponseSchema>;

export const taskResponseSchema = z.object({
  task: taskRowSchema,
});
export type TaskResponse = z.infer<typeof taskResponseSchema>;

export const taskEventRowSchema = z.object({
  id: z.number().int(),
  task_id: z.string().uuid(),
  owner_id: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  kind: z.enum(EVENT_KINDS),
  payload: z.unknown(),
  created_at: z.string(),
});
export type TaskEventRow = z.infer<typeof taskEventRowSchema>;

export const taskEventsResponseSchema = z.object({
  events: z.array(taskEventRowSchema),
});
export type TaskEventsResponse = z.infer<typeof taskEventsResponseSchema>;

export const appendEventRequestSchema = eventInputSchema;
export type AppendEventRequest = z.infer<typeof appendEventRequestSchema>;

export const appendEventResponseSchema = z.object({
  event: taskEventRowSchema,
});
export type AppendEventResponse = z.infer<typeof appendEventResponseSchema>;

export const claimTaskRequestSchema = z.object({
  machine_id: z.string().uuid(),
});
export type ClaimTaskRequest = z.infer<typeof claimTaskRequestSchema>;

export const claimTaskResponseSchema = z.object({
  task: taskRowSchema.nullable(),
});
export type ClaimTaskResponse = z.infer<typeof claimTaskResponseSchema>;

export const completeTaskRequestSchema = z.object({
  summary: z.string().min(1),
  conversation_id: z.string().nullable().optional(),
});
export type CompleteTaskRequest = z.infer<typeof completeTaskRequestSchema>;

export const completeTaskResponseSchema = z.object({
  task: taskRowSchema,
});
export type CompleteTaskResponse = z.infer<typeof completeTaskResponseSchema>;

export const failTaskRequestSchema = z.object({
  error: z.string().min(1),
});
export type FailTaskRequest = z.infer<typeof failTaskRequestSchema>;

export const failTaskResponseSchema = z.object({
  task: taskRowSchema,
});
export type FailTaskResponse = z.infer<typeof failTaskResponseSchema>;

export const cancelTaskRequestSchema = z.object({
  reason: z.string().optional(),
});
export type CancelTaskRequest = z.infer<typeof cancelTaskRequestSchema>;

export const cancelTaskResponseSchema = z.object({
  task: taskRowSchema,
});
export type CancelTaskResponse = z.infer<typeof cancelTaskResponseSchema>;


export const approvalRowSchema = z.object({
  id: z.string().uuid(),
  task_id: z.string().uuid(),
  owner_id: z.string().uuid(),
  action_kind: z.enum(ACTION_KINDS),
  summary: z.string(),
  risk: z.enum(RISK_LEVELS),
  tool_payload: z.unknown(),
  frame_path: z.string().nullable(),
  decision: z.enum(APPROVAL_DECISIONS),
  decided_at: z.string().nullable(),
  expires_at: z.string(),
  created_at: z.string(),
  rejection_reason: z.string().nullable().optional(),
});
export type ApprovalRow = z.infer<typeof approvalRowSchema>;

export const createApprovalRequestSchema = z.object({
  task_id: z.string().uuid(),
  action_kind: z.enum(ACTION_KINDS),
  summary: z.string().min(1),
  risk: z.enum(RISK_LEVELS),
  tool_payload: z.unknown().default({}),
  frame_path: z.string().nullable().optional(),
  timeout_ms: z.number().int().positive().optional(),
});
export type CreateApprovalRequest = z.infer<typeof createApprovalRequestSchema>;

export const createApprovalResponseSchema = z.object({
  approval: approvalRowSchema,
});
export type CreateApprovalResponse = z.infer<typeof createApprovalResponseSchema>;

export const decideApprovalRequestSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().optional(),
});
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequestSchema>;

export const decideApprovalResponseSchema = z.object({
  approval: approvalRowSchema,
});
export type DecideApprovalResponse = z.infer<typeof decideApprovalResponseSchema>;

export const listApprovalsResponseSchema = z.object({
  approvals: z.array(approvalRowSchema),
});
export type ListApprovalsResponse = z.infer<typeof listApprovalsResponseSchema>;

export const createPhoneSessionRequestSchema = z.object({
  owner_secret: z.string().min(1),
});
export type CreatePhoneSessionRequest = z.infer<typeof createPhoneSessionRequestSchema>;

export const createPhoneSessionResponseSchema = z.object({
  session_token: z.string().min(16),
  expires_at: z.string(),
});
export type CreatePhoneSessionResponse = z.infer<typeof createPhoneSessionResponseSchema>;
