import { describe, expect, it } from 'vitest';
import {
  createTask,
  claimTask,
  transitionTask,
  completeTask,
  failTask,
  cancelTask,
} from './task-service.js';

describe('task service lifecycle rules', () => {
  const now = new Date('2026-09-16T12:00:00.000Z');

  it('creates a task in queued status with defaults', () => {
    const task = createTask({
      ownerId: 'owner-1',
      machineId: 'machine-1',
      prompt: 'Do something',
    }, now);

    expect(task.status).toBe('queued');
    expect(task.owner_id).toBe('owner-1');
    expect(task.machine_id).toBe('machine-1');
    expect(task.kind).toBe('browser');
    expect(task.mode).toBe('default');
    expect(task.created_at).toBe(now.toISOString());
  });

  it('claims a queued task onto the target machine', () => {
    const task = createTask({
      ownerId: 'owner-1',
      machineId: 'machine-1',
      prompt: 'Do something',
    }, now);

    const claimed = claimTask(task, 'machine-1', new Date('2026-09-16T12:01:00.000Z'));
    expect(claimed.status).toBe('claimed');
    expect(claimed.started_at).toBe('2026-09-16T12:01:00.000Z');
  });

  it('rejects claim for wrong machine or non-queued status', () => {
    const task = createTask({
      ownerId: 'owner-1',
      machineId: 'machine-1',
      prompt: 'Do something',
    }, now);

    expect(() => claimTask(task, 'other-machine', now)).toThrow(/machine mismatch/i);

    const claimed = claimTask(task, 'machine-1', now);
    expect(() => claimTask(claimed, 'machine-1', now)).toThrow(/cannot transition/i);
  });

  it('transitions through running and completes task', () => {
    const task = createTask({
      ownerId: 'owner-1',
      machineId: 'machine-1',
      prompt: 'Do something',
    }, now);
    const claimed = claimTask(task, 'machine-1', now);
    const running = transitionTask(claimed, 'running');
    expect(running.status).toBe('running');

    const completed = completeTask(running, {
      summary: 'Done successfully',
      conversationId: 'conv-1',
    }, new Date('2026-09-16T12:05:00.000Z'));

    expect(completed.status).toBe('done');
    expect(completed.result_summary).toBe('Done successfully');
    expect(completed.conversation_id).toBe('conv-1');
    expect(completed.finished_at).toBe('2026-09-16T12:05:00.000Z');
  });

  it('fails running task', () => {
    const task = createTask({
      ownerId: 'owner-1',
      machineId: 'machine-1',
      prompt: 'Do something',
    }, now);
    const claimed = claimTask(task, 'machine-1', now);
    const running = transitionTask(claimed, 'running');

    const failed = failTask(running, { error: 'Something crashed' }, now);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Something crashed');
    expect(failed.finished_at).toBe(now.toISOString());
  });

  it('cancels running task', () => {
    const task = createTask({
      ownerId: 'owner-1',
      machineId: 'machine-1',
      prompt: 'Do something',
    }, now);
    const claimed = claimTask(task, 'machine-1', now);
    const running = transitionTask(claimed, 'running');

    const cancelled = cancelTask(running, { reason: 'User cancelled' }, now);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.error).toBe('User cancelled');
    expect(cancelled.finished_at).toBe(now.toISOString());
  });
});

