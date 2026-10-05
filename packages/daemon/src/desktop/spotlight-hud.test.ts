import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpotlightHudRunner } from './spotlight-hud.js';

// Parse prompt responses without compiling Swift or opening a real native HUD.
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: 'native helper unavailable in unit tests' })),
  spawn: vi.fn(() => ({
    on: vi.fn(), stdout: { on: vi.fn() }, stdin: { writable: false }, killed: false,
    kill: vi.fn(), unref: vi.fn(),
  })),
}));

describe('SpotlightHudRunner', () => {
  let mockExec: any;
  let runner: SpotlightHudRunner;

  beforeEach(() => {
    mockExec = vi.fn();
    runner = new SpotlightHudRunner(mockExec);
  });

  it('parses successful prompt response from swift hud', async () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify({ query: 'how to upload a new file', app: 'Photoshop' }),
      stderr: '',
      status: 0,
    });

    const result = await runner.openPrompt('Photoshop');
    expect(result).toEqual({ query: 'how to upload a new file', app: 'Photoshop' });
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringMatching(/swift|rh-spotlight/),
      expect.arrayContaining(['prompt', '--app=Photoshop'])
    );
  });

  it('returns null when user cancels prompt or exits with non-zero status', async () => {
    mockExec.mockReturnValue({
      stdout: '',
      stderr: 'cancelled',
      status: 1,
    });

    const result = await runner.openPrompt();
    expect(result).toBeNull();
  });

  it('handles invalid json output gracefully', async () => {
    mockExec.mockReturnValue({
      stdout: 'not a json',
      stderr: '',
      status: 0,
    });

    const result = await runner.openPrompt();
    expect(result).toBeNull();
  });

  it('exposes openInteractivePrompt method returning a close handle', () => {
    const handle = runner.openInteractivePrompt('Finder', () => {});
    expect(handle).toBeDefined();
    expect(typeof handle.close).toBe('function');
    handle.close();
  });

  it('triggers onCancel when handle.close is invoked', () => {
    const onCancel = vi.fn();
    const handle = runner.openInteractivePrompt('Finder', () => {}, onCancel);
    handle.close();
    expect(onCancel).toHaveBeenCalled();
  });

  it('accepts onStop callback in openInteractivePrompt', () => {
    const onCancel = vi.fn();
    const onStop = vi.fn();
    const handle = runner.openInteractivePrompt('Finder', () => {}, onCancel, onStop);
    expect(handle).toBeDefined();
    handle.close();
    expect(onCancel).toHaveBeenCalled();
  });

  it('parses attachments in prompt response from swift hud', async () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify({
        query: 'check the ad campaign',
        app: 'Arc',
        attachments: [
          {
            type: 'browser_tab',
            id: 'tab-1',
            browser: 'Arc',
            title: 'Meta Ads Manager',
            url: 'https://adsmanager.facebook.com',
          },
        ],
      }),
      stderr: '',
      status: 0,
    });

    const result = await runner.openPrompt('Arc');
    expect(result).toEqual({
      query: 'check the ad campaign',
      app: 'Arc',
      attachments: [
        {
          type: 'browser_tab',
          id: 'tab-1',
          browser: 'Arc',
          title: 'Meta Ads Manager',
          url: 'https://adsmanager.facebook.com',
        },
      ],
    });
  });
});


describe('embedded hotkey helper source', () => {
  it('matches spotlight-hud.swift (run `npm run build -w @remote-hands/daemon` after editing the Swift file)', async () => {
    const fsm = await import('node:fs');
    const pathm = await import('node:path');
    const { SPOTLIGHT_SWIFT_SOURCE } = await import('./spotlight-source.generated.js');
    const file = pathm.join(__dirname, 'spotlight-hud.swift');
    expect(SPOTLIGHT_SWIFT_SOURCE).toBe(fsm.readFileSync(file, 'utf-8'));
  });

  it('materializeSwiftSource writes it when missing, repairs a stale copy, and leaves a fresh copy untouched', async () => {
    const fsm = await import('node:fs');
    const osm = await import('node:os');
    const pathm = await import('node:path');
    const { materializeSwiftSource } = await import('./spotlight-hud.js');
    const home = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'rh-swift-'));
    try {
      const target = materializeSwiftSource(home, 'v1');
      expect(target).toBe(pathm.join(home, '.remote-hands', 'spotlight-hud.swift'));
      expect(fsm.readFileSync(target, 'utf-8')).toBe('v1');
      const old = new Date(Date.now() - 60_000);
      fsm.utimesSync(target, old, old);
      materializeSwiftSource(home, 'v1');
      expect(fsm.statSync(target).mtimeMs).toBeLessThan(Date.now() - 30_000);
      materializeSwiftSource(home, 'v2');
      expect(fsm.readFileSync(target, 'utf-8')).toBe('v2');
    } finally {
      fsm.rmSync(home, { recursive: true, force: true });
    }
  });
});
