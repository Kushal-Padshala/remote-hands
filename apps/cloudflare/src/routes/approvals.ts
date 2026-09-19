import {
  createApprovalRequestSchema,
  decideApprovalRequestSchema,
} from '@remote-hands/shared';
import {
  createApproval,
  decideApproval,
  appendEvent,
} from '@remote-hands/control-plane';
import { requireOwnerSession, requireSession } from '../auth/session.js';
import { TasksRepository } from '../d1/tasks-repository.js';
import { ApprovalsRepository } from '../d1/approvals-repository.js';
import { EventsRepository } from '../d1/events-repository.js';
import { NotFoundError } from '../http/errors.js';
import { jsonOk } from '../http/json.js';
import type { Env } from '../env.js';

import { getTaskRoomStub } from '../realtime/room-router.js';

export async function handleCreateApproval(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  const body = createApprovalRequestSchema.parse(await request.json());

  const tasksRepo = new TasksRepository(env.DB);
  const task = await tasksRepo.getById(body.task_id);

  if (!task || task.owner_id !== session.owner_id) {
    throw new NotFoundError('Task not found');
  }

  const approval = createApproval({
    ownerId: session.owner_id,
    taskId: body.task_id,
    actionKind: body.action_kind,
    summary: body.summary,
    risk: body.risk,
    toolPayload: body.tool_payload,
    framePath: body.frame_path,
    timeoutMs: body.timeout_ms,
  });

  const approvalsRepo = new ApprovalsRepository(env.DB);
  await approvalsRepo.create(approval);
  await tasksRepo.updateStatus(body.task_id, 'awaiting_approval');

  try {
    const room = getTaskRoomStub(body.task_id, env);
    await room.fetch(new Request('https://internal/event', {
      method: 'POST',
      body: JSON.stringify({
        type: 'approval.requested',
        task_id: body.task_id,
        approval_id: approval.id,
        summary: approval.summary,
        action_kind: approval.action_kind,
        risk: approval.risk,
        frame_base64: approval.frame_path || undefined,
      }),
    }));
    await room.fetch(new Request('https://internal/event', {
      method: 'POST',
      body: JSON.stringify({
        type: 'task.event',
        event: {
          id: Date.now(),
          task_id: body.task_id,
          owner_id: task.owner_id,
          seq: 999990,
          kind: 'status',
          payload: { status: 'awaiting_approval' },
          created_at: new Date().toISOString(),
        },
      }),
    }));
  } catch {}

  return jsonOk({ approval }, 201);
}

export async function handleDecideApproval(
  approvalId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await requireOwnerSession(request, env.DB);
  const body = decideApprovalRequestSchema.parse(await request.json());

  const approvalsRepo = new ApprovalsRepository(env.DB);
  const approval = await approvalsRepo.getById(approvalId);

  if (!approval || approval.owner_id !== session.owner_id) {
    throw new NotFoundError('Approval not found');
  }

  const decided = decideApproval(approval, body.decision, body.reason);
  await approvalsRepo.updateDecision(approvalId, decided.decision, decided.decided_at!, body.reason);

  const tasksRepo = new TasksRepository(env.DB);
  await tasksRepo.updateStatus(approval.task_id, 'running');

  try {
    const room = getTaskRoomStub(approval.task_id, env);
    await room.fetch(new Request('https://internal/event', {
      method: 'POST',
      body: JSON.stringify({
        type: 'approval.decided',
        approval_id: approvalId,
        decision: decided.decision,
        reason: body.reason || undefined,
      }),
    }));
    await room.fetch(new Request('https://internal/event', {
      method: 'POST',
      body: JSON.stringify({
        type: 'task.event',
        event: {
          id: Date.now(),
          task_id: approval.task_id,
          owner_id: session.owner_id,
          seq: 999991,
          kind: 'status',
          payload: { status: 'running' },
          created_at: new Date().toISOString(),
        },
      }),
    }));

    if (body.decision === 'rejected' && body.reason) {
      const eventsRepo = new EventsRepository(env.DB);
      const existingEvents = await eventsRepo.listForTask(approval.task_id);
      const eventRow = appendEvent(
        existingEvents,
        {
          kind: 'approval_rejected',
          payload: {
            approval_id: approvalId,
            action_kind: approval.action_kind,
            summary: approval.summary,
            reason: body.reason,
          },
        },
        {
          ownerId: session.owner_id,
          taskId: approval.task_id,
        },
      );
      await eventsRepo.append(eventRow);
      await room.fetch(new Request('https://internal/event', {
        method: 'POST',
        body: JSON.stringify({
          type: 'task.event',
          event: eventRow,
        }),
      }));
    }
  } catch {}

  return jsonOk({ approval: decided });
}

export async function handleGetApproval(
  approvalId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await requireSession(request, env.DB);
  const approvalsRepo = new ApprovalsRepository(env.DB);
  const approval = await approvalsRepo.getById(approvalId);

  if (!approval || approval.owner_id !== session.owner_id) {
    throw new NotFoundError('Approval not found');
  }

  if (approval.decision === 'pending' && Date.now() > Date.parse(approval.expires_at)) {
    return jsonOk({ approval: { ...approval, decision: 'expired' } });
  }

  return jsonOk({ approval });
}

export async function handleListTaskApprovals(
  taskId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await requireSession(request, env.DB);
  const tasksRepo = new TasksRepository(env.DB);
  const task = await tasksRepo.getById(taskId);

  if (!task || task.owner_id !== session.owner_id) {
    throw new NotFoundError('Task not found');
  }

  const approvalsRepo = new ApprovalsRepository(env.DB);
  const approvals = await approvalsRepo.listByTask(taskId);
  const now = Date.now();
  const evaluated = approvals.map((a) => {
    if (a.decision === 'pending' && now > Date.parse(a.expires_at)) {
      return { ...a, decision: 'expired' as const };
    }
    return a;
  });

  return jsonOk({ approvals: evaluated });
}
