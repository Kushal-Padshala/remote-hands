import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendRunRecord, readFastLaneConfig } from '@remote-hands/daemon';
import { main } from '../index.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-flcli-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

type Status = { state: 'unsupported' | 'not-installed' | 'ready' | 'running'; reason?: string; model?: string; tier?: 'standard' | 'lite'; handoffGapNats?: number };

function run(args: string[], opts: { status?: Status; install?: ReturnType<typeof vi.fn>; env?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const inference = {
    status: vi.fn(() => (opts.status ?? { state: 'not-installed', model: 'qwen3-4b-instruct-2507-q4km', tier: 'standard' }) as never),
    install: opts.install ?? vi.fn(async () => {}),
  };
  const code = main(['fast-lane', ...args], {
    stdout: (m) => out.push(m),
    stderr: (m) => err.push(m),
    env: opts.env ?? {},
    fastLane: { inference: inference as never, homeDir: home, totalRamBytes: 16 * 2 ** 30 },
  });
  return { code, out, err, inference };
}

const text = (lines: string[]) => lines.join('\n');

describe('rh fast-lane status', () => {
  it('is the default command and explains a machine without the model in plain words', async () => {
    const r = run([]);
    expect(await r.code).toBe(0);
    const t = text(r.out);
    expect(t).toContain('Fast lane: off');
    expect(t).toContain('not installed');
    expect(t).toContain('Qwen3 4B Instruct');
    expect(t).toContain('rh fast-lane install');
  });

  it('shows on and ready, and what to do to turn it off', async () => {
    await run(['enable'], { status: { state: 'ready', model: 'qwen3-4b-instruct-2507-q4km', tier: 'standard' } }).code;
    const r = run(['status'], { status: { state: 'ready', model: 'qwen3-4b-instruct-2507-q4km', tier: 'standard' } });
    expect(await r.code).toBe(0);
    const t = text(r.out);
    expect(t).toContain('Fast lane: on');
    expect(t).toContain('ready');
    expect(t).toContain('rh fast-lane disable');
  });

  it('reports why an unsupported machine cannot use it', async () => {
    const r = run(['status'], { status: { state: 'unsupported', reason: 'The fast lane needs at least 8GB of memory to run the local model.' } });
    expect(await r.code).toBe(0);
    expect(text(r.out)).toContain('not supported');
    expect(text(r.out)).toContain('at least 8GB');
  });

  it('shows how the recent requests went', async () => {
    for (const elapsedMs of [900, 1100, 1300]) appendRunRecord(home, { at: '2026-10-04T10:00:00.000Z', lane: 'skill', result: 'handled', elapsedMs });
    appendRunRecord(home, { at: '2026-10-04T10:00:00.000Z', lane: 'brain', result: 'continued', elapsedMs: 200 });
    const r = run(['status'], { status: { state: 'ready', model: 'qwen3-4b-instruct-2507-q4km', tier: 'standard' } });
    await r.code;
    expect(text(r.out)).toContain('Recent:    3 of 4 requests finished by the fast lane (median 1.1s)');
  });

  it('says when RH_FAST_LANE decides, not the file', async () => {
    const r = run(['status'], { env: { RH_FAST_LANE: '1' } });
    await r.code;
    expect(text(r.out)).toContain('Fast lane: on');
    expect(text(r.out)).toContain('RH_FAST_LANE');
  });
});

describe('rh fast-lane install', () => {
  it('installs, shows progress and says how to turn it on', async () => {
    const install = vi.fn(async (onProgress?: (stage: string, done: number, total: number) => void) => {
      onProgress?.('runtime', 0, 100);
      onProgress?.('runtime', 100, 100);
      onProgress?.('model', 5, 100);
      onProgress?.('model', 55, 100);
      onProgress?.('model', 100, 100);
    });
    const r = run(['install'], { install: install as never });
    expect(await r.code).toBe(0);
    const t = text(r.out);
    expect(t).toContain('Runtime: 100%');
    expect(t).toContain('Model: 50%');
    expect(t).toContain('Model: 100%');
    expect(t).toContain('rh fast-lane enable');
  });

  it('refuses an unsupported machine with the reason and downloads nothing', async () => {
    const install = vi.fn();
    const r = run(['install'], { status: { state: 'unsupported', reason: 'not enough memory' }, install: install as never });
    expect(await r.code).toBe(1);
    expect(text(r.err)).toContain('not enough memory');
    expect(install).not.toHaveBeenCalled();
  });

  it('reports a failed download without a stack trace', async () => {
    const r = run(['install'], { install: vi.fn(async () => { throw new Error('checksum mismatch for model.gguf'); }) as never });
    expect(await r.code).toBe(1);
    expect(text(r.err)).toContain('checksum mismatch');
    expect(text(r.err)).not.toContain('    at ');
  });

  it('accepts the size as a separate word too', async () => {
    const ok = run(['install', '--tier', 'lite']);
    expect(await ok.code).toBe(0);
    expect(readFastLaneConfig(home, {}).tier).toBe('lite');
  });

  it('keeps the old size setting when the install of the new one fails', async () => {
    expect(await run(['install', '--tier=standard']).code).toBe(0);
    const failed = run(['install', '--tier=lite'], { install: vi.fn(async () => { throw new Error('offline'); }) as never });
    expect(await failed.code).toBe(1);
    expect(readFastLaneConfig(home, {}).tier).toBe('standard');
  });

  it('remembers a chosen tier and rejects an unknown one', async () => {
    const ok = run(['install', '--tier=lite']);
    expect(await ok.code).toBe(0);
    expect(readFastLaneConfig(home, {}).tier).toBe('lite');
    const bad = run(['install', '--tier=huge']);
    expect(await bad.code).toBe(1);
    expect(text(bad.err)).toContain('standard or lite');
  });
});

describe('rh fast-lane enable and disable', () => {
  const ready: Status = { state: 'ready', model: 'qwen3-4b-instruct-2507-q4km', tier: 'standard' };

  it('refuses to turn on before the model is installed', async () => {
    const r = run(['enable'], { status: { state: 'not-installed', model: 'x', tier: 'standard' } });
    expect(await r.code).toBe(1);
    expect(text(r.err)).toContain('rh fast-lane install');
    expect(readFastLaneConfig(home, {}).enabled).toBe(false);
  });

  it('turns on and off', async () => {
    const on = run(['enable'], { status: ready });
    expect(await on.code).toBe(0);
    expect(readFastLaneConfig(home, {}).enabled).toBe(true);
    const off = run(['disable'], { status: ready });
    expect(await off.code).toBe(0);
    expect(readFastLaneConfig(home, {}).enabled).toBe(false);
    expect(text(off.out)).toContain('straight to the agent');
  });

  it('tells you when RH_FAST_LANE overrides the setting you just changed', async () => {
    const r = run(['enable'], { status: ready, env: { RH_FAST_LANE: '0' } });
    expect(await r.code).toBe(0);
    expect(text(r.out)).toContain('RH_FAST_LANE');
  });

  it('can always turn off, even without the model', async () => {
    const r = run(['disable'], { status: { state: 'unsupported', reason: 'x' } });
    expect(await r.code).toBe(0);
  });
});

describe('rh fast-lane help', () => {
  it('prints usage for help and for an unknown subcommand', async () => {
    const help = run(['--help']);
    expect(await help.code).toBe(0);
    expect(text(help.out)).toContain('status');
    expect(text(help.out)).toContain('install');
    const unknown = run(['frobnicate']);
    expect(await unknown.code).toBe(1);
    expect(text(unknown.err)).toContain('Usage');
  });
});
