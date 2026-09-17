import { requireSession } from '../auth/session.js';
import { TasksRepository } from '../d1/tasks-repository.js';
import { getTaskRoomStub } from '../realtime/room-router.js';
import { NotFoundError } from '../http/errors.js';
import { jsonOk, jsonError } from '../http/json.js';
import type { Env } from '../env.js';

export async function handlePushFrame(taskId: string, request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  const tasksRepo = new TasksRepository(env.DB);
  const task = await tasksRepo.getById(taskId);

  if (!task || task.owner_id !== session.owner_id) {
    throw new NotFoundError('Task not found');
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const jpegBase64 = body?.jpeg_base64;
  if (!jpegBase64 || typeof jpegBase64 !== 'string') {
    return jsonError('Missing jpeg_base64', 400);
  }

  const capturedAt = typeof body?.captured_at === 'string' ? body.captured_at : new Date().toISOString();

  try {
    const room = getTaskRoomStub(taskId, env);
    await room.fetch(new Request('https://internal/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'task.frame',
        task_id: taskId,
        jpeg_base64: jpegBase64,
        captured_at: capturedAt,
      }),
    }));
  } catch {}

  return jsonOk({ ok: true });
}
