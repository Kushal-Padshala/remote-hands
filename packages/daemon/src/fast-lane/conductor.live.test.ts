/**
 * Live router check: pilot-versus-brain decisions by the real local model. Skipped unless
 * RH_FASTLANE_LIVE=1 (same env as inference/live.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeRequest } from './conductor.js';
import { MODELS } from './inference/catalog.js';
import { LlamaDecisionEngine } from './inference/decide.js';
import { LlamaSidecar } from './inference/server.js';
import { SkillRegistry } from './skills/registry.js';
import type { SkillContext } from './skills/types.js';

const live = process.env.RH_FASTLANE_LIVE === '1';

const PILOT = [
  'complete this survey for me',
  'fill out the contact form on this page',
  'click next until the form is submitted',
  'sign in with my saved account',
  'add the cheapest laptop to the cart',
  'search for flights from Zurich to London',
  'accept the cookies and open the pricing page',
  'select the economy cabin and continue',
  'go through the checkout steps up to the payment page',
  'fill in my shipping details',
  'scroll down and click the download button',
  'open the second search result',
];
const BRAIN = [
  'write a short story about a lighthouse keeper',
  'draft a polite reply declining this meeting',
  'fix the failing unit test in my repo',
  'research the best rental marketing strategy for a small flat',
  'summarize this article in three sentences',
  'why is my node server using so much memory',
  'compare these two pricing plans and tell me which is cheaper over 3 years',
  'plan a three step migration from sqlite to postgres',
  'write a cover letter for a data analyst job',
  'download the invoices, rename them by date and ask the coding agent to build a spreadsheet',
  'what is the capital of Australia',
  'refactor this function to be faster',
];

describe.skipIf(!live)('router: pilot versus brain (live)', () => {
  const tier = process.env.FAST_LANE_TIER === 'lite' ? 'lite' : 'standard';
  const model = MODELS.find((m) => m.tier === tier)!;
  let sidecar: LlamaSidecar;
  let engine: LlamaDecisionEngine;

  beforeAll(async () => {
    sidecar = new LlamaSidecar({ serverPath: process.env.FAST_LANE_SERVER_PATH!, modelPath: process.env.FAST_LANE_MODEL_PATH!, contextTokens: model.contextTokens });
    await sidecar.start();
    engine = new LlamaDecisionEngine(sidecar, model.promptFormat);
  }, 120_000);
  afterAll(async () => {
    await sidecar?.stop();
  });

  async function lane(query: string): Promise<string> {
    const route = await routeRequest({
      query,
      frontApp: 'Google Chrome',
      frontIsBrowser: true,
      registry: new SkillRegistry(),
      ctx: {} as SkillContext,
      engine,
      handoffGapNats: model.handoffGapNats,
    });
    return route.lane;
  }

  it('sends page tasks to the pilot and everything else to the brain, mostly correctly', async () => {
    const wrongPilot: string[] = [];
    const wrongBrain: string[] = [];
    for (const q of PILOT) if ((await lane(q)) === 'skill') wrongPilot.push(q);
    let pilotRight = 0;
    for (const q of PILOT) if ((await lane(q)) === 'pilot') pilotRight++;
    let brainRight = 0;
    for (const q of BRAIN) {
      const l = await lane(q);
      if (l === 'brain') brainRight++;
      else wrongBrain.push(`${q} -> ${l}`);
    }
    console.log(JSON.stringify({ tier, pilotRight: `${pilotRight}/${PILOT.length}`, brainRight: `${brainRight}/${BRAIN.length}`, wrongBrain }));
    // Sending a request that needs the brain to the pilot is the costly mistake (it acts); the
    // opposite only costs speed. So the brain side must be near-perfect.
    expect(brainRight / BRAIN.length).toBeGreaterThanOrEqual(0.9);
    expect(pilotRight / PILOT.length).toBeGreaterThanOrEqual(0.5);
    expect(wrongPilot).toEqual([]);
  }, 300_000);
});
