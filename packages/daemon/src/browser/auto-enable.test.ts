import { describe, it, expect, vi } from 'vitest';
import { createAutoEnable } from './auto-enable.js';
import { findBrowser } from './browsers.js';
import type { SetupFs } from './setup.js';

const chrome = findBrowser('chrome')!;

function fsWith(content: string | null): SetupFs {
  return {
    readFile: async () => {
      if (content === null) throw new Error('ENOENT');
      return content;
    },
    writeFile: async () => {},
    rename: async () => {},
    mkdir: async () => {},
  };
}

const state = (decision: string) => JSON.stringify({ browsers: { 'Google Chrome': { decision, at: '2026-10-03T00:00:00.000Z' } } });
const transport = {} as any;

describe('createAutoEnable', () => {
  it('runs setup only for a browser the user approved during rh browser setup', async () => {
    const enableJs = vi.fn(async () => ({ ok: true as const, changed: true, state: 'checked' as const }));
    const auto = createAutoEnable({ transport, setup: { enableJs } as any, fs: fsWith(state('enabled')), platform: 'darwin' });
    expect(await auto(chrome)).toEqual({ ok: true });
    expect(enableJs).toHaveBeenCalledTimes(1);
    // never asks the user to click: no guide callback is passed
    expect((enableJs.mock.calls[0] as unknown[]).length).toBe(1);
  });

  it.each([['declined'], ['manual']])('never for a %s browser', async (decision) => {
    const enableJs = vi.fn();
    const auto = createAutoEnable({ transport, setup: { enableJs } as any, fs: fsWith(state(decision)), platform: 'darwin' });
    expect(await auto(chrome)).toEqual({ ok: false });
    expect(enableJs).not.toHaveBeenCalled();
  });

  it('never when the user was never asked (no state file) or on another platform', async () => {
    const enableJs = vi.fn();
    expect(await createAutoEnable({ transport, setup: { enableJs } as any, fs: fsWith(null), platform: 'darwin' })(chrome)).toEqual({ ok: false });
    expect(await createAutoEnable({ transport, setup: { enableJs } as any, fs: fsWith(state('enabled')), platform: 'linux' })(chrome)).toEqual({ ok: false });
    expect(enableJs).not.toHaveBeenCalled();
  });

  it('reports why it failed, including a thrown error', async () => {
    const failing = createAutoEnable({
      transport,
      setup: { enableJs: async () => ({ ok: false as const, reason: 'accessibility_denied' as const, message: 'AX denied' }) } as any,
      fs: fsWith(state('enabled')),
      platform: 'darwin',
    });
    expect(await failing(chrome)).toEqual({ ok: false, message: 'AX denied' });
    const throwing = createAutoEnable({
      transport,
      setup: {
        enableJs: async () => {
          throw new Error('boom');
        },
      } as any,
      fs: fsWith(state('enabled')),
      platform: 'darwin',
    });
    expect(await throwing(chrome)).toEqual({ ok: false, message: 'boom' });
  });
});
