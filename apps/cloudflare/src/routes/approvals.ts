import {
  createApprovalRequestSchema,
  decideApprovalRequestSchema,
} from '@remote-hands/shared';
import {
  createApproval,
  decideApproval,
} from '@remote-hands/control-plane';
import { requireOwnerSession, requireSession } from '../auth/session.js';
import { TasksRepository } from '../d1/tasks-repository.js';
import { ApprovalsRepository } from '../d1/approvals-repository.js';
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

  const decided = decideApproval(approval, body.decision);
  await approvalsRepo.updateDecision(approvalId, decided.decision, decided.decided_at!);

  try {
    const room = getTaskRoomStub(approval.task_id, env);
    await room.fetch(new Request('https://internal/event', {
      method: 'POST',
      body: JSON.stringify({
        type: 'approval.decided',
        approval_id: approvalId,
        decision: decided.decision,
      }),
    }));
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

  return jsonOk({ approvals });
}
