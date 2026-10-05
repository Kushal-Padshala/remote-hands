import { describe, expect, it, vi } from 'vitest';
import { routeRequest } from './conductor.js';
import { SkillRegistry } from './skills/registry.js';
import type { Skill, SkillContext } from './skills/types.js';
import type { DecideInput, DecideResult, DecisionEngine } from './types.js';

const ctx = {} as SkillContext;

const skill = (id: string, accepts: RegExp): Skill => ({
  id,
  description: id,
  extract: async (q) => (accepts.test(q) ? { q } : null),
  run: async () => ({ ok: true, summary: id }),
});

function engineChoosing(optionText: RegExp | null, gap = 5) {
  const asked: DecideInput[] = [];
  const engine: DecisionEngine = {
    decide: vi.fn(async (input: DecideInput): Promise<DecideResult> => {
      asked.push(input);
      const chosen = optionText === null ? undefined : input.options.find((o) => optionText.test(o.text));
      return { choice: chosen?.id ?? null, probabilities: {}, gapNats: chosen ? gap : 0, letterMass: 1, latencyMs: 1, promptTokens: 1 };
    }),
  };
  return { engine, asked };
}

const registry = () => {
  const r = new SkillRegistry();
  r.register(skill('open_app', /^open /i));
  return r;
};
const base = { query: 'fill in this form', frontApp: 'Google Chrome', frontIsBrowser: true, ctx, handoffGapNats: 2 };

describe('routeRequest', () => {
  it('routes a request a skill recognises to that skill without asking the model', async () => {
    const { engine } = engineChoosing(/^Yes/);
    const route = await routeRequest({ ...base, query: 'open spotify', registry: registry(), engine });
    expect(route).toMatchObject({ lane: 'skill', slots: { q: 'open spotify' } });
    expect((route as { skill: Skill }).skill.id).toBe('open_app');
    expect(engine.decide).not.toHaveBeenCalled();
  });

  it('sends everything to the brain when the front app is not a browser, without asking the model', async () => {
    const { engine } = engineChoosing(/^Yes/);
    const route = await routeRequest({ ...base, frontApp: 'Finder', frontIsBrowser: false, registry: registry(), engine });
    expect(route).toMatchObject({ lane: 'brain' });
    expect(engine.decide).not.toHaveBeenCalled();
  });

  it('routes a web-page request to the pilot when the model is clear', async () => {
    const { engine, asked } = engineChoosing(/^Yes/, 7.5);
    const route = await routeRequest({ ...base, registry: registry(), engine });
    expect(route).toEqual({ lane: 'pilot', gapNats: 7.5 });
    expect(asked[0]!.state).toContain('fill in this form');
    expect(asked[0]!.state).toContain('Google Chrome');
    expect(asked[0]!.options).toHaveLength(2);
  });

  it('routes to the brain when the model picks the other option', async () => {
    const { engine } = engineChoosing(/^No/, 9);
    expect(await routeRequest({ ...base, query: 'write a poem', registry: registry(), engine })).toMatchObject({ lane: 'brain' });
  });

  it('routes to the brain when the model is unsure', async () => {
    const { engine } = engineChoosing(/^Yes/, 1.2);
    const route = await routeRequest({ ...base, registry: registry(), engine });
    expect(route).toMatchObject({ lane: 'brain' });
    expect((route as { reason: string }).reason).toContain('not sure');
  });

  it('routes to the brain when the model makes no choice', async () => {
    const { engine } = engineChoosing(null);
    expect(await routeRequest({ ...base, registry: registry(), engine })).toMatchObject({ lane: 'brain' });
  });

  it('routes to the brain when the model fails', async () => {
    const engine: DecisionEngine = { decide: async () => { throw new Error('ECONNREFUSED'); } };
    const route = await routeRequest({ ...base, registry: registry(), engine });
    expect(route).toMatchObject({ lane: 'brain' });
    expect((route as { reason: string }).reason).toContain('ECONNREFUSED');
  });
});
