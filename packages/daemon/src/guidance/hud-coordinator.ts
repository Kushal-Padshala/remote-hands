import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Task } from '@remote-hands/shared';
import { SpotlightHudRunner, type SpotlightPromptResult } from '../desktop/spotlight-hud.js';
import { IntentResolver } from './intent-resolver.js';
import { GuidanceManager } from './guidance-manager.js';
import { MacOsDriver, type ActiveWindowContext } from '../desktop/macos-driver.js';
import { LocalTaskStore } from '../local-task-store.js';
import type { TaskStore } from '../task-store.js';
import { ProcessAgentRunner, type AgentRunner } from '../agy-runner.js';

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

  async executeTaskStandalone(task: Task): Promise<void> {
    const store = this.getStore();
    if (!store) return;
    const claimed = await store.claimNextTask('machine-local');
    if (!claimed) return;
    const running = await store.markTaskRunning(claimed.id);
    await store.appendEvent(running.id, { kind: 'status', payload: { status: 'running' } });

    const runner = this.runner || new ProcessAgentRunner('agy');
    try {
      const res = await runner.run(running, async (event) => {
        if (store.appendEvent) {
          await store.appendEvent(running.id, event as any).catch(() => {});
        }
      });
      if (res.status === 'failed') {
        await store.failTask(running.id, { error: res.summary || 'Task failed' });
      } else {
        await store.completeTask(running.id, { summary: res.summary, conversationId: res.conversationId });
      }
      if (this.onTaskCompleted) {
        await this.onTaskCompleted(running, res.summary);
      }
    } catch (err: any) {
      await store.failTask(running.id, { error: err?.message || String(err) });
    }
  }

  private getStore(): TaskStore | null {
    if (this.store) return this.store;
    return this.initDefaultStore() || null;
  }

  async handleResult(result: SpotlightPromptResult): Promise<boolean> {
    const windowContext = await this.macosDriver.getActiveWindowContext(result.app);
    const isGoal = isAutonomousGoal(result.query);

    if (isGoal && this.store && typeof this.store.createTask === 'function') {
      const prompt = formatContextualTaskPrompt(result.query, windowContext);
      const task = await this.store.createTask({
        prompt,
        goal: result.query,
        kind: windowContext.isBrowser ? 'browser' : 'mixed',
        mode: 'autonomous',
        status: 'queued',
      });
      if (this.onTaskCreated) {
        await this.onTaskCreated(task);
      }
      if (this.autoExecute) {
        this.executeTaskStandalone(task).catch(() => {});
      }
      return true;
    }

    const resolution = await this.intentResolver.resolve(
      result.query,
      windowContext.app || result.app
    );

    if (resolution.steps.length === 0) {
      return false;
    }

    await this.guidanceManager.startSession(resolution.steps);
    return true;
  }

  async triggerPrompt(appOverride?: string): Promise<boolean> {
    const promptResult = await this.hudRunner.openPrompt(appOverride);
    if (!promptResult || !promptResult.query) {
      return false;
    }
    return await this.handleResult(promptResult);
  }

  startListening(): { stop: () => void } {
    return this.hudRunner.startListener(async (result: SpotlightPromptResult) => {
      try {
        await this.handleResult(result);
      } catch {}
    });
  }
}
