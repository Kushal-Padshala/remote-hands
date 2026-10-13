import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AX_BUILD_FAILURE_TTL_MS,
  AxHelperClient,
  AxHelperError,
  axBinaryIsCurrent,
  axHelperEnabledByDefault,
  axHelperPaths,
  ensureAxHelperBinary,
  type AxSnapshot,
} from './ax-helper.js';

// A stand-in for rh-ax that speaks the same protocol, so no Accessibility permission or app is needed.
const FAKE = String.raw`
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let r; try { r = JSON.parse(line); } catch { process.stdout.write('this is not json\n'); return; }
  switch (r.op) {
    case 'ping': out({ id: r.id, ok: true, version: 1, trusted: true, pid: process.pid }); break;
    case 'snapshot': out({ id: r.id, ok: true, app: { name: r.app || 'Front', pid: 1 }, nodes: [{ id: 1, parent: 0, role: 'AXWindow' }], truncated: false, timedOut: false, elapsedMs: 3 }); break;
    case 'fail': out({ id: r.id, ok: false, error: 'stale', message: 'gone' }); break;
    case 'hang': break;
    case 'die': process.exit(1); break;
    case 'slow': setTimeout(() => out({ id: r.id, ok: true, tag: r.tag }), r.ms); break;
    case 'split': { const text = JSON.stringify({ id: r.id, ok: true, tag: 'split' }) + '\n'; process.stdout.write(text.slice(0, 9)); setTimeout(() => process.stdout.write(text.slice(9)), 30); break; }
    default: out({ id: r.id, ok: true, echo: r });
  }
});
`;

let dir: string;
let script: string;
const clients: AxHelperClient[] = [];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-ax-test-'));
  script = path.join(dir, 'fake.mjs');
  fs.writeFileSync(script, FAKE);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
});

function make(over: ConstructorParameters<typeof AxHelperClient>[0] = {}): AxHelperClient {
  const c = new AxHelperClient({ enabled: true, launch: () => ({ command: process.execPath, args: [script] }), ...over });
  clients.push(c);
  return c;
}

describe('AxHelperClient', () => {
  it('starts on demand, answers a ping and returns a snapshot reply', async () => {
    const c = make();
    expect(await c.ready()).toBe(true);
    const snap = await c.request<AxSnapshot>({ op: 'snapshot', app: 'Finder' });
    expect(snap.app.name).toBe('Finder');
    expect(snap.nodes).toHaveLength(1);
  });

  it('turns an ok:false reply into an AxHelperError with the helper\'s code', async () => {
    const c = make();
    const err = await c.request({ op: 'fail' }).catch((e) => e);
    expect(err).toBeInstanceOf(AxHelperError);
    expect(err).toMatchObject({ code: 'stale', message: 'gone' });
  });

  it('matches replies to requests by id even when they arrive out of order', async () => {
    const c = make();
    const slow = c.request<{ ok: true; tag: string }>({ op: 'slow', ms: 120, tag: 'first' });
    const fast = c.request<{ ok: true; tag: string }>({ op: 'slow', ms: 5, tag: 'second' });
    expect((await fast).tag).toBe('second');
    expect((await slow).tag).toBe('first');
  });

  it('reassembles a reply that arrives in pieces and ignores lines that are not JSON', async () => {
    const c = make();
    const reply = await c.request<{ ok: true; tag: string }>({ op: 'split' });
    expect(reply.tag).toBe('split');
    await expect(c.request({ op: 'garbage-then-ok' })).resolves.toMatchObject({ ok: true });
  });

  it('times out a hung helper, replaces it, and the next request works on a fresh process', async () => {
    const c = make({ requestTimeoutMs: 150 });
    const before = (await c.request<{ ok: true; echo: unknown }>({ op: 'ping' })) as unknown as { pid: number };
    const hung = await c.request({ op: 'hang' }).catch((e) => e);
    expect(hung).toMatchObject({ code: 'timeout' });
    const after = (await c.request({ op: 'ping' })) as unknown as { pid: number };
    expect(after.pid).not.toBe(before.pid);
  });

  it('rejects the request that was running when the helper died, then starts a new one', async () => {
    const c = make();
    await c.ready();
    const died = await c.request({ op: 'die' }).catch((e) => e);
    expect(died).toMatchObject({ code: 'helper_exited' });
    expect(await c.ready()).toBe(true);
  });

  it('stops trying for a minute after repeated crashes, then recovers', async () => {
    let clock = 1_000_000;
    const c = make({ now: () => clock });
    for (let i = 0; i < 3; i += 1) {
      await c.ready();
      await c.request({ op: 'die' }).catch(() => undefined);
    }
    expect(await c.ready()).toBe(false);
    clock += 61_000;
    expect(await c.ready()).toBe(true);
  });

  it('is unavailable when turned off, and when its binary is not built yet', async () => {
    const off = make({ enabled: false });
    expect(await off.ready()).toBe(false);
    await expect(off.request({ op: 'ping' })).rejects.toMatchObject({ code: 'unavailable' });
    const notBuilt = make({ launch: () => null });
    expect(await notBuilt.ready()).toBe(false);
    await expect(notBuilt.request({ op: 'ping' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('reports a launch command that cannot run as unavailable instead of throwing', async () => {
    const c = make({ launch: () => ({ command: path.join(dir, 'no-such-binary'), args: [] }) });
    expect(await c.ready()).toBe(false);
    await expect(c.request({ op: 'ping' })).rejects.toBeInstanceOf(AxHelperError);
  });

  it('is on only on macOS and without RH_AX_HELPER=0', () => {
    expect(axHelperEnabledByDefault({}, 'darwin')).toBe(true);
    expect(axHelperEnabledByDefault({ RH_AX_HELPER: '0' }, 'darwin')).toBe(false);
    expect(axHelperEnabledByDefault({}, 'linux')).toBe(false);
  });
});

describe('the helper binary', () => {
  const homeFor = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'rh-ax-home-'));

  it('writes the source, and is current only when the binary is newer than it', () => {
    const home = homeFor();
    const { swift, binary } = axHelperPaths(home);
    expect(axBinaryIsCurrent({ home, source: 'v1' })).toBe(false);
    expect(fs.readFileSync(swift, 'utf8')).toBe('v1');
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    const fiveSecondsAgo = new Date(Date.now() - 5_000);
    fs.utimesSync(swift, tenSecondsAgo, tenSecondsAgo);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, 'bin');
    fs.utimesSync(binary, fiveSecondsAgo, fiveSecondsAgo);
    expect(axBinaryIsCurrent({ home, source: 'v1' })).toBe(true);
    // a changed source (a new release) makes the old binary stale
    expect(axBinaryIsCurrent({ home, source: 'v2' })).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('builds once for concurrent callers, installs the result and does not rebuild', async () => {
    const home = homeFor();
    let compiles = 0;
    const compile = async (_swift: string, out: string): Promise<number> => {
      compiles += 1;
      await new Promise((r) => setTimeout(r, 20));
      fs.writeFileSync(out, 'binary');
      return 0;
    };
    const [a, b] = await Promise.all([ensureAxHelperBinary({ home, source: 's', compile }), ensureAxHelperBinary({ home, source: 's', compile })]);
    expect(a).toEqual({ ok: true, path: axHelperPaths(home).binary });
    expect(b).toEqual(a);
    expect(compiles).toBe(1);
    expect(fs.readFileSync(axHelperPaths(home).binary, 'utf8')).toBe('binary');
    expect(await ensureAxHelperBinary({ home, source: 's', compile })).toEqual(a);
    expect(compiles).toBe(1);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('remembers a real compile error for a while, but retries when the compiler could not run', async () => {
    const home = homeFor();
    let clock = 5_000_000;
    let status: number | null = 1;
    let compiles = 0;
    const compile = async (): Promise<number | null> => {
      compiles += 1;
      return status;
    };
    const opts = { home, source: 'x', compile, now: () => clock };
    const failed = await ensureAxHelperBinary(opts);
    expect(failed).toMatchObject({ ok: false });
    await ensureAxHelperBinary(opts);
    expect(compiles).toBe(1);
    clock += AX_BUILD_FAILURE_TTL_MS + 1;
    await ensureAxHelperBinary(opts);
    expect(compiles).toBe(2);
    // swiftc missing (status null) is not remembered
    const home2 = homeFor();
    status = null;
    compiles = 0;
    await ensureAxHelperBinary({ ...opts, home: home2 });
    await ensureAxHelperBinary({ ...opts, home: home2 });
    expect(compiles).toBe(2);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(home2, { recursive: true, force: true });
  });

  it('the embedded source is exactly the .swift file', async () => {
    const { AX_HELPER_SWIFT_SOURCE } = await import('./ax-helper-source.generated.js');
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ax-helper.swift');
    expect(AX_HELPER_SWIFT_SOURCE).toBe(fs.readFileSync(file, 'utf-8'));
  });
});
