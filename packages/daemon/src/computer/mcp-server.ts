import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ComputerSession } from './session.js';
import { buildComputerTools, type ComputerTool } from './tools.js';

export function createComputerMcpServer(tools: ComputerTool[]): McpServer {
  const server = new McpServer({ name: 'remote-hands-computer', version: '0.1.0' });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: any) => {
        try {
          return { content: [{ type: 'text' as const, text: await tool.handler(args) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: 'text' as const, text: `error: ${err?.message ?? String(err)}` }] };
        }
      },
    );
  }
  return server;
}

export async function serveComputerMcp(session: ComputerSession): Promise<void> {
  const server = createComputerMcpServer(buildComputerTools(session));
  await server.connect(new StdioServerTransport());
}
