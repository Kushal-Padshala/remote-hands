import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
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
    const steps = [{ op: 'click', index: 1 }];
    await batch.handler({ steps: [{ tool: 'browser_do', args: { steps } }] });
    expect(session.browserDo).toHaveBeenCalledWith(steps);
  });

  it('computer_batch description says browser_do is preferred for browser sequences', () => {
    const batch = buildComputerTools(fakeSession()).find((t) => t.name === 'computer_batch')!;
    expect(batch.description).toContain('browser_do');
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
});
