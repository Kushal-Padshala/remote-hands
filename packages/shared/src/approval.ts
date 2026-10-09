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

const RISKY_CONTROLS: ReadonlyArray<readonly [ActionKind, RegExp]> = [
  ['pay', /\b(pay|buy|purchase|checkout|check out|place (?:your )?order|subscribe|donate|transfer|withdraw|book now)\b/i],
  ['delete', /\b(delete|destroy|erase|uninstall|terminate|revoke|deactivate|close account)\b/i],
  ['push', /\b(deploy|merge|promote to production)\b/i],
  ['send', /\b(send|reply)\b/i],
  ['publish', /\b(post|publish|tweet|submit|go live)\b/i],
];

/**
 * Which irreversible action pressing a control named `label` would take, or null.
 * Used by the action gate so these clicks wait for the phone instead of relying on
 * the agent to call `rh approve` first. `goal` mode classifies a free-text goal
 * (`rh desktop act`). Control labels are classified regardless of length.
 */
export function classifyRiskyAction(label: string, opts: { goal?: boolean } = {}): ActionKind | null {
  const text = (label ?? '').trim();
  if (!text) return null;
  for (const [kind, pattern] of RISKY_CONTROLS) {
    if (pattern.test(text)) return kind;
  }
  return null;
}

const COMMAND_MODIFIERS = new Set(['cmd', 'command', 'meta', 'ctrl', 'control']);

/**
 * Keyboard shortcuts that send or delete without a button press: Cmd/Ctrl+Enter sends in
 * Mail, Slack, Gmail, Outlook and Teams; Cmd+Shift+D sends in Mail; Cmd+Delete deletes in
 * Finder, Mail and Photos. Plain Enter is left alone (it would gate every search box).
 */
export function classifyRiskyKey(combo: string): ActionKind | null {
  const parts = (combo ?? '')
    .toLowerCase()
    .split(/[+\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key || !parts.some((p) => COMMAND_MODIFIERS.has(p))) return null;
  if (key === 'enter' || key === 'return') return 'send';
  if (key === 'd' && parts.includes('shift') && (parts.includes('cmd') || parts.includes('command'))) return 'send';
  if (key === 'delete' || key === 'backspace' || key === 'forwarddelete') return 'delete';
  return null;
}
