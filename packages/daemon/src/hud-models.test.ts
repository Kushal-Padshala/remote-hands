import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWarmAgyArgs } from './warm-agy-session.js';
import { buildAgyArgs } from './agy-runner.js';
import {
  DEFAULT_HUD_MODEL_KEY,
  HUD_MODELS,
  effortFor,
  readHudModelKey,
  resolveHudModel,
  writeHudModelKey,
} from './hud-models.js';

const homes: string[] = [];
const tmpHome = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-hud-model-'));
  homes.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('HUD models', () => {
  it('starts with what the HUD has always used, and every key is unique', () => {
    expect(HUD_MODELS[0]).toMatchObject({ key: DEFAULT_HUD_MODEL_KEY, model: 'gemini-3.8-flash', effort: 'low' });
    expect(new Set(HUD_MODELS.map((m) => m.key)).size).toBe(HUD_MODELS.length);
  });

  it('falls back to the default for anything it does not know', () => {
    for (const bad of [undefined, null, '', 'nope', 42, {}]) expect(resolveHudModel(bad).key).toBe(DEFAULT_HUD_MODEL_KEY);
    expect(resolveHudModel('claude-sonnet').model).toBe('claude-sonnet-4-6');
  });

  it('remembers a choice between runs and ignores a broken or unknown file', () => {
    const home = tmpHome();
    expect(readHudModelKey(home)).toBe(DEFAULT_HUD_MODEL_KEY);
    expect(writeHudModelKey('claude-opus', home)).toBe(true);
    expect(readHudModelKey(home)).toBe('claude-opus');
    expect(writeHudModelKey('made-up', home)).toBe(false);
    expect(readHudModelKey(home)).toBe('claude-opus');
    fs.writeFileSync(path.join(home, '.remote-hands', 'hud-model.json'), '{not json');
    expect(readHudModelKey(home)).toBe(DEFAULT_HUD_MODEL_KEY);
    fs.writeFileSync(path.join(home, '.remote-hands', 'hud-model.json'), JSON.stringify({ model: 'gone' }));
    expect(readHudModelKey(home)).toBe(DEFAULT_HUD_MODEL_KEY);
  });

  it('does not fail when the home cannot be written', () => {
    const file = path.join(tmpHome(), 'a-file');
    fs.writeFileSync(file, 'x');
    expect(writeHudModelKey('claude-opus', file)).toBe(false);
  });

  it('leaves --effort out where agy would refuse it', () => {
    expect(effortFor('gemini-3.8-flash', 'low')).toBe('low');
    expect(effortFor('gemini-3.8-flash', 'high')).toBe('high');
    expect(effortFor('claude-sonnet-4-6', 'low')).toBeUndefined();
    expect(effortFor('gpt-oss-120b-medium', 'low')).toBeUndefined();
    expect(effortFor('gpt-oss-120b-medium', 'medium')).toBe('medium');
    expect(effortFor('gemini-3.8-flash', undefined)).toBeUndefined();
  });

  it('starts agy with arguments it accepts for every model in the list', () => {
    for (const m of HUD_MODELS) {
      const warm = buildWarmAgyArgs({ model: m.model, effort: m.effort });
      expect(warm[warm.indexOf('--model') + 1]).toBe(m.model);
      const effort = effortFor(m.model, m.effort);
      expect(warm.includes('--effort')).toBe(effort !== undefined);
      if (effort) expect(warm[warm.indexOf('--effort') + 1]).toBe(effort);
      const task = { id: 't', prompt: 'p', model: m.model, effort: m.effort } as Parameters<typeof buildAgyArgs>[0];
      const cold = buildAgyArgs(task, { agyCommand: 'agy', systemPrompt: 's' });
      expect(cold.includes('--effort')).toBe(effort !== undefined);
    }
  });
});
