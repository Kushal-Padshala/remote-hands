import { isSafeWorkspacePath, type TaskStatus } from '@remote-hands/shared';
import type { AgentRunner } from './agy-runner.js';
import type { DaemonConfig } from './config.js';
import type { RuntimeMetadata } from './runtime.js';
import type { TaskStore } from './task-store.js';
import type { BrowserFrame, FrameSource } from './frame-stream.js';
import { ThrottledFrameStream } from './frame-stream.js';
import { DefaultFrameSource, cleanupStaleFrameFiles } from './screen-capture.js';
import type { ChromeManager } from './chrome-manager.js';

export interface RunDaemonOnceInput {
  userId: string;
  config: DaemonConfig;
  runtime: RuntimeMetadata;
  store: TaskStore;
  runner: AgentRunner;
  onFrame?: ((frame: BrowserFrame) => Promise<void> | void) | undefined;
  frameSource?: FrameSource | undefined;
  chromeManager?: ChromeManager | undefined;
}

export type RunDaemonOnceResult =
  | { claimed: false }
  | { claimed: true; taskId: string; status: Extract<TaskStatus, 'done' | 'failed' | 'cancelled'> };

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

  if (running.workspace_path) {
    const check = isSafeWorkspacePath(running.workspace_path, input.config.workspaceAllowlist);
    if (!check.allowed) {
      const error = check.reason || 'Workspace path rejected by security policy';
      await input.store.appendEvent(running.id, {
        kind: 'error',
        payload: { message: error, fatal: true },
      });
      await input.store.failTask(running.id, { error });
      return { claimed: true, taskId: running.id, status: 'failed' };
    }
  }

  const taskStartTime = Date.now();
  cleanupStaleFrameFiles(taskStartTime);

  const isBrowserKind = running.kind === 'browser';
  if (isBrowserKind || running.prompt.includes('http://') || running.prompt.includes('https://')) {
    if (input.chromeManager) {
      await input.chromeManager.ensureRunning().catch(() => {});
    }
  }
  const canCaptureFrames = true;

  let frameStream: ThrottledFrameStream | null = null;
  const frameSource = input.frameSource ?? new DefaultFrameSource({
    taskStartTime,
    browserActive: false,
  });

  if (canCaptureFrames) {
    frameStream = new ThrottledFrameStream({
      source: frameSource,
      minIntervalMs: 1000,
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

    if (isBrowserKind) {
      if (frameSource instanceof DefaultFrameSource) {
        frameSource.setBrowserActive(true);
      }
      frameStream.start(1000);
    }
  }

  const abortController = new AbortController();
  let cancelled = false;
  const cancelPoll = setInterval(async () => {
    try {
      if (input.store.getTask) {
        const current = await input.store.getTask(running.id);
        if (current && current.status === 'cancelled') {
          cancelled = true;
          abortController.abort();
        }
      }
    } catch {}
  }, 1000);

  try {
    let streamedCount = 0;
    const result = await input.runner.run(
      running,
      async (event) => {
        try {
          streamedCount++;
          if (event.kind === 'tool_call') {
            const tool = String((event.payload as any)?.tool || '');
            const cmd = String(
              (event.payload as any)?.input?.CommandLine ||
              (event.payload as any)?.input?.command ||
              ''
            );
            if (
              tool.includes('browser') ||
              tool.includes('screen') ||
              cmd.includes('browser') ||
              cmd.includes('rh') ||
              cmd.includes('open http') ||
              cmd.includes('chrome')
            ) {
              if (frameSource instanceof DefaultFrameSource) {
                frameSource.setBrowserActive(true);
              }
              if (frameStream && !frameStream.isRunning()) {
                frameStream.start(1000);
              }
            }
          }
          await input.store.appendEvent(running.id, event);
        } catch {}
      },
      abortController.signal,
    );

    if (cancelled || abortController.signal.aborted) {
      await input.store.appendEvent(running.id, {
        kind: 'status',
        payload: { status: 'cancelled' },
      }).catch(() => {});
      return { claimed: true, taskId: running.id, status: 'cancelled' };
    }

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
    if (cancelled || abortController.signal.aborted) {
      await input.store.appendEvent(running.id, {
        kind: 'status',
        payload: { status: 'cancelled' },
      }).catch(() => {});
      return { claimed: true, taskId: running.id, status: 'cancelled' };
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    await input.store.appendEvent(running.id, {
      kind: 'error',
      payload: { message, fatal: true },
    });
    await input.store.failTask(running.id, { error: message });
    return { claimed: true, taskId: running.id, status: 'failed' };
  } finally {
    clearInterval(cancelPoll);
    if (frameStream) {
      frameStream.stop();
    }
    if (typeof (frameSource as any).dispose === 'function') {
      try {
        (frameSource as any).dispose();
      } catch {}
    }
  }
}
