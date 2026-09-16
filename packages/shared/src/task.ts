export const TASK_STATUSES = [
  'queued', 'claimed', 'running', 'awaiting_approval',
  'done', 'failed', 'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_KINDS = ['browser', 'coding', 'mixed', 'auto'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_MODES = ['default', 'accept-edits', 'plan'] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export interface Task {
  id: string;
  user_id: string;
  machine_id: string;
  prompt: string;
  kind: TaskKind;
  workspace_path: string | null;
  model: string | null;
  effort: string | null;
  mode: TaskMode;
  status: TaskStatus;
  conversation_id: string | null;
  parent_task_id: string | null;
  result_summary: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['done', 'failed', 'cancelled']);

const ALLOWED: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['claimed', 'cancelled'],
  claimed: ['running', 'failed', 'cancelled'],
  running: ['awaiting_approval', 'done', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED[from].includes(to);
}
