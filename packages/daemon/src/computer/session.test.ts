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
      clickAt: vi.fn().mockResolvedValue(undefined),
      typeText: vi.fn().mockResolvedValue(undefined),
      sendKeyCombo: vi.fn().mockResolvedValue(undefined),
      listWindows: vi.fn().mockResolvedValue([{ app: 'Finder', title: 'Docs' }]),
    },
    walker: { walkActiveApp: vi.fn().mockResolvedValue(elements) },
    axAction: vi.fn().mockResolvedValue(true),
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
    expect(deps.axAction).toHaveBeenCalledWith(
      'Finder',
      { index: 1, bounds: [10, 20, 100, 40], role: 'AXButton', label: 'Next' },
      'AXPress',
    );
    expect(deps.walker.walkActiveApp).toHaveBeenCalledTimes(2);
    expect(out.startsWith('clicked [1] Button "Next"')).toBe(true);
    expect(out).toContain('[2] TextField "Email"');
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

  it('falls back to a coordinate click at the element center and says so', async () => {
    const deps = makeDeps({ axAction: vi.fn().mockResolvedValue(false) });
    const s = new ComputerSession(deps);
    await s.desktopSnapshot('Finder');
    const out = await s.desktopClick(1, 'Finder');
    expect(deps.desktop.clickAt).toHaveBeenCalledWith(60, 40);
    expect(out).toContain('AX press failed; used physical click at 60,40');
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
