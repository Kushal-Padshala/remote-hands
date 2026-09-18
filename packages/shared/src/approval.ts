export const APPROVAL_DECISIONS = ['pending', 'approved', 'rejected', 'expired'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const ACTION_KINDS = [
  'publish', 'send', 'pay', 'delete', 'push', 'shell', 'other',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** How long the hook waits for a human before denying. Ten minutes. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;

export interface Approval {
  id: string;
  task_id: string;
  user_id: string;
  action_kind: ActionKind;
  summary: string;
  risk: RiskLevel;
  tool_payload: unknown;
  frame_path: string | null;
  decision: ApprovalDecision;
  decided_at: string | null;
  expires_at: string;
  created_at: string;
  rejection_reason?: string | null | undefined;
}

function past(deadline: string, now: Date): boolean {
  return now.getTime() > Date.parse(deadline);
}

export function isPending(approval: Approval, now: Date = new Date()): boolean {
  return approval.decision === 'pending' && !past(approval.expires_at, now);
}

export function hasExpired(approval: Approval, now: Date = new Date()): boolean {
  return approval.decision === 'pending' && past(approval.expires_at, now);
}

/**
 * The single place the "deny on timeout" rule is expressed. Silence is not
 * consent: the user is deliberately away, so an unanswered request expires
 * rather than proceeding.
 */
export function resolveDecision(approval: Approval, now: Date = new Date()): ApprovalDecision {
  if (approval.decision !== 'pending') return approval.decision;
  return past(approval.expires_at, now) ? 'expired' : 'pending';
}
