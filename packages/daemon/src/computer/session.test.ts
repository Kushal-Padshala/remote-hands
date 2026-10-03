import { describe, it, expect, vi } from 'vitest';
import { ComputerSession, createDefaultComputerSession, type ComputerSessionDeps } from './session.js';

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
    menuSearch: vi.fn().mockResolvedValue({ success: true, triggeredPath: ['File', 'Save'] }),
    browser: {
      listTabs: vi.fn().mockResolvedValue([
        { id: 't1', title: 'Inbox', url: 'https://mail.example', active: true, windowIndex: 1, tabIndex: 2 },
      ]),
      focusTab: vi.fn().mockResolvedValue({ success: true, tab: { title: 'Inbox', url: 'https://mail.example' } }),
      openUrl: vi.fn().mockResolvedValue({ success: true, url: 'https://x.test' }),
      snapshot: vi.fn().mockResolvedValue({ url: 'u', title: 't', elements: [], formattedTable: '[1] button "Go"' }),
      clickIndex: vi.fn().mockResolvedValue({ success: true, label: 'Go' }),
      typeIndex: vi.fn().mockResolvedValue({ success: true, label: 'Email' }),
    },
    settleMs: 0,
    sleep: async () => {},
    ...overrides,
  };
  return deps;
}

describe('ComputerSession desktop', () => {
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

  it('click targets by bounds, role and label with NO index key', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    await s.desktopSnapshot('Finder');
    await s.desktopClick(1, 'Finder');
    const call = vi.mocked(deps.axAction).mock.calls[0]!;
    expect(call[0]).toBe('Finder');
    expect(call[1]).toEqual({ bounds: [10, 20, 100, 40], role: 'AXButton', label: 'Next' });
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

  it('browser click and type still report the action when the snapshot fails', async () => {
    const deps = makeDeps();
    deps.browser.snapshot = vi.fn().mockRejectedValue(new Error('cdp gone'));
    const s = new ComputerSession(deps);
    expect(await s.browserClick(1)).toBe('clicked [1] Go\n(state unavailable: cdp gone; call browser_snapshot)');
    expect(await s.browserType(2, 'x')).toBe('typed into [2] Email\n(state unavailable: cdp gone; call browser_snapshot)');
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

describe('ComputerSession browser', () => {
  it('tabs lists window/tab ids, active marker, title and url', async () => {
    const s = new ComputerSession(makeDeps());
    expect(await s.browserTabs()).toBe('[w1-t2] (active) Inbox - https://mail.example');
  });

  it('click returns the page state after the click', async () => {
    const deps = makeDeps();
    const s = new ComputerSession(deps);
    const out = await s.browserClick(1);
    expect(deps.browser.clickIndex).toHaveBeenCalledWith(1);
    expect(out).toBe('clicked [1] Go\n[1] button "Go"');
  });

  it('type returns the page state after typing', async () => {
    const deps = makeDeps();
    const out = await new ComputerSession(deps).browserType(2, 'a@b.c');
    expect(deps.browser.typeIndex).toHaveBeenCalledWith(2, 'a@b.c');
    expect(out).toBe('typed into [2] Email\n[1] button "Go"');
  });

  it('snapshot caps very long tables', async () => {
    const table = Array.from({ length: 300 }, (_, i) => `[${i}] link "l${i}"`).join('\n');
    const deps = makeDeps();
    deps.browser.snapshot = vi.fn().mockResolvedValue({ url: 'u', title: 't', elements: [], formattedTable: table });
    const out = await new ComputerSession(deps).browserSnapshot();
    expect(out.split('\n')).toHaveLength(121);
    expect(out).toContain('… 180 more lines hidden');
  });
});

describe('createDefaultComputerSession', () => {
  it('constructs real drivers without performing any I/O', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const session = createDefaultComputerSession();
    expect(session).toBeInstanceOf(ComputerSession);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
