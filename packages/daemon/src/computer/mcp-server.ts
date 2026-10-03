import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ComputerSession } from './session.js';
import { buildComputerTools, type ComputerTool } from './tools.js';

/**
 * Every tool call drives the same desktop/browser, so calls are serialized per server: a
 * promise chain runs them strictly one after the other (a failing call never blocks the
 * queue). computer_batch calls the raw handlers for its steps, so it never re-enqueues.
 */
export function createComputerMcpServer(tools: ComputerTool[]): McpServer {
  const server = new McpServer({ name: 'remote-hands-computer', version: '0.1.0' });
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
        serialized(async () => {
          try {
            return { content: [{ type: 'text' as const, text: await tool.handler(args) }] };
          } catch (err: any) {
            return { isError: true, content: [{ type: 'text' as const, text: `error: ${err?.message ?? String(err)}` }] };
          }
        }),
    );
  }
  return server;
}

export async function serveComputerMcp(session: ComputerSession): Promise<void> {
  const server = createComputerMcpServer(buildComputerTools(session));
  await server.connect(new StdioServerTransport());
}
