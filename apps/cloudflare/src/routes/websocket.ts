import { requireSession } from '../auth/session.js';
import { TasksRepository } from '../d1/tasks-repository.js';
import { MachinesRepository } from '../d1/machines-repository.js';
import { getTaskRoomStub, getMachineRoomStub } from '../realtime/room-router.js';
import { ForbiddenError, NotFoundError } from '../http/errors.js';
import type { Env } from '../env.js';

export async function handleTaskWebSocket(
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

  const stub = getTaskRoomStub(taskId, env);
  return await stub.fetch(request);
}

export async function handleMachineWebSocket(
  machineId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await requireSession(request, env.DB);
  if (session.kind === 'daemon' && session.machine_id !== machineId) {
    throw new ForbiddenError('Machine session mismatch');
  }

  const machinesRepo = new MachinesRepository(env.DB);
  const machine = await machinesRepo.getById(machineId);

  if (!machine || machine.owner_id !== session.owner_id) {
    throw new NotFoundError('Machine not found');
  }

  const stub = getMachineRoomStub(machineId, env);
  return await stub.fetch(request);
}
