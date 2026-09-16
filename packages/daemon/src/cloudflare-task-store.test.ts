import { describe, expect, it, vi } from 'vitest';
import type { TaskRow, MachineRow, TaskEventRow } from '@remote-hands/shared';
import { CloudflareControlPlaneClient } from './cloudflare-client.js';
import { CloudflareTaskStore } from './cloudflare-task-store.js';

describe('CloudflareTaskStore', () => {
  const machineId = '11111111-1111-4111-8111-111111111111';
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const taskId = '33333333-3333-4333-8333-333333333333';

  const fakeMachineRow: MachineRow = {
    id: machineId,
    owner_id: ownerId,
    name: 'test-mac',
    hostname: 'test.local',
    daemon_version: '0.1.0',
    agy_version: '0.2.0',
    status: 'online',
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  const fakeTaskRow: TaskRow = {
    id: taskId,
    owner_id: ownerId,
    machine_id: machineId,
    prompt: 'Do something',
    kind: 'browser',
    workspace_path: '/tmp',
    model: 'claude-3-7-sonnet',
    effort: 'high',
    mode: 'default',
    status: 'claimed',
    conversation_id: null,
    parent_task_id: null,
    result_summary: null,
    error: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
  };

  function createMockClient(): CloudflareControlPlaneClient {
    return {
      heartbeat: vi.fn(async () => fakeMachineRow),
      claimNextTask: vi.fn(async () => fakeTaskRow),
      markTaskRunning: vi.fn(async () => ({ ...fakeTaskRow, status: 'running' as const })),
      appendEvent: vi.fn(async (_tId, input) => {
        const row: TaskEventRow = {
          id: 1,
          task_id: taskId,
          owner_id: ownerId,
          seq: 0,
          kind: input.kind,
          payload: input.payload,
          created_at: new Date().toISOString(),
        };
        return row;
      }),
      completeTask: vi.fn(async (_tId, input) => ({
        ...fakeTaskRow,
        status: 'done' as const,
        result_summary: input.summary,
        conversation_id: input.conversation_id ?? null,
      })),
      failTask: vi.fn(async (_tId, input) => ({
        ...fakeTaskRow,
        status: 'failed' as const,
        error: input.error,
      })),
    } as unknown as CloudflareControlPlaneClient;
  }

  it('registers machine and heartbeats through client', async () => {
    const client = createMockClient();
    const store = new CloudflareTaskStore({ client, machineId });

    const machine = await store.registerMachine({
      userId: ownerId,
      name: 'test-mac',
      hostname: 'test.local',
      agyVersion: '0.2.0',
      daemonVersion: '0.1.0',
    });

    expect(client.heartbeat).toHaveBeenCalledWith(machineId);
    expect(machine.id).toBe(machineId);
    expect(machine.user_id).toBe(ownerId);
    expect(machine.name).toBe('test-mac');

    await store.heartbeat(machineId);
    expect(client.heartbeat).toHaveBeenCalledTimes(2);
  });

  it('claims next task and maps TaskRow to Task', async () => {
    const client = createMockClient();
    const store = new CloudflareTaskStore({ client, machineId });

    const task = await store.claimNextTask(machineId);
    expect(client.claimNextTask).toHaveBeenCalledWith(machineId);
    expect(task).not.toBeNull();
    expect(task?.id).toBe(taskId);
    expect(task?.user_id).toBe(ownerId);
    expect(task?.status).toBe('claimed');
  });

  it('marks task running', async () => {
    const client = createMockClient();
    const store = new CloudflareTaskStore({ client, machineId });

    const running = await store.markTaskRunning(taskId);
    expect(client.markTaskRunning).toHaveBeenCalledWith(taskId);
    expect(running.status).toBe('running');
  });

  it('appends event and maps TaskEventRow to TaskEvent', async () => {
    const client = createMockClient();
    const store = new CloudflareTaskStore({ client, machineId });

    const event = await store.appendEvent(taskId, {
      kind: 'agent_text',
      payload: { text: 'Working on it' },
    });

    expect(client.appendEvent).toHaveBeenCalledWith(taskId, {
      kind: 'agent_text',
      payload: { text: 'Working on it' },
    });
    expect(event.kind).toBe('agent_text');
    expect(event.user_id).toBe(ownerId);
    expect(event.task_id).toBe(taskId);
  });

  it('completes and fails task', async () => {
    const client = createMockClient();
    const store = new CloudflareTaskStore({ client, machineId });

    const completed = await store.completeTask(taskId, {
      summary: 'Task finished',
      conversationId: 'conv-123',
    });
    expect(client.completeTask).toHaveBeenCalledWith(taskId, {
      summary: 'Task finished',
      conversation_id: 'conv-123',
    });
    expect(completed.status).toBe('done');

    const failed = await store.failTask(taskId, { error: 'Something crashed' });
    expect(client.failTask).toHaveBeenCalledWith(taskId, { error: 'Something crashed' });
    expect(failed.status).toBe('failed');
  });
});
