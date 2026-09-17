import type { TaskStatus } from '@remote-hands/shared';
import type { AgentRunner } from './agy-runner.js';
import type { DaemonConfig } from './config.js';
import type { RuntimeMetadata } from './runtime.js';
import type { TaskStore } from './task-store.js';
import type { BrowserFrame, FrameSource } from './frame-stream.js';
import { ThrottledFrameStream } from './frame-stream.js';
import { DefaultFrameSource } from './screen-capture.js';

export interface RunDaemonOnceInput {
  userId: string;
  config: DaemonConfig;
  runtime: RuntimeMetadata;
  store: TaskStore;
  runner: AgentRunner;
  onFrame?: ((frame: BrowserFrame) => Promise<void> | void) | undefined;
  frameSource?: FrameSource | undefined;
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

  const frameStream = new ThrottledFrameStream({
    source: input.frameSource ?? new DefaultFrameSource(),
    minIntervalMs: 2000,
    onFrame: (frame) => {
      try {
        if (input.onFrame) {
          input.onFrame(frame);
        }
        if (input.store.pushFrame) {
          input.store.pushFrame(running.id, frame).catch(() => {});
        }
      } catch {}
    },
  });

  frameStream.start(2000);

  try {
    let streamedCount = 0;
    const result = await input.runner.run(running, async (event) => {
      try {
        streamedCount++;
        await input.store.appendEvent(running.id, event);
      } catch {}
    });
    if (streamedCount === 0 && result.events) {
      for (const event of result.events) {
        await input.store.appendEvent(running.id, event);
      }
    }
    const hasResultEvent = result.events.some((e) => e.kind === 'result');
    if (!hasResultEvent) {
      await input.store.appendEvent(running.id, {
        kind: 'result',
        payload: {
          summary: result.summary,
          conversation_id: result.conversationId ?? undefined,
          duration_seconds: result.durationSeconds,
        },
      });
    }
    const hasFatalError = result.events.some((e) => e.kind === 'error' && (e.payload as any)?.fatal);
    const isFailed = result.status === 'failed' || hasFatalError;
    const finalStatus = isFailed ? 'failed' : 'done';

    await input.store.appendEvent(running.id, { kind: 'status', payload: { status: finalStatus } });
    if (isFailed) {
      await input.store.failTask(running.id, {
        error: result.summary || 'Task failed',
      });
    } else {
      await input.store.completeTask(running.id, {
        summary: result.summary,
        conversationId: result.conversationId,
      });
    }
    return { claimed: true, taskId: running.id, status: finalStatus };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await input.store.appendEvent(running.id, {
      kind: 'error',
      payload: { message, fatal: true },
    });
    await input.store.failTask(running.id, { error: message });
    return { claimed: true, taskId: running.id, status: 'failed' };
  } finally {
    frameStream.stop();
  }
}

