import { describe, it, expect, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { ComputerSession, createDefaultComputerSession, type ComputerSessionDeps } from './session.js';
import { FastBrowserEngine } from '../browser/engine.js';
import { AppleScriptTransport } from '../browser/transport.js';
import { LegacyBrowserPort } from '../browser/legacy-port.js';
import { searchAndTriggerMenu } from '../desktop/menu-crawler.js';
import { classifyRiskyAction } from '@remote-hands/shared';

// Inert stubs: nothing real is ever spawned, and every call is recorded.
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ on: () => {}, stdout: null, stderr: null, kill: () => {} })),
    spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '', error: new Error('stubbed') })),
    execFile: vi.fn(() => ({ on: () => {}, kill: () => {} })),
    execFileSync: vi.fn(() => {
      throw new Error('stubbed');
    }),
    exec: vi.fn(() => ({ on: () => {}, kill: () => {} })),
  };
});

function makeDeps(overrides: Partial<ComputerSessionDeps> = {}) {
  const elements = [
    { index: 1, role: 'AXButton', label: 'Next', bounds: [10, 20, 100, 40] as [number, number, number, number] },
    { index: 2, role: 'AXTextField', label: 'Email', bounds: [0, 0, 50, 20] as [number, number, number, number] },
  ];
  const deps: ComputerSessionDeps = {
    desktop: {
      openApp: vi.fn().mockResolvedValue(undefined),
      focusWindow: vi.fn().mockResolvedValue(undefined),
      typeText: vi.fn().mockResolvedValue(undefined),
      sendKeyCombo: vi.fn().mockResolvedValue(undefined),
      listWindows: vi.fn().mockResolvedValue([{ app: 'Finder', title: 'Docs' }]),
      getActiveWindowContext: vi.fn().mockResolvedValue({ app: 'Finder', title: 'Docs' }),
    },
    walker: { walkActiveApp: vi.fn().mockResolvedValue(elements) },
    axAction: vi.fn().mockResolvedValue({ success: true, method: 'ax' }),
    menuSearch: vi.fn(async (_app, _query, _exec, gate) => {
      await gate?.('Save');
      return { success: true, triggeredPath: ['File', 'Save'] };
    }),
    browser: {
      tabs: vi.fn().mockResolvedValue('tabs text'),
      focus: vi.fn().mockResolvedValue('focused text'),
      open: vi.fn().mockResolvedValue('opened text'),
      snapshot: vi.fn().mockResolvedValue('snapshot text'),
      click: vi.fn().mockResolvedValue('click text'),
      type: vi.fn().mockResolvedValue('type text'),
      find: vi.fn().mockResolvedValue('find text'),
      do: vi.fn().mockResolvedValue('do text'),
      extract: vi.fn().mockResolvedValue('extract text'),
    },
    settleMs: 0,
    sleep: async () => {},
    ...overrides,
  };
  return deps;
}

describe('ComputerSession desktop', () => {
  it('requires approval for a menu item resolved from an abbreviated query', async () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stderr: '', stdout: JSON.stringify({ success: true, triggeredPath: ['Edit', 'Delete'], appPid: 123 }) });
    const asked: string[] = [];
    const deps = makeDeps({
      menuSearch: (app, query, _exec, gate) => searchAndTriggerMenu(app, query, exec, gate),
      gate: async (label) => { asked.push(label); if (classifyRiskyAction(label)) throw new Error('Approval rejected'); },
    });
    await expect(new ComputerSession(deps).desktopMenu('Mail', 'Del')).rejects.toThrow('Approval rejected');
    expect(asked).toEqual(['Delete']);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('asks the gate before a desktop click or menu item, and a rejection stops it', async () => {
    const gate = vi.fn().mockRejectedValue(new Error('Approval rejected by user.'));
    const deps = makeDeps({ gate });
    const s = new ComputerSession(deps);
    await s.desktopSnapshot('Finder');
    await expect(s.desktopClick(1)).rejects.toThrow('Approval rejected by user.');
    await expect(s.desktopMenu('Finder', 'Delete')).rejects.toThrow('Approval rejected by user.');
    expect(gate.mock.calls.map((c) => c[0])).toEqual(['Next', 'Save']);
    expect(deps.axAction).not.toHaveBeenCalled();
    expect(deps.menuSearch).toHaveBeenCalledWith('Finder', 'Delete', undefined, gate);
  });

  it('snapshot walks once, caches, and returns a header plus compact lines', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    const out = await s.desktopSnapshot('Finder');
    expect(out).toBe('app: Finder\n[1] Button "Next"\n[2] TextField "Email"');
    expect(deps.walker.walkActiveApp).toHaveBeenCalledTimes(1);
  });

  it('click uses the cached element without re-walking first, then returns fresh state', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    await s.desktopSnapshot('Finder');
    const out = await s.desktopClick(1, 'Finder');
    expect(deps.axAction).toHaveBeenCalledTimes(1);
    expect(deps.walker.walkActiveApp).toHaveBeenCalledTimes(2);
    expect(out.startsWith('clicked [1] Button "Next"')).toBe(true);
    expect(out).toContain('[2] TextField "Email"');
  });

  it('click targets strictly by bounds and role, with an empty label and NO index key', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    await s.desktopSnapshot('Finder');
    const out = await s.desktopClick(1, 'Finder');
    const call = vi.mocked(deps.axAction).mock.calls[0]!;
    expect(call[0]).toBe('Finder');
    // Strict matching ignores the label; an empty one keeps typed/label text out of the Swift script.
    expect(call[1]).toEqual({ bounds: [10, 20, 100, 40], role: 'AXButton', label: '', strict: true });
    expect(out.startsWith('clicked [1] Button "Next"')).toBe(true);
    expect(Object.keys(call[1] as object)).not.toContain('index');
    expect(call[2]).toBe('AXPress');
  });

  it('click without a cached snapshot errors and tells the model to snapshot', async () => {
    const s = new ComputerSession(makeDeps());
    await expect(s.desktopClick(1)).rejects.toThrow('No snapshot cached. Call desktop_snapshot first.');
  });

  it('click with an index missing from the cache errors instead of guessing', async () => {
    const s = new ComputerSession(makeDeps());
    await s.desktopSnapshot('Finder');
    await expect(s.desktopClick(99, 'Finder')).rejects.toThrow('Index 99 not in last snapshot. Call desktop_snapshot again.');
  });

  it('throws a re-snapshot hint when the element is not found any more', async () => {
    const deps = makeDeps({ axAction: vi.fn().mockResolvedValue({ success: false, error: 'Element not found' }) });
    const s = new ComputerSession(deps);
    await s.desktopSnapshot('Finder');
    await expect(s.desktopClick(1, 'Finder')).rejects.toThrow('Element [1] no longer present. Call desktop_snapshot again.');
  });

  it('throws a generic failure message including the error', async () => {
    const deps = makeDeps({ axAction: vi.fn().mockResolvedValue({ success: false, error: 'AXPress failed' }) });
    const s = new ComputerSession(deps);
    await s.desktopSnapshot('Finder');
    await expect(s.desktopClick(1, 'Finder')).rejects.toThrow(
      'AX press failed for [1] (AXPress failed). Call desktop_snapshot and retry.',
    );
  });

  it('notes when the press was delivered as a physical click', async () => {
    const deps = makeDeps({ axAction: vi.fn().mockResolvedValue({ success: true, method: 'cgevent' }) });
    const s = new ComputerSession(deps);
    await s.desktopSnapshot('Finder');
    const out = await s.desktopClick(1, 'Finder');
    expect(out).toContain('note: AX press unsupported on this element; used a physical click at its center');
    expect(out.indexOf('note:')).toBeLessThan(out.indexOf('[2] TextField'));
  });

  it('refuses to click when the requested app differs from the snapshot app', async () => {
    const s = new ComputerSession(makeDeps());
    await s.desktopSnapshot('Finder');
    await expect(s.desktopClick(1, 'Safari')).rejects.toThrow(
      'Last snapshot was of Finder, not Safari. Call desktop_snapshot for Safari first.',
    );
  });

  it('compares app names case-insensitively', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    await s.desktopSnapshot('Finder');
    await expect(s.desktopClick(1, 'finder')).resolves.toContain('clicked [1]');
    expect(vi.mocked(deps.axAction).mock.calls[0]![0]).toBe('Finder');
  });

  it('snapshot without app resolves the frontmost app name and walks with it', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    const out = await s.desktopSnapshot();
    expect(deps.walker.walkActiveApp).toHaveBeenCalledWith('Finder', { allowOcr: false });
    expect(out.startsWith('app: Finder\n')).toBe(true);
    await s.desktopClick(1);
    expect(vi.mocked(deps.axAction).mock.calls[0]![0]).toBe('Finder');
    expect(vi.mocked(deps.walker.walkActiveApp).mock.calls[1]![0]).toBe('Finder');
  });

  it('when frontmost resolution fails it falls back to a frontmost walk and click without app errors', async () => {
    const deps = makeDeps();
    deps.desktop.getActiveWindowContext = vi.fn().mockRejectedValue(new Error('no ctx'));
    const s = new ComputerSession(deps);
    const out = await s.desktopSnapshot();
    expect(out).toContain('[1] Button "Next"');
    expect(vi.mocked(deps.walker.walkActiveApp).mock.calls[0]![0]).toBeUndefined();
    await expect(s.desktopClick(1)).rejects.toThrow('Snapshot app is unknown. Call desktop_snapshot with an explicit app.');
    expect(deps.axAction).not.toHaveBeenCalled();
  });

  it('key parses combos into key and modifiers', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    await s.desktopKey('cmd+shift+s');
    expect(deps.desktop.sendKeyCombo).toHaveBeenCalledWith(['s'], ['command', 'shift']);
    await s.desktopKey('return');
    expect(deps.desktop.sendKeyCombo).toHaveBeenCalledWith(['return'], []);
  });

  it('type, open and menu return fresh state', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    expect(await s.desktopType('hello', 'Finder')).toContain('typed 5 characters');
    expect(deps.desktop.typeText).toHaveBeenCalledWith('hello');
    expect(await s.desktopOpen('Finder')).toContain('opened Finder');
    expect(await s.desktopMenu('Finder', 'save')).toContain('menu File > Save');
  });

  it('menu reports failure without throwing a stack', async () => {
    const deps = makeDeps({ menuSearch: vi.fn().mockResolvedValue({ success: false, error: 'No match' }) });
    const s = new ComputerSession(deps);
    await expect(s.desktopMenu('Finder', 'zzz')).rejects.toThrow('No match');
  });
});

describe('ComputerSession post-action state is best-effort', () => {
  async function withFailingWalk(deps: ComputerSessionDeps, s: ComputerSession) {
    await s.desktopSnapshot('Finder');
    vi.mocked(deps.walker.walkActiveApp).mockRejectedValue(new Error('ax gone'));
  }
  const note = '(state unavailable: ax gone; call desktop_snapshot)';

  it('click still reports the action', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    await withFailingWalk(deps, s);
    const out = await s.desktopClick(1, 'Finder');
    expect(out).toBe(`clicked [1] Button "Next"\n${note}`);
  });

  it('type still reports the action', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    await withFailingWalk(deps, s);
    expect(await s.desktopType('hi', 'Finder')).toBe(`typed 2 characters\n${note}`);
  });

  it('key still reports the action', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    await withFailingWalk(deps, s);
    expect(await s.desktopKey('return', 'Finder')).toBe(`pressed return\n${note}`);
  });

  it('open still reports the action', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    await withFailingWalk(deps, s);
    expect(await s.desktopOpen('Finder')).toBe(`opened Finder\n${note}`);
  });

  it('menu still reports the action', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    await withFailingWalk(deps, s);
    expect(await s.desktopMenu('Finder', 'save')).toBe(`menu File > Save\n${note}`);
  });

  it('never performs a session-level physical click', async () => {
    const deps = makeDeps({ axAction: vi.fn().mockResolvedValue({ success: false, error: 'AXPress failed' }) });
    const clickAt = vi.fn();
    (deps.desktop as unknown as { clickAt: unknown }).clickAt = clickAt;
    const s = new ComputerSession(deps);
    await s.desktopSnapshot('Finder');
    await expect(s.desktopClick(1, 'Finder')).rejects.toThrow();
    expect(clickAt).not.toHaveBeenCalled();
    expect('clickAt' in makeDeps().desktop).toBe(false);
  });
});

describe('ComputerSession browser (delegates to the BrowserPort)', () => {
  it('tabs, focus, open and snapshot return the port text unchanged', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    expect(await s.browserTabs()).toBe('tabs text');
    expect(await s.browserFocus('mail')).toBe('focused text');
    expect(deps.browser.focus).toHaveBeenCalledWith('mail');
    expect(await s.browserFocus(3)).toBe('focused text');
    expect(deps.browser.focus).toHaveBeenLastCalledWith(3);
    expect(await s.browserOpen('https://x.test')).toBe('opened text');
    expect(deps.browser.open).toHaveBeenCalledWith('https://x.test');
    expect(await s.browserSnapshot()).toBe('snapshot text');
    expect(deps.browser.snapshot).toHaveBeenCalledWith();
  });

  it('click passes the index and returns the port text', async () => {
    const deps = makeDeps();
    expect(await new ComputerSession(deps).browserClick(7)).toBe('click text');
    expect(deps.browser.click).toHaveBeenCalledWith(7);
  });

  it('type passes index, text and submit (omitted when not given)', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    expect(await s.browserType(2, 'a@b.c')).toBe('type text');
    expect(deps.browser.type).toHaveBeenLastCalledWith(2, 'a@b.c', undefined);
    await s.browserType(2, 'q', true);
    expect(deps.browser.type).toHaveBeenLastCalledWith(2, 'q', { submit: true });
    await s.browserType(2, 'q', false);
    expect(deps.browser.type).toHaveBeenLastCalledWith(2, 'q', { submit: false });
  });

  it('find, do and extract delegate with exact args', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    expect(await s.browserFind('sign in', 5)).toBe('find text');
    expect(deps.browser.find).toHaveBeenCalledWith('sign in', 5);
    await s.browserFind('x');
    expect(deps.browser.find).toHaveBeenLastCalledWith('x', undefined);
    const steps = [{ op: 'type' as const, index: 3, text: 'hi', submit: true }, { op: 'press' as const, key: 'Enter' }];
    expect(await s.browserDo(steps)).toBe('do text');
    expect(deps.browser.do).toHaveBeenCalledWith(steps);
    expect(await s.browserExtract(900)).toBe('extract text');
    expect(deps.browser.extract).toHaveBeenCalledWith(900);
    await s.browserExtract();
    expect(deps.browser.extract).toHaveBeenLastCalledWith(undefined);
  });

  it('propagates port errors', async () => {
    const deps = makeDeps();
    deps.browser.click = vi.fn().mockRejectedValue(new Error('stale id'));
    await expect(new ComputerSession(deps).browserClick(1)).rejects.toThrow('stale id');
  });
});

describe('createDefaultComputerSession', () => {
  it('builds the fast engine over AppleScript with the legacy port, performing no I/O', () => {
    const procs = [
      childProcess.spawn,
      childProcess.spawnSync,
      childProcess.execFile,
      childProcess.execFileSync,
      childProcess.exec,
    ].map((f) => vi.mocked(f));
    procs.forEach((f) => f.mockClear());
    const fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
    try {
      const session = createDefaultComputerSession();
      expect(session).toBeInstanceOf(ComputerSession);
      const browser = (session as unknown as { deps: ComputerSessionDeps }).deps.browser;
      expect(browser).toBeInstanceOf(FastBrowserEngine);
      // Wiring is read from the engine's private fields (no public hook exists to inject the environment).
      const engine = browser as unknown as { t: unknown; legacy: unknown };
      expect(engine.t).toBeInstanceOf(AppleScriptTransport);
      expect(engine.legacy).toBeInstanceOf(LegacyBrowserPort);
      for (const sp of procs) expect(sp).not.toHaveBeenCalled();
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      fetchStub.mockRestore();
    }
  });
});
