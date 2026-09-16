import { describe, expect, it } from 'vitest';
import { appendEvent } from './event-service.js';

describe('event service append rules', () => {
  const now = new Date('2026-09-16T12:00:00.000Z');

  it('assigns seq 0 for the first event in a task', () => {
    const event = appendEvent([], {
      kind: 'agent_text',
      payload: { text: 'Hello' },
    }, {
      ownerId: 'owner-1',
      taskId: 'task-1',
    }, now);

    expect(event.seq).toBe(0);
    expect(event.owner_id).toBe('owner-1');
    expect(event.task_id).toBe('task-1');
    expect(event.kind).toBe('agent_text');
    expect(event.created_at).toBe(now.toISOString());
  });

  it('monotonically increments seq for subsequent events', () => {
    const history = [{ seq: 0 }, { seq: 1 }, { seq: 2 }];
    const event = appendEvent(history, {
      kind: 'status',
      payload: { status: 'running' },
    }, {
      ownerId: 'owner-1',
      taskId: 'task-1',
    }, now);

    expect(event.seq).toBe(3);
  });
});
