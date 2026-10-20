import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ContextAttachment, Task } from '@remote-hands/shared';
import type { FastLane, FastLaneOutcome } from '../fast-lane/fast-lane.js';
import { SpotlightHudRunner, type SpotlightPromptResult, type HudUpdateSender, type HudApprovalOutcome } from '../desktop/spotlight-hud.js';
import { IntentResolver } from './intent-resolver.js';
import { GuidanceManager } from './guidance-manager.js';
import { MacOsDriver, type ActiveWindowContext } from '../desktop/macos-driver.js';
import { LocalTaskStore } from '../local-task-store.js';
import type { TaskStore } from '../task-store.js';
import { ProcessAgentRunner, parseAgyStreamLine, HUD_TASK_MODE, type AgentRunner, type AgentRunResult } from '../agy-runner.js';
import { HUD_MODELS, hudModelByKey, readHudModelKey, resolveHudModel, writeHudModelKey, type HudModel } from '../hud-models.js';
import { WarmAgySession } from '../warm-agy-session.js';
import { agyCommand } from '../system/windows.js';
import { computerPrompt } from '../computer/prompt.js';
import { DynamicPowerManager } from '../system/power-manager.js';
import { HudFeed, plainSummary } from './hud-feed.js';
import { buildChatHistory, toHistoryItems, type ChatTurn, type HudHistoryItem } from './chat-history.js';

/** The warm agy process is stopped after this long unused; the hotkey starts a fresh one while the user types. */
const HUD_AGY_IDLE_MS = Number(process.env.RH_HUD_AGY_IDLE_MS ?? 10 * 60_000);





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

export interface PreviousTaskDigest {
  goal: string;
  summary: string;
  finishedAt: number;
}

export const PREVIOUS_TASK_WINDOW_MS = 10 * 60_000;
export const PREVIOUS_TASK_SUMMARY_MAX = 2000;
export const PREVIOUS_TASK_GOAL_MAX = 300;

export function formatPreviousTaskSection(prev: PreviousTaskDigest | undefined, nowMs: number): string[] {
  if (!prev) return [];
  const summary = prev.summary.trim();
  if (!summary) return [];
  if (nowMs - prev.finishedAt > PREVIOUS_TASK_WINDOW_MS) return [];
  const body =
    summary.length > PREVIOUS_TASK_SUMMARY_MAX
      ? `${summary.slice(0, PREVIOUS_TASK_SUMMARY_MAX)}\n[summary truncated]`
      : summary;
  return [
    '',
    'Previous task (just finished). Use this as ground truth for follow-up requests such as "add those answers to a note"; do not re-derive it from transcripts or files:',
    `Goal: ${prev.goal}`,
    'Result:',
    body,
  ];
}

export function formatContextualTaskPrompt(
  query: string,
  context: ActiveWindowContext,
  attachments?: ContextAttachment[],
  previous?: PreviousTaskDigest,
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
  lines.push('4. Rules Loaded: The operating rules are already in your context. Do not open or read any SKILL.md or other skill file; make your first tool call on the task itself.');
  lines.push('5. ZERO SCREENSHOTS & ZERO PHYSICAL MOUSE MOVEMENTS: Prefer the rh-computer MCP tools (browser_snapshot, browser_click, browser_type, browser_do for forms and multi-step browser sequences, desktop_snapshot, desktop_click, computer_batch) with zero cursor movement. If those tools are unavailable, use these shell commands as a fallback: `rh browser snapshot`, `rh browser click <index>`, `rh browser type <index>`, or `rh desktop ax-action <app> <index> [action]`. Never take screenshots and never simulate physical mouse clicks (except the physical-click fallback that desktop_click reports in its result).');
  lines.push(...formatPreviousTaskSection(previous, Date.now()));
  return lines.join('\n');
}

function outcomeOf(decision: string): HudApprovalOutcome {
  return decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'expired';
}

export interface HudResumed {
  id: string;
  title: string;
  turns: ChatTurn[];
}

/** What the prompt window can ask for with /history: the list of chats and the choice of one. */
export interface HudHistory {
  list: () => Promise<HudHistoryItem[]>;
  resume: (id: string) => Promise<HudResumed | null>;
}

/** What the prompt window can ask for when the person answers an Allow / Deny card. */
export interface HudApprovals {
  /** Records the answer. Resolves to what stands in the end: an approval that already ran out of time cannot be allowed. */
  decide: (id: string, approved: boolean) => Promise<HudApprovalOutcome>;
}

/** How often a running task is checked for an action waiting on the person. */
export const APPROVAL_WATCH_MS = 500;

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
  /**
   * Optional fast lane in front of the agent (instant skills, the page pilot). Absent by default:
   * without it the task path below is exactly the old one.
   */
  fastLane?: Pick<FastLane, 'attempt' | 'prewarm'> | undefined;
  /** Where the chosen model is remembered (the user's home by default). */
  settingsHome?: string | undefined;
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
  /** Bumped whenever the conversation is chosen on purpose, so a task that settles late cannot overwrite the choice. */
  private conversationEpoch = 0;
  /** Approvals this HUD put up for the running task; only these can be answered from it. */
  private offeredApprovals = new Set<string>();
  private approvalWatch?: { end: () => Promise<void> } | undefined;
  private lastTaskDigest?: PreviousTaskDigest | undefined;
  /** The last digest came from a fast-lane task, which the agent's own conversation knows nothing about. */
  private lastDigestFromFastLane = false;
  private taskFront = new Map<string, { app: string; isBrowser: boolean }>();
  private taskQueries = new Map<string, string>();
  private powerManager?: DynamicPowerManager | undefined;
  private fastLane?: Pick<FastLane, 'attempt' | 'prewarm'> | undefined;
  /** Tests never read or write the real home. */
  private settingsHome: string = process.env.VITEST === 'true' ? path.join(os.tmpdir(), 'rh-vitest-no-settings') : os.homedir();

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
      this.fastLane = opts.fastLane;
      if (opts.settingsHome) this.settingsHome = opts.settingsHome;
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
    const approvalsEnded = this.endApprovalWatch();
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
    await approvalsEnded;
    if (sendUpdate) {
      sendUpdate('STOPPED', reason, 'STATUS');
    }
  }

  private inflight = new Set<Promise<void>>();

  private trackExecution(promise: Promise<void>): void {
    const tracked = promise.catch(() => {}).finally(() => {
      this.inflight.delete(tracked);
    });
    this.inflight.add(tracked);
  }

  /** Resolves once every auto-executed task started so far has finished. */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }

  /** Stops the default warm runner (if any) so one-shot callers can exit. Safe to call repeatedly. */
  dispose(): void {
    const runner = this.defaultRunner;
    this.defaultRunner = undefined;
    runner?.stop();
  }

  private getRunner(): AgentRunner {
    if (this.runner) return this.runner;
    if (!this.defaultRunner) {
      this.defaultRunner =
        this.defaultRunnerFactory?.() ??
        new ProcessAgentRunner(
          agyCommand(),
          computerPrompt(),
          undefined,
          new WarmAgySession({ command: agyCommand(), parseLine: parseAgyStreamLine, idleMs: HUD_AGY_IDLE_MS }),
        );
    }
    return this.defaultRunner;
  }

  async cancelActiveTask(reason = 'Task cancelled by user from HUD'): Promise<void> {
    this.conversationEpoch++;
    this.currentConversationId = undefined;
    this.defaultRunner?.newConversation(this.warmHint());
    await this.stopActiveTask(reason);
  }

  private async loadChats(): Promise<ReturnType<typeof buildChatHistory>> {
    const store = this.getStore() as { listTasks?: (o: { limit: number }) => Promise<any[]> } | null;
    if (!store || typeof store.listTasks !== 'function') return [];
    const tasks = await store.listTasks({ limit: 400 }).catch(() => [] as any[]);
    return buildChatHistory(tasks);
  }

  /** The chats /history shows. */
  async historyList(nowMs: number = Date.now()): Promise<HudHistoryItem[]> {
    return toHistoryItems(await this.loadChats(), nowMs);
  }

  /** Makes the next task continue that chat. A running task is stopped first. Null (nothing changes) for an unknown id. */
  async resumeChat(id: string): Promise<HudResumed | null> {
    const chat = (await this.loadChats()).find((c) => c.id === id);
    if (!chat) return null;
    this.conversationEpoch++;
    if (this.hasActiveTask()) await this.stopActiveTask('Switched to another chat');
    this.currentConversationId = chat.id;
    this.lastTaskDigest = undefined;
    this.lastDigestFromFastLane = false;
    return { id: chat.id, title: chat.title, turns: chat.turns };
  }

  private historyMenu(): HudHistory {
    return { list: () => this.historyList(), resume: (id) => this.resumeChat(id) };
  }

  private approvalsMenu(): HudApprovals {
    return { decide: (id, approved) => this.decideApproval(id, approved) };
  }

  /**
   * Answers an Allow / Deny card. Only an approval this HUD showed for the running task takes the answer, and the store decides
   * who got there first: what is returned is what stands (a phone that said no a moment earlier wins over this Allow).
   */
  async decideApproval(id: string, approved: boolean): Promise<HudApprovalOutcome> {
    const store = this.getStore();
    if (!store?.decideApproval || !this.offeredApprovals.has(id)) return 'expired';
    try {
      const row = await store.decideApproval(id, approved ? 'approved' : 'rejected', approved ? undefined : 'Denied from the HUD');
      return outcomeOf(row.decision);
    } catch {
      return 'expired';
    }
  }

  /** Takes the Allow / Deny cards away and turns away what is still waiting: used when the task is stopped, replaced or over. */
  private endApprovalWatch(): Promise<void> {
    return this.approvalWatch?.end() ?? Promise.resolve();
  }

  /**
   * While a task runs, puts the action it is waiting on in front of the person (an Allow / Deny card) and takes the card down
   * when the answer comes from anywhere. `end()` stops the watch at once (no card can be answered after it is called), waits for
   * a look that is already under way, rejects whatever is still waiting and closes the card that is up. It is safe to call again.
   */
  private watchApprovals(taskId: string, sendUpdate?: HudUpdateSender): { end: () => Promise<void> } {
    const store = this.getStore();
    const show = sendUpdate?.approval;
    if (!sendUpdate || !show || !store?.listApprovals || !store.decideApproval) return { end: async () => {} };
    const close = sendUpdate.approvalClosed;
    const mine = new Set<string>();
    let shown: string | null = null;
    let stopped = false;
    let looking: Promise<void> | null = null;
    let ended: Promise<void> | null = null;

    const settleShown = (outcome: HudApprovalOutcome) => {
      if (!shown) return;
      close?.(shown, outcome);
      shown = null;
    };

    const look = async () => {
      if (stopped) return;
      const all = await store.listApprovals!(taskId);
      if (stopped) return;
      if (shown) {
        const current = all.find((a) => a.id === shown);
        if (!current || current.decision !== 'pending') settleShown(current ? outcomeOf(current.decision) : 'expired');
      }
      const waiting = all.filter((a) => a.decision === 'pending');
      // The same action asked again means the earlier asker gave up: only the newest of those stays.
      const newest = waiting[waiting.length - 1];
      for (const old of waiting) {
        if (newest && old.id !== newest.id && old.summary === newest.summary && old.action_kind === newest.action_kind) {
          await store.decideApproval!(old.id, 'rejected', 'Asked again').catch(() => {});
          if (shown === old.id) settleShown('expired');
        }
      }
      if (stopped || shown || !newest) return;
      const live = await store.getApproval?.(newest.id);
      if (stopped || shown || !live || live.decision !== 'pending') return;
      shown = newest.id;
      mine.add(newest.id);
      this.offeredApprovals.add(newest.id);
      show({ id: newest.id, summary: newest.summary, risk: newest.risk });
    };

    const timer = setInterval(() => {
      if (looking || stopped) return;
      looking = look().catch(() => {}).finally(() => { looking = null; });
    }, APPROVAL_WATCH_MS);
    timer.unref?.();

    const end = (): Promise<void> => {
      if (ended) return ended;
      // the synchronous part: from here no card of this task can be answered
      stopped = true;
      clearInterval(timer);
      for (const id of mine) this.offeredApprovals.delete(id);
      ended = (async () => {
        await looking;
        // what the card stood for before this turned the waiting ones away: still waiting means "no longer needed"
        let outcome: HudApprovalOutcome = 'expired';
        try {
          for (const a of await store.listApprovals!(taskId)) {
            if (a.id === shown && a.decision !== 'pending') outcome = outcomeOf(a.decision);
            if (a.decision === 'pending') await store.decideApproval!(a.id, 'rejected', 'The task ended').catch(() => {});
          }
        } catch {}
        settleShown(outcome);
        for (const id of mine) this.offeredApprovals.delete(id);
        if (this.approvalWatch?.end === end) this.approvalWatch = undefined;
      })();
      return ended;
    };
    const watch = { end };
    this.approvalWatch = watch;
    return watch;
  }

  hasActiveTask(): boolean {
    return this.activeExecution !== undefined || this.currentTaskId !== undefined;
  }

  async executeTaskStandalone(task: Task, sendUpdate?: HudUpdateSender, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const store = this.getStore();
    if (!store) return;

    this.powerManager?.startTask();
    // Only a task that finishes successfully leaves a digest; a failed or stopped one must not
    // let an older digest be presented as "just finished".
    this.lastTaskDigest = undefined;
    const abortController = new AbortController();
    const execution = { taskId: task.id, abortController };
    const epoch = this.conversationEpoch;
    this.activeExecution = execution;

    if (signal) {
      if (signal.aborted) {
        abortController.abort();
      } else {
        signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    let running: Task | undefined;
    let completedDigest: PreviousTaskDigest | undefined;
    let approvalWatch: { end: () => Promise<void> } | undefined;
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
      const query = this.taskQueries.get(running.id);
      this.taskQueries.delete(running.id);
      const front = this.taskFront.get(running.id);
      this.taskFront.delete(running.id);

      await store.appendEvent(running.id, { kind: 'status', payload: { status: 'running' } });
      approvalWatch = this.watchApprovals(running.id, sendUpdate);

      if (sendUpdate) {
        sendUpdate('STARTING', '');
      }
      // No window is brought forward here: the browser is driven in place (any browser, not only
      // Chrome), and forcing Chrome to the front pulled the user out of the app they were in.

      // The fast lane gets the first try. It either finishes the request, or the agent carries on
      // (with a note of what was already done). It never fails the task: errors mean "continue".
      let taskForAgent: Task = running;
      let fastLaneResult: AgentRunResult | undefined;
      if (this.fastLane) {
        const outcome = await this.fastLane
          .attempt({
            taskId: running.id,
            query: query ?? running.prompt,
            front,
            signal: abortController.signal,
            onUpdate: (text) => sendUpdate?.('WORKING', text),
          })
          .catch((): FastLaneOutcome => ({ kind: 'continue' }));
        if (outcome.kind === 'handled') {
          fastLaneResult = { events: [], summary: outcome.summary, conversationId: null, status: outcome.status };
        } else if (outcome.addendum) {
          taskForAgent = { ...running, prompt: `${running.prompt}\n\n${outcome.addendum}` };
        }
      }

      const runner = this.getRunner();
      // The full event stream is stored as is; the HUD only gets a few plain sentences from it.
      const feed = sendUpdate ? new HudFeed(sendUpdate) : null;
      const res = fastLaneResult ?? await runner.run(taskForAgent, async (event) => {
        if (store.appendEvent) {
          await store.appendEvent(running!.id, event as any).catch(() => {});
        }
        // A Stop that landed while the event was being stored must not be followed by a status update.
        if (!abortController.signal.aborted) feed?.event(event);
      }, abortController.signal);

      if (res.conversationId && epoch === this.conversationEpoch) {
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
          sendUpdate('FAILED', plainSummary(res.summary || '') || 'Task failed', 'ERROR');
        }
      } else {
        await store.completeTask(running.id, { summary: res.summary, conversationId: res.conversationId });
        completedDigest = {
          goal: String(query ?? running.prompt ?? '').slice(0, PREVIOUS_TASK_GOAL_MAX),
          summary: res.summary ?? '',
          finishedAt: Date.now(),
        };
        if (sendUpdate) {
          sendUpdate('COMPLETE', plainSummary(res.summary || '') || 'Task completed successfully', 'DONE');
        }
      }
      if (this.onTaskCompleted && !abortController.signal.aborted) {
        await this.onTaskCompleted(running, res.summary);
      }
      // Completion hooks can fail, cancel this task, or start another one. Only the
      // successful execution that still owns the coordinator may publish its result.
      if (completedDigest && !abortController.signal.aborted && this.activeExecution === execution) {
        this.lastTaskDigest = completedDigest;
        this.lastDigestFromFastLane = fastLaneResult !== undefined;
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
        sendUpdate('FAILED', plainSummary(err?.message || '', 400) || 'Task failed', 'ERROR');
      }
    } finally {
      await approvalWatch?.end();
      this.powerManager?.endTask();
      if (this.activeExecution?.taskId === task.id || (running && this.activeExecution?.taskId === running.id)) {
        this.activeExecution = undefined;
      }
      if (this.currentTaskId === task.id || (running && this.currentTaskId === running.id)) {
        this.currentTaskId = undefined;
      }
    }

  }

  /** The model the next task uses: the one the HUD just sent, else the last one chosen, else the default. */
  private modelFor(result: { model?: string | undefined }): HudModel {
    if (hudModelByKey(result.model)) {
      if (readHudModelKey(this.settingsHome) !== result.model) writeHudModelKey(result.model, this.settingsHome);
      return resolveHudModel(result.model);
    }
    return resolveHudModel(readHudModelKey(this.settingsHome));
  }

  /** What the warm agent process should be started with, so the first task after a choice does not wait for a restart. */
  private warmHint(): { mode: string; model: string; effort: string } {
    const chosen = resolveHudModel(readHudModelKey(this.settingsHome));
    return { mode: HUD_TASK_MODE, model: chosen.model, effort: chosen.effort };
  }

  /** The model list and current choice shown in the prompt window, and what to do when the person picks another. */
  private modelMenu(): { models: Array<{ key: string; label: string }>; model: string; onModel: (key: string) => void } {
    return {
      models: HUD_MODELS.map((m) => ({ key: m.key, label: m.label })),
      model: readHudModelKey(this.settingsHome),
      onModel: (key) => {
        if (!writeHudModelKey(key, this.settingsHome)) return;
        // Warming with another model restarts the agent process, which would end a task that is running: that task
        // finishes as it is, and the next turn starts with the new choice.
        if (!this.hasActiveTask()) this.defaultRunner?.prewarm(this.warmHint());
      },
    };
  }

  private getStore(): TaskStore | null {
    if (this.store) return this.store;
    return this.initDefaultStore() || null;
  }

  async handleResult(result: SpotlightPromptResult, sendUpdate?: HudUpdateSender, signal?: AbortSignal): Promise<boolean> {
    if (this.activeExecution) {
      const prev = this.activeExecution;
      this.activeExecution = undefined;
      void this.endApprovalWatch();
      prev.abortController.abort();
    }
    const windowContext = result.windowTitle
      ? await this.macosDriver.getActiveWindowContext(result.app, result.windowTitle)
      : await this.macosDriver.getActiveWindowContext(result.app);
    const isGoal = isAutonomousGoal(result.query);
    const chosen = this.modelFor(result);

    if (isGoal && this.store && typeof this.store.createTask === 'function') {
      if (sendUpdate) {
        sendUpdate('THINKING', '');
      }
      const prompt = formatContextualTaskPrompt(
        result.query,
        windowContext,
        result.attachments,
        this.currentConversationId && !this.lastDigestFromFastLane ? undefined : this.lastTaskDigest,
      );
      const task = await this.store.createTask({
        prompt,
        goal: result.query,
        kind: windowContext.isBrowser ? 'browser' : 'mixed',
        mode: HUD_TASK_MODE,
        status: 'queued',
        model: chosen.model,
        effort: chosen.effort,
        conversation_id: this.currentConversationId ?? null,
        attachments: result.attachments,
      });
      this.currentTaskId = task.id;
      this.taskQueries.set(task.id, result.query);
      this.taskFront.set(task.id, { app: windowContext.app || result.app || '', isBrowser: windowContext.isBrowser === true });
      if (this.onTaskCreated) {
        await this.onTaskCreated(task);
      }
      if (this.autoExecute) {
        this.trackExecution(this.executeTaskStandalone(task, sendUpdate, signal));
      }
      return true;
    }

    if (sendUpdate) {
      sendUpdate('THINKING', '');
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
          sendUpdate('THINKING', '');
        }
        const prompt = formatContextualTaskPrompt(
          result.query,
          windowContext,
          result.attachments,
          this.currentConversationId && !this.lastDigestFromFastLane ? undefined : this.lastTaskDigest,
        );
        const task = await this.store.createTask({
          prompt,
          goal: result.query,
          kind: windowContext.isBrowser ? 'browser' : 'mixed',
          mode: HUD_TASK_MODE,
          status: 'queued',
          model: chosen.model,
          effort: chosen.effort,
          conversation_id: this.currentConversationId ?? null,
          attachments: result.attachments,
        });
        this.currentTaskId = task.id;
        this.taskQueries.set(task.id, result.query);
        this.taskFront.set(task.id, { app: windowContext.app || result.app || '', isBrowser: windowContext.isBrowser === true });
        if (this.onTaskCreated) {
          await this.onTaskCreated(task);
        }
        if (this.autoExecute) {
          this.trackExecution(this.executeTaskStandalone(task, sendUpdate, signal));
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
          undefined,
          this.modelMenu(),
          this.historyMenu(),
          this.approvalsMenu(),
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
      this.defaultRunner?.prewarm(this.warmHint());
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
          this.conversationEpoch++;
          this.currentConversationId = undefined;
          this.defaultRunner?.newConversation(this.warmHint());
          this.fastLane?.prewarm();
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
          promptArgs.push(event.windowTitle || undefined, this.modelMenu(), this.historyMenu(), this.approvalsMenu());
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
