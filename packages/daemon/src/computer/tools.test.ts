import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createComputerMcpServer } from './mcp-server.js';
import { buildComputerTools } from './tools.js';
import type { ComputerSession } from './session.js';

function fakeSession() {
  return {
    desktopSnapshot: vi.fn().mockResolvedValue('snap'),
    desktopClick: vi.fn().mockResolvedValue('clicked'),
    desktopType: vi.fn().mockResolvedValue('typed'),
    desktopKey: vi.fn().mockResolvedValue('pressed'),
    desktopOpen: vi.fn().mockResolvedValue('opened'),
    desktopMenu: vi.fn().mockResolvedValue('menu'),
    desktopWindows: vi.fn().mockResolvedValue('wins'),
    browserTabs: vi.fn().mockResolvedValue('tabs'),
    browserFocus: vi.fn().mockResolvedValue('focused'),
    browserOpen: vi.fn().mockResolvedValue('opened url'),
    browserSnapshot: vi.fn().mockResolvedValue('bsnap'),
    browserClick: vi.fn().mockResolvedValue('bclicked'),
    browserType: vi.fn().mockResolvedValue('btyped'),
    browserFind: vi.fn().mockResolvedValue('bfound'),
    browserDo: vi.fn().mockResolvedValue('bdid'),
    browserExtract: vi.fn().mockResolvedValue('bextracted'),
  } as unknown as ComputerSession & Record<string, ReturnType<typeof vi.fn>>;
}

describe('buildComputerTools', () => {
  it('exposes the expected tool names', () => {
    const names = buildComputerTools(fakeSession()).map((t) => t.name).sort();
    expect(names).toEqual([
      'browser_click',
      'browser_do',
      'browser_extract',
      'browser_find',
      'browser_focus',
      'browser_open',
      'browser_snapshot',
      'browser_tabs',
      'browser_type',
      'computer_batch',
      'desktop_click',
      'desktop_key',
      'desktop_menu',
      'desktop_open',
      'desktop_snapshot',
      'desktop_type',
      'desktop_windows',
    ]);
  });

  it('routes handler arguments to the session', async () => {
    const session = fakeSession();
    const tool = (name: string) => buildComputerTools(session).find((t) => t.name === name)!;
    await tool('desktop_click').handler({ index: 4, app: 'Finder' });
    expect(session.desktopClick).toHaveBeenCalledWith(4, 'Finder');
    await tool('browser_type').handler({ index: 2, text: 'hi' });
    expect(session.browserType).toHaveBeenCalledWith(2, 'hi', undefined);
    await tool('browser_type').handler({ index: 2, text: 'hi', submit: true });
    expect(session.browserType).toHaveBeenLastCalledWith(2, 'hi', true);
    await tool('desktop_snapshot').handler({ filter: 'save' });
    expect(session.desktopSnapshot).toHaveBeenCalledWith(undefined, 'save');
  });

  it('batch runs steps in order and returns the last state', async () => {
    const session = fakeSession();
    const batch = buildComputerTools(session).find((t) => t.name === 'computer_batch')!;
    const out = await batch.handler({
      steps: [
        { tool: 'desktop_type', args: { text: 'a' } },
        { tool: 'desktop_key', args: { combo: 'tab' } },
      ],
    });
    expect(session.desktopType).toHaveBeenCalledWith('a', undefined);
    expect(session.desktopKey).toHaveBeenCalledWith('tab', undefined);
    expect(out).toBe('step 1 desktop_type ok\nstep 2 desktop_key ok\npressed');
  });

  it('batch stops at the first failing step and reports it', async () => {
    const session = fakeSession();
    session.desktopKey = vi.fn().mockRejectedValue(new Error('bad combo'));
    const batch = buildComputerTools(session).find((t) => t.name === 'computer_batch')!;
    await expect(
      batch.handler({
        steps: [
          { tool: 'desktop_type', args: { text: 'a' } },
          { tool: 'desktop_key', args: { combo: '??' } },
          { tool: 'desktop_type', args: { text: 'never' } },
        ],
      }),
    ).rejects.toThrow('step 2 desktop_key failed: bad combo (step 1 ok; steps after 2 not run)');
    expect(session.desktopType).toHaveBeenCalledTimes(1);
  });

  it('batch rejects nested batches and unknown tools', async () => {
    const batch = buildComputerTools(fakeSession()).find((t) => t.name === 'computer_batch')!;
    await expect(batch.handler({ steps: [{ tool: 'computer_batch', args: {} }] })).rejects.toThrow(
      'step 1 computer_batch failed: unknown or nested tool',
    );
  });

  it('batch validates every step before running any (bad arg type)', async () => {
    const session = fakeSession();
    const batch = buildComputerTools(session).find((t) => t.name === 'computer_batch')!;
    await expect(
      batch.handler({
        steps: [
          { tool: 'desktop_type', args: { text: 'a' } },
          { tool: 'desktop_click', args: { index: '3' } },
        ],
      }),
    ).rejects.toThrow(/^step 2 desktop_click invalid args: .*No steps were run\.$/);
    expect(session.desktopType).not.toHaveBeenCalled();
    expect(session.desktopClick).not.toHaveBeenCalled();
  });

  it('batch detects an unknown tool before any handler runs', async () => {
    const session = fakeSession();
    const batch = buildComputerTools(session).find((t) => t.name === 'computer_batch')!;
    await expect(
      batch.handler({
        steps: [
          { tool: 'desktop_type', args: { text: 'a' } },
          { tool: 'desktop_key', args: { combo: 'tab' } },
          { tool: 'bogus', args: {} },
        ],
      }),
    ).rejects.toThrow('step 3 bogus failed: unknown or nested tool');
    expect(session.desktopType).not.toHaveBeenCalled();
    expect(session.desktopKey).not.toHaveBeenCalled();
  });

  it('batch rejects a step with a missing required arg before running anything', async () => {
    const session = fakeSession();
    const batch = buildComputerTools(session).find((t) => t.name === 'computer_batch')!;
    await expect(
      batch.handler({
        steps: [
          { tool: 'desktop_type', args: { text: 'a' } },
          { tool: 'browser_type', args: { index: 2 } },
        ],
      }),
    ).rejects.toThrow(/step 2 browser_type invalid args: text: .*No steps were run\./);
    expect(session.browserType).not.toHaveBeenCalled();
    expect(session.desktopType).not.toHaveBeenCalled();
  });

  it('batch passes parsed args to handlers', async () => {
    const session = fakeSession();
    const batch = buildComputerTools(session).find((t) => t.name === 'computer_batch')!;
    const out = await batch.handler({
      steps: [
        { tool: 'browser_type', args: { index: 2, text: 'hi', extra: 'dropped' } },
        { tool: 'desktop_windows' },
      ],
    });
    expect(session.browserType).toHaveBeenCalledWith(2, 'hi', undefined);
    expect(session.desktopWindows).toHaveBeenCalledTimes(1);
    expect(out).toBe('step 1 browser_type ok\nstep 2 desktop_windows ok\nwins');
  });

  it('has 17 tools', () => {
    expect(buildComputerTools(fakeSession())).toHaveLength(17);
  });

  it('routes browser_find, browser_do and browser_extract args unchanged', async () => {
    const session = fakeSession();
    const tool = (name: string) => buildComputerTools(session).find((t) => t.name === name)!;
    await tool('browser_find').handler({ query: 'sign in', limit: 5 });
    expect(session.browserFind).toHaveBeenCalledWith('sign in', 5);
    await tool('browser_find').handler({ query: 'x' });
    expect(session.browserFind).toHaveBeenLastCalledWith('x', undefined);
    const steps = [
      { op: 'type', index: 3, text: 'a@b.c', submit: true },
      { op: 'press', key: 'Enter' },
    ];
    await tool('browser_do').handler({ steps });
    expect(session.browserDo).toHaveBeenCalledWith(steps);
    await tool('browser_extract').handler({ max_chars: 900 });
    expect(session.browserExtract).toHaveBeenCalledWith(900);
    await tool('browser_extract').handler({});
    expect(session.browserExtract).toHaveBeenLastCalledWith(undefined);
  });

  describe('zod validation of the new browser tools', () => {
    const schema = (name: string) =>
      z.object(buildComputerTools(fakeSession()).find((t) => t.name === name)!.inputSchema);
    const doOk = (steps: unknown) => schema('browser_do').safeParse({ steps }).success;

    it('browser_do accepts every op shape', () => {
      expect(
        doOk([
          { op: 'click', index: 1 },
          { op: 'type', index: 2, text: 'x', submit: false },
          { op: 'select', index: 3, value: 'v' },
          { op: 'check', index: 4, checked: true },
          { op: 'press', key: 'Enter' },
          { op: 'scroll', delta: -400 },
          { op: 'wait', ms: 0 },
          { op: 'wait', ms: 5000 },
        ]),
      ).toBe(true);
    });

    it('browser_do rejects bad ops, missing fields and bad values', () => {
      expect(doOk([{ op: 'hover', index: 1 }])).toBe(false);
      expect(doOk([{ op: 'click' }])).toBe(false);
      expect(doOk([{ op: 'click', index: 0 }])).toBe(false);
      expect(doOk([{ op: 'click', index: -2 }])).toBe(false);
      expect(doOk([{ op: 'click', index: 1.5 }])).toBe(false);
      expect(doOk([{ op: 'click', index: '1' }])).toBe(false);
      expect(doOk([{ op: 'type', index: 1 }])).toBe(false);
      expect(doOk([{ op: 'select', index: 1 }])).toBe(false);
      expect(doOk([{ op: 'check', index: 1 }])).toBe(false);
      expect(doOk([{ op: 'press' }])).toBe(false);
      expect(doOk([{ op: 'scroll' }])).toBe(false);
      expect(doOk([{ op: 'wait', ms: 5001 }])).toBe(false);
      expect(doOk([{ op: 'wait', ms: -1 }])).toBe(false);
      expect(doOk([])).toBe(false);
      expect(doOk(Array.from({ length: 16 }, () => ({ op: 'press', key: 'Tab' })))).toBe(false);
      expect(doOk(Array.from({ length: 15 }, () => ({ op: 'press', key: 'Tab' })))).toBe(true);
      expect(schema('browser_do').safeParse({}).success).toBe(false);
    });

    it('browser_do per-op required fields name the step number and op', () => {
      const msgs = (steps: unknown[]) => {
        const r = schema('browser_do').safeParse({ steps });
        return r.success ? [] : r.error.issues.map((i) => i.message);
      };
      expect(msgs([{ op: 'press', key: 'Tab' }, { op: 'click' }])).toEqual([expect.stringMatching(/step 2 click.*index/)]);
      expect(msgs([{ op: 'type', index: 1 }])).toEqual([expect.stringMatching(/step 1 type.*text/)]);
      expect(msgs([{ op: 'select', index: 1 }])).toEqual([expect.stringMatching(/step 1 select.*value/)]);
      expect(msgs([{ op: 'check', index: 1 }])).toEqual([expect.stringMatching(/step 1 check.*checked/)]);
      expect(msgs([{ op: 'press' }])).toEqual([expect.stringMatching(/step 1 press.*key/)]);
      expect(msgs([{ op: 'scroll' }])).toEqual([expect.stringMatching(/step 1 scroll.*delta/)]);
      expect(msgs([{ op: 'wait' }])).toEqual([expect.stringMatching(/step 1 wait.*ms/)]);
    });

    it('browser_do steps keep every provided field through parsing', () => {
      const step = { op: 'type', index: 3, text: 'a', submit: true };
      const r = schema('browser_do').safeParse({ steps: [step] });
      expect(r.success && r.data.steps).toEqual([step]);
    });

    it('browser_click and browser_type ids must be integers >= 1', () => {
      for (const name of ['browser_click', 'browser_type']) {
        const base = name === 'browser_type' ? { text: 'x' } : {};
        expect(schema(name).safeParse({ index: 1, ...base }).success).toBe(true);
        expect(schema(name).safeParse({ index: 0, ...base }).success).toBe(false);
        expect(schema(name).safeParse({ index: -3, ...base }).success).toBe(false);
        expect(schema(name).safeParse({ index: 1.5, ...base }).success).toBe(false);
      }
    });

    it('browser_find limits are 1-20 integers and query is required', () => {
      const f = schema('browser_find');
      expect(f.safeParse({ query: 'a' }).success).toBe(true);
      expect(f.safeParse({ query: 'a', limit: 1 }).success).toBe(true);
      expect(f.safeParse({ query: 'a', limit: 20 }).success).toBe(true);
      expect(f.safeParse({ query: 'a', limit: 0 }).success).toBe(false);
      expect(f.safeParse({ query: 'a', limit: 21 }).success).toBe(false);
      expect(f.safeParse({ query: 'a', limit: 2.5 }).success).toBe(false);
      expect(f.safeParse({}).success).toBe(false);
    });

    it('browser_extract max_chars is 200-20000 and optional', () => {
      const e = schema('browser_extract');
      expect(e.safeParse({}).success).toBe(true);
      expect(e.safeParse({ max_chars: 200 }).success).toBe(true);
      expect(e.safeParse({ max_chars: 20000 }).success).toBe(true);
      expect(e.safeParse({ max_chars: 199 }).success).toBe(false);
      expect(e.safeParse({ max_chars: 20001 }).success).toBe(false);
    });

    it('browser_type accepts an optional boolean submit', () => {
      const t = schema('browser_type');
      expect(t.safeParse({ index: 1, text: 'x', submit: true }).success).toBe(true);
      expect(t.safeParse({ index: 1, text: 'x' }).success).toBe(true);
      expect(t.safeParse({ index: 1, text: 'x', submit: 'yes' }).success).toBe(false);
    });
  });

  it('batch validates browser_do steps up front and passes them through', async () => {
    const session = fakeSession();
    const batch = buildComputerTools(session).find((t) => t.name === 'computer_batch')!;
    await expect(
      batch.handler({ steps: [{ tool: 'browser_do', args: { steps: [{ op: 'bogus' }] } }] }),
    ).rejects.toThrow(/step 1 browser_do invalid args: .*No steps were run\./);
    expect(session.browserDo).not.toHaveBeenCalled();
    await expect(
      batch.handler({ steps: [{ tool: 'browser_do', args: { steps: [{ op: 'click' }] } }] }),
    ).rejects.toThrow('step 1 browser_do invalid args: steps.0.index: step 1 click needs index. No steps were run.');
    const steps = [{ op: 'click', index: 1 }];
    await batch.handler({ steps: [{ tool: 'browser_do', args: { steps } }] });
    expect(session.browserDo).toHaveBeenCalledWith(steps);
  });

  it('computer_batch description says browser_do is preferred for browser sequences', () => {
    const batch = buildComputerTools(fakeSession()).find((t) => t.name === 'computer_batch')!;
    expect(batch.description).toContain('browser_do');
  });

  it('browser_do says press is synthetic and browser_snapshot says selects/checkboxes need browser_do (fix pass 4)', () => {
    const tools = buildComputerTools(fakeSession());
    const d = (n: string) => tools.find((t) => t.name === n)!.description;
    expect(d('browser_do')).toMatch(/press dispatches synthetic key events only/i);
    expect(d('browser_do')).toMatch(/Enter submits forms/);
    expect(d('browser_do')).toMatch(/Tab.*do not move focus or type/);
    expect(d('browser_snapshot')).toMatch(/selects and checkboxes .*browser_do.*"select".*"check"/i);
    expect(d('browser_snapshot')).toMatch(/browser_click\/browser_type cannot/);
  });

  it('computer_batch description says only desktop indexes shift; browser ids are stable', () => {
    const batch = buildComputerTools(fakeSession()).find((t) => t.name === 'computer_batch')!;
    expect(batch.description).toMatch(/only DESKTOP indexes/i);
    expect(batch.description).toMatch(/browser ids are stable/i);
    expect(batch.description).not.toMatch(/browser_click, browser_type\) refer to the UI state AFTER/);
  });

  it('browser tool descriptions teach the stable-id model', () => {
    const tools = buildComputerTools(fakeSession());
    const d = (n: string) => tools.find((t) => t.name === n)!.description;
    for (const n of ['browser_click', 'browser_type', 'browser_open', 'browser_focus']) {
      expect(d(n)).toMatch(/do not call browser_snapshot/i);
    }
    expect(d('browser_snapshot')).toMatch(/stable/i);
    expect(d('browser_do')).toMatch(/form/i);
    expect(d('browser_find')).toMatch(/large|big/i);
    expect(d('browser_extract')).toMatch(/long text/i);
  });

  it('no tool advertises oneOf, anyOf, allOf, $ref, const, exclusive bounds, not, if or then in its JSON Schema', async () => {
    const server = createComputerMcpServer(buildComputerTools(fakeSession()));
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(17);
    const banned = new Set(['oneOf', 'anyOf', 'allOf', '$ref', 'const', 'exclusiveMinimum', 'exclusiveMaximum', 'not', 'if', 'then']);
    const found: string[] = [];
    const walk = (node: unknown, where: string, inProperties = false): void => {
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${where}[${i}]`));
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        // keys of a `properties` map are field names, not schema keywords
        if (!inProperties && banned.has(k)) found.push(`${where}.${k}`);
        walk(v, `${where}.${k}`, !inProperties && k === 'properties');
      }
    };
    for (const t of tools) walk(t.inputSchema, t.name);
    expect(found).toEqual([]);
  });

  it('browser_do schema is a flat step object with a plain string enum op', async () => {
    const server = createComputerMcpServer(buildComputerTools(fakeSession()));
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const items = (tools.find((t) => t.name === 'browser_do')!.inputSchema as any).properties.steps.items;
    expect(items.type).toBe('object');
    expect(items.properties.op).toMatchObject({ type: 'string', enum: ['click', 'type', 'select', 'check', 'press', 'scroll', 'wait'] });
    expect(items.required).toEqual(['op']);
    expect(Object.keys(items.properties).sort()).toEqual(
      ['checked', 'delta', 'index', 'key', 'ms', 'op', 'submit', 'text', 'value'],
    );
  });

  it('browser_do and browser_snapshot descriptions carry the example, per-op fields and pseudo-line mapping', () => {
    const tools = buildComputerTools(fakeSession());
    const d = (n: string) => tools.find((t) => t.name === n)!.description;
    expect(d('browser_do')).toContain('[{"op":"type","index":3,"text":"me@x.com"},{"op":"click","index":7}]');
    expect(d('browser_do')).toMatch(/click\/type\/select\/check need index/);
    expect(d('browser_do')).toMatch(/remaining steps not run/);
    expect(d('browser_do')).toMatch(/fallback.*only click, type and wait/i);
    for (const n of ['browser_do', 'browser_snapshot']) {
      expect(d(n)).toContain('[scroll_down]');
      expect(d(n)).toContain('[scroll_up]');
      expect(d(n)).toContain('[wait]');
      expect(d(n)).toMatch(/\{op:"scroll",delta:560\|-560\}/);
    }
  });

  it('browser_find query description does not promise surrounding-text matching', () => {
    const find = buildComputerTools(fakeSession()).find((t) => t.name === 'browser_find')!;
    expect(JSON.stringify(z.toJSONSchema(find.inputSchema.query!))).not.toMatch(/surrounding/);
    expect(find.description).not.toMatch(/surrounding/);
  });
});
