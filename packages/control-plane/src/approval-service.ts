import { randomUUID } from 'crypto';
import {
  type ActionKind,
  type ApprovalDecision,
  type ApprovalRow,
  type RiskLevel,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from '@remote-hands/shared';

export interface CreateApprovalParams {
  id?: string | undefined;
  ownerId: string;
  taskId: string;
  actionKind: ActionKind;
  summary: string;
  risk: RiskLevel;
  toolPayload: unknown;
  framePath?: string | null | undefined;
  timeoutMs?: number | undefined;
}


export function createApproval(params: CreateApprovalParams, now: Date = new Date()): ApprovalRow {
  const timeoutMs = params.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const expiresAt = new Date(now.getTime() + timeoutMs).toISOString();

  return {
    id: params.id ?? randomUUID(),
    task_id: params.taskId,
    owner_id: params.ownerId,
    action_kind: params.actionKind,
    summary: params.summary,
    risk: params.risk,
    tool_payload: params.toolPayload,
    frame_path: params.framePath ?? null,
    decision: 'pending',
    decided_at: null,
    expires_at: expiresAt,
    created_at: now.toISOString(),
  };
}

export function evaluateApprovalDecision(approval: ApprovalRow, now: Date = new Date()): ApprovalDecision {
  if (approval.decision !== 'pending') {
    return approval.decision;
  }
  if (now.getTime() > Date.parse(approval.expires_at)) {
    return 'expired';
  }
  return 'pending';
}

export function decideApproval(
  approval: ApprovalRow,
  decision: 'approved' | 'rejected',
  now: Date = new Date(),
): ApprovalRow {
  const current = evaluateApprovalDecision(approval, now);
  if (current === 'expired') {
    throw new Error('Cannot decide approval: request has expired');
  }
  if (current !== 'pending') {
    throw new Error(`Cannot decide approval: already resolved as ${current}`);
  }

  return {
    ...approval,
    decision,
    decided_at: now.toISOString(),
  };
}

export function expireApproval(approval: ApprovalRow, now: Date = new Date()): ApprovalRow {
  const current = evaluateApprovalDecision(approval, now);
  if (current !== 'expired') {
    throw new Error('Approval has not reached its expiration deadline');
  }
  return {
    ...approval,
    decision: 'expired',
  };
}
