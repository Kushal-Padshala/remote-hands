import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createComputerMcpServer } from './mcp-server.js';
import type { ComputerTool } from './tools.js';

async function connect(tools: ComputerTool[]) {
  const server = createComputerMcpServer(tools);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe('createComputerMcpServer', () => {
  it('lists tools and returns handler text', async () => {
    const handler = vi.fn().mockResolvedValue('state text');
    const client = await connect([
      { name: 'echo', description: 'Echo', inputSchema: { text: z.string() }, handler },
    ]);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['echo']);
    const res = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(handler).toHaveBeenCalledWith({ text: 'hi' });
    expect(res.content).toEqual([{ type: 'text', text: 'state text' }]);
    expect(res.isError).toBeFalsy();
  });

  it('turns handler exceptions into isError results', async () => {
    const client = await connect([
      { name: 'boom', description: 'Boom', inputSchema: {}, handler: async () => { throw new Error('nope'); } },
    ]);
    const res = await client.callTool({ name: 'boom', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: 'text', text: 'error: nope' }]);
  });

  it('rejects invalid arguments without invoking the handler', async () => {
    const handler = vi.fn().mockResolvedValue('should not run');
    const client = await connect([
      { name: 'num', description: 'Num', inputSchema: { index: z.number().int() }, handler },
    ]);
    let isError = false;
    let text = '';
    try {
      const res = await client.callTool({ name: 'num', arguments: { index: 'three' } });
      isError = res.isError === true;
      text = JSON.stringify(res.content);
    } catch (err: any) {
      isError = true;
      text = String(err?.message ?? err);
    }
    expect(isError).toBe(true);
    expect(text).toMatch(/num|invalid/i);
    expect(handler).not.toHaveBeenCalled();
  });
});
