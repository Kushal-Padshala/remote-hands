import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlamaSidecar } from './server.js';

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.kill = vi.fn((signal?: string) => {
    queueMicrotask(() => child.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  });
  return child;
}

const ok = () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
const loading = () => new Response(JSON.stringify({ error: { message: 'Loading model' } }), { status: 503 });

function harness(opts: { health?: Array<() => Response | Promise<Response>>; idleMs?: number; healthTimeoutMs?: number; pidFile?: string; processes?: any } = {}) {
  const children: any[] = [];
  const spawn = vi.fn((..._args: any[]) => {
    const c = fakeChild();
    children.push(c);
    return c;
  });
  const health = [...(opts.health ?? [ok])];
  const fetchFn = vi.fn(async (..._args: any[]) => {
    const next = health.length > 1 ? health.shift()! : health[0]!;
    return next();
  });
  let clock = 0;
  const timers: Array<{ id: number; fn: () => void; at: number; cleared: boolean }> = [];
  let nextId = 1;
  const sidecar = new LlamaSidecar({
    serverPath: '/rt/llama-server',
    modelPath: '/models/m.gguf',
    contextTokens: 4096,
    spawn: spawn as any,
    fetch: fetchFn as any,
    randomPort: async () => 51234,
    randomKey: () => 'sekret-key-123',
    healthTimeoutMs: opts.healthTimeoutMs ?? 1000,
    ...(opts.pidFile ? { pidFile: opts.pidFile } : {}),
    ...(opts.processes ? { processes: opts.processes } : {}),
    healthPollMs: 100,
    idleMs: opts.idleMs ?? 600_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((r) => setTimeout(r, 0)); // yield a macrotask like a real sleep would
    },
    setTimer: ((fn: () => void, ms: number) => {
      const t = { id: nextId++, fn, at: clock + ms, cleared: false };
      timers.push(t);
      return t.id;
    }) as any,
    clearTimer: ((id: number) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    }) as any,
  });
  const fireIdle = () => {
    for (const t of timers.filter((x) => !x.cleared && x.at >= 600_000)) {
      t.cleared = true;
      t.fn();
    }
  };
  return { sidecar, spawn, children, fetchFn, fireIdle, timers };
}

describe('LlamaSidecar', () => {
  it('spawns llama-server bound to localhost with a port and the model, passing the key through the environment', async () => {
    const { sidecar, spawn } = harness();
    await sidecar.start();
    const [bin, args, options] = spawn.mock.calls[0]!;
    expect(bin).toBe('/rt/llama-server');
    expect(args).toEqual(['-m', '/models/m.gguf', '--host', '127.0.0.1', '--port', '51234', '-c', '4096', '-ngl', '99', '-np', '1', '--no-webui']);
    // The key must not be visible in the process list (`ps`), so it travels in the environment.
    expect(JSON.stringify(args)).not.toContain('sekret-key-123');
    expect((options as any).env.LLAMA_API_KEY).toBe('sekret-key-123');
    expect(sidecar.baseUrl()).toBe('http://127.0.0.1:51234');
    expect(sidecar.apiKey()).toBe('sekret-key-123');
    expect(sidecar.isRunning()).toBe(true);
  });

  it('gives every health check a timeout signal so a wedged server cannot stall startup', async () => {
    const { sidecar, fetchFn } = harness();
    await sidecar.start();
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('waits through loading responses until the health check is ok', async () => {
    const { sidecar, fetchFn } = harness({ health: [loading, loading, ok] });
    await sidecar.start();
    expect(fetchFn.mock.calls.length).toBe(3);
  });

  it('keeps polling when the connection is refused at first', async () => {
    const refused = () => {
      throw new Error('ECONNREFUSED');
    };
    const { sidecar } = harness({ health: [refused as any, ok] });
    await sidecar.start();
    expect(sidecar.isRunning()).toBe(true);
  });

  it('kills the child and rejects when it never becomes healthy', async () => {
    const { sidecar, children } = harness({ health: [loading], healthTimeoutMs: 500 });
    await expect(sidecar.start()).rejects.toThrow('did not become healthy within 500ms');
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(sidecar.isRunning()).toBe(false);
  });

  it('rejects when the child exits before it is healthy and never leaks the api key', async () => {
    const { sidecar, children } = harness({ health: [loading] });
    const started = sidecar.start();
    await new Promise((r) => setTimeout(r, 0));
    children[0].stderr.emit('data', Buffer.from('error: bad model sekret-key-123\n'));
    children[0].emit('exit', 1, null);
    const err = await started.catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/exited before it was ready/);
    expect((err as Error).message).not.toContain('sekret-key-123');
    expect(sidecar.isRunning()).toBe(false);
  });

  it('ensureStarted is a no-op while running and restarts after an unexpected exit', async () => {
    const { sidecar, spawn, children } = harness();
    await sidecar.ensureStarted();
    await sidecar.ensureStarted();
    expect(spawn).toHaveBeenCalledTimes(1);
    children[0].emit('exit', 139, null); // crash
    expect(sidecar.isRunning()).toBe(false);
    await sidecar.ensureStarted();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(sidecar.isRunning()).toBe(true);
  });

  it('concurrent ensureStarted calls share one start', async () => {
    const { sidecar, spawn } = harness();
    await Promise.all([sidecar.ensureStarted(), sidecar.ensureStarted(), sidecar.ensureStarted()]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('stops the process after the idle window and restarts on demand', async () => {
    const { sidecar, spawn, children, fireIdle } = harness({ idleMs: 600_000 });
    await sidecar.start();
    fireIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(sidecar.isRunning()).toBe(false);
    await sidecar.ensureStarted();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('touch resets the idle timer', async () => {
    const { sidecar, timers } = harness();
    await sidecar.start();
    const before = timers.filter((t) => !t.cleared).length;
    sidecar.touch();
    const live = timers.filter((t) => !t.cleared);
    expect(live.length).toBe(before); // old timer cleared, new one set
    expect(timers.length).toBeGreaterThan(before);
  });

  it('stop kills with SIGTERM and is idempotent', async () => {
    const { sidecar, children } = harness();
    await sidecar.start();
    await sidecar.stop();
    await sidecar.stop();
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(sidecar.isRunning()).toBe(false);
  });
});

describe('LlamaSidecar orphan handling (pid file)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-pid-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const pidFile = () => path.join(dir, 'sidecar.json');

  function fakeProcesses(opts: { alive: boolean; command: string | null }) {
    let alive = opts.alive;
    return {
      isAlive: vi.fn(() => alive),
      commandOf: vi.fn(() => opts.command),
      kill: vi.fn(() => {
        alive = false;
      }),
    };
  }

  it('kills a leftover llama-server from a previous daemon that is still running our binary', async () => {
    fs.writeFileSync(pidFile(), JSON.stringify({ pid: 9999, serverPath: '/rt/llama-server' }));
    const processes = fakeProcesses({ alive: true, command: '/rt/llama-server -m /models/m.gguf --port 4000' });
    const { sidecar } = harness({ pidFile: pidFile(), processes });
    await sidecar.start();
    expect(processes.kill).toHaveBeenCalledWith(9999, 'SIGTERM');
    expect(JSON.parse(fs.readFileSync(pidFile(), 'utf8')).pid).toBe(4242); // replaced by the new child
  });

  it('never kills a process that merely reuses the old pid', async () => {
    fs.writeFileSync(pidFile(), JSON.stringify({ pid: 9999, serverPath: '/rt/llama-server' }));
    const processes = fakeProcesses({ alive: true, command: '/usr/bin/some-other-program' });
    const { sidecar } = harness({ pidFile: pidFile(), processes });
    await sidecar.start();
    expect(processes.kill).not.toHaveBeenCalled();
  });

  it('does nothing for a dead pid or a corrupt pid file', async () => {
    fs.writeFileSync(pidFile(), JSON.stringify({ pid: 9999, serverPath: '/rt/llama-server' }));
    const dead = fakeProcesses({ alive: false, command: null });
    await harness({ pidFile: pidFile(), processes: dead }).sidecar.start();
    expect(dead.kill).not.toHaveBeenCalled();
    fs.writeFileSync(pidFile(), '{not json');
    const other = fakeProcesses({ alive: true, command: '/rt/llama-server' });
    await harness({ pidFile: pidFile(), processes: other }).sidecar.start();
    expect(other.kill).not.toHaveBeenCalled();
  });

  it('records the child pid after spawn and removes the file when the child exits', async () => {
    const processes = fakeProcesses({ alive: false, command: null });
    const { sidecar, children } = harness({ pidFile: pidFile(), processes });
    await sidecar.start();
    expect(JSON.parse(fs.readFileSync(pidFile(), 'utf8'))).toEqual({ pid: 4242, serverPath: '/rt/llama-server' });
    children[0].emit('exit', 0, null);
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it('escalates to SIGKILL when the leftover ignores SIGTERM', async () => {
    fs.writeFileSync(pidFile(), JSON.stringify({ pid: 9999, serverPath: '/rt/llama-server' }));
    const kill = vi.fn();
    const processes = { isAlive: vi.fn(() => true), commandOf: vi.fn(() => '/rt/llama-server'), kill };
    const { sidecar } = harness({ pidFile: pidFile(), processes });
    await sidecar.start();
    expect(kill).toHaveBeenCalledWith(9999, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(9999, 'SIGKILL');
  });
});
