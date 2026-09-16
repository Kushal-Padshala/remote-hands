import { describe, expect, it } from 'vitest';
import type { Task } from '@remote-hands/shared';
import { MemoryTaskStore } from './memory-task-store.js';

const userId = '11111111-1111-4111-8111-111111111111';
const machineId = '22222222-2222-4222-8222-222222222222';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    user_id: userId,
    machine_id: machineId,
    prompt: 'Add a privacy policy page',
    kind: 'browser',
    workspace_path: null,
    model: null,
    effort: null,
    mode: 'default',
    status: 'queued',
    conversation_id: null,
    parent_task_id: null,
    result_summary: null,
    error: null,
    created_at: '2026-09-16T14:00:00.000Z',
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

describe('MemoryTaskStore', () => {
  it('heartbeats a registered machine online with the current timestamp', async () => {
    const store = new MemoryTaskStore({ now: () => new Date('2026-09-16T14:01:00.000Z') });
    const machine = await store.registerMachine({
      userId,
      name: 'office-mac',
      hostname: 'office.local',
      agyVersion: null,
      daemonVersion: '0.0.0',
    });

    const heartbeat = await store.heartbeat(machine.id);

    expect(heartbeat.status).toBe('online');
    expect(heartbeat.last_seen_at).toBe('2026-09-16T14:01:00.000Z');
  });

  it('claims the oldest queued task for the machine', async () => {
    const store = new MemoryTaskStore({
      tasks: [
        task({ id: '44444444-4444-4444-8444-444444444444', created_at: '2026-09-16T14:02:00.000Z' }),
        task({ id: '55555555-5555-4555-8555-555555555555', created_at: '2026-09-16T14:01:00.000Z' }),
      ],
    });

    const claimed = await store.claimNextTask(machineId);

    expect(claimed?.id).toBe('55555555-5555-4555-8555-555555555555');
    expect(claimed?.status).toBe('claimed');
  });

  it('assigns per-task event sequence numbers starting at zero', async () => {
    const store = new MemoryTaskStore({ tasks: [task()] });

    const first = await store.appendEvent(task().id, {
      kind: 'status',
      payload: { status: 'running' },
    });
    const second = await store.appendEvent(task().id, {
      kind: 'agent_text',
      payload: { text: 'Working on it' },
    });

    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(store.eventsForTask(task().id).map((event) => event.seq)).toEqual([0, 1]);
  });

  it('marks tasks done or failed with terminal metadata', async () => {
    const store = new MemoryTaskStore({
      now: () => new Date('2026-09-16T14:03:00.000Z'),
      tasks: [task()],
    });

    const done = await store.completeTask(task().id, {
      summary: 'Published page',
      conversationId: 'conversation-1',
    });
    expect(done.status).toBe('done');
    expect(done.result_summary).toBe('Published page');
    expect(done.conversation_id).toBe('conversation-1');
    expect(done.finished_at).toBe('2026-09-16T14:03:00.000Z');

    const failedTask = task({ id: '66666666-6666-4666-8666-666666666666' });
    const failingStore = new MemoryTaskStore({ tasks: [failedTask] });
    const failed = await failingStore.failTask(failedTask.id, { error: 'agy failed' });

    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('agy failed');
  });
});

