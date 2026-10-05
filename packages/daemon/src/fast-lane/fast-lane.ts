import { routeRequest } from './conductor.js';
import type { InferenceStatus } from './inference/service.js';
import { BrowserPilotEnv, type PilotBrowser } from './pilot/env.js';
import { runPilot as defaultRunPilot, type RunPilotInput } from './pilot/pilot.js';
import type { PilotResult } from './pilot/types.js';
import type { SkillRegistry } from './skills/registry.js';
import type { SkillContext } from './skills/types.js';
import type { DecisionEngine } from './types.js';

export type FastLaneOutcome =
  /** The fast lane finished the request; the task is complete with this summary. */
  | { kind: 'handled'; status: 'done'; summary: string }
  /** Carry on with the agent as usual, optionally telling it what the fast lane already did. */
  | { kind: 'continue'; addendum?: string };

export interface FastLaneInferenceLike extends DecisionEngine {
  status(): InferenceStatus;
  prewarm(): Promise<boolean>;
  handoffGapNats(): number;
}

export interface FastLaneDeps {
  enabled: () => boolean;
  inference: FastLaneInferenceLike;
  registry: SkillRegistry;
  skillContext: () => SkillContext;
  browser: () => PilotBrowser;
  frontmost: () => Promise<{ app: string; isBrowser: boolean }>;
  /**
   * Records the running task for the approval gate (it reads the marker to know which task to file
   * approvals under); null clears it. Without a task the gate lets everything through.
   */
  setActiveTask: (id: string | null) => void;
  runPilot?: ((input: RunPilotInput) => Promise<PilotResult>) | undefined;
}

export interface AttemptInput {
  taskId: string;
  query: string;
  signal?: AbortSignal | undefined;
  onUpdate?: ((text: string) => void) | undefined;
}

const STOPPED: FastLaneOutcome = { kind: 'handled', status: 'done', summary: 'Stopped.' };

/** What the fast lane already did, for the agent that takes over. Typed values are never included. */
export function describePilotHandoff(result: Extract<PilotResult, { status: 'handoff' }>): string {
  const page = result.finalView ? ` The page now is "${result.finalView.title}" (${result.finalView.url}).` : '';
  if (result.steps.length === 0) {
    return `The fast lane looked at the page but did not act, because ${result.detail}.${page}`;
  }
  const steps = result.steps
    .map((s) => `${s.index}. ${s.description}${s.outcome === 'ok' ? '' : s.outcome === 'no-change' ? ' (nothing changed)' : ' (failed)'}`)
    .join('\n');
  return `The fast lane already did these steps in the browser:\n${steps}\nThen it handed over because ${result.detail}.${page}`;
}

/**
 * The fast lane in front of the agent: instant skills, the live page pilot, and a clean handover.
 * It never fails a task: anything unexpected becomes "continue with the agent".
 */
export class FastLane {
  constructor(private readonly deps: FastLaneDeps) {}

  /** Start loading the model while the user is still typing or speaking. */
  prewarm(): void {
    if (!this.deps.enabled()) return;
    void this.deps.inference.prewarm().catch(() => {});
  }

  async attempt(input: AttemptInput): Promise<FastLaneOutcome> {
    if (!this.deps.enabled()) return { kind: 'continue' };
    const state = this.deps.inference.status().state;
    if (state !== 'ready' && state !== 'running') return { kind: 'continue' };
    if (input.signal?.aborted) return STOPPED;

    this.deps.setActiveTask(input.taskId);
    try {
      return await this.run(input);
    } catch {
      return { kind: 'continue' };
    } finally {
      this.deps.setActiveTask(null);
    }
  }

  private async run(input: AttemptInput): Promise<FastLaneOutcome> {
    const { inference, registry } = this.deps;
    const front = await this.deps.frontmost();
    const ctx: SkillContext = { ...this.deps.skillContext(), decide: inference };

    const route = await routeRequest({
      query: input.query,
      frontApp: front.app,
      frontIsBrowser: front.isBrowser,
      registry,
      ctx,
      engine: inference,
      handoffGapNats: inference.handoffGapNats(),
    });
    if (input.signal?.aborted) return STOPPED;

    if (route.lane === 'brain') return { kind: 'continue' };

    if (route.lane === 'skill') {
      input.onUpdate?.(route.skill.description);
      const result = await route.skill.run(route.slots, ctx);
      if (result.ok) return { kind: 'handled', status: 'done', summary: result.summary };
      if (result.declined) return { kind: 'handled', status: 'done', summary: 'Stopped: the approval was declined, so I did not go ahead.' };
      return { kind: 'continue', addendum: `The fast lane tried the "${route.skill.id}" shortcut and it failed: ${result.reason}` };
    }

    input.onUpdate?.('Working on the page...');
    const pilot = this.deps.runPilot ?? defaultRunPilot;
    const result = await pilot({
      goal: input.query,
      env: new BrowserPilotEnv(this.deps.browser()),
      engine: inference,
      handoffGapNats: inference.handoffGapNats(),
      shouldStop: () => input.signal?.aborted === true,
      onStep: (step) => input.onUpdate?.(step.description),
    });
    if (input.signal?.aborted) return STOPPED;

    if (result.status === 'done') {
      const n = result.steps.length;
      const seconds = (result.elapsedMs / 1000).toFixed(1);
      return { kind: 'handled', status: 'done', summary: `Done in ${n} step${n === 1 ? '' : 's'} (${seconds}s): ${result.steps.map((s) => s.description).join('; ')}` };
    }
    if (result.status === 'declined') {
      return { kind: 'handled', status: 'done', summary: 'Stopped: the approval was declined, so nothing more was done on the page.' };
    }
    return { kind: 'continue', addendum: describePilotHandoff(result) };
  }
}
