import { describe, it, expect, vi } from 'vitest';
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
  } as unknown as ComputerSession & Record<string, ReturnType<typeof vi.fn>>;
}

describe('buildComputerTools', () => {
  it('exposes the expected tool names', () => {
    const names = buildComputerTools(fakeSession()).map((t) => t.name).sort();
    expect(names).toEqual([
      'browser_click',
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
    expect(session.browserType).toHaveBeenCalledWith(2, 'hi');
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
    expect(session.browserType).toHaveBeenCalledWith(2, 'hi');
    expect(session.desktopWindows).toHaveBeenCalledTimes(1);
    expect(out).toBe('step 1 browser_type ok\nstep 2 desktop_windows ok\nwins');
  });
});
