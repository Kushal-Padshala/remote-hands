import { spawn, type ChildProcess } from 'node:child_process';
import type { EventInput } from './task-store.js';

export interface WarmSessionConfig {
  model: string;
  effort?: string | undefined;
  workspace?: string | undefined;
  mode?: string | undefined;
  /** The conversation the task continues; a different one replaces the live process. */
  conversationId?: string | undefined;
}

export interface TurnResult {
  events: EventInput[];
  summary: string;
  conversationId: string | null;
  failed: boolean;
  aborted: boolean;
}

export interface WarmAgySessionOptions {
  command: string;
  parseLine: (line: string) => EventInput | null;
  spawnFn?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. Defaults to killing the whole process group on non-win32. */
  killFn?: (proc: ChildProcess, signal?: NodeJS.Signals) => void;
}

export function buildWarmAgyArgs(
  c: Omit<WarmSessionConfig, 'conversationId'> & { conversationId?: string | null | undefined },
): string[] {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '0'];
  if (c.workspace) args.push('--add-dir', c.workspace);
  if (c.conversationId) args.push('--conversation', c.conversationId);
  if (c.mode && c.mode !== 'default') args.push('--mode', c.mode);
  if (c.model) args.push('--model', c.model);
  if (c.effort && !c.model.toLowerCase().includes('claude')) args.push('--effort', c.effort);
  args.push('-p=');
  return args;
}

function defaultKill(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform !== 'win32' && typeof proc.pid === 'number' && proc.pid > 1) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // fall through to a direct kill
    }
  }
  proc.kill(signal);
}

interface ActiveTurn {
  events: EventInput[];
  summary: string;
  conversationId: string | null;
  onEvent: ((event: EventInput) => Promise<void> | void) | undefined;
  chain: Promise<void>;
  finish: (partial: Partial<TurnResult>) => void;
}

export class WarmAgySession {
  private proc: ChildProcess | null = null;
  private procKey = '';
  /** The workspace the live process was spawned in ('' = none). */
  private procWorkspace = '';
  private buffer = '';
  private turn: ActiveTurn | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastConversationId: string | null = null;
  /** The live process has received a turn, so it holds context even if no conversation_id came back. */
  private processServedTurn = false;

  constructor(private readonly opts: WarmAgySessionOptions) {}

  hasHistory(): boolean {
    return this.lastConversationId !== null || (this.proc !== null && this.processServedTurn);
  }

  prewarm(config: WarmSessionConfig): void {
    try {
      this.ensure(config);
    } catch {}
  }

  stop(): void {
    this.kill();
    this.turn?.finish({ summary: 'agy session stopped', failed: true });
  }

  reset(): void {
    // Idle and nothing to forget (never served a turn, not resumed from a conversation):
    // keep the (possibly prewarmed) process.
    if (!this.turn && !this.processServedTurn && this.lastConversationId === null) return;
    this.kill();
    this.turn?.finish({ summary: 'agy session reset', failed: true });
    this.lastConversationId = null;
  }

  runTurn(
    prompt: string,
    config: WarmSessionConfig,
    onEvent?: (event: EventInput) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    const run = () =>
      new Promise<TurnResult>((resolve) => {
        const cancelled = (): TurnResult => ({
          events: [],
          summary: 'Task cancelled by user',
          conversationId: this.lastConversationId,
          failed: false,
          aborted: true,
        });
        const failedResult = (summary: string): TurnResult => ({
          events: [],
          summary,
          conversationId: this.lastConversationId,
          failed: true,
          aborted: false,
        });
        if (signal?.aborted) return resolve(cancelled());

        let proc: ChildProcess;
        try {
          proc = this.ensure(config);
        } catch (err: any) {
          return resolve(failedResult(err?.message ?? 'Failed to start agy'));
        }

        const stdin = proc.stdin;
        if (!stdin) {
          this.kill();
          return resolve(failedResult('agy stdin unavailable'));
        }

        let onAbort: (() => void) | undefined;
        let settled = false;
        const turn: ActiveTurn = {
          events: [],
          summary: '',
          conversationId: this.lastConversationId,
          onEvent,
          chain: Promise.resolve(),
          finish: (partial) => {
            if (settled || this.turn !== turn) return;
            settled = true;
            this.turn = null;
            if (onAbort) signal?.removeEventListener('abort', onAbort);
            void turn.chain.then(() =>
              resolve({
                events: turn.events,
                summary: turn.summary,
                conversationId: turn.conversationId,
                failed: false,
                aborted: false,
                ...partial,
              }),
            );
          },
        };
        this.turn = turn;

        if (signal) {
          onAbort = () => {
            this.kill();
            turn.finish({ summary: 'Task cancelled by user', aborted: true });
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }

        try {
          this.processServedTurn = true;
          stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
        } catch {
          this.kill();
          turn.finish({ summary: 'Failed to write to agy', failed: true });
        }
      });

    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private ensure(config: WarmSessionConfig): ChildProcess {
    // A task that names a conversation other than the active one (or a fresh process with
    // no history) gets a process started with --conversation <that id>.
    if (config.conversationId && config.conversationId !== this.lastConversationId) {
      if (this.proc) this.kill();
      this.lastConversationId = config.conversationId;
    }
    const key = JSON.stringify([config.model, config.effort ?? '', config.mode ?? '']);
    // cwd and --add-dir are fixed at spawn. A request without a workspace reuses any live
    // process; one with a workspace needs a process spawned there. A respawn keeps
    // lastConversationId, so the new process resumes the same conversation.
    const workspace = config.workspace || '';
    const workspaceMatches = !workspace || workspace === this.procWorkspace;
    if (this.proc && this.procKey === key && workspaceMatches) return this.proc;
    if (this.proc) this.kill();

    const spawnFn = this.opts.spawnFn ?? spawn;
    const proc = spawnFn(
      this.opts.command,
      buildWarmAgyArgs({ ...config, conversationId: this.lastConversationId }),
      {
        cwd: config.workspace || process.cwd(),
        env: {
          ...(this.opts.env ?? process.env),
          BU_CDP_URL: process.env.BU_CDP_URL || 'http://127.0.0.1:9222',
          CHROME_REMOTE_DEBUGGING_PORT: process.env.CHROME_REMOTE_DEBUGGING_PORT || '9222',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    this.proc = proc;
    this.procKey = key;
    this.procWorkspace = workspace;
    this.buffer = '';
    this.processServedTurn = false;

    proc.stdin?.on('error', () => {});
    proc.stdout?.on('data', (chunk: Buffer) => this.onData(proc, chunk.toString()));
    proc.stderr?.on('data', () => {});
    proc.on('error', (err: Error) => this.onClose(proc, err?.message));
    proc.on('close', () => this.onClose(proc));
    return proc;
  }

  private onData(proc: ChildProcess, text: string): void {
    if (proc !== this.proc) return;
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      let event: EventInput | null = null;
      try {
        event = this.opts.parseLine(line);
      } catch {
        event = null;
      }
      const turn = this.turn;
      if (event && !turn && event.kind === 'error' && (event.payload as any)?.fatal === true) {
        // A broken idle (e.g. prewarmed) process: forget it so the next turn respawns
        // instead of writing into a dead session with no turn timeout.
        this.kill();
        return;
      }
      if (!event || !turn) continue;
      turn.events.push(event);
      const conversationId = (event.payload as any)?.conversation_id;
      if (typeof conversationId === 'string') {
        turn.conversationId = conversationId;
        this.lastConversationId = conversationId;
      }
      if (turn.onEvent) {
        const handler = turn.onEvent;
        turn.chain = turn.chain.then(async () => {
          try {
            await handler(event!);
          } catch {}
        });
      }
      const payload = event.payload as any;
      if (event.kind === 'error' && payload?.fatal === true) {
        const message = typeof payload.message === 'string' && payload.message ? payload.message : 'agy reported a fatal error';
        this.kill();
        turn.finish({ summary: message, failed: true });
        return;
      }
      if (event.kind === 'result') {
        turn.summary = payload?.summary ?? turn.summary;
        turn.finish(payload?.is_error ? { failed: true } : {});
      }
    }
  }

  private onClose(proc: ChildProcess, errorMessage?: string): void {
    if (proc !== this.proc) return;
    this.proc = null;
    this.procKey = '';
    this.processServedTurn = false;
    this.turn?.finish({
      summary: errorMessage ? `agy failed: ${errorMessage}` : 'agy process exited unexpectedly',
      failed: true,
    });
  }

  private kill(): void {
    const proc = this.proc;
    this.proc = null;
    this.procKey = '';
    this.processServedTurn = false;
    if (!proc) return;
    try {
      (this.opts.killFn ?? defaultKill)(proc, 'SIGTERM');
    } catch {}
  }
}
