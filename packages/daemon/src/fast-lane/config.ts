import fs from 'node:fs';
import path from 'node:path';
import type { ModelTier } from './inference/catalog.js';

export interface FastLaneConfig {
  enabled: boolean;
  tier?: ModelTier;
}

export function fastLaneConfigPath(homeDir: string): string {
  return path.join(homeDir, '.remote-hands', 'fast-lane', 'config.json');
}

function readFile(homeDir: string): FastLaneConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(fastLaneConfigPath(homeDir), 'utf8'));
  } catch {
    return { enabled: false };
  }
  if (typeof raw !== 'object' || raw === null) return { enabled: false };
  const file = raw as { enabled?: unknown; tier?: unknown };
  const config: FastLaneConfig = { enabled: file.enabled === true };
  if (file.tier === 'standard' || file.tier === 'lite') config.tier = file.tier;
  return config;
}

/** The fast lane is off unless the file or `RH_FAST_LANE` (1/true/on or 0/false/off) says otherwise. */
export function readFastLaneConfig(homeDir: string, env: Record<string, string | undefined>): FastLaneConfig {
  const config = readFile(homeDir);
  const override = env.RH_FAST_LANE?.trim().toLowerCase();
  if (override === '1' || override === 'true' || override === 'on') config.enabled = true;
  else if (override === '0' || override === 'false' || override === 'off') config.enabled = false;
  return config;
}

export function writeFastLaneConfig(homeDir: string, patch: Partial<FastLaneConfig>): FastLaneConfig {
  const next: FastLaneConfig = { ...readFile(homeDir), ...patch };
  const file = fastLaneConfigPath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
  fs.renameSync(temporary, file);
  return next;
}
