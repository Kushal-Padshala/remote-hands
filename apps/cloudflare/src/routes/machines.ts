import { requireOwnerSession } from '../auth/session.js';
import { MachinesRepository } from '../d1/machines-repository.js';
import { jsonOk } from '../http/json.js';
import type { Env } from '../env.js';

export async function handleListMachines(request: Request, env: Env): Promise<Response> {
  const session = await requireOwnerSession(request, env.DB);
  const repo = new MachinesRepository(env.DB);
  const machines = await repo.listByOwner(session.owner_id);
  return jsonOk({ machines });
}
