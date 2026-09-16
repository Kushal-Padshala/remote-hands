import { requireOwnerSession, requireSession } from '../auth/session.js';
import { MachinesRepository } from '../d1/machines-repository.js';
import { ForbiddenError, NotFoundError } from '../http/errors.js';
import { jsonOk } from '../http/json.js';
import type { Env } from '../env.js';

export async function handleListMachines(request: Request, env: Env): Promise<Response> {
  const session = await requireOwnerSession(request, env.DB);
  const repo = new MachinesRepository(env.DB);
  const machines = await repo.listByOwner(session.owner_id);
  return jsonOk({ machines });
}

export async function handleGetMachine(machineId: string, request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  const repo = new MachinesRepository(env.DB);
  const machine = await repo.getById(machineId);
  if (!machine || machine.owner_id !== session.owner_id) {
    throw new NotFoundError('Machine not found');
  }
  return jsonOk({ machine });
}

export async function handleMachineHeartbeat(machineId: string, request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  if (session.kind === 'daemon' && session.machine_id !== machineId) {
    throw new ForbiddenError('Machine session mismatch');
  }

  const repo = new MachinesRepository(env.DB);
  const machine = await repo.getById(machineId);
  if (!machine || machine.owner_id !== session.owner_id) {
    throw new NotFoundError('Machine not found');
  }

  await repo.updateHeartbeat(machineId, new Date().toISOString());
  const updated = await repo.getById(machineId);
  return jsonOk({ machine: updated });
}
