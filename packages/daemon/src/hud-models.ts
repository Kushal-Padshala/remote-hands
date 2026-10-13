import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A model the person can pick in the HUD. `model` and `effort` are what agy is started with. */
export interface HudModel {
  key: string;
  label: string;
  model: string;
  effort: string;
}

/** The models offered in the HUD, in the order shown. The first is what the HUD has always used. */
export const HUD_MODELS: readonly HudModel[] = [
  { key: 'gemini-flash-fast', label: 'Gemini 3.8 Flash · fast', model: 'gemini-3.8-flash', effort: 'low' },
  { key: 'gemini-flash-smart', label: 'Gemini 3.8 Flash · thinks more', model: 'gemini-3.8-flash', effort: 'high' },
  { key: 'claude-sonnet', label: 'Claude Sonnet 4.6', model: 'claude-sonnet-4-6', effort: 'low' },
  { key: 'claude-opus', label: 'Claude Opus 4.6 · most capable', model: 'claude-opus-4-6-thinking', effort: 'low' },
  { key: 'gpt-oss', label: 'GPT-OSS 120B', model: 'gpt-oss-120b-medium', effort: 'medium' },
];

export const DEFAULT_HUD_MODEL_KEY = 'gemini-flash-fast';

export function hudModelByKey(key: unknown): HudModel | undefined {
  return typeof key === 'string' ? HUD_MODELS.find((m) => m.key === key) : undefined;
}

/** The model for a key; anything unknown (an old file, a typo) is the default. */
export function resolveHudModel(key: unknown): HudModel {
  return hudModelByKey(key) ?? HUD_MODELS.find((m) => m.key === DEFAULT_HUD_MODEL_KEY)!;
}

const settingsFile = (home: string): string => path.join(home, '.remote-hands', 'hud-model.json');

/** The key the person chose last, or the default when nothing valid is saved. */
export function readHudModelKey(home: string = os.homedir()): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(home), 'utf-8')) as { model?: unknown };
    const found = hudModelByKey(parsed.model);
    if (found) return found.key;
  } catch {
    // no file yet, or unreadable: the default
  }
  return DEFAULT_HUD_MODEL_KEY;
}

/** Remembers the choice for the next task. An unknown key is ignored. Returns whether it was saved. */
export function writeHudModelKey(key: unknown, home: string = os.homedir()): boolean {
  const found = hudModelByKey(key);
  if (!found) return false;
  try {
    const file = settingsFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ model: found.key }), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `--effort` value to give agy, or undefined to leave it out. Claude models take none, and models that already
 * carry an effort in their name (`gpt-oss-120b-medium`) refuse a different one.
 */
export function effortFor(model: string, effort?: string | null): string | undefined {
  if (!effort) return undefined;
  const name = model.toLowerCase();
  if (name.includes('claude')) return undefined;
  const named = /-(low|medium|high)$/.exec(name)?.[1];
  if (named && named !== effort.toLowerCase()) return undefined;
  return effort;
}
