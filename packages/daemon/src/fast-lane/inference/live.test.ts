/**
 * Live decision-quality test against the real llama-server and a real model. Skipped unless
 * RH_FASTLANE_LIVE=1, so the normal suite never loads a model. Needs:
 *   FAST_LANE_SERVER_PATH  path to llama-server
 *   FAST_LANE_MODEL_PATH   path to the GGUF file
 *   FAST_LANE_TIER         'standard' (default) or 'lite'
 * Run: RH_FASTLANE_LIVE=1 FAST_LANE_SERVER_PATH=... FAST_LANE_MODEL_PATH=... npx vitest run packages/daemon/src/fast-lane/inference/live.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODELS } from './catalog.js';
import { LlamaDecisionEngine } from './decide.js';
import { LlamaSidecar } from './server.js';

const live = process.env.RH_FASTLANE_LIVE === '1';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__');

interface GoldItem {
  id: string;
  set: 'router' | 'element' | 'policy';
  state: string;
  question: string;
  options: Record<string, string>;
  gold: string;
}

const load = (file: string): GoldItem[] => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

describe.skipIf(!live)('local decision model (live)', () => {
  const tier = process.env.FAST_LANE_TIER === 'lite' ? 'lite' : 'standard';
  const model = MODELS.find((m) => m.tier === tier)!;
  let sidecar: LlamaSidecar;
  let engine: LlamaDecisionEngine;

  beforeAll(async () => {
    sidecar = new LlamaSidecar({
      serverPath: process.env.FAST_LANE_SERVER_PATH!,
      modelPath: process.env.FAST_LANE_MODEL_PATH!,
      contextTokens: model.contextTokens,
    });
    await sidecar.start();
    engine = new LlamaDecisionEngine(sidecar, model.promptFormat);
  }, 120_000);

  afterAll(async () => {
    await sidecar?.stop();
  });

  async function accuracy(items: GoldItem[]): Promise<{ acc: number; medianMs: number }> {
    let ok = 0;
    const latencies: number[] = [];
    for (const item of items) {
      const options = Object.entries(item.options).map(([id, text]) => ({ id, text }));
      const r = await engine.decide({ state: item.state, question: item.question, options });
      if (r.choice === item.gold) ok++;
      latencies.push(r.latencyMs);
    }
    latencies.sort((a, b) => a - b);
    return { acc: ok / items.length, medianMs: latencies[Math.floor(latencies.length / 2)]! };
  }

  const floor = tier === 'standard' ? 0.9 : 0.8;

  it(`routes requests at or above ${floor}`, async () => {
    const r = await accuracy(load('gold.json').filter((i) => i.set === 'router'));
    console.log('router', r);
    expect(r.acc).toBeGreaterThanOrEqual(floor);
  }, 120_000);

  it(`picks elements at or above ${floor}`, async () => {
    const r = await accuracy(load('gold.json').filter((i) => i.set === 'element'));
    console.log('element', r);
    expect(r.acc).toBeGreaterThanOrEqual(floor);
  }, 120_000);

  it('answers a decision in well under a second once warm', async () => {
    const r = await accuracy(load('gold.json').filter((i) => i.set === 'router').slice(0, 10));
    expect(r.medianMs).toBeLessThan(1000);
  }, 120_000);
});
