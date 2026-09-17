import {
  claimTaskRequestSchema,
  createTaskRequestSchema,
  completeTaskRequestSchema,
  failTaskRequestSchema,
  cancelTaskRequestSchema,
  type TaskRow,
} from '@remote-hands/shared';
import {
  createTask,
  claimTask,
  transitionTask,
  completeTask,
  failTask,
  cancelTask,
} from '@remote-hands/control-plane';

import { requireOwnerSession, requireSession } from '../auth/session.js';
import { TasksRepository } from '../d1/tasks-repository.js';
import { getTaskRoomStub } from '../realtime/room-router.js';
import { ForbiddenError, NotFoundError } from '../http/errors.js';
import { jsonOk } from '../http/json.js';
import type { Env } from '../env.js';

export async function handleCreateTask(request: Request, env: Env): Promise<Response> {
  const session = await requireOwnerSession(request, env.DB);
  const body = createTaskRequestSchema.parse(await request.json());

  const task = createTask({
    ownerId: session.owner_id,
    machineId: body.machine_id,
    prompt: body.prompt,
    kind: body.kind,
    mode: body.mode,
    workspacePath: body.workspace_path,
    model: body.model || 'gemini-3.8-flash-high',
    effort: body.effort || 'high',
    conversationId: body.conversation_id,
    parentTaskId: body.parent_task_id,
  });

  const repo = new TasksRepository(env.DB);
  await repo.create(task as TaskRow);

  return jsonOk({ task }, 201);
}

export async function handleGetTask(taskId: string, request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  const repo = new TasksRepository(env.DB);
  const task = await repo.getById(taskId);

  if (!task || task.owner_id !== session.owner_id) {
    throw new NotFoundError('Task not found');
  }

  return jsonOk({ task });
}

export async function handleClaimNextTask(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  if (session.kind !== 'daemon' || !session.machine_id) {
    throw new ForbiddenError('Only daemon sessions can claim tasks');
  }

  const body = claimTaskRequestSchema.parse(await request.json());
  if (session.machine_id !== body.machine_id) {
    throw new ForbiddenError('Machine ID mismatch');
  }

  const repo = new TasksRepository(env.DB);
  const queued = await repo.listQueuedForMachine(body.machine_id);
  if (queued.length === 0) {
    return jsonOk({ task: null });
  }

  const oldest = queued[0]!;
  const claimed = claimTask(oldest as any, session.machine_id);
  await repo.updateStatus(oldest.id, 'claimed', { started_at: claimed.started_at });

  return jsonOk({ task: claimed });
}

export async function handleClaimTask(taskId: string, request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  if (session.kind !== 'daemon' || !session.machine_id) {
    throw new ForbiddenError('Only daemon sessions can claim tasks');
  }

  const repo = new TasksRepository(env.DB);
  const task = await repo.getById(taskId);

  if (!task || task.owner_id !== session.owner_id) {
    throw new NotFoundError('Task not found');
  }

  const claimed = claimTask(task as any, session.machine_id);
  await repo.updateStatus(taskId, 'claimed', { started_at: claimed.started_at });

  return jsonOk({ task: claimed });
}

export async function handleMarkTaskRunning(taskId: string, request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  const repo = new TasksRepository(env.DB);
  const task = await repo.getById(taskId);

  if (!task || task.owner_id !== session.owner_id) {
    throw new NotFoundError('Task not found');
  }

  const running = transitionTask(task as any, 'running');
  await repo.updateStatus(taskId, 'running');

  return jsonOk({ task: running });
}


export async function handleCompleteTask(taskId: string, request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  const repo = new TasksRepository(env.DB);
  const task = await repo.getById(taskId);

  if (!task || task.owner_id !== session.owner_id) {
    throw new NotFoundError('Task not found');
  }

  const body = completeTaskRequestSchema.parse(await request.json());
  const completed = completeTask(task as any, {
    summary: body.summary,
    conversationId: body.conversation_id,
  });

  await repo.updateStatus(taskId, 'done', {
    finished_at: completed.finished_at,
    result_summary: completed.result_summary,
    conversation_id: completed.conversation_id ?? undefined,
  });

  try {
    const room = getTaskRoomStub(taskId, env);
    await room.fetch(new Request('https://internal/event', {
      method: 'POST',
      body: JSON.stringify({
        type: 'task.event',
        event: {
          id: Date.now(),
          task_id: taskId,
          owner_id: task.owner_id,
          seq: 999999,
          kind: 'status',
          payload: { status: 'done' },
          created_at: new Date().toISOString(),
        },
      }),
    }));
  } catch {}

  return jsonOk({ task: completed });
}

export async function handleFailTask(taskId: string, request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  const repo = new TasksRepository(env.DB);
  const task = await repo.getById(taskId);

  if (!task || task.owner_id !== session.owner_id) {
    throw new NotFoundError('Task not found');
  }

  const body = failTaskRequestSchema.parse(await request.json());
  const failed = failTask(task as any, { error: body.error });

  await repo.updateStatus(taskId, 'failed', {
    finished_at: failed.finished_at,
    error: failed.error ?? undefined,
  });

  try {
    const room = getTaskRoomStub(taskId, env);
    await room.fetch(new Request('https://internal/event', {
      method: 'POST',
      body: JSON.stringify({
        type: 'task.event',
        event: {
          id: Date.now(),
          task_id: taskId,
          owner_id: task.owner_id,
          seq: 999999,
          kind: 'status',
          payload: { status: 'failed' },
          created_at: new Date().toISOString(),
        },
      }),
    }));
  } catch {}

  return jsonOk({ task: failed });
}

export async function handleCancelTask(
  taskId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await requireSession(request, env.DB);
  const repo = new TasksRepository(env.DB);
  const task = await repo.getById(taskId);

  if (!task || task.owner_id !== session.owner_id) {
    throw new NotFoundError('Task not found');
  }

  let reason: string | undefined;
  try {
    const raw = await request.json();
    const parsed = cancelTaskRequestSchema.safeParse(raw);
    if (parsed.success && parsed.data.reason) {
      reason = parsed.data.reason;
    }
  } catch {}

  const cancelled = cancelTask(task as any, { reason });

  await repo.updateStatus(taskId, 'cancelled', {
    finished_at: cancelled.finished_at,
    error: cancelled.error ?? undefined,
  });

  try {
    const room = getTaskRoomStub(taskId, env);
    await room.fetch(
      new Request('https://internal/event', {
        method: 'POST',
        body: JSON.stringify({
          type: 'task.event',
          event: {
            id: Date.now(),
            task_id: taskId,
            owner_id: task.owner_id,
            seq: 999999,
            kind: 'status',
            payload: { status: 'cancelled' },
            created_at: new Date().toISOString(),
          },
        }),
      }),
    );
  } catch {}

  return jsonOk({ task: cancelled });
}

