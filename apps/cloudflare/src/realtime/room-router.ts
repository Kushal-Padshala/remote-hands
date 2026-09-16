import type { Env, DurableObjectStub } from '../env.js';

export function getTaskRoomStub(taskId: string, env: Env): DurableObjectStub {
  const id = env.TASK_ROOM.idFromName(`task:${taskId}`);
  return env.TASK_ROOM.get(id);
}

export function getMachineRoomStub(machineId: string, env: Env): DurableObjectStub {
  const id = env.TASK_ROOM.idFromName(`machine:${machineId}`);
  return env.TASK_ROOM.get(id);
}
