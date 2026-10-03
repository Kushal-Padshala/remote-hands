import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ContextAttachment, Task } from '@remote-hands/shared';
import { SpotlightHudRunner, type SpotlightPromptResult, type HudUpdateSender } from '../desktop/spotlight-hud.js';
import { IntentResolver } from './intent-resolver.js';
import { GuidanceManager } from './guidance-manager.js';
import { MacOsDriver, type ActiveWindowContext } from '../desktop/macos-driver.js';
import { LocalTaskStore } from '../local-task-store.js';
import type { TaskStore } from '../task-store.js';
import { ProcessAgentRunner, parseAgyStreamLine, HUD_TASK_MODE, type AgentRunner } from '../agy-runner.js';
import { WarmAgySession } from '../warm-agy-session.js';
import { SLIM_COMPUTER_PROMPT } from '../computer/prompt.js';
import { DynamicPowerManager } from '../system/power-manager.js';





export function isAutonomousGoal(query: string): boolean {
  const q = query.toLowerCase().trim();

  if (
    q.includes('teach') ||
    q.includes('explain') ||
    q.includes('help me') ||
    q.includes('what is') ||
    q.includes('how can i make') ||
    q.includes('how do i make')
  ) {
    return true;
  }

  const pureGuidanceTriggers = [
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

  const words = q.split(/\s+/);
  if (pureGuidanceTriggers.some((t) => q.startsWith(t)) && words.length <= 6) {
    return false;
  }

  if (pureGuidanceTriggers.some((t) => q.includes(` ${t} `)) && words.length <= 5) {
    return false;
  }

  const actionKeywords = [
    'start',
    'create',
    'make',
    'complete',
    'finish',
    'answer',
    'survey',
    'form',
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
    'change',
    'color',
    'edit',
    'add',
    'remove',
    'delete',
    'slice',
    'print',
  ];
  return actionKeywords.some((verb) => q.includes(verb)) || words.length >= 4;
}

export function formatContextualTaskPrompt(
  query: string,
  context: ActiveWindowContext,
  attachments?: ContextAttachment[],
): string {
  const lines: string[] = [];
  lines.push(`Goal: ${query}`);
  lines.push('');
  lines.push('Active Environment Context:');
  lines.push(`- Frontmost Application: ${context.app}`);
  if (context.title) lines.push(`- Window Title: ${context.title}`);
  if (context.url) lines.push(`- Active URL: ${context.url}`);
  lines.push(`- Application Type: ${context.isBrowser ? 'Web Browser' : 'Native Desktop Software'}`);

  lines.push('');
  lines.push('PRIORITIZED ACTIVE TARGET MANDATE:');
  lines.push(`1. The user triggered this task while actively in "${context.title || context.app}" (${context.url || context.app}).`);
  lines.push('2. You MUST prioritize and operate directly on this exact window, tab, and profile.');
  lines.push('3. NEVER switch to a different profile (such as Personal or Default profile when Guest mode is active), and NEVER open new duplicate windows or tabs if this page or app is already in front.');

  if (attachments && attachments.length > 0) {
    lines.push('');
    lines.push('User Attached Context:');
    for (const att of attachments) {
      if (att.type === 'browser_tab') {
        const prof = att.profile ? ` [Profile: ${att.profile}]` : '';
        lines.push(`- Browser Tab (${att.browser}${prof}): "${att.title}" -> ${att.url}${att.tabIndex !== undefined ? ` (index: ${att.tabIndex})` : ''}`);
      } else if (att.type === 'app_window') {
        lines.push(`- App Window (${att.app}): "${att.title || att.app}"`);
      } else if (att.type === 'local_file') {
        lines.push(`- Local File: "${att.name}" (${att.path})`);
      }
    }
    lines.push('Target Mandate: The user explicitly attached these tabs, windows, and files. Operate directly on them. Never search for profiles, open redundant duplicate tabs, or scan directories.');
  }

  lines.push('');
  lines.push('Execution Mandate:');
  lines.push('1. Active Context Awareness: The user triggered this task while actively in this window. Target and interact with this application directly.');
  lines.push('2. Autonomous Research: If this task requires research (such as rental property marketing strategies, campaign setup requirements, ad platform configurations, or client redirection mechanisms), perform targeted web research and synthesize the needed steps immediately.');
  lines.push('3. Full-Speed Execution: Do not stall on exploratory discovery commands. Jump straight into executing the steps at full speed.');
  lines.push('4. Skill Reference: Apply the `remote-hands-operator` skill for blazing-fast in-place browser tab reuse, native window control, and zero-discovery execution.');
  lines.push('5. ZERO SCREENSHOTS & ZERO PHYSICAL MOUSE MOVEMENTS: Prefer the rh-computer MCP tools (browser_snapshot, browser_click, browser_type, desktop_snapshot, desktop_click, computer_batch) with zero cursor movement. If those tools are unavailable, use these shell commands as a fallback: `rh browser snapshot`, `rh browser click <index>`, `rh browser type <index>`, or `rh desktop ax-action <app> <index> [action]`. Never take screenshots and never simulate physical mouse clicks.');
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
        detail = inp.toolAction || inp.CommandLine || inp.goal || inp.url || inp.text || inp.app || inp.toolSummary || inp.command || inp.query || '';
      } else {
        detail = String(payload.input);
      }
    }
    const cleanDetail = detail ? `: ${detail.slice(0, 80)}` : '';
    return {
      status: 'EXECUTING',
      text: tool === 'run_command' && detail ? detail.slice(0, 90) : `Using ${tool}${cleanDetail}`,
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
  /** Test seam: builds the default warm runner used when no `runner` is injected. */
  defaultRunnerFactory?: (() => ProcessAgentRunner) | undefined;
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
  private defaultRunner?: ProcessAgentRunner | undefined;
  private defaultRunnerFactory?: (() => ProcessAgentRunner) | undefined;
  private autoExecute: boolean;
  private onTaskCreated?: ((task: Task) => Promise<void> | void) | undefined;
  private onTaskCompleted?: ((task: Task, summary: string) => Promise<void> | void) | undefined;
  private activeExecution?: { taskId: string; abortController: AbortController } | undefined;
  private currentTaskId?: string | undefined;
  private currentConversationId?: string | undefined;
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
      this.defaultRunnerFactory = opts.defaultRunnerFactory;
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

  async stopActiveTask(reason = 'Task stopped by user from HUD', sendUpdate?: HudUpdateSender): Promise<void> {
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
    if (sendUpdate) {
      sendUpdate('STOPPED', reason, 'STATUS');
    }
  }

  private getRunner(): AgentRunner {
    if (this.runner) return this.runner;
    if (!this.defaultRunner) {
      this.defaultRunner =
        this.defaultRunnerFactory?.() ??
        new ProcessAgentRunner(
          'agy',
          SLIM_COMPUTER_PROMPT,
          undefined,
          new WarmAgySession({ command: 'agy', parseLine: parseAgyStreamLine }),
        );
    }
    return this.defaultRunner;
  }

  async cancelActiveTask(reason = 'Task cancelled by user from HUD'): Promise<void> {
    this.currentConversationId = undefined;
    this.defaultRunner?.newConversation({ mode: HUD_TASK_MODE });
    await this.stopActiveTask(reason);
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
      if (store.claimNextTask) {
        const claimed = await store.claimNextTask('machine-local');
        if (claimed) {
          running = (await store.markTaskRunning?.(claimed.id)) || claimed;
        }
      }
      if (!running) {
        if (typeof (store as any).updateTaskStatus === 'function') {
          await (store as any).updateTaskStatus(task.id, 'running');
          running = (await store.getTask?.(task.id)) || task;
        } else if (store.markTaskRunning) {
          running = await store.markTaskRunning(task.id);
        } else {
          running = task;
        }
      }

      if (!running || abortController.signal.aborted) {
        if (abortController.signal.aborted && store.cancelTask) {
          await store.cancelTask(task.id, 'Task cancelled by user').catch(() => {});
        }
        return;
      }
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

      const runner = this.getRunner();
      const res = await runner.run(running, async (event) => {
        if (store.appendEvent) {
          await store.appendEvent(running!.id, event as any).catch(() => {});
        }
        if (sendUpdate) {
          const formatted = formatHudStatus(event);
          if (formatted.text) {
            sendUpdate(formatted.status, formatted.text, formatted.role);
          }
        }
      }, abortController.signal);

      if (res.conversationId) {
        this.currentConversationId = res.conversationId;
      }

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
    if (this.activeExecution) {
      const prev = this.activeExecution;
      this.activeExecution = undefined;
      prev.abortController.abort();
    }
    const windowContext = result.windowTitle
      ? await this.macosDriver.getActiveWindowContext(result.app, result.windowTitle)
      : await this.macosDriver.getActiveWindowContext(result.app);
    const isGoal = isAutonomousGoal(result.query);

    if (isGoal && this.store && typeof this.store.createTask === 'function') {
      if (sendUpdate) {
        sendUpdate('THINKING', 'Analyzing context and initializing agent...');
      }
      const prompt = formatContextualTaskPrompt(result.query, windowContext, result.attachments);
      const task = await this.store.createTask({
        prompt,
        goal: result.query,
        kind: windowContext.isBrowser ? 'browser' : 'mixed',
        mode: HUD_TASK_MODE,
        status: 'queued',
        model: 'gemini-3.8-flash',
        effort: 'low',
        conversation_id: this.currentConversationId ?? null,
        attachments: result.attachments,
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

    const isUnresolvedEcho =
      resolution.steps.length === 1 &&
      resolution.steps[0]?.target === (windowContext.app || result.app) &&
      resolution.confidence <= 0.7;

    if (resolution.steps.length === 0 || isUnresolvedEcho) {
      if (this.store && typeof this.store.createTask === 'function') {
        if (sendUpdate) {
          sendUpdate('THINKING', 'Analyzing context and initializing agent...');
        }
        const prompt = formatContextualTaskPrompt(result.query, windowContext, result.attachments);
        const task = await this.store.createTask({
          prompt,
          goal: result.query,
          kind: windowContext.isBrowser ? 'browser' : 'mixed',
          mode: HUD_TASK_MODE,
          status: 'queued',
          model: 'gemini-3.8-flash',
          effort: 'low',
          conversation_id: this.currentConversationId ?? null,
          attachments: result.attachments,
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
      if (resolution.steps.length === 0) {
        if (sendUpdate) {
          sendUpdate('FAILED', 'Could not determine guidance steps');
        }
        return false;
      }
    }

    await this.guidanceManager.startSession(resolution.steps);
    if (sendUpdate) {
      const stepSummary = resolution.steps.map((s) => s.text).filter(Boolean).join('\n') || 'Guidance overlay active';
      sendUpdate('COMPLETE', stepSummary, 'GUIDE');
    }
    return true;
  }

  async triggerPrompt(appOverride?: string): Promise<boolean> {
    if (typeof this.hudRunner.openInteractivePrompt === 'function') {
      return new Promise<boolean>((resolve) => {
        let settled = false;
        this.hudRunner.openInteractivePrompt(
          appOverride,
          async (result, sendUpdate) => {
            const success = await this.handleResult(result, sendUpdate);
            if (!settled) {
              settled = true;
              resolve(success);
            }
          },
          () => {
            this.cancelActiveTask('User cancelled from Spotlight HUD').catch(() => {});
            if (!settled) {
              settled = true;
              resolve(false);
            }
          },
          (sendUpdate) => {
            this.stopActiveTask('User stopped task from Spotlight HUD', sendUpdate).catch(() => {});
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
    if (!this.runner) {
      this.getRunner();
      this.defaultRunner?.prewarm({ mode: HUD_TASK_MODE });
    }
    let activePrompt: { close: () => void } | null = null;
    const runnerListener = this.hudRunner.startListener(async (event: any) => {
      try {
        if (event && event.query) {
          await this.handleResult(event);
        } else if (event && event.event === 'hotkey' && typeof this.hudRunner.openInteractivePrompt === 'function') {
          if (activePrompt) {
            this.cancelActiveTask('New hotkey session started').catch(() => {});
            activePrompt.close();
            activePrompt = null;
          }
          this.currentConversationId = undefined;
          this.defaultRunner?.newConversation({ mode: HUD_TASK_MODE });
          const promptArgs: any[] = [
            event.app,
            async (result: any, sendUpdate: any) => {
              try {
                await this.handleResult(result, sendUpdate);
              } catch {}
            },
            () => {
              this.cancelActiveTask('User cancelled from Spotlight HUD').catch(() => {});
              activePrompt = null;
            },
            (sendUpdate: any) => {
              this.stopActiveTask('User stopped task from Spotlight HUD', sendUpdate).catch(() => {});
            },
          ];
          if (event.windowTitle) {
            promptArgs.push(event.windowTitle);
          }
          activePrompt = (this.hudRunner.openInteractivePrompt as any)(...promptArgs);
        }
      } catch {}
    });

    return {
      stop: () => {
        this.powerManager?.releaseAll();
        if (activePrompt) {
          this.cancelActiveTask('HUD service stopped').catch(() => {});
          activePrompt.close();
          activePrompt = null;
        }
        runnerListener.stop();
        this.defaultRunner?.stop();
      },
    };

  }
}
