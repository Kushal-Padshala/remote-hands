import type { EventInput, TaskEventRow } from '@remote-hands/shared';

export interface EventTarget {
  ownerId: string;
  taskId: string;
}

export function appendEvent(
  existingEvents: Array<{ seq: number }>,
  input: EventInput,
  target: EventTarget,
  now: Date = new Date(),
): TaskEventRow {
  const nextSeq = existingEvents.length === 0
    ? 0
    : Math.max(...existingEvents.map((e) => e.seq)) + 1;

  return {
    id: nextSeq + 1,
    task_id: target.taskId,
    owner_id: target.ownerId,
    seq: nextSeq,
    kind: input.kind,
    payload: input.payload,
    created_at: now.toISOString(),
  };
}
