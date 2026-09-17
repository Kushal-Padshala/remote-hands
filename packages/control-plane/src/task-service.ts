import { randomUUID } from 'crypto';
import {
  type Task,
  type TaskKind,
  type TaskMode,
  type TaskStatus,
  canTransition,
} from '@remote-hands/shared';

export interface CreateTaskParams {
  id?: string | undefined;
  ownerId: string;
  machineId: string;
  prompt: string;
  kind?: TaskKind | undefined;
  workspacePath?: string | null | undefined;
  model?: string | null | undefined;
  effort?: string | null | undefined;
  mode?: TaskMode | undefined;
  conversationId?: string | null | undefined;
  parentTaskId?: string | null | undefined;
}

export function createTask(params: CreateTaskParams, now: Date = new Date()): Task & { owner_id: string } {
  return {
    id: params.id ?? randomUUID(),
    user_id: params.ownerId,
    owner_id: params.ownerId,
    machine_id: params.machineId,
    prompt: params.prompt,

    kind: params.kind ?? 'browser',
    workspace_path: params.workspacePath ?? null,
    model: params.model ?? 'gemini-3.8-flash-high',
    effort: params.effort ?? 'high',
    mode: params.mode ?? 'default',
    status: 'queued',
    conversation_id: params.conversationId ?? null,
    parent_task_id: params.parentTaskId ?? null,
    result_summary: null,
    error: null,
    created_at: now.toISOString(),
    started_at: null,
    finished_at: null,
  };
}

export function transitionTask(task: Task, toStatus: TaskStatus): Task {
  if (!canTransition(task.status, toStatus)) {
    throw new Error(`Cannot transition task from status ${task.status} to ${toStatus}`);
  }
  return {
    ...task,
    status: toStatus,
  };
}

export function claimTask(task: Task, machineId: string, now: Date = new Date()): Task {
  if (task.machine_id !== machineId) {
    throw new Error(`Task machine mismatch: task is assigned to ${task.machine_id}, claimed by ${machineId}`);
  }
  const transitioned = transitionTask(task, 'claimed');
  return {
    ...transitioned,
    started_at: now.toISOString(),
  };
}

export function completeTask(
  task: Task,
  input: { summary: string; conversationId?: string | null | undefined },
  now: Date = new Date(),
): Task {

  const transitioned = transitionTask(task, 'done');
  return {
    ...transitioned,
    result_summary: input.summary,
    conversation_id: input.conversationId ?? task.conversation_id,
    finished_at: now.toISOString(),
  };
}

export function failTask(
  task: Task,
  input: { error: string },
  now: Date = new Date(),
): Task {
  const transitioned = transitionTask(task, 'failed');
  return {
    ...transitioned,
    error: input.error,
    finished_at: now.toISOString(),
  };
}

export function cancelTask(
  task: Task,
  input?: { reason?: string | undefined },
  now: Date = new Date(),
): Task {
  const transitioned = transitionTask(task, 'cancelled');
  return {
    ...transitioned,
    error: input?.reason ?? 'Task cancelled by user',
    finished_at: now.toISOString(),
  };
}

