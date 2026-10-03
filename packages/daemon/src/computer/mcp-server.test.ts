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

  it('runs concurrent tool calls strictly one after the other, and a failure does not block the queue', async () => {
    const log: string[] = [];
    const slow = (name: string, ms: number, fail = false): ComputerTool => ({
      name,
      description: name,
      inputSchema: {},
      handler: async () => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${name}`);
        if (fail) throw new Error(`${name} failed`);
        return name;
      },
    });
    const client = await connect([slow('a', 40), slow('b', 5), slow('c', 20, true), slow('d', 1)]);
    const results = await Promise.all([
      client.callTool({ name: 'a', arguments: {} }),
      client.callTool({ name: 'b', arguments: {} }),
      client.callTool({ name: 'c', arguments: {} }),
      client.callTool({ name: 'd', arguments: {} }),
    ]);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c', 'start d', 'end d']);
    expect(results[2]!.isError).toBe(true);
    expect(results[3]!.content).toEqual([{ type: 'text', text: 'd' }]);
  });

  it('computer_batch still works through the serialized server (inner steps do not enqueue)', async () => {
    const { buildComputerTools } = await import('./tools.js');
    const session = {
      desktopType: vi.fn().mockResolvedValue('typed'),
      desktopKey: vi.fn().mockResolvedValue('pressed'),
    } as any;
    const client = await connect(buildComputerTools(session));
    const res = await Promise.race([
      client.callTool({
        name: 'computer_batch',
        arguments: { steps: [{ tool: 'desktop_type', args: { text: 'a' } }, { tool: 'desktop_key', args: { combo: 'tab' } }] },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock')), 2000)),
    ]);
    expect((res as any).isError).toBeFalsy();
    expect((res as any).content[0].text).toBe('step 1 desktop_type ok\nstep 2 desktop_key ok\npressed');
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
