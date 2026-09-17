import { describe, expect, it } from 'vitest';
import type { Machine, Task } from '@remote-hands/shared';
import type { AgentRunner } from './agy-runner.js';
import { StaticAgentRunner } from './agy-runner.js';
import type { DaemonConfig } from './config.js';
import { runDaemonOnce } from './daemon.js';
import { MemoryTaskStore } from './memory-task-store.js';
import type { RuntimeMetadata } from './runtime.js';

const userId = '11111111-1111-4111-8111-111111111111';
const machineId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';

const config: DaemonConfig = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'anon-key',
  machineName: 'office-mac',
  agyCommand: 'agy',
  workspaceAllowlist: [],
  pollIntervalMs: 5_000,
  heartbeatIntervalMs: 15_000,
};

const runtime: RuntimeMetadata = {
  hostname: 'office.local',
  daemonVersion: '0.0.0',
  agyVersion: null,
};

function machine(): Machine {
  return {
    id: machineId,
    user_id: userId,
    name: config.machineName,
    hostname: runtime.hostname,
    agy_version: null,
    daemon_version: runtime.daemonVersion,
    status: 'offline',
    last_seen_at: null,
    created_at: '2026-09-16T14:00:00.000Z',
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
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

describe('runDaemonOnce', () => {
  it('heartbeats and returns without claiming when no queued task exists', async () => {
    const store = new MemoryTaskStore({
      machines: [machine()],
      now: () => new Date('2026-09-16T14:05:00.000Z'),
    });

    await expect(
      runDaemonOnce({
        userId,
        config,
        runtime,
        store,
        runner: new StaticAgentRunner({ events: [], summary: 'unused', conversationId: null }),
      }),
    ).resolves.toEqual({ claimed: false });
  });

  it('runs one queued task and marks it done with agent events', async () => {
    const store = new MemoryTaskStore({ machines: [machine()], tasks: [task()] });

    const result = await runDaemonOnce({
      userId,
      config,
      runtime,
      store,
      runner: new StaticAgentRunner({
        events: [{ kind: 'agent_text', payload: { text: 'Drafted the page' } }],
        summary: 'Published page',
        conversationId: 'conversation-1',
      }),
    });

    expect(result).toEqual({ claimed: true, taskId, status: 'done' });
    expect(store.taskById(taskId)?.status).toBe('done');
    expect(store.taskById(taskId)?.result_summary).toBe('Published page');
    expect(store.taskById(taskId)?.conversation_id).toBe('conversation-1');
    expect(store.eventsForTask(taskId).map((event) => event.kind)).toEqual(['status', 'agent_text', 'result', 'status']);
  });

  it('writes an error event and marks the task failed when the runner throws', async () => {
    const store = new MemoryTaskStore({ machines: [machine()], tasks: [task()] });
    const runner: AgentRunner = {
      async run() {
        throw new Error('agy failed');
      },
    };

    const result = await runDaemonOnce({ userId, config, runtime, store, runner });

    expect(result).toEqual({ claimed: true, taskId, status: 'failed' });
    expect(store.taskById(taskId)?.status).toBe('failed');
    expect(store.taskById(taskId)?.error).toBe('agy failed');
    expect(store.eventsForTask(taskId).map((event) => event.kind)).toContain('error');
  });
});

