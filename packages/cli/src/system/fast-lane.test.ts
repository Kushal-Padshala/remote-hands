import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFastLaneConfig, SkillRegistry } from '@remote-hands/daemon';
import { resolveFastLane } from './fast-lane.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-flres-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function fakeInference(state: 'ready' | 'not-installed' | 'unsupported' | 'running', reason?: string) {
  return {
    status: vi.fn(() => ({ state, ...(reason ? { reason } : {}) })),
    prewarm: vi.fn(async () => true),
    decide: vi.fn(),
    handoffGapNats: () => 2,
    dispose: vi.fn(async () => {}),
    install: vi.fn(),
  };
}

const overrides = () => ({
  registry: new SkillRegistry(),
  frontmost: vi.fn(async () => ({ app: 'Finder', isBrowser: false })),
});

async function resolve(opts: { state: 'ready' | 'not-installed' | 'unsupported' | 'running'; reason?: string; enabled?: boolean; env?: Record<string, string> }) {
  if (opts.enabled !== undefined) writeFastLaneConfig(home, { enabled: opts.enabled });
  const inference = fakeInference(opts.state, opts.reason);
  const out: string[] = [];
  const over = overrides();
  const resolved = await resolveFastLane(
    { env: opts.env ?? {}, fastLane: { inference: inference as never, homeDir: home } },
    (m) => out.push(m),
    over,
  );
  return { resolved, inference, out, over };
}

describe('resolveFastLane', () => {
  it('is quiet when it is off and not installed', async () => {
    const r = await resolve({ state: 'not-installed' });
    expect(r.out).toEqual([]);
  });

  it('is quiet and absent on an unsupported machine that did not turn it on', async () => {
    const r = await resolve({ state: 'unsupported', reason: 'memory' });
    expect(r.resolved).toBeUndefined();
    expect(r.out).toEqual([]);
  });

  it('still returns a fast lane when it is on but not installed, with a hint, so installing later needs no restart', async () => {
    const r = await resolve({ state: 'not-installed', enabled: true });
    expect(r.resolved).toBeDefined();
    expect(r.out.join('\n')).toContain('rh fast-lane install');
    // nothing is installed yet: a request passes straight through
    expect(await r.resolved!.fastLane.attempt({ taskId: 't', query: 'anything' })).toEqual({ kind: 'continue' });
    expect(r.over.frontmost).not.toHaveBeenCalled();
  });

  it('says why it cannot run when it is on but unsupported, and has no fast lane', async () => {
    const r = await resolve({ state: 'unsupported', reason: 'The fast lane needs at least 8GB of memory to run the local model.', enabled: true });
    expect(r.resolved).toBeUndefined();
    expect(r.out.join('\n')).toContain('at least 8GB');
  });

  it('returns a fast lane when the model is installed, even while off, so turning it on needs no restart', async () => {
    const r = await resolve({ state: 'ready', enabled: false });
    expect(r.resolved).toBeDefined();
    await r.resolved!.fastLane.attempt({ taskId: 't', query: 'anything' });
    expect(r.over.frontmost).not.toHaveBeenCalled(); // disabled: it passes straight through
    writeFastLaneConfig(home, { enabled: true });
    await r.resolved!.fastLane.attempt({ taskId: 't', query: 'anything' });
    expect(r.over.frontmost).toHaveBeenCalled(); // now it tries
  });

  it('warms the model up only while it is on', async () => {
    const off = await resolve({ state: 'ready', enabled: false });
    off.resolved!.fastLane.prewarm();
    expect(off.inference.prewarm).not.toHaveBeenCalled();
    writeFastLaneConfig(home, { enabled: true });
    off.resolved!.fastLane.prewarm();
    expect(off.inference.prewarm).toHaveBeenCalledTimes(1);
  });

  it('honours RH_FAST_LANE', async () => {
    const r = await resolve({ state: 'ready', env: { RH_FAST_LANE: '1' } });
    await r.resolved!.fastLane.attempt({ taskId: 't', query: 'anything' });
    expect(r.over.frontmost).toHaveBeenCalled();
  });

  it('writes one privacy-safe record per request to the run log', async () => {
    const inference = fakeInference('ready');
    const over = { ...overrides(), frontmost: vi.fn(async () => ({ app: 'Finder', isBrowser: false })) };
    writeFastLaneConfig(home, { enabled: true });
    const resolved = await resolveFastLane({ env: {}, fastLane: { inference: inference as never, homeDir: home } }, () => {}, over);
    await resolved!.fastLane.attempt({ taskId: 't', query: 'a private request about hunter2' });
    const log = fs.readFileSync(path.join(home, '.remote-hands', 'fast-lane', 'runs.jsonl'), 'utf8');
    expect(log).toContain('"lane":"brain"');
    expect(log).not.toContain('hunter2');
  });

  it('stops the model process on dispose', async () => {
    const r = await resolve({ state: 'ready', enabled: true });
    await r.resolved!.dispose();
    expect(r.inference.dispose).toHaveBeenCalledTimes(1);
  });
});
