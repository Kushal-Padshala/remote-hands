import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';

export interface SidecarOptions {
  serverPath: string;
  modelPath: string;
  contextTokens: number;
  spawn?: typeof nodeSpawn | undefined;
  fetch?: typeof fetch | undefined;
  randomPort?: (() => Promise<number>) | undefined;
  randomKey?: (() => string) | undefined;
  /** How long to wait for the model to load and the server to report healthy. Default 60s. */
  healthTimeoutMs?: number | undefined;
  healthPollMs?: number | undefined;
  /** Stop the process after this long without `touch()`. 0 disables. Default 10 minutes. */
  idleMs?: number | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  setTimer?: ((fn: () => void, ms: number) => unknown) | undefined;
  clearTimer?: ((timer: unknown) => void) | undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Owns one `llama-server` process: random localhost port, per-run API key, health wait, idle
 * unload, and restart after a crash. Nothing else in the daemon spawns the model.
 */
export class LlamaSidecar {
  private child: ChildProcess | undefined;
  private port = 0;
  private key = '';
  private starting: Promise<void> | undefined;
  private idleTimer: unknown;
  private readonly exited = new WeakSet<ChildProcess>();

  constructor(private readonly o: SidecarOptions) {}

  isRunning(): boolean {
    return this.child !== undefined;
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  apiKey(): string {
    return this.key;
  }

  ensureStarted(): Promise<void> {
    return this.start();
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.isRunning()) return Promise.resolve();
    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Resets the idle timer; call on every use. */
  touch(): void {
    const idleMs = this.o.idleMs ?? 600_000;
    const clear = this.o.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));
    const set = this.o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    if (this.idleTimer !== undefined) clear(this.idleTimer);
    this.idleTimer = undefined;
    if (idleMs <= 0) return;
    const timer = set(() => {
      void this.stop();
    }, idleMs);
    (timer as { unref?: () => void } | undefined)?.unref?.();
    this.idleTimer = timer;
  }

  async stop(): Promise<void> {
    this.clearIdle();
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
    await this.terminate(child);
  }

  private clearIdle(): void {
    const clear = this.o.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));
    if (this.idleTimer !== undefined) clear(this.idleTimer);
    this.idleTimer = undefined;
  }

  private terminate(child: ChildProcess): Promise<void> {
    if (this.exited.has(child)) return Promise.resolve();
    const set = this.o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clear = this.o.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));
    return new Promise<void>((resolve) => {
      let killTimer: unknown;
      child.once('exit', () => {
        if (killTimer !== undefined) clear(killTimer);
        resolve();
      });
      child.kill('SIGTERM');
      killTimer = set(() => {
        child.kill('SIGKILL');
      }, 3000);
    });
  }

  private async doStart(): Promise<void> {
    const doSpawn = this.o.spawn ?? nodeSpawn;
    const doFetch = this.o.fetch ?? fetch;
    const now = this.o.now ?? Date.now;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const timeoutMs = this.o.healthTimeoutMs ?? 60_000;
    const pollMs = this.o.healthPollMs ?? 100;

    const port = await (this.o.randomPort ?? freePort)();
    const key = (this.o.randomKey ?? (() => randomBytes(24).toString('hex')))();
    this.port = port;
    this.key = key;

    const args = [
      '-m', this.o.modelPath, '--host', '127.0.0.1', '--port', String(port), '-c', String(this.o.contextTokens),
      '-ngl', '99', '-np', '1', '--no-webui', '--api-key', key,
    ];
    const child = doSpawn(this.o.serverPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;

    let stderrTail = '';
    let early: { code: number | null; signal: string | null; error?: string } | undefined;
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    child.on('error', (err: Error) => {
      early = { code: null, signal: null, error: err.message };
      this.exited.add(child);
      if (this.child === child) this.child = undefined;
    });
    child.on('exit', (code: number | null, signal: string | null) => {
      early = { code, signal };
      this.exited.add(child);
      if (this.child === child) {
        this.child = undefined;
        this.clearIdle();
      }
    });

    const redact = (text: string) => text.split(key).join('***');
    const deadline = now() + timeoutMs;
    for (;;) {
      if (early !== undefined) {
        const reason = early.error ?? `code ${early.code ?? early.signal}`;
        const line = stderrTail.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
        throw new Error(`llama-server exited before it was ready (${reason})${line ? `: ${redact(line)}` : ''}`);
      }
      try {
        const res = await doFetch(`${this.baseUrl()}/health`, { headers: { Authorization: `Bearer ${key}` } });
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { status?: string } | null;
          if (body === null || body.status === 'ok') break;
        }
      } catch {
        // not listening yet
      }
      if (now() >= deadline) {
        if (this.child === child) this.child = undefined;
        await this.terminate(child);
        throw new Error(`llama-server did not become healthy within ${timeoutMs}ms`);
      }
      await sleep(pollMs);
    }
    this.touch();
  }
}
