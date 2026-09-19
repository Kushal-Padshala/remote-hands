import { describe, expect, it, vi } from 'vitest';
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

  it('skips heartbeat when heartbeatIntervalMs has not elapsed', async () => {
    const lastHeartbeatAtRef = { current: Date.now() - 5000 };
    const fakeM = machine();
    const mockStore = new MemoryTaskStore({ machines: [fakeM] });
    const heartbeatSpy = vi.spyOn(mockStore, 'heartbeat');

    await runDaemonOnce({
      userId,
      config: { ...config, heartbeatIntervalMs: 60000 },
      runtime,
      store: mockStore,
      runner: new StaticAgentRunner({ events: [], summary: 'unused', conversationId: null }),
      lastHeartbeatAtRef,
    });

    expect(heartbeatSpy).not.toHaveBeenCalled();
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

  it('marks task failed when the runner returns failed status', async () => {
    const store = new MemoryTaskStore({ machines: [machine()], tasks: [task()] });
    const runner = new StaticAgentRunner({
      events: [{ kind: 'error', payload: { message: 'Quota exceeded', fatal: true } }],
      summary: 'Quota exceeded',
      conversationId: null,
      status: 'failed',
    });

    const result = await runDaemonOnce({ userId, config, runtime, store, runner });

    expect(result).toEqual({ claimed: true, taskId, status: 'failed' });
    expect(store.taskById(taskId)?.status).toBe('failed');
    expect(store.taskById(taskId)?.error).toBe('Quota exceeded');
  });

  it('aborts and marks cancelled when task is cancelled during run', async () => {
    const store = new MemoryTaskStore({ machines: [machine()], tasks: [task()] });
    let runnerAborted = false;
    const runner: AgentRunner = {
      async run(_task, _onEvent, signal) {
        if (signal) {
          signal.addEventListener('abort', () => {
            runnerAborted = true;
          });
        }
        await store.cancelTask(taskId, 'User stopped task');
        await new Promise((resolve) => setTimeout(resolve, 1100));
        return { events: [], summary: 'Done', conversationId: null };
      },
    };

    const result = await runDaemonOnce({ userId, config, runtime, store, runner });

    expect(result).toEqual({ claimed: true, taskId, status: 'cancelled' });
    expect(runnerAborted).toBe(true);
  });

  it('does not stream frames for coding tasks', async () => {
    const store = new MemoryTaskStore({
      machines: [machine()],
      tasks: [task({ kind: 'coding' })],
    });
    const pushedFrames: any[] = [];
    const mockSource = {
      captureFrame: async () => ({
        jpegBase64: 'fake-frame',
        capturedAt: new Date().toISOString(),
      }),
    };

    await runDaemonOnce({
      userId,
      config,
      runtime,
      store,
      runner: new StaticAgentRunner({ events: [], summary: 'Done', conversationId: null }),
      frameSource: mockSource,
      onFrame: (f) => pushedFrames.push(f),
    });

    expect(pushedFrames.length).toBe(0);
  });

  it('ensures Chrome is running for browser tasks when chromeManager is provided', async () => {
    const store = new MemoryTaskStore({
      machines: [machine()],
      tasks: [task({ id: 'browser-task-1', prompt: 'Check https://github.com/pulls', kind: 'browser' })],
    });

    let ensureRunningCalled = false;
    const mockChrome = {
      ensureRunning: async () => {
        ensureRunningCalled = true;
        return { available: true, port: 9222, mode: 'dedicated' as const };
      },
      checkDebuggerStatus: async () => ({ available: true, port: 9222, mode: 'dedicated' as const }),
    };

    await runDaemonOnce({
      userId,
      config,
      runtime,
      store,
      runner: new StaticAgentRunner({ events: [], summary: 'Done', conversationId: null }),
      chromeManager: mockChrome as any,
    });

    expect(ensureRunningCalled).toBe(true);
  });

  it('rejects unsafe workspace path and marks task failed without executing', async () => {
    const store = new MemoryTaskStore({
      machines: [machine()],
      tasks: [task({ id: 'unsafe-task-1', workspace_path: '/etc/shadow' })],
    });

    let runnerExecuted = false;
    const runner: AgentRunner = {
      async run() {
        runnerExecuted = true;
        return { events: [], summary: 'Done', conversationId: null };
      },
    };

    const result = await runDaemonOnce({
      userId,
      config,
      runtime,
      store,
      runner,
    });

    expect(result).toEqual({ claimed: true, taskId: 'unsafe-task-1', status: 'failed' });
    expect(runnerExecuted).toBe(false);
    expect(store.taskById('unsafe-task-1')?.status).toBe('failed');
    expect(store.taskById('unsafe-task-1')?.error).toContain('forbidden');
  });

  it('handles multi-turn approval flow when user approves on mobile', async () => {
    const store = new MemoryTaskStore({
      machines: [machine()],
      tasks: [task({ id: 'approval-task-1', prompt: 'Post to X: Hello world' })],
    });

    const approvalId = 'appr-1111-2222';
    store.addApproval({
      id: approvalId,
      task_id: 'approval-task-1',
      owner_id: userId,
      action_kind: 'publish',
      summary: 'Post to X: Hello world',
      risk: 'high',
      tool_payload: {},
      frame_path: null,
      decision: 'pending',
      decided_at: null,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      created_at: new Date().toISOString(),
    });

    const receivedPrompts: string[] = [];
    let turnCount = 0;
    const runner: AgentRunner = {
      async run(t) {
        turnCount++;
        receivedPrompts.push(t.prompt);
        if (turnCount === 1) {
          setTimeout(() => {
            store.decideApproval(approvalId, 'approved').catch(() => {});
          }, 50);
          return {
            events: [{ kind: 'agent_text', payload: { text: 'Drafted post, waiting for approval' } }],
            summary: 'Drafted post',
            conversationId: 'conv-xyz',
          };
        }
        return {
          events: [{ kind: 'agent_text', payload: { text: 'Clicked post button and verified' } }],
          summary: 'Published post to X',
          conversationId: 'conv-xyz',
        };
      },
    };

    const result = await runDaemonOnce({
      userId,
      config,
      runtime,
      store,
      runner,
    });

    expect(result).toEqual({ claimed: true, taskId: 'approval-task-1', status: 'done' });
    expect(turnCount).toBe(2);
    expect(receivedPrompts[0]).toBe('Post to X: Hello world');
    expect(receivedPrompts[1]).toContain('[HUMAN APPROVAL GRANTED]');
    expect(receivedPrompts[1]).toContain('Post to X: Hello world');
    expect(store.taskById('approval-task-1')?.status).toBe('done');
    expect(store.taskById('approval-task-1')?.conversation_id).toBe('conv-xyz');

    const events = store.eventsForTask('approval-task-1');
    const statuses = events.filter((e) => e.kind === 'status').map((e) => (e.payload as any).status);
    expect(statuses).toContain('awaiting_approval');
    expect(statuses).toContain('running');
    expect(statuses).toContain('done');
  });

  it('handles multi-turn rejection flow when user rejects on mobile', async () => {
    const store = new MemoryTaskStore({
      machines: [machine()],
      tasks: [task({ id: 'rejection-task-1', prompt: 'Post to X: Buy crypto' })],
    });

    const approvalId = 'appr-reject-1';
    store.addApproval({
      id: approvalId,
      task_id: 'rejection-task-1',
      owner_id: userId,
      action_kind: 'publish',
      summary: 'Post to X: Buy crypto',
      risk: 'high',
      tool_payload: {},
      frame_path: null,
      decision: 'pending',
      decided_at: null,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      created_at: new Date().toISOString(),
    });

    const receivedPrompts: string[] = [];
    let turnCount = 0;
    const runner: AgentRunner = {
      async run(t) {
        turnCount++;
        receivedPrompts.push(t.prompt);
        if (turnCount === 1) {
          setTimeout(() => {
            store.decideApproval(approvalId, 'rejected', 'Never post about crypto').catch(() => {});
          }, 50);
          return {
            events: [],
            summary: 'Awaiting approval',
            conversationId: 'conv-crypto',
          };
        }
        return {
          events: [],
          summary: 'Task adjusted per rejection feedback',
          conversationId: 'conv-crypto',
        };
      },
    };

    const result = await runDaemonOnce({
      userId,
      config,
      runtime,
      store,
      runner,
    });

    expect(result).toEqual({ claimed: true, taskId: 'rejection-task-1', status: 'done' });
    expect(turnCount).toBe(2);
    expect(receivedPrompts[1]).toContain('[HUMAN APPROVAL REJECTED]');
    expect(receivedPrompts[1]).toContain('Never post about crypto');
  });

  it('fails task when pending approval times out without decision', async () => {
    const store = new MemoryTaskStore({
      machines: [machine()],
      tasks: [task({ id: 'timeout-task-1', prompt: 'Post to X' })],
    });

    const approvalId = 'appr-timeout-1';
    store.addApproval({
      id: approvalId,
      task_id: 'timeout-task-1',
      owner_id: userId,
      action_kind: 'publish',
      summary: 'Post to X',
      risk: 'high',
      tool_payload: {},
      frame_path: null,
      decision: 'pending',
      decided_at: null,
      expires_at: new Date(Date.now() + 100).toISOString(),
      created_at: new Date().toISOString(),
      timeout_ms: 50,
    } as any);

    const runner: AgentRunner = {
      async run() {
        return {
          events: [],
          summary: 'Drafted',
          conversationId: 'conv-to',
        };
      },
    };

    const result = await runDaemonOnce({
      userId,
      config,
      runtime,
      store,
      runner,
    });

    expect(result).toEqual({ claimed: true, taskId: 'timeout-task-1', status: 'failed' });
    expect(store.taskById('timeout-task-1')?.status).toBe('failed');
    expect(store.taskById('timeout-task-1')?.error).toContain('timed out');
  });
});


