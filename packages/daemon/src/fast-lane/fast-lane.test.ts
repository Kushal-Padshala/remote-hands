import { describe, expect, it, vi } from 'vitest';
import { describePilotHandoff, FastLane, type FastLaneDeps } from './fast-lane.js';
import type { PilotBrowser } from './pilot/env.js';
import type { PilotResult, PilotView } from './pilot/types.js';
import { SkillRegistry } from './skills/registry.js';
import type { Skill, SkillContext } from './skills/types.js';
import type { DecideInput, DecideResult } from './types.js';

const view = (title: string, url = 'https://x.test/p'): PilotView => ({ title, url, elements: [], sameDocument: false, changed: true, stateUnavailable: false, notes: [] });

function inferenceFake(opts: { state?: 'ready' | 'running' | 'not-installed' | 'unsupported'; choose?: (i: DecideInput) => string | null; gap?: number } = {}) {
  const asked: DecideInput[] = [];
  return {
    asked,
    status: vi.fn(() => ({ state: opts.state ?? 'ready' }) as never),
    prewarm: vi.fn(async () => true),
    handoffGapNats: () => 2,
    decide: vi.fn(async (input: DecideInput): Promise<DecideResult> => {
      asked.push(input);
      const choice = opts.choose ? opts.choose(input) : null;
      return { choice, probabilities: {}, gapNats: choice === null ? 0 : (opts.gap ?? 6), letterMass: 1, latencyMs: 1, promptTokens: 1 };
    }),
  };
}

const skill = (id: string, accepts: RegExp, run: Skill['run']): Skill => ({ id, description: `do ${id}`, extract: async (q) => (accepts.test(q) ? { q } : null), run });

function build(over: Partial<FastLaneDeps> & { skills?: Skill[] } = {}) {
  const registry = new SkillRegistry();
  for (const s of over.skills ?? []) registry.register(s);
  const marker: Array<string | null> = [];
  const inference = (over.inference as ReturnType<typeof inferenceFake> | undefined) ?? inferenceFake();
  const deps: FastLaneDeps = {
    enabled: () => true,
    inference: inference as never,
    registry,
    skillContext: () => ({}) as SkillContext,
    browser: () => ({}) as PilotBrowser,
    frontmost: async () => ({ app: 'Google Chrome', isBrowser: true }),
    setActiveTask: (id) => marker.push(id),
    runPilot: vi.fn(async (): Promise<PilotResult> => ({ status: 'done', steps: [], elapsedMs: 0, finalView: view('End') })),
    ...over,
  } as FastLaneDeps;
  return { fl: new FastLane(deps), marker, inference, deps };
}

const input = (query: string, extra: Record<string, unknown> = {}) => ({ taskId: 't1', query, ...extra });

describe('FastLane.attempt: pass-through', () => {
  it('continues silently when disabled', async () => {
    const { fl, marker } = build({ enabled: () => false, skills: [skill('s', /x/, async () => ({ ok: true, summary: 'ran' }))] });
    expect(await fl.attempt(input('x'))).toEqual({ kind: 'continue' });
    expect(marker).toEqual([]);
  });

  it.each(['not-installed', 'unsupported'] as const)('continues silently when the model is %s', async (state) => {
    const { fl } = build({ inference: inferenceFake({ state }) as never, skills: [skill('s', /x/, async () => ({ ok: true, summary: 'ran' }))] });
    expect(await fl.attempt(input('x'))).toEqual({ kind: 'continue' });
  });

  it('continues with the brain when the router says brain', async () => {
    const { fl } = build({ inference: inferenceFake({ choose: (i) => i.options.find((o) => /^No/.test(o.text))!.id }) as never });
    expect(await fl.attempt(input('write a poem'))).toEqual({ kind: 'continue' });
  });

  it('continues when anything throws', async () => {
    const { fl, marker } = build({ frontmost: async () => { throw new Error('no window'); }, skills: [] });
    const out = await fl.attempt(input('write a poem'));
    expect(out.kind).toBe('continue');
    expect(marker.at(-1)).toBeNull();
  });
});

describe('FastLane.attempt: skills', () => {
  it('finishes the task with the skill summary', async () => {
    const run = vi.fn(async () => ({ ok: true as const, summary: 'Opened Spotify' }));
    const { fl } = build({ skills: [skill('open_app', /^open/, run)] });
    expect(await fl.attempt(input('open spotify'))).toEqual({ kind: 'handled', status: 'done', summary: 'Opened Spotify' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('tells the brain what failed when a skill fails', async () => {
    const { fl } = build({ skills: [skill('open_app', /^open/, async () => ({ ok: false as const, reason: 'Unable to find application' }))] });
    const out = await fl.attempt(input('open spotify'));
    expect(out).toEqual({ kind: 'continue', addendum: expect.stringContaining('open_app') });
    expect((out as { addendum: string }).addendum).toContain('Unable to find application');
  });

  it('stops without handing over when an approval is declined', async () => {
    const { fl } = build({ skills: [skill('messages_send', /^text/, async () => ({ ok: false as const, declined: true, reason: 'Approval rejected by user: no' }))] });
    const out = await fl.attempt(input('text John saying hi'));
    expect(out).toMatchObject({ kind: 'handled', status: 'done' });
    expect((out as { summary: string }).summary).toMatch(/stopped/i);
    expect((out as { summary: string }).summary).toContain('declined');
  });

  it('continues when a skill throws', async () => {
    const { fl } = build({ skills: [skill('s', /x/, async () => { throw new Error('boom'); })] });
    expect((await fl.attempt(input('x'))).kind).toBe('continue');
  });

  it('gives skills the decision model so ambiguous app names can be resolved', async () => {
    let seen: SkillContext | undefined;
    const { fl, inference } = build({ skills: [skill('s', /x/, async (_s, ctx) => { seen = ctx; return { ok: true, summary: 'ok' }; })] });
    await fl.attempt(input('x'));
    expect(seen?.decide).toBe(inference);
  });
});

describe('FastLane.attempt: pilot', () => {
  const pilotRouter = inferenceFake({ choose: (i) => i.options.find((o) => /^Yes/.test(o.text))!.id });

  it('finishes the task with a summary of the steps when the pilot is done', async () => {
    const steps = [
      { index: 1, op: 'click', description: 'click [6] button "Next"', gapNats: 5, decideMs: 400, actMs: 100, outcome: 'ok' as const },
      { index: 2, op: 'click', description: 'click [9] button "Finish"', gapNats: 5, decideMs: 400, actMs: 100, outcome: 'ok' as const },
    ];
    const { fl, deps } = build({ inference: pilotRouter as never, runPilot: vi.fn(async () => ({ status: 'done' as const, steps, elapsedMs: 1234, finalView: view('Thanks') })) });
    const out = await fl.attempt(input('finish the survey'));
    expect(out).toMatchObject({ kind: 'handled', status: 'done' });
    const summary = (out as { summary: string }).summary;
    expect(summary).toContain('2 steps');
    expect(summary).toContain('1.2s');
    expect(summary).toContain('click [6] button "Next"');
    const call = (deps.runPilot as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.goal).toBe('finish the survey');
    expect(call.handoffGapNats).toBe(2);
  });

  it('stops with a note when the user declines an approval during the pilot', async () => {
    const { fl } = build({ inference: pilotRouter as never, runPilot: vi.fn(async () => ({ status: 'declined' as const, reason: 'Approval rejected by user: no', steps: [], elapsedMs: 10, finalView: null })) });
    const out = await fl.attempt(input('buy it'));
    expect(out).toMatchObject({ kind: 'handled', status: 'done' });
    expect((out as { summary: string }).summary).toMatch(/stopped/i);
  });

  it('hands over to the brain with what was done and why it stopped', async () => {
    const result: PilotResult = {
      status: 'handoff', reason: 'low_margin', detail: 'top choices too close (gap 0.97 nats): tick [13] checkbox "A"', elapsedMs: 900,
      steps: [{ index: 1, op: 'check', description: 'select [2] radio "Somewhat confident"', gapNats: 20, decideMs: 400, actMs: 50, outcome: 'ok' }],
      finalView: view('Survey 3', 'https://app.example/s'),
    };
    const { fl } = build({ inference: pilotRouter as never, runPilot: vi.fn(async () => result) });
    const out = await fl.attempt(input('finish the survey'));
    expect(out.kind).toBe('continue');
    const addendum = (out as { addendum: string }).addendum;
    expect(addendum).toContain('select [2] radio "Somewhat confident"');
    expect(addendum).toContain('top choices too close');
    expect(addendum).toContain('Survey 3');
  });

  it('treats a stop request as handled so the coordinator cancels the task', async () => {
    const controller = new AbortController();
    const { fl } = build({
      inference: pilotRouter as never,
      runPilot: vi.fn(async (args: { shouldStop?: () => boolean }) => {
        controller.abort();
        expect(args.shouldStop?.()).toBe(true);
        return { status: 'handoff' as const, reason: 'budget' as const, detail: 'stopped by the user', steps: [], elapsedMs: 5, finalView: null };
      }),
    });
    const out = await fl.attempt(input('finish the survey', { signal: controller.signal }));
    expect(out).toEqual({ kind: 'handled', status: 'done', summary: 'Stopped.' });
  });

  it('reports each step to the HUD as it happens', async () => {
    const updates: string[] = [];
    const { fl } = build({
      inference: pilotRouter as never,
      runPilot: vi.fn(async (args: { onStep?: (s: never) => void }) => {
        args.onStep?.({ description: 'click [1] button "Go"' } as never);
        return { status: 'done' as const, steps: [], elapsedMs: 1, finalView: view('End') };
      }),
    });
    await fl.attempt(input('go', { onUpdate: (t: string) => updates.push(t) }));
    expect(updates).toContain('click [1] button "Go"');
  });
});

describe('FastLane.attempt: the active-task marker (approval gate)', () => {
  it('is set for the whole attempt and cleared afterwards, also on error and on abort', async () => {
    const a = build({ skills: [skill('s', /x/, async () => ({ ok: true, summary: 'ok' }))] });
    await a.fl.attempt(input('x'));
    expect(a.marker).toEqual(['t1', null]);

    const b = build({ skills: [skill('s', /x/, async () => { throw new Error('boom'); })] });
    await b.fl.attempt(input('x'));
    expect(b.marker).toEqual(['t1', null]);

    const controller = new AbortController();
    controller.abort();
    const c = build({ skills: [skill('s', /x/, async () => ({ ok: true, summary: 'ok' }))] });
    expect(await c.fl.attempt(input('x', { signal: controller.signal }))).toEqual({ kind: 'handled', status: 'done', summary: 'Stopped.' });
    expect(c.marker.at(-1) ?? null).toBeNull();
  });
});

describe('FastLane.prewarm', () => {
  it('prewarms the model when enabled and not at all when disabled', () => {
    const on = build();
    on.fl.prewarm();
    expect(on.inference.prewarm).toHaveBeenCalledTimes(1);
    const off = build({ enabled: () => false });
    off.fl.prewarm();
    expect(off.inference.prewarm).not.toHaveBeenCalled();
  });

  it('never throws', () => {
    const inf = inferenceFake();
    inf.prewarm = vi.fn(async () => { throw new Error('x'); });
    expect(() => build({ inference: inf as never }).fl.prewarm()).not.toThrow();
  });
});

describe('describePilotHandoff', () => {
  const steps = [
    { index: 1, op: 'fill', description: 'fill [3] textbox "Email" with email', gapNats: 9, decideMs: 1, actMs: 1, outcome: 'ok' as const },
    { index: 2, op: 'click', description: 'click [4] button "Next"', gapNats: 9, decideMs: 1, actMs: 1, outcome: 'no-change' as const },
  ];

  it('lists the steps, the reason and the page, without any typed value', () => {
    const text = describePilotHandoff({ status: 'handoff', reason: 'no_progress', detail: 'two actions in a row changed nothing on the page', steps, elapsedMs: 1, finalView: view('Sign in', 'https://x.test/login') });
    expect(text).toContain('1. fill [3] textbox "Email" with email');
    expect(text).toContain('2. click [4] button "Next" (nothing changed)');
    expect(text).toContain('two actions in a row changed nothing');
    expect(text).toContain('"Sign in" (https://x.test/login)');
  });

  it('says so when it did nothing', () => {
    const text = describePilotHandoff({ status: 'handoff', reason: 'low_margin', detail: 'too close', steps: [], elapsedMs: 1, finalView: null });
    expect(text).toContain('did not act');
    expect(text).toContain('too close');
  });
});
