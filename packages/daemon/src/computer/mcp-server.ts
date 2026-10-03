import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ComputerSession } from './session.js';
import { buildComputerTools, type ComputerTool } from './tools.js';

/**
 * Every tool call drives the same desktop/browser, so calls are serialized per server: a
 * promise chain runs them strictly one after the other (a failing call never blocks the
 * queue). computer_batch calls the raw handlers for its steps, so it never re-enqueues.
 */
const DEFAULT_CALL_TIMEOUT_MS = 90_000;

/** The error text for a call that hit the per-call timeout. */
export function formatTimeout(ms: number): string {
  return `error: tool call timed out after ${ms / 1000}s`;
}

export interface ComputerMcpServerOptions {
  /** Per-call limit so a handler that never settles cannot block the queue (default 90 s). */
  callTimeoutMs?: number | undefined;
}

export function createComputerMcpServer(tools: ComputerTool[], opts: ComputerMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'remote-hands-computer', version: '0.1.0' });
  const limit = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  type Result = { isError?: boolean; content: { type: 'text'; text: string }[] };
  // The abandoned handler keeps running (it is not cancelled); only the queue moves on.
  const withTimeout = (work: Promise<Result>): Promise<Result> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Result>((resolve) => {
      timer = setTimeout(() => resolve({ isError: true, content: [{ type: 'text', text: formatTimeout(limit) }] }), limit);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
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
      (args: any) =>
        serialized(() =>
          withTimeout(
            (async (): Promise<Result> => {
              try {
                return { content: [{ type: 'text' as const, text: await tool.handler(args) }] };
              } catch (err: any) {
                return { isError: true, content: [{ type: 'text' as const, text: `error: ${err?.message ?? String(err)}` }] };
              }
            })(),
          ),
        ),
    );
  }
  return server;
}

export async function serveComputerMcp(session: ComputerSession): Promise<void> {
  const server = createComputerMcpServer(buildComputerTools(session));
  await server.connect(new StdioServerTransport());
}
