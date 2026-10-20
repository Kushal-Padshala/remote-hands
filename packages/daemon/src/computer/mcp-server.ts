import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import os from 'node:os';
import { axHelperEnabledByDefault, ensureAxHelperBinary } from '../desktop/ax-helper.js';
import { appendCallRecord, classifyError, type ToolCallRecord } from './call-log.js';
import { runInCallScope } from './call-scope.js';
import { fitResult } from './result-budget.js';
import type { ComputerSession } from './session.js';
import { buildComputerTools, type ComputerTool } from './tools.js';

/**
 * Every tool call drives the same desktop/browser, so calls are serialized per server: a
 * promise chain runs them strictly one after the other (a failing call never blocks the
 * queue). computer_batch calls the raw handlers for its steps, so it never re-enqueues.
 */
const DEFAULT_CALL_TIMEOUT_MS = 90_000;
/** The least time a call keeps after an approval, to do the action that was approved. */
const AFTER_APPROVAL_MS = 15_000;

/** The error text for a call that hit the per-call timeout. */
export function formatTimeout(ms: number): string {
  return `error: tool call timed out after ${ms / 1000}s`;
}

export interface ComputerMcpServerOptions {
  /** Per-call limit so a handler that never settles cannot block the queue (default 90 s). */
  callTimeoutMs?: number | undefined;
  /**
   * Told about every finished tool call (tool name, timing, outcome class only). Calls the SDK
   * rejects for invalid arguments never reach a tool and are not reported. If it throws, the
   * error is ignored.
   */
  onCall?: ((record: ToolCallRecord) => void) | undefined;
  /** Monotonic milliseconds for timing a call (default performance.now; wall-clock changes must not skew it). */
  now?: (() => number) | undefined;
}

export function createComputerMcpServer(tools: ComputerTool[], opts: ComputerMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'remote-hands-computer', version: '0.1.0' });
  const limit = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const clock = opts.now ?? (() => performance.now());
  type Result = { isError?: boolean; content: { type: 'text'; text: string }[] };
  // A call that hits the limit is abandoned: its scope is marked, so whatever it is still doing
  // (a batch, an approval wait) refuses to act any more, and only then does the queue move on.
  const withTimeout = (work: Promise<Result>, abandon: () => void, watchWaiting: (cb: (waiting: boolean) => void) => void): Promise<Result> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fire!: (result: Result) => void;
    let over = false;
    let left = limit;
    let armedAt = 0;
    const timeout = new Promise<Result>((resolve) => { fire = resolve; });
    const arm = () => {
      clearTimeout(timer);
      if (over) return;
      armedAt = performance.now();
      timer = setTimeout(() => {
        abandon();
        fire({ isError: true, content: [{ type: 'text', text: formatTimeout(limit) }] });
      }, left);
    };
    arm();
    // While the call waits for the person's approval the clock stands still; afterwards it runs on with what was left of it
    // (but never less than the time a click needs).
    watchWaiting((waiting) => {
      if (waiting) {
        clearTimeout(timer);
        left = Math.max(0, left - (performance.now() - armedAt));
      } else {
        left = Math.max(left, AFTER_APPROVAL_MS);
        arm();
      }
    });
    return Promise.race([work, timeout]).finally(() => {
      over = true;
      clearTimeout(timer);
    });
  };
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: any) => {
        let startedAt = new Date();
        let startedMs = clock();
        const result = await serialized(() => {
          startedAt = new Date(); // time the work itself, not the wait for earlier calls
          startedMs = clock();
          const { result, abort, watchWaiting } = runInCallScope(
            async (): Promise<Result> => {
              try {
                return { content: [{ type: 'text' as const, text: tool.keepWhole ? await tool.handler(args) : fitResult(await tool.handler(args)) }] };
              } catch (err: any) {
                return { isError: true, content: [{ type: 'text' as const, text: fitResult(`error: ${err?.message ?? String(err)}`) }] };
              }
            },
          );
          return withTimeout(result, abort, watchWaiting);
        });
        if (opts.onCall) {
          try {
            const record: ToolCallRecord = { at: startedAt.toISOString(), tool: tool.name, ms: Math.max(0, clock() - startedMs), ok: result.isError !== true };
            if (result.isError) record.kind = classifyError(result.content[0]?.text ?? '');
            opts.onCall(record);
          } catch {
            // logging must never break the call
          }
        }
        return result;
      },
    );
  }
  return server;
}

export async function serveComputerMcp(session: ComputerSession): Promise<void> {
  // Build the native-app helper in the background so the first desktop_snapshot already has it.
  if (axHelperEnabledByDefault()) void ensureAxHelperBinary();
  const server = createComputerMcpServer(
    buildComputerTools(session),
    process.env.RH_CALL_LOG === '0' ? {} : { onCall: (record) => appendCallRecord(os.homedir(), record) },
  );
  await server.connect(new StdioServerTransport());
  // The agent ends this server by closing its input. Without this a server with open connections (the browser) can outlive it.
  process.stdin.once('end', () => process.exit(0));
  process.stdin.once('close', () => process.exit(0));
}
