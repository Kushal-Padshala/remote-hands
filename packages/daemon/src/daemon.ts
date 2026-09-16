import type { TaskStatus } from '@remote-hands/shared';
import type { AgentRunner } from './agy-runner.js';
import type { DaemonConfig } from './config.js';
import type { RuntimeMetadata } from './runtime.js';
import type { TaskStore } from './task-store.js';

export interface RunDaemonOnceInput {
  userId: string;
  config: DaemonConfig;
  runtime: RuntimeMetadata;
  store: TaskStore;
  runner: AgentRunner;
}

export type RunDaemonOnceResult =
  | { claimed: false }
  | { claimed: true; taskId: string; status: Extract<TaskStatus, 'done' | 'failed'> };

export async function runDaemonOnce(input: RunDaemonOnceInput): Promise<RunDaemonOnceResult> {
  const machine = await input.store.registerMachine({
    userId: input.userId,
    name: input.config.machineName,
    hostname: input.runtime.hostname,
    agyVersion: input.runtime.agyVersion,
    daemonVersion: input.runtime.daemonVersion,
  });

  await input.store.heartbeat(machine.id);

  const claimed = await input.store.claimNextTask(machine.id);
  if (claimed === null) return { claimed: false };

  const running = await input.store.markTaskRunning(claimed.id);
  await input.store.appendEvent(running.id, { kind: 'status', payload: { status: 'running' } });

  try {
    const result = await input.runner.run(running);
    for (const event of result.events) {
      await input.store.appendEvent(running.id, event);
    }
    await input.store.completeTask(running.id, {
      summary: result.summary,
      conversationId: result.conversationId,
    });
    return { claimed: true, taskId: running.id, status: 'done' };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await input.store.appendEvent(running.id, {
      kind: 'error',
      payload: { message, fatal: true },
    });
    await input.store.failTask(running.id, { error: message });
    return { claimed: true, taskId: running.id, status: 'failed' };
  }
}

