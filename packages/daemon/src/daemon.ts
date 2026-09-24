import { isSafeWorkspacePath, type ApprovalRow, type Task, type TaskStatus } from '@remote-hands/shared';
import type { AgentRunner } from './agy-runner.js';
import type { DaemonConfig } from './config.js';
import type { RuntimeMetadata } from './runtime.js';
import type { TaskStore } from './task-store.js';
import type { BrowserFrame, FrameSource } from './frame-stream.js';
import { ThrottledFrameStream } from './frame-stream.js';
import { DefaultFrameSource, cleanupStaleFrameFiles } from './screen-capture.js';
import type { ChromeManager } from './chrome-manager.js';
import type { DynamicPowerManager } from './system/power-manager.js';

export interface RunDaemonOnceInput {
  userId: string;
  config: DaemonConfig;
  runtime: RuntimeMetadata;
  store: TaskStore;
  runner: AgentRunner;
  onFrame?: ((frame: BrowserFrame) => Promise<void> | void) | undefined;
  frameSource?: FrameSource | undefined;
  chromeManager?: ChromeManager | undefined;
  lastHeartbeatAtRef?: { current: number } | undefined;
  powerManager?: DynamicPowerManager | undefined;
}


export type RunDaemonOnceResult =
  | { claimed: false }
  | { claimed: true; taskId: string; status: Extract<TaskStatus, 'done' | 'failed' | 'cancelled'> };

export async function runDaemonOnce(input: RunDaemonOnceInput): Promise<RunDaemonOnceResult> {
  const machine = input.store.getMachine
    ? await input.store.getMachine()
    : await input.store.registerMachine({
        userId: input.userId,
        name: input.config.machineName,
        hostname: input.runtime.hostname,
        agyVersion: input.runtime.agyVersion,
        daemonVersion: input.runtime.daemonVersion,
      });

  const now = Date.now();
  const interval = input.config.heartbeatIntervalMs || 60000;
  if (!input.lastHeartbeatAtRef || now - input.lastHeartbeatAtRef.current >= interval) {
    await input.store.heartbeat(machine.id);
    if (input.lastHeartbeatAtRef) {
      input.lastHeartbeatAtRef.current = now;
    }
  }

  const claimed = await input.store.claimNextTask(machine.id);
  if (claimed === null) return { claimed: false };

  input.powerManager?.startTask();

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
    browserActive: isBrowserKind,
    enableDesktopCapture: true,
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

    if (frameSource instanceof DefaultFrameSource) {
      frameSource.setBrowserActive(isBrowserKind);
    }
    frameStream.start(1000);
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
    let currentTask: Task = running;
    let lastSummary = '';
    let lastConversationId = running.conversation_id;

    while (!cancelled && !abortController.signal.aborted) {
      let streamedCount = 0;
      const result = await input.runner.run(
        currentTask,
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

      if (result.conversationId) {
        lastConversationId = result.conversationId;
      }
      if (result.summary) {
        lastSummary = result.summary;
      }

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

      const hasFatalError = result.events.some((e) => e.kind === 'error' && (e.payload as any)?.fatal);
      if (result.status === 'failed' || hasFatalError) {
        await input.store.appendEvent(running.id, { kind: 'status', payload: { status: 'failed' } });
        await input.store.failTask(running.id, {
          error: result.summary || lastSummary || 'Task failed',
        });
        return { claimed: true, taskId: running.id, status: 'failed' };
      }

      let pendingApproval: ApprovalRow | null = null;
      if (input.store.getPendingApproval) {
        pendingApproval = await input.store.getPendingApproval(running.id);
      } else if (input.store.listApprovals) {
        const list = await input.store.listApprovals(running.id);
        pendingApproval = list.find((a) => a.decision === 'pending') ?? null;
      }

      if (!pendingApproval) {
        const hasResultEvent = result.events.some((e) => e.kind === 'result');
        if (!hasResultEvent) {
          await input.store.appendEvent(running.id, {
            kind: 'result',
            payload: {
              summary: result.summary || lastSummary,
              conversation_id: lastConversationId ?? undefined,
              duration_seconds: result.durationSeconds,
            },
          });
        }
        await input.store.appendEvent(running.id, { kind: 'status', payload: { status: 'done' } });
        await input.store.completeTask(running.id, {
          summary: result.summary || lastSummary,
          conversationId: lastConversationId,
        });
        return { claimed: true, taskId: running.id, status: 'done' };
      }

      if (input.store.markTaskAwaitingApproval) {
        await input.store.markTaskAwaitingApproval(running.id);
      }
      await input.store.appendEvent(running.id, {
        kind: 'status',
        payload: { status: 'awaiting_approval' },
      });

      let decided: ApprovalRow | null = null;
      const approvalTimeoutMs = pendingApproval.expires_at
        ? Math.max(1000, Date.parse(pendingApproval.expires_at) - Date.now())
        : 600000;

      if (input.store.waitForApprovalDecision) {
        try {
          decided = await input.store.waitForApprovalDecision(
            pendingApproval.id,
            approvalTimeoutMs,
            abortController.signal,
          );
        } catch {
          decided = null;
        }
      } else {
        const timeoutMs = approvalTimeoutMs;
        const startWait = Date.now();
        while (Date.now() - startWait < timeoutMs && !cancelled && !abortController.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (input.store.getTask) {
            const cur = await input.store.getTask(running.id);
            if (cur && cur.status === 'cancelled') {
              cancelled = true;
              break;
            }
          }
          if (input.store.listApprovals) {
            const list = await input.store.listApprovals(running.id);
            const found = list.find((a) => a.id === pendingApproval!.id);
            if (found && found.decision !== 'pending') {
              decided = found;
              break;
            }
          }
        }
      }

      if (cancelled || abortController.signal.aborted) {
        await input.store.appendEvent(running.id, {
          kind: 'status',
          payload: { status: 'cancelled' },
        }).catch(() => {});
        return { claimed: true, taskId: running.id, status: 'cancelled' };
      }

      if (!decided || decided.decision === 'pending' || decided.decision === 'expired') {
        const error = 'Approval timed out with no decision from user';
        await input.store.appendEvent(running.id, {
          kind: 'error',
          payload: { message: error, fatal: true },
        });
        await input.store.failTask(running.id, { error });
        return { claimed: true, taskId: running.id, status: 'failed' };
      }

      await input.store.markTaskRunning(running.id);
      await input.store.appendEvent(running.id, {
        kind: 'status',
        payload: { status: 'running' },
      });

      let continuationPrompt: string;
      if (decided.decision === 'approved') {
        continuationPrompt = `[HUMAN APPROVAL GRANTED] The user approved the action on their phone: "${decided.summary}". Proceed immediately to execute and complete the action (e.g. click Post / Submit) now.`;
      } else {
        const reasonStr = decided.rejection_reason ? ` Reason: "${decided.rejection_reason}".` : '';
        continuationPrompt = `[HUMAN APPROVAL REJECTED] The user rejected the action on their phone: "${decided.summary}".${reasonStr} Adjust your draft/plan according to this feedback, or cancel if the user requested to abort.`;
      }

      currentTask = {
        ...running,
        conversation_id: lastConversationId,
        prompt: continuationPrompt,
      };
    }

    return { claimed: true, taskId: running.id, status: 'cancelled' };
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
    input.powerManager?.endTask();
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
