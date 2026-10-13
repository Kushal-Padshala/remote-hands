import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createComputerMcpServer, type ComputerMcpServerOptions } from './mcp-server.js';
import type { ToolCallRecord } from './call-log.js';
import type { ComputerTool } from './tools.js';

async function connect(tools: ComputerTool[], opts?: ComputerMcpServerOptions) {
  const server = createComputerMcpServer(tools, opts);
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

  it('reports each call to onCall with timing and outcome, never the arguments or result', async () => {
    const records: ToolCallRecord[] = [];
    const client = await connect(
      [
        { name: 'ok_tool', description: 'd', inputSchema: { text: z.string() }, handler: async () => 'secret result' },
        { name: 'bad_tool', description: 'd', inputSchema: {}, handler: async () => { throw new Error('Element [3]: page changed. Call browser_snapshot.'); } },
      ],
      { onCall: (r) => records.push(r) },
    );
    await client.callTool({ name: 'ok_tool', arguments: { text: 'private typed text' } });
    await client.callTool({ name: 'bad_tool', arguments: {} });
    expect(records.map((r) => [r.tool, r.ok, r.kind])).toEqual([['ok_tool', true, undefined], ['bad_tool', false, 'stale']]);
    expect(JSON.stringify(records)).not.toContain('secret');
    expect(JSON.stringify(records)).not.toContain('private typed text');
    expect(records.every((r) => typeof r.ms === 'number' && r.ms >= 0 && !Number.isNaN(Date.parse(r.at)))).toBe(true);
  });

  it('records a timed-out call as a timeout', async () => {
    const records: ToolCallRecord[] = [];
    const client = await connect(
      [{ name: 'hang', description: 'd', inputSchema: {}, handler: () => new Promise<string>(() => {}) }],
      { callTimeoutMs: 20, onCall: (r) => records.push(r) },
    );
    const res = await client.callTool({ name: 'hang', arguments: {} });
    expect(res.isError).toBe(true);
    expect(records.map((r) => [r.tool, r.ok, r.kind])).toEqual([['hang', false, 'timeout']]);
  });

  it('times the work itself on a monotonic clock, not the wait behind an earlier call', async () => {
    const records: ToolCallRecord[] = [];
    let clock = 0;
    const tools: ComputerTool[] = [
      { name: 'slow', description: 's', inputSchema: {}, handler: async () => { await new Promise((r) => setTimeout(r, 5)); clock += 400; return 'slow'; } },
      { name: 'quick', description: 'q', inputSchema: {}, handler: async () => { clock += 7; return 'quick'; } },
    ];
    const client = await connect(tools, { onCall: (r) => records.push(r), now: () => clock });
    await Promise.all([client.callTool({ name: 'slow', arguments: {} }), client.callTool({ name: 'quick', arguments: {} })]);
    expect(Object.fromEntries(records.map((r) => [r.tool, r.ms]))).toEqual({ slow: 400, quick: 7 });
  });

  it('times with a monotonic clock by default, so wall-clock jumps do not reach the log', async () => {
    const records: ToolCallRecord[] = [];
    let wall = 50_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (wall -= 60_000));
    try {
      const client = await connect(
        [{ name: 't', description: 'd', inputSchema: {}, handler: async () => { await new Promise((r) => setTimeout(r, 25)); return 'ok'; } }],
        { onCall: (r) => records.push(r) },
      );
      await client.callTool({ name: 't', arguments: {} });
    } finally {
      spy.mockRestore();
    }
    expect(records[0]!.ms).toBeGreaterThanOrEqual(15);
    expect(records[0]!.ms).toBeLessThan(2000);
  });

  it('never reports a negative duration, even if the clock misbehaves', async () => {
    const records: ToolCallRecord[] = [];
    let clock = 1000;
    const client = await connect(
      [{ name: 't', description: 'd', inputSchema: {}, handler: async () => { clock -= 60_000; return 'ok'; } }],
      { onCall: (r) => records.push(r), now: () => clock },
    );
    await client.callTool({ name: 't', arguments: {} });
    expect(records[0]!.ms).toBe(0);
  });

  it('a throwing onCall never breaks the tool call', async () => {
    const client = await connect(
      [{ name: 't', description: 'd', inputSchema: {}, handler: async () => 'fine' }],
      { onCall: () => { throw new Error('logger down'); } },
    );
    const res = await client.callTool({ name: 't', arguments: {} });
    expect(res.content).toEqual([{ type: 'text', text: 'fine' }]);
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

  it('a call that never settles times out and the queue advances (fix pass 5 C)', async () => {
    const after = vi.fn().mockResolvedValue('next ran');
    const fast = vi.fn().mockResolvedValue('quick');
    const client = await connect(
      [
        { name: 'hang', description: 'hang', inputSchema: {}, handler: () => new Promise<string>(() => {}) },
        { name: 'after', description: 'after', inputSchema: {}, handler: after },
        { name: 'fast', description: 'fast', inputSchema: {}, handler: fast },
      ],
      { callTimeoutMs: 50 },
    );
    const [hung, next] = await Promise.all([
      client.callTool({ name: 'hang', arguments: {} }),
      client.callTool({ name: 'after', arguments: {} }),
    ]);
    expect(hung.isError).toBe(true);
    expect(hung.content).toEqual([{ type: 'text', text: 'error: tool call timed out after 0.05s' }]);
    expect(next.content).toEqual([{ type: 'text', text: 'next ran' }]);
    const ok = await client.callTool({ name: 'fast', arguments: {} });
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toEqual([{ type: 'text', text: 'quick' }]);
  });

  it('the default call timeout is 90 s in the message', async () => {
    const { formatTimeout } = await import('./mcp-server.js');
    expect(formatTimeout(90_000)).toBe('error: tool call timed out after 90s');
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
