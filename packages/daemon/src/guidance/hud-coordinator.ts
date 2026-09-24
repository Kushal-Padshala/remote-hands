import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Task } from '@remote-hands/shared';
import { SpotlightHudRunner, type SpotlightPromptResult, type HudUpdateSender } from '../desktop/spotlight-hud.js';
import { IntentResolver } from './intent-resolver.js';
import { GuidanceManager } from './guidance-manager.js';
import { MacOsDriver, type ActiveWindowContext } from '../desktop/macos-driver.js';
import { LocalTaskStore } from '../local-task-store.js';
import type { TaskStore } from '../task-store.js';
import { ProcessAgentRunner, type AgentRunner } from '../agy-runner.js';
import { DynamicPowerManager } from '../system/power-manager.js';





export function isAutonomousGoal(query: string): boolean {
  const q = query.toLowerCase().trim();
  const guidanceTriggers = [
    'how to',
    'how do i',
    'how can i',
    'where is',
    'where to',
    'where are',
    'show me where',
    'point to',
    'guide me to',
    'where do i click',
    'which button is',
    'highlight the',
  ];
  if (guidanceTriggers.some((t) => q.startsWith(t) || q.includes(` ${t} `))) {
    return false;
  }

  const actionKeywords = [
    'start',
    'create',
    'make',
    'campaign',
    'launch',
    'run',
    'execute',
    'redirect',
    'rent',
    'property',
    'search',
    'find',
    'open',
    'browse',
    'automate',
    'post',
    'tweet',
    'send',
    'fill',
    'submit',
    'download',
    'upload',
    'buy',
    'book',
    'draft',
    'write',
    'generate',
    'build',
    'scrape',
    'extract',
    'click',
    'setup',
    'set up',
    'configure',
    'deploy',
  ];
  return actionKeywords.some((verb) => q.includes(verb)) || q.split(/\s+/).length >= 4;
}

export function formatContextualTaskPrompt(query: string, context: ActiveWindowContext): string {
  const lines: string[] = [];
  lines.push(`Goal: ${query}`);
  lines.push('');
  lines.push('Active Environment Context:');
  lines.push(`- Frontmost Application: ${context.app}`);
  if (context.title) lines.push(`- Window Title: ${context.title}`);
  if (context.url) lines.push(`- Active URL: ${context.url}`);
  lines.push(`- Application Type: ${context.isBrowser ? 'Web Browser' : 'Native Desktop Software'}`);
  lines.push('');
  lines.push('Execution Mandate:');
  lines.push('1. Active Context Awareness: The user triggered this task while actively in this window. Target and interact with this application directly.');
  lines.push('2. Autonomous Research: If this task requires research (such as rental property marketing strategies, campaign setup requirements, ad platform configurations, or client redirection mechanisms), perform targeted web research and synthesize the needed steps immediately.');
  lines.push('3. Full-Speed Execution: Do not stall on exploratory discovery commands. Jump straight into executing the steps at full speed.');
  return lines.join('\n');
}

export function formatHudStatus(event: any): { status: string; text: string; role?: string } {
  if (!event) return { status: 'THINKING', text: '' };
  const kind = event.kind || event.type;
  const payload = event.payload || event;

  if (kind === 'tool_call') {
    const tool = payload.tool || 'Action';
    let detail = '';
    if (payload.input) {
      if (typeof payload.input === 'object') {
        const inp = payload.input as any;
        detail = inp.goal || inp.url || inp.text || inp.app || inp.command || inp.query || '';
      } else {
        detail = String(payload.input);
      }
    }
    const cleanDetail = detail ? `: ${detail.slice(0, 80)}` : '';
    return {
      status: 'EXECUTING',
      text: `Using ${tool}${cleanDetail}`,
      role: 'ACTION',
    };
  }

  if (kind === 'tool_result') {
    return {
      status: 'THINKING',
      text: 'Processing action results...',
      role: 'OUTPUT',
    };
  }

  if (kind === 'thinking') {
    const raw = typeof payload.text === 'string' ? payload.text.trim() : '';
    const clean = raw.split('\n')[0]?.slice(0, 100) || 'Thinking through next step...';
    return {
      status: 'THINKING',
      text: clean,
      role: 'THINK',
    };
  }

  if (kind === 'agent_text') {
    const raw = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!raw) return { status: 'THINKING', text: '' };
    const clean = raw.split('\n')[0]?.slice(0, 100) || '';
    return {
      status: 'WORKING',
      text: clean,
      role: 'AGENT',
    };
  }

  if (kind === 'status') {
    const st = payload.status || 'running';
    return {
      status: st === 'running' ? 'WORKING' : String(st).toUpperCase(),
      text: `Task status: ${st}`,
      role: 'STATUS',
    };
  }

  if (kind === 'error') {
    return {
      status: 'ERROR',
      text: payload.message || 'An error occurred',
      role: 'ERROR',
    };
  }

  return { status: 'WORKING', text: '' };
}

export interface HudCoordinatorOptions {
  hudRunner?: SpotlightHudRunner | undefined;
  intentResolver?: IntentResolver | undefined;
  guidanceManager?: GuidanceManager | undefined;
  macosDriver?: MacOsDriver | undefined;
  store?: TaskStore | undefined;
  runner?: AgentRunner | undefined;
  autoExecute?: boolean | undefined;
  onTaskCreated?: ((task: Task) => Promise<void> | void) | undefined;
  onTaskCompleted?: ((task: Task, summary: string) => Promise<void> | void) | undefined;
  powerManager?: DynamicPowerManager | undefined;
}

export class HudCoordinator {
  private hudRunner: SpotlightHudRunner;
  private intentResolver: IntentResolver;
  private guidanceManager: GuidanceManager;
  private macosDriver: MacOsDriver;
  private store?: TaskStore | undefined;
  private runner?: AgentRunner | undefined;
  private autoExecute: boolean;
  private onTaskCreated?: ((task: Task) => Promise<void> | void) | undefined;
  private onTaskCompleted?: ((task: Task, summary: string) => Promise<void> | void) | undefined;
  private activeExecution?: { taskId: string; abortController: AbortController } | undefined;
  private currentTaskId?: string | undefined;
  private powerManager?: DynamicPowerManager | undefined;

  constructor(
    hudRunnerOrOptions?: SpotlightHudRunner | HudCoordinatorOptions,
    intentResolver?: IntentResolver,
    guidanceManager?: GuidanceManager,
    macosDriver?: MacOsDriver,
    store?: TaskStore,
  ) {
    if (hudRunnerOrOptions && typeof (hudRunnerOrOptions as any).openPrompt !== 'function') {
      const opts = hudRunnerOrOptions as HudCoordinatorOptions;
      this.hudRunner = opts.hudRunner || new SpotlightHudRunner();
      this.intentResolver = opts.intentResolver || new IntentResolver();
      this.guidanceManager = opts.guidanceManager || new GuidanceManager();
      this.macosDriver = opts.macosDriver || new MacOsDriver();
      this.store = opts.store;
      this.runner = opts.runner;
      this.autoExecute = opts.autoExecute ?? false;
      this.onTaskCreated = opts.onTaskCreated;
      this.onTaskCompleted = opts.onTaskCompleted;
      this.powerManager = opts.powerManager || new DynamicPowerManager();
      if (this.store === undefined) {
        this.store = this.initDefaultStore();
      }
    } else {
      this.hudRunner = (hudRunnerOrOptions as SpotlightHudRunner) || new SpotlightHudRunner();
      this.intentResolver = intentResolver || new IntentResolver();
      this.guidanceManager = guidanceManager || new GuidanceManager();
      this.macosDriver = macosDriver || new MacOsDriver();
      this.store = store;
      this.autoExecute = false;
      this.powerManager = new DynamicPowerManager();
      if (!hudRunnerOrOptions && !intentResolver && !guidanceManager && !macosDriver && !store) {
        this.store = this.initDefaultStore();
      }
    }
  }


  private initDefaultStore(): TaskStore | undefined {
    try {
      const dbPath = path.join(os.homedir(), '.remote-hands', 'local.db');
      if (fs.existsSync(dbPath)) {
        return new LocalTaskStore({ dbPath });
      }
    } catch {}
    return undefined;
  }

  async cancelActiveTask(reason = 'Task cancelled by user from HUD'): Promise<void> {
    this.powerManager?.releaseAll();
    const currentId = this.activeExecution?.taskId || this.currentTaskId;
    if (this.activeExecution) {
      const { abortController } = this.activeExecution;
      abortController.abort();
      this.activeExecution = undefined;
    }
    this.currentTaskId = undefined;
    if (currentId) {
      const store = this.getStore();
      if (store) {
        if (store.cancelTask) {
          await store.cancelTask(currentId, reason).catch(() => {});
        } else {
          await store.failTask(currentId, { error: reason }).catch(() => {});
        }
        if (store.appendEvent) {
          await store.appendEvent(currentId, {
            kind: 'status',
            payload: { status: 'cancelled' },
          }).catch(() => {});
        }
      }
    }
  }

  hasActiveTask(): boolean {
    return this.activeExecution !== undefined || this.currentTaskId !== undefined;
  }

  async executeTaskStandalone(task: Task, sendUpdate?: HudUpdateSender, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const store = this.getStore();
    if (!store) return;

    this.powerManager?.startTask();
    const abortController = new AbortController();
    this.activeExecution = { taskId: task.id, abortController };


    if (signal) {
      if (signal.aborted) {
        abortController.abort();
      } else {
        signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    let running: Task | undefined;
    try {
      const claimed = await store.claimNextTask('machine-local');
      if (!claimed || abortController.signal.aborted) {
        if (abortController.signal.aborted && store.cancelTask) {
          await store.cancelTask(task.id, 'Task cancelled by user').catch(() => {});
        }
        return;
      }
      running = await store.markTaskRunning(claimed.id);
      if (this.activeExecution) {
        this.activeExecution.taskId = running.id;
      }
      this.currentTaskId = running.id;

      await store.appendEvent(running.id, { kind: 'status', payload: { status: 'running' } });

      if (sendUpdate) {
        sendUpdate('WORKING', 'Starting autonomous agent execution...');
      }
      if (task.kind === 'browser' && process.platform === 'darwin') {
        this.macosDriver.focusWindow('Google Chrome').catch(() => {});
      }

      const runner = this.runner || new ProcessAgentRunner('agy');
      const res = await runner.run(running, async (event) => {
        if (store.appendEvent) {
          await store.appendEvent(running!.id, event as any).catch(() => {});
        }
        if (event && (event.kind === 'tool_call' || (event as any).type === 'tool_call') && process.platform === 'darwin') {
          const payload = event.payload || event;
          const tool = String((payload as any).tool || '').toLowerCase();
          if (tool.includes('browser')) {
            this.macosDriver.focusWindow('Google Chrome').catch(() => {});
            if (sendUpdate) {
              sendUpdate('FOCUS', 'Brought Google Chrome to front', 'FOCUS');
            }
          } else if (tool.includes('desktop')) {
            const targetApp = (payload as any).input?.app;
            if (targetApp && typeof targetApp === 'string') {
              this.macosDriver.focusWindow(targetApp).catch(() => {});
              if (sendUpdate) {
                sendUpdate('FOCUS', `Brought ${targetApp} to front`, 'FOCUS');
              }
            }
          }
        }
        if (sendUpdate) {
          const formatted = formatHudStatus(event);
          if (formatted.text) {
            sendUpdate(formatted.status, formatted.text, formatted.role);
          }
        }
      }, abortController.signal);

      if (abortController.signal.aborted) {
        if (store.cancelTask) {
          await store.cancelTask(running.id, 'Task cancelled by user').catch(() => {});
        } else {
          await store.failTask(running.id, { error: 'Task cancelled by user' });
        }
        if (store.appendEvent) {
          await store.appendEvent(running.id, {
            kind: 'status',
            payload: { status: 'cancelled' },
          }).catch(() => {});
        }
        return;
      }

      if (res.status === 'failed') {
        await store.failTask(running.id, { error: res.summary || 'Task failed' });
        if (sendUpdate) {
          sendUpdate('FAILED', res.summary || 'Task failed', 'ERROR');
        }
      } else {
        await store.completeTask(running.id, { summary: res.summary, conversationId: res.conversationId });
        if (sendUpdate) {
          sendUpdate('COMPLETE', res.summary || 'Task completed successfully', 'DONE');
        }
      }
      if (this.onTaskCompleted && !abortController.signal.aborted) {
        await this.onTaskCompleted(running, res.summary);
      }
    } catch (err: any) {
      const targetId = running?.id || task.id;
      if (abortController.signal.aborted) {
        if (store.cancelTask) {
          await store.cancelTask(targetId, 'Task cancelled by user').catch(() => {});
        } else {
          await store.failTask(targetId, { error: 'Task cancelled by user' });
        }
        if (store.appendEvent) {
          await store.appendEvent(targetId, {
            kind: 'status',
            payload: { status: 'cancelled' },
          }).catch(() => {});
        }
        return;
      }
      await store.failTask(targetId, { error: err?.message || String(err) });
      if (sendUpdate) {
        sendUpdate('FAILED', err?.message || 'Task failed', 'ERROR');
      }
    } finally {
      this.powerManager?.endTask();
      if (this.activeExecution?.taskId === task.id || (running && this.activeExecution?.taskId === running.id)) {
        this.activeExecution = undefined;
      }
      if (this.currentTaskId === task.id || (running && this.currentTaskId === running.id)) {
        this.currentTaskId = undefined;
      }
    }

  }

  private getStore(): TaskStore | null {
    if (this.store) return this.store;
    return this.initDefaultStore() || null;
  }

  async handleResult(result: SpotlightPromptResult, sendUpdate?: HudUpdateSender, signal?: AbortSignal): Promise<boolean> {
    const windowContext = await this.macosDriver.getActiveWindowContext(result.app);
    const isGoal = isAutonomousGoal(result.query);

    if (isGoal && this.store && typeof this.store.createTask === 'function') {
      if (sendUpdate) {
        sendUpdate('THINKING', 'Analyzing context and initializing agent...');
      }
      const prompt = formatContextualTaskPrompt(result.query, windowContext);
      const task = await this.store.createTask({
        prompt,
        goal: result.query,
        kind: windowContext.isBrowser ? 'browser' : 'mixed',
        mode: 'autonomous',
        status: 'queued',
        model: 'gemini-3.8-flash',
        effort: 'low',
      });
      this.currentTaskId = task.id;
      if (this.onTaskCreated) {
        await this.onTaskCreated(task);
      }
      if (this.autoExecute) {
        this.executeTaskStandalone(task, sendUpdate, signal).catch(() => {});
      }
      return true;
    }

    if (sendUpdate) {
      sendUpdate('THINKING', 'Resolving visual guidance...');
    }
    const resolution = await this.intentResolver.resolve(
      result.query,
      windowContext.app || result.app
    );

    if (resolution.steps.length === 0) {
      if (sendUpdate) {
        sendUpdate('FAILED', 'Could not determine guidance steps');
      }
      return false;
    }

    await this.guidanceManager.startSession(resolution.steps);
    if (sendUpdate) {
      sendUpdate('COMPLETE', 'Guidance overlay active');
    }
    return true;
  }

  async triggerPrompt(appOverride?: string): Promise<boolean> {
    if (typeof this.hudRunner.openInteractivePrompt === 'function') {
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const promptAbortController = new AbortController();
        this.hudRunner.openInteractivePrompt(
          appOverride,
          async (result, sendUpdate) => {
            if (!settled) {
              settled = true;
            }
            const success = await this.handleResult(result, sendUpdate, promptAbortController.signal);
            resolve(success);
          },
          () => {
            promptAbortController.abort();
            this.cancelActiveTask('User cancelled from Spotlight HUD').catch(() => {});
            if (!settled) {
              settled = true;
              resolve(false);
            }
          },
        );
      });
    }

    const promptResult = await this.hudRunner.openPrompt(appOverride);
    if (!promptResult || !promptResult.query) {
      return false;
    }
    return await this.handleResult(promptResult);
  }

  startListening(): { stop: () => void } {
    let activePrompt: { close: () => void } | null = null;
    let promptAbortController: AbortController | null = null;
    const runnerListener = this.hudRunner.startListener(async (event: any) => {
      try {
        if (event && event.query) {
          await this.handleResult(event);
        } else if (event && event.event === 'hotkey' && typeof this.hudRunner.openInteractivePrompt === 'function') {
          if (activePrompt) {
            promptAbortController?.abort();
            this.cancelActiveTask('New hotkey session started').catch(() => {});
            activePrompt.close();
            activePrompt = null;
          }
          promptAbortController = new AbortController();
          const currentController = promptAbortController;
          activePrompt = this.hudRunner.openInteractivePrompt(
            event.app,
            async (result, sendUpdate) => {
              try {
                await this.handleResult(result, sendUpdate, currentController.signal);
              } finally {
                activePrompt = null;
              }
            },
            () => {
              currentController.abort();
              this.cancelActiveTask('User cancelled from Spotlight HUD').catch(() => {});
              activePrompt = null;
            },
          );
        }
      } catch {}
    });

    return {
      stop: () => {
        this.powerManager?.releaseAll();
        if (activePrompt) {
          promptAbortController?.abort();
          this.cancelActiveTask('HUD service stopped').catch(() => {});
          activePrompt.close();
          activePrompt = null;
        }
        runnerListener.stop();
      },
    };

  }
}
