import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODELS, RUNTIMES } from './catalog.js';
import { FastLaneInference } from './service.js';

const GB = 2 ** 30;
const hw = (gb: number, platform: NodeJS.Platform = 'darwin') => ({ platform, arch: 'arm64', totalRamBytes: gb * GB });
const standard = MODELS.find((m) => m.tier === 'standard')!;
const lite = MODELS.find((m) => m.tier === 'lite')!;
const runtime = RUNTIMES.find((r) => r.platform === 'darwin-arm64')!;

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-svc-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const fl = (...p: string[]) => path.join(home, '.remote-hands', 'fast-lane', ...p);

function fakes() {
  const download = vi.fn(async (req: { destination: string; bytes: number; onProgress?: (d: number, t: number) => void }) => {
    fs.mkdirSync(path.dirname(req.destination), { recursive: true });
    fs.closeSync(fs.openSync(req.destination, 'w'));
    fs.truncateSync(req.destination, req.bytes); // sparse: no real 2.5GB on disk
    req.onProgress?.(req.bytes, req.bytes);
    return req.destination;
  });
  const ensureRuntime = vi.fn(async (entry: typeof runtime, o: { homeDir: string }) => {
    const serverPath = path.join(o.homeDir, '.remote-hands', 'fast-lane', 'runtime', `${entry.build}-${entry.platform}`, entry.archiveDir, 'llama-server');
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
    fs.writeFileSync(serverPath, '#!/bin/sh\n', { mode: 0o755 });
    return { serverPath };
  });
  const sidecars: any[] = [];
  const createSidecar = vi.fn((o: { serverPath: string; modelPath: string; contextTokens: number }) => {
    let running = false;
    const sc = {
      opts: o,
      ensureStarted: vi.fn(async () => {
        running = true;
      }),
      stop: vi.fn(async () => {
        running = false;
      }),
      isRunning: () => running,
      touch: vi.fn(),
      baseUrl: () => 'http://127.0.0.1:1',
      apiKey: () => 'k',
    };
    sidecars.push(sc);
    return sc;
  });
  const fetchFn = vi.fn(async () =>
    new Response(JSON.stringify({ completion_probabilities: [{ top_logprobs: [{ token: 'A', logprob: -0.1 }, { token: 'B', logprob: -3 }] }], tokens_evaluated: 10 }), { status: 200 }),
  );
  return { download, ensureRuntime, createSidecar, sidecars, fetch: fetchFn };
}

const make = (gb: number, f = fakes(), platform: NodeJS.Platform = 'darwin') =>
  ({ f, svc: new FastLaneInference({ homeDir: home, hardware: hw(gb, platform), deps: f as any }) });

describe('FastLaneInference.status', () => {
  it('reports unsupported hardware with the reason, and decide refuses', async () => {
    const { svc } = make(4);
    expect(svc.status()).toMatchObject({ state: 'unsupported' });
    expect(svc.status().reason).toMatch(/memory/i);
    await expect(svc.decide({ state: 's', question: 'q', options: [{ id: 'a', text: 'a' }] })).rejects.toThrow('not available');
  });

  it('reports not-installed when nothing has been downloaded', () => {
    const { svc } = make(16);
    expect(svc.status()).toMatchObject({ state: 'not-installed', model: standard.id, tier: 'standard', handoffGapNats: 2.0 });
  });

  it('uses the lite model and its threshold on an 8GB machine', () => {
    const { svc } = make(8);
    expect(svc.status()).toMatchObject({ state: 'not-installed', model: lite.id, tier: 'lite', handoffGapNats: 1.5 });
    expect(svc.handoffGapNats()).toBe(1.5);
  });
});

describe('FastLaneInference.install', () => {
  it('installs the runtime then the pinned model, writes the state marker and becomes ready', async () => {
    const { svc, f } = make(16);
    const progress: Array<[string, number, number]> = [];
    await svc.install((stage, done, total) => progress.push([stage, done, total]));
    expect(f.ensureRuntime).toHaveBeenCalledWith(runtime, expect.objectContaining({ homeDir: home }));
    const req = f.download.mock.calls[0]![0] as any;
    expect(req.url).toContain(standard.commit);
    expect(req.sha256).toBe(standard.sha256);
    expect(req.destination).toBe(fl('models', standard.file));
    expect(progress.some(([stage]) => stage === 'model')).toBe(true);
    const state = JSON.parse(fs.readFileSync(fl('state.json'), 'utf8'));
    expect(state).toMatchObject({ version: 1, modelId: standard.id, runtimeBuild: runtime.build, verified: true });
    expect(svc.status().state).toBe('ready');
  });

  it('refuses to install on unsupported hardware', async () => {
    const { svc, f } = make(4);
    await expect(svc.install()).rejects.toThrow(/memory/i);
    expect(f.download).not.toHaveBeenCalled();
  });

  it('is not ready again if the model file is truncated afterwards', async () => {
    const { svc } = make(16);
    await svc.install();
    fs.truncateSync(fl('models', standard.file), standard.bytes - 1);
    expect(svc.status().state).toBe('not-installed');
  });

  it('is not ready if the state marker names a different model', async () => {
    const { svc } = make(16);
    await svc.install();
    const state = JSON.parse(fs.readFileSync(fl('state.json'), 'utf8'));
    fs.writeFileSync(fl('state.json'), JSON.stringify({ ...state, modelId: 'something-else' }));
    expect(svc.status().state).toBe('not-installed');
  });

  it('ignores a corrupt state file', async () => {
    const { svc } = make(16);
    await svc.install();
    fs.writeFileSync(fl('state.json'), '{not json');
    expect(svc.status().state).toBe('not-installed');
  });
});

describe('FastLaneInference runtime use', () => {
  it('prewarm returns false and never throws when not installed', async () => {
    const { svc, f } = make(16);
    await expect(svc.prewarm()).resolves.toBe(false);
    expect(f.createSidecar).not.toHaveBeenCalled();
  });

  it('prewarm swallows a sidecar start failure and reports false', async () => {
    const { svc, f } = make(16);
    await svc.install();
    f.createSidecar.mockImplementationOnce(() => ({
      ensureStarted: async () => {
        throw new Error('boom');
      },
      stop: async () => {},
      isRunning: () => false,
      touch: () => {},
      baseUrl: () => '',
      apiKey: () => '',
    }) as any);
    await expect(svc.prewarm()).resolves.toBe(false);
  });

  it('decide starts the sidecar once, reuses it and reports running', async () => {
    const { svc, f } = make(16);
    await svc.install();
    const input = { state: 's', question: 'q', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] };
    const r1 = await svc.decide(input);
    await svc.decide(input);
    expect(r1.choice).toBe('a');
    expect(f.createSidecar).toHaveBeenCalledTimes(1);
    expect(f.sidecars[0].opts).toMatchObject({ modelPath: fl('models', standard.file), contextTokens: standard.contextTokens });
    expect(svc.status().state).toBe('running');
  });

  it('dispose stops the sidecar', async () => {
    const { svc, f } = make(16);
    await svc.install();
    await svc.prewarm();
    await svc.dispose();
    expect(f.sidecars[0].stop).toHaveBeenCalled();
    expect(svc.status().state).toBe('ready');
  });
});
