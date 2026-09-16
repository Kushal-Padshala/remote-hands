import { appendEventRequestSchema } from '@remote-hands/shared';
import { appendEvent } from '@remote-hands/control-plane';
import { requireSession } from '../auth/session.js';
import { TasksRepository } from '../d1/tasks-repository.js';
import { EventsRepository } from '../d1/events-repository.js';
import { NotFoundError } from '../http/errors.js';
import { jsonOk } from '../http/json.js';
import type { Env } from '../env.js';

export async function handleListEvents(taskId: string, request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  const tasksRepo = new TasksRepository(env.DB);
  const task = await tasksRepo.getById(taskId);

  if (!task || task.owner_id !== session.owner_id) {
    throw new NotFoundError('Task not found');
  }

  const eventsRepo = new EventsRepository(env.DB);
  const events = await eventsRepo.listForTask(taskId);
  return jsonOk({ events });
}

export async function handleAppendEvent(taskId: string, request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env.DB);
  const tasksRepo = new TasksRepository(env.DB);
  const task = await tasksRepo.getById(taskId);

  if (!task || task.owner_id !== session.owner_id) {
    throw new NotFoundError('Task not found');
  }

  const eventInput = appendEventRequestSchema.parse(await request.json());
  const eventsRepo = new EventsRepository(env.DB);
  const existingEvents = await eventsRepo.listForTask(taskId);

  const eventRow = appendEvent(
    existingEvents,
    eventInput,
    {
      ownerId: session.owner_id,
      taskId,
    },
  );

  await eventsRepo.append(eventRow);
  return jsonOk({ event: eventRow }, 201);
}
