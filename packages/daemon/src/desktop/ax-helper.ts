import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AX_HELPER_SWIFT_SOURCE } from './ax-helper-source.generated.js';

/** One accessibility element as the helper reports it. */
export interface AxNode {
  /** Stable handle: the same element keeps it across snapshots. */
  id: number;
  /** Handle of the parent that was reported, 0 for a root. */
  parent: number;
  role: string;
  sub?: string;
  label?: string;
  value?: string;
  help?: string;
  placeholder?: string;
  /** Present (false) only when disabled. */
  enabled?: false;
  focused?: true;
  selected?: true;
  expanded?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Named accessibility actions, e.g. AXPress, AXOpen. */
  actions?: string[];
  /** Children left out because they are scrolled out of view. */
  off?: number;
  /** Vertical scroll position 0..1 of a scroll area. */
  scroll?: number;
}

export interface AxSnapshot {
  ok: true;
  app: { name: string; pid: number; bundle?: string };
  window?: { title: string; x?: number; y?: number; width?: number; height?: number };
  noWindow?: boolean;
  nodes: AxNode[];
  truncated: boolean;
  timedOut: boolean;
  enhancedRetry?: boolean;
  elapsedMs: number;
}

/** A reply with `ok: false`, a timeout, or a helper that went away. `code` is machine readable. */
export class AxHelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AxHelperError';
  }
}

export interface AxHelperPort {
  /** Whether the helper can serve requests right now (starts it when its binary is ready). Never throws. */
  ready(): Promise<boolean>;
  /** Sends one request; resolves with the reply, rejects with AxHelperError. */
  request<T extends { ok: true }>(op: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

// ---- the binary -----------------------------------------------------------------------------

export type AxBinaryResult = { ok: true; path: string } | { ok: false; error: string };

export interface AxBinaryOptions {
  home?: string;
  source?: string;
  /** Compiles asynchronously; resolves with the exit status (null when it could not run). Injectable for tests. */
  compile?: (swiftFile: string, output: string) => Promise<number | null>;
  now?: () => number;
}

/** A real compile error disables rebuilding for this long. */
export const AX_BUILD_FAILURE_TTL_MS = 10 * 60_000;

const buildsInFlight = new Map<string, Promise<AxBinaryResult>>();
const buildFailures = new Map<string, number>();

export function axHelperPaths(home: string = os.homedir()): { swift: string; binary: string } {
  return {
    swift: path.join(home, '.remote-hands', 'ax-helper.swift'),
    binary: path.join(home, '.remote-hands', 'bin', 'rh-ax'),
  };
}

function realCompile(swiftFile: string, output: string): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn('swiftc', ['-O', swiftFile, '-o', output], { stdio: 'ignore' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Writes the embedded source to ~/.remote-hands when it is missing or differs, and says whether the binary is current. */
export function axBinaryIsCurrent(opts: AxBinaryOptions = {}): boolean {
  const { swift, binary } = axHelperPaths(opts.home);
  const source = opts.source ?? AX_HELPER_SWIFT_SOURCE;
  try {
    let current: string | null = null;
    try {
      current = fs.readFileSync(swift, 'utf-8');
    } catch {
      // not written yet
    }
    if (current !== source) {
      fs.mkdirSync(path.dirname(swift), { recursive: true });
      fs.writeFileSync(swift, source, 'utf-8');
    }
    return fs.existsSync(binary) && fs.statSync(binary).mtimeMs >= fs.statSync(swift).mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Builds the helper from the embedded source when needed. Compilation takes a while, so this never blocks:
 * callers get the same in-flight promise, and a real compiler error is remembered for a few minutes.
 */
export function ensureAxHelperBinary(opts: AxBinaryOptions = {}): Promise<AxBinaryResult> {
  const { swift, binary } = axHelperPaths(opts.home);
  if (axBinaryIsCurrent(opts)) return Promise.resolve({ ok: true, path: binary });
  const now = (opts.now ?? Date.now)();
  const failedAt = buildFailures.get(binary);
  if (failedAt !== undefined && now - failedAt < AX_BUILD_FAILURE_TTL_MS) {
    return Promise.resolve({ ok: false, error: 'the accessibility helper could not be built (see ~/.remote-hands/ax-helper.swift)' });
  }
  const running = buildsInFlight.get(binary);
  if (running) return running;
  const job = (async (): Promise<AxBinaryResult> => {
    const compile = opts.compile ?? realCompile;
    const tmp = `${binary}.build-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      const status = await compile(swift, tmp);
      if (status !== 0 || !fs.existsSync(tmp)) {
        fs.rmSync(tmp, { force: true });
        // Only a real compiler diagnostic is remembered; a swiftc that could not run is retried next time.
        if (typeof status === 'number') buildFailures.set(binary, now);
        return { ok: false, error: 'could not build the accessibility helper (it needs the Xcode Command Line Tools: xcode-select --install)' };
      }
      if (process.platform === 'darwin' && !opts.compile) spawnSync('codesign', ['-s', '-', '--force', tmp], { stdio: 'ignore' });
      fs.renameSync(tmp, binary);
      buildFailures.delete(binary);
      return { ok: true, path: binary };
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      buildsInFlight.delete(binary);
    }
  })();
  buildsInFlight.set(binary, job);
  return job;
}

// ---- the client -----------------------------------------------------------------------------

export interface AxHelperLaunch {
  command: string;
  args: string[];
}

export interface AxHelperClientOptions {
  /** Where the helper runs from. Default: the built rh-ax binary (null while it is still being built). */
  launch?: () => AxHelperLaunch | null;
  /** Default off macOS or when RH_AX_HELPER=0. */
  enabled?: boolean;
  requestTimeoutMs?: number;
  now?: () => number;
}

interface Pending {
  resolve: (reply: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;

export function axHelperEnabledByDefault(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  return platform === 'darwin' && env.RH_AX_HELPER !== '0';
}

/**
 * Owns the helper process: starts it on first use, matches replies to requests, kills and restarts a hung
 * one, and gives up for a minute after repeated crashes. Never keeps the Node process alive.
 */
export class AxHelperClient implements AxHelperPort {
  private child: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private crashes: number[] = [];
  private disabledUntil = 0;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly launch: () => AxHelperLaunch | null;

  constructor(opts: AxHelperClientOptions = {}) {
    this.enabled = opts.enabled ?? axHelperEnabledByDefault();
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.launch =
      opts.launch ??
      ((): AxHelperLaunch | null => {
        if (axBinaryIsCurrent()) return { command: axHelperPaths().binary, args: [] };
        // Build in the background; until it exists callers use the slower path.
        void ensureAxHelperBinary();
        return null;
      });
  }

  async ready(): Promise<boolean> {
    if (!this.enabled || this.now() < this.disabledUntil) return false;
    try {
      if (!this.child) {
        const launch = this.launch();
        if (!launch) return false;
        this.start(launch);
      }
      await this.request({ op: 'ping' }, 5000);
      return true;
    } catch {
      return false;
    }
  }

  request<T extends { ok: true }>(op: Record<string, unknown>, timeoutMs: number = this.timeoutMs): Promise<T> {
    if (!this.enabled) return Promise.reject(new AxHelperError('unavailable', 'the accessibility helper is turned off'));
    if (!this.child) {
      const launch = this.launch();
      if (!launch) return Promise.reject(new AxHelperError('unavailable', 'the accessibility helper is not built yet'));
      try {
        this.start(launch);
      } catch (err) {
        return Promise.reject(new AxHelperError('unavailable', err instanceof Error ? err.message : String(err)));
      }
    }
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) {
      return Promise.reject(new AxHelperError('helper_exited', 'the accessibility helper is not running'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AxHelperError('timeout', `the accessibility helper did not answer within ${Math.round(timeoutMs / 1000)} s`));
        // A helper that stopped answering is replaced, so the next request starts clean.
        this.kill();
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        resolve: (reply) => {
          if (reply && reply.ok === true) resolve(reply as T);
          else reject(new AxHelperError(String(reply?.error ?? 'failed'), String(reply?.message ?? 'the accessibility helper reported an error')));
        },
        reject,
      });
      try {
        child.stdin!.write(`${JSON.stringify({ ...op, id })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AxHelperError('helper_exited', err instanceof Error ? err.message : String(err)));
      }
    });
  }

  /** Stops the helper (it is started again by the next request). */
  stop(): void {
    this.kill();
  }

  private start(launch: AxHelperLaunch): void {
    const child = spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    this.buffer = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.onData(child, chunk));
    child.stdin!.on('error', () => {
      // a helper that died while we wrote: the exit handler cleans up
    });
    child.on('error', () => this.onExit(child));
    child.on('exit', () => this.onExit(child));
    // The helper must never keep Node alive, and it ends by itself when our end of the pipe closes.
    child.unref();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
  }

  private onData(child: ChildProcess, chunk: string): void {
    if (child !== this.child) return;
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (!line) continue;
      let reply: any;
      try {
        reply = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = typeof reply?.id === 'number' ? this.pending.get(reply.id) : undefined;
      if (!pending) continue;
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      pending.resolve(reply);
    }
  }

  private onExit(child: ChildProcess): void {
    if (child !== this.child) return;
    this.child = null;
    const at = this.now();
    this.crashes = this.crashes.filter((t) => at - t < CRASH_WINDOW_MS);
    this.crashes.push(at);
    if (this.crashes.length >= MAX_CRASHES) this.disabledUntil = at + CRASH_WINDOW_MS;
    this.failPending(new AxHelperError('helper_exited', 'the accessibility helper stopped'));
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    this.failPending(new AxHelperError('helper_exited', 'the accessibility helper was restarted'));
  }

  private failPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
  }
}
