import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LocalTaskStore } from './local-task-store.js';

describe('LocalTaskStore', () => {
  let tempDir: string;
  let store: LocalTaskStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-local-store-test-'));
    store = new LocalTaskStore({ dbPath: path.join(tempDir, 'test.db') });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates and retrieves a task', async () => {
    const task = await store.createTask({
      goal: 'Test desktop goal',
      workspacePath: os.homedir(),
    });
    expect(task.id).toBeDefined();
    expect(task.status).toBe('queued');
    expect(task.goal).toBe('Test desktop goal');

    const fetched = await store.getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(task.id);
  });

  it('claims next queued task and updates status', async () => {
    const task = await store.createTask({
      goal: 'Task to claim',
      workspacePath: os.homedir(),
    });
    const claimed = await store.claimNextTask('machine-local');
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.status).toBe('claimed');

    await store.updateTaskStatus(task.id, 'running');
    const updated = await store.getTask(task.id);
    expect(updated?.status).toBe('running');
  });

  it('records events and handles approval flow', async () => {
    const task = await store.createTask({
      goal: 'Approval task',
      workspacePath: os.homedir(),
    });
    await store.recordEvent(task.id, {
      type: 'text',
      text: 'Starting desktop run',
    });

    const events = await store.getEvents(task.id);
    expect(events.length).toBe(1);
    expect(events[0]?.text).toBe('Starting desktop run');

    const approval = await store.createApproval(task.id, {
      summary: 'Click Publish Button',
      action: 'publish',
      risk: 'high',
    });
    expect(approval.status).toBe('pending');

    await store.resolveApproval(approval.id, 'approved');
    const resolved = await store.getApproval(approval.id);
    expect(resolved?.status).toBe('approved');
  });

  it('handles machine lifecycle', async () => {
    const machine = await store.registerMachine({
      userId: 'user-1',
      name: 'mac-studio',
      hostname: 'studio.local',
      agyVersion: '1.0.0',
      daemonVersion: '0.1.0',
    });
    expect(machine.id).toBeDefined();
    expect(machine.status).toBe('offline');

    const heartbeat = await store.heartbeat(machine.id);
    expect(heartbeat.status).toBe('online');
    expect(heartbeat.last_seen_at).not.toBeNull();

    const fetchedMachine = await store.getMachine();
    expect(fetchedMachine.id).toBe(machine.id);
  });

  it('handles task completions, failures, and cancellations', async () => {
    const task = await store.createTask({
      prompt: 'Work unit',
      workspacePath: os.homedir(),
    });

    const running = await store.markTaskRunning(task.id);
    expect(running.status).toBe('running');
    expect(running.started_at).not.toBeNull();

    const awaiting = await store.markTaskAwaitingApproval(task.id);
    expect(awaiting.status).toBe('awaiting_approval');

    const completed = await store.completeTask(task.id, {
      summary: 'Completed successfully',
      conversationId: 'conv-123',
    });
    expect(completed.status).toBe('done');
    expect(completed.result_summary).toBe('Completed successfully');
    expect(completed.conversation_id).toBe('conv-123');

    const failedTask = await store.createTask({
      prompt: 'Will fail',
    });
    const failed = await store.failTask(failedTask.id, { error: 'Fatal failure' });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Fatal failure');

    const cancelTask = await store.createTask({
      prompt: 'Will cancel',
    });
    const cancelled = await store.cancelTask(cancelTask.id, 'Cancelled by user');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.error).toBe('Cancelled by user');
  });

  it('appends structured typed events', async () => {
    const task = await store.createTask({
      prompt: 'Structured task',
    });

    const event = await store.appendEvent(task.id, {
      kind: 'agent_text',
      payload: { text: 'Hello from agent' },
    });
    expect(event.id).toBeGreaterThan(0);
    expect(event.seq).toBe(0);
    expect(event.kind).toBe('agent_text');
    expect(event.payload.text).toBe('Hello from agent');

    const events = await store.getEvents(task.id);
    expect(events.length).toBe(1);
  });

  it('manages approvals listing, decisions, and waiting', async () => {
    const task = await store.createTask({
      prompt: 'Approval waiting task',
    });

    const approval = await store.createApproval(task.id, {
      summary: 'Run dangerous command',
      action: 'shell',
      risk: 'high',
    });

    const pending = await store.getPendingApproval(task.id);
    expect(pending).not.toBeNull();
    expect(pending?.id).toBe(approval.id);

    const list = await store.listApprovals(task.id);
    expect(list.length).toBe(1);

    const decisionPromise = store.waitForApprovalDecision(approval.id);
    await store.decideApproval(approval.id, 'approved');
    const decision = await decisionPromise;
    expect(decision.decision).toBe('approved');

    const afterDecisionPending = await store.getPendingApproval(task.id);
    expect(afterDecisionPending).toBeNull();
  });

  it('supports in-memory store and frame saving and retrieval', async () => {
    const memoryStore = new LocalTaskStore({ dbPath: ':memory:' });
    const task = await memoryStore.createTask({ goal: 'Memory task' });
    expect(task.id).toBeDefined();

    const empty = await memoryStore.getLatestFrame(task.id);
    expect(empty).toBeNull();

    await memoryStore.pushFrame(task.id, {
      jpegBase64: 'fake-frame-data',
      capturedAt: '2026-09-22T19:00:00.000Z',
    });

    const latest = await memoryStore.getLatestFrame(task.id);
    expect(latest).not.toBeNull();
    expect(latest?.jpegBase64).toBe('fake-frame-data');
    expect(latest?.capturedAt).toBe('2026-09-22T19:00:00.000Z');

    memoryStore.close();
  });
});
