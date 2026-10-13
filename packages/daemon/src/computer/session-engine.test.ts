import { describe, expect, it, vi } from 'vitest';
import { ComputerSession, type ComputerSessionDeps } from './session.js';
import { DesktopEngine } from './desktop-engine.js';
import { AxHelperError, type AxHelperPort, type AxNode, type AxSnapshot } from '../desktop/ax-helper.js';

const WIN: AxNode = { id: 1, parent: 0, role: 'AXWindow', x: 0, y: 0, width: 800, height: 600 };
const SAVE: AxNode = { id: 2, parent: 1, role: 'AXButton', label: 'Save', actions: ['AXPress'], x: 10, y: 10, width: 60, height: 20 };
const SEND: AxNode = { id: 3, parent: 1, role: 'AXButton', label: 'Send', actions: ['AXPress'], x: 80, y: 10, width: 60, height: 20 };
const NAME: AxNode = { id: 4, parent: 1, role: 'AXTextField', label: 'Name', value: '', x: 10, y: 40, width: 200, height: 20 };
const PASS: AxNode = { id: 5, parent: 1, role: 'AXTextField', sub: 'AXSecureTextField', label: 'Password', value: 'secret', x: 10, y: 70, width: 200, height: 20 };
const AREA: AxNode = { id: 6, parent: 1, role: 'AXScrollArea', off: 4, scroll: 0, x: 0, y: 100, width: 400, height: 300 };
const FILE: AxNode = { id: 7, parent: 6, role: 'AXRow', label: 'report.pdf', actions: ['AXOpen'], x: 0, y: 100, width: 400, height: 20 };
const ROW_NO_PRESS: AxNode = { id: 8, parent: 6, role: 'AXRow', label: 'notes.txt', x: 0, y: 120, width: 400, height: 20 };

interface Fake extends AxHelperPort {
  calls: Array<Record<string, unknown>>;
  nodes: AxNode[];
  ready: () => Promise<boolean>;
}

function fakeHelper(over: { failOps?: Record<string, AxHelperError>; setMatches?: boolean; ready?: boolean } = {}): Fake {
  const fake: Fake = {
    calls: [],
    nodes: [WIN, SAVE, SEND, NAME, PASS, AREA, FILE, ROW_NO_PRESS],
    ready: async () => over.ready ?? true,
    request: (async (op: Record<string, unknown>) => {
      fake.calls.push(op);
      const failure = over.failOps?.[String(op.op)];
      if (failure) throw failure;
      switch (op.op) {
        case 'snapshot':
          return { ok: true, epoch: 77, app: { name: 'Notes', pid: 1 }, window: { title: 'Doc' }, nodes: op.root === undefined ? fake.nodes : fake.nodes.filter((n) => n.id === op.root || n.parent === op.root), truncated: false, timedOut: false, elapsedMs: 1 } satisfies AxSnapshot;
        case 'setValue':
          if (over.setMatches !== false) fake.nodes = fake.nodes.map((n) => (n.id === op.h ? { ...n, value: String(op.value) } : n));
          return { ok: true, matches: over.setMatches !== false };
        case 'scroll':
          return { ok: true, before: 0, after: 0.3 };
        case 'read':
          return { ok: true, text: 'full text', truncated: false };
        default:
          return { ok: true };
      }
    }) as AxHelperPort['request'],
  };
  return fake;
}

function make(helper: AxHelperPort, extra: Partial<ComputerSessionDeps> = {}) {
  const legacyWalk = vi.fn().mockResolvedValue([{ index: 1, role: 'AXButton', label: 'Legacy', bounds: [0, 0, 10, 10] as [number, number, number, number] }]);
  const deps: ComputerSessionDeps = {
    desktop: {
      openApp: vi.fn().mockResolvedValue(undefined),
      focusWindow: vi.fn().mockResolvedValue(undefined),
      typeText: vi.fn().mockResolvedValue(undefined),
      sendKeyCombo: vi.fn().mockResolvedValue(undefined),
      listWindows: vi.fn().mockResolvedValue([]),
      getActiveWindowContext: vi.fn().mockResolvedValue({ app: 'Notes', title: 'Doc' }),
    },
    walker: { walkActiveApp: legacyWalk },
    axAction: vi.fn().mockResolvedValue({ success: true, method: 'ax' }),
    menuSearch: vi.fn(),
    browser: {} as ComputerSessionDeps['browser'],
    settleMs: 0,
    sleep: async () => {},
    engine: new DesktopEngine(helper),
    ...extra,
  };
  return { session: new ComputerSession(deps), deps, legacyWalk };
}

describe('ComputerSession with the fast reader', () => {
  it('snapshots through the helper and keeps the app header', async () => {
    const helper = fakeHelper();
    const { session, legacyWalk } = make(helper);
    const text = await session.desktopSnapshot('Notes');
    expect(text.startsWith('app: Notes')).toBe(true);
    expect(text).toContain('[2] button "Save"');
    expect(text).toContain('… 4 more below (desktop_scroll [6])');
    expect(legacyWalk).not.toHaveBeenCalled();
  });

  it('reads one part of the window when given an index from the latest snapshot', async () => {
    const helper = fakeHelper();
    const { session } = make(helper);
    await session.desktopSnapshot('Notes');
    const text = await session.desktopSnapshot('Notes', undefined, 6);
    expect(helper.calls.filter((c) => c.op === 'snapshot').pop()).toMatchObject({ root: 6, epoch: 77 });
    expect(text).toContain('inside: [6] scroll area');
    expect(text).toContain('[7] row "report.pdf" {open}');
    expect(text).not.toContain('[2] button "Save"');
    await expect(session.desktopSnapshot('Mail', undefined, 6)).rejects.toThrow(/Last snapshot was of Notes/);
  });

  it('cannot zoom before a fast snapshot, or when the slower reader is in use', async () => {
    const fresh = make(fakeHelper()).session;
    await expect(fresh.desktopSnapshot('Notes', undefined, 6)).rejects.toThrow(/fast reader/);
    const slow = make(fakeHelper({ ready: false }));
    await slow.session.desktopSnapshot('Notes');
    await expect(slow.session.desktopSnapshot('Notes', undefined, 1)).rejects.toThrow(/fast reader/);
  });

  it('uses the slower reader unchanged when the helper is not ready, fails to start, or times out', async () => {
    for (const helper of [fakeHelper({ ready: false }), fakeHelper({ failOps: { snapshot: new AxHelperError('timeout', 'slow') } })]) {
      const { session, legacyWalk } = make(helper);
      const text = await session.desktopSnapshot('Notes');
      expect(text).toContain('[1] Button "Legacy"');
      expect(legacyWalk).toHaveBeenCalled();
      // and a click then goes the old way
      const clicked = await session.desktopClick(1);
      expect(clicked).toContain('clicked [1] Button "Legacy"');
    }
  });

  it('presses by native action, asks the gate first, and reports only what changed', async () => {
    const helper = fakeHelper();
    const gate = vi.fn().mockResolvedValue(undefined);
    const { session } = make(helper, { gate });
    await session.desktopSnapshot('Notes');
    helper.nodes = [...helper.nodes, { id: 9, parent: 1, role: 'AXStaticText', value: 'Saved!' }];
    const out = await session.desktopClick(2);
    expect(gate).toHaveBeenCalledWith('Save');
    expect(helper.calls.find((c) => c.op === 'perform')).toMatchObject({ h: 2, action: 'AXPress' });
    expect(out).toContain('clicked [2] button "Save"');
    expect(out).toContain('+ text "Saved!"');
    expect(out).toContain('unchanged');
    expect(out).not.toContain('[3] button "Send"');
  });

  it('a refused gate stops the click before the helper is asked', async () => {
    const helper = fakeHelper();
    const { session } = make(helper, { gate: vi.fn().mockRejectedValue(new Error('Approval rejected by user.')) });
    await session.desktopSnapshot('Notes');
    await expect(session.desktopClick(3)).rejects.toThrow('Approval rejected by user.');
    await expect(session.desktopClick(3, undefined, 'double')).rejects.toThrow('Approval rejected by user.');
    await expect(session.desktopDrag(7, 2)).rejects.toThrow('Approval rejected by user.');
    expect(helper.calls.filter((c) => ['perform', 'click', 'drag'].includes(String(c.op)))).toHaveLength(0);
  });

  it('open uses the native open, falls back to a double click, and menu/right click at the element', async () => {
    const helper = fakeHelper();
    const { session } = make(helper);
    await session.desktopSnapshot('Notes');
    await session.desktopClick(7, undefined, 'open');
    expect(helper.calls.find((c) => c.op === 'perform')).toMatchObject({ h: 7, action: 'AXOpen' });
    helper.calls.length = 0;
    await session.desktopClick(8, undefined, 'open');
    expect(helper.calls.find((c) => c.op === 'click')).toMatchObject({ h: 8, button: 'left', count: 2 });
    helper.calls.length = 0;
    await session.desktopClick(8, undefined, 'menu');
    expect(helper.calls.find((c) => c.op === 'click')).toMatchObject({ h: 8, button: 'right', count: 1 });
    helper.calls.length = 0;
    const out = await session.desktopClick(2, undefined, 'right');
    expect(helper.calls.find((c) => c.op === 'click')).toMatchObject({ h: 2, button: 'right' });
    expect(out).toContain('right-clicked [2] button "Save"');
  });

  it('a press the element does not support becomes a click at its center and says so', async () => {
    const helper = fakeHelper({ failOps: { perform: new AxHelperError('unsupported', 'no') } });
    const { session } = make(helper);
    await session.desktopSnapshot('Notes');
    const out = await session.desktopClick(2);
    expect(helper.calls.find((c) => c.op === 'click')).toMatchObject({ h: 2, button: 'left', count: 1 });
    expect(out).toContain('note: no native press on this element; clicked at its center');
  });

  it('refuses an unknown id, and a stale element, with a plain message to snapshot again', async () => {
    const helper = fakeHelper();
    const { session } = make(helper);
    await session.desktopSnapshot('Notes');
    await expect(session.desktopClick(99)).rejects.toThrow('Index 99 not in last snapshot. Call desktop_snapshot again.');
    const stale = fakeHelper({ failOps: { perform: new AxHelperError('stale', 'gone') } });
    const second = make(stale);
    await second.session.desktopSnapshot('Notes');
    await expect(second.session.desktopClick(2)).rejects.toThrow('That element is no longer there. Call desktop_snapshot again.');
  });

  it('a covered click is reported, not retried', async () => {
    const helper = fakeHelper({ failOps: { click: new AxHelperError('covered', 'Safari is on top of that element.') } });
    const { session } = make(helper);
    await session.desktopSnapshot('Notes');
    await expect(session.desktopClick(8)).rejects.toThrow('Safari is on top of that element.');
  });

  it('keeps the same-app rule', async () => {
    const { session } = make(fakeHelper());
    await session.desktopSnapshot('Notes');
    await expect(session.desktopClick(2, 'Finder')).rejects.toThrow('Last snapshot was of Notes, not Finder.');
  });

  it('types into a field: focus first, then the text; replace sets the value; falls back to select-all and type', async () => {
    const helper = fakeHelper();
    const { session, deps } = make(helper);
    await session.desktopSnapshot('Notes');
    const out = await session.desktopType('héllo 👋\nworld', undefined, { index: 4 });
    expect(helper.calls.filter((c) => c.op === 'focus' || c.op === 'typeText').map((c) => c.op)).toEqual(['focus', 'typeText']);
    expect(helper.calls.find((c) => c.op === 'typeText')).toMatchObject({ text: 'héllo 👋\nworld', pid: 1, h: 4, epoch: 77 });
    expect(out).toContain('typed into [4] textfield "Name": 13 characters');
    helper.calls.length = 0;
    const set = await session.desktopType('Ann', undefined, { index: 4, replace: true });
    expect(set).toContain('set [4]');
    expect(helper.calls.some((c) => c.op === 'typeText')).toBe(false);
    expect(set).toContain('~ [4] textfield "Name" = "Ann"');
    const stubborn = fakeHelper({ setMatches: false });
    const second = make(stubborn);
    await second.session.desktopSnapshot('Notes');
    helper.calls.length = 0;
    const replaced = await second.session.desktopType('Bob', undefined, { index: 4, replace: true });
    expect(stubborn.calls.find((c) => c.op === 'key')).toMatchObject({ key: 'selectAll', h: 4, pid: 1 });
    expect(second.deps.desktop.sendKeyCombo).not.toHaveBeenCalled();
    expect(stubborn.calls.some((c) => c.op === 'typeText')).toBe(true);
    expect(replaced).toContain('replaced [4]');
    expect(deps.desktop.typeText).not.toHaveBeenCalled();
  });

  it('submit presses Return after typing, and asks the gate about the field', async () => {
    const helper = fakeHelper();
    const gate = vi.fn().mockResolvedValue(undefined);
    const { session, deps } = make(helper, { gate });
    await session.desktopSnapshot('Notes');
    helper.calls.length = 0;
    await session.desktopType('hi', undefined, { index: 4, submit: true });
    expect(gate).toHaveBeenCalledWith('Name');
    // Return goes through the helper, to the field that has the cursor: never a global key press
    expect(helper.calls.filter((c) => ['focus', 'key'].includes(String(c.op))).map((c) => `${c.op}:${c.key ?? ''}`)).toEqual(['focus:', 'focus:', 'key:return']);
    expect(deps.desktop.sendKeyCombo).not.toHaveBeenCalled();
  });

  it('only types into text fields, and never shows what was typed into a password', async () => {
    const helper = fakeHelper();
    const { session } = make(helper);
    await session.desktopSnapshot('Notes');
    await expect(session.desktopType('x', undefined, { index: 2 })).rejects.toThrow('[2] button is not a text field');
    expect(await session.desktopSnapshot('Notes')).toContain('password "Password" = "••••"');
    const out = await session.desktopType('hunter2', undefined, { index: 5 });
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('secret');
    await expect(session.desktopRead(5)).rejects.toThrow('password field');
  });

  it('typing without an index keeps the old way, and replace without an index is refused', async () => {
    const helper = fakeHelper();
    const { session, deps } = make(helper);
    await session.desktopSnapshot('Notes');
    await session.desktopType('abc');
    expect(deps.desktop.typeText).toHaveBeenCalledWith('abc');
    await expect(session.desktopType('abc', undefined, { replace: true })).rejects.toThrow('replace needs an index');
  });

  it('asks the gate before replacing the value of a field, with the full label', async () => {
    const helper = fakeHelper();
    const long = `${'x'.repeat(90)} Delete`;
    helper.nodes = helper.nodes.map((n) => (n.id === 4 ? { ...n, label: long } : n));
    const gate = vi.fn().mockRejectedValue(new Error('Approval rejected by user.'));
    const { session } = make(helper, { gate });
    await session.desktopSnapshot('Notes');
    await expect(session.desktopType('x', undefined, { index: 4, replace: true })).rejects.toThrow('Approval rejected by user.');
    expect(gate).toHaveBeenCalledWith(long);
    expect(helper.calls.some((c) => ['setValue', 'typeText', 'key'].includes(String(c.op)))).toBe(false);
  });

  it('judges a click by the whole label, not the shortened one on screen', async () => {
    const helper = fakeHelper();
    const long = `${'y'.repeat(100)} Delete everything`;
    helper.nodes = helper.nodes.map((n) => (n.id === 2 ? { ...n, label: long } : n));
    const gate = vi.fn().mockResolvedValue(undefined);
    const { session } = make(helper, { gate });
    const shown = await session.desktopSnapshot('Notes');
    expect(shown).not.toContain('Delete everything');
    await session.desktopClick(2);
    expect(gate).toHaveBeenCalledWith(long);
  });

  it('every action carries the epoch of the snapshot, so ids from before a helper restart are refused', async () => {
    const helper = fakeHelper();
    const { session } = make(helper);
    await session.desktopSnapshot('Notes');
    await session.desktopClick(2);
    await session.desktopScroll(6, 'down', 1);
    for (const call of helper.calls.filter((c) => ['perform', 'scroll'].includes(String(c.op)))) expect(call.epoch).toBe(77);
  });

  it('scrolls and reports the movement', async () => {
    const helper = fakeHelper();
    const { session } = make(helper);
    await session.desktopSnapshot('Notes');
    const out = await session.desktopScroll(6, 'down', 3);
    expect(helper.calls.find((c) => c.op === 'scroll')).toMatchObject({ h: 6, dy: -30, dx: 0 });
    expect(out).toContain('scrolled down in [6] scroll area');
    expect(out).toContain('(0% -> 30% of the way down)');
  });

  it('drags between rows by selecting the source row first, and keeps the epoch', async () => {
    const helper = fakeHelper();
    const { session } = make(helper);
    await session.desktopSnapshot('Notes');
    const out = await session.desktopDrag(7, 8);
    expect(helper.calls.find((c) => c.op === 'drag')).toMatchObject({ from: { h: 7 }, to: { h: 8 }, select: true, epoch: 77 });
    expect(out).toContain('dragged [7] row "report.pdf" to [8] row "notes.txt"');
  });

  it('reads the full text of an element', async () => {
    const helper = fakeHelper();
    const { session } = make(helper);
    await session.desktopSnapshot('Notes');
    expect(await session.desktopRead(4)).toBe('[4] textfield "Name"\nfull text');
  });

  it('scroll, read and drag say plainly when only the slower reader is available', async () => {
    const { session } = make(fakeHelper({ ready: false }));
    await session.desktopSnapshot('Notes');
    await expect(session.desktopScroll(1, 'down', 1)).rejects.toThrow('desktop_scroll needs the fast reader');
    await expect(session.desktopRead(1)).rejects.toThrow('desktop_read needs the fast reader');
    await expect(session.desktopDrag(1, 1)).rejects.toThrow('desktop_drag needs the fast reader');
    await expect(session.desktopType('x', undefined, { index: 1 })).rejects.toThrow('needs the fast reader');
    await expect(session.desktopClick(1, undefined, 'double')).rejects.toThrow('needs the fast reader');
  });

  it('a helper that dies mid-task gives a plain message, and the next snapshot recovers on the slower reader', async () => {
    const helper = fakeHelper({ failOps: { perform: new AxHelperError('helper_exited', 'died') } });
    const { session } = make(helper);
    await session.desktopSnapshot('Notes');
    await expect(session.desktopClick(2)).rejects.toThrow('The accessibility helper stopped responding. Call desktop_snapshot again.');
  });

  it('actions open the right app view after desktop_open and desktop_key too', async () => {
    const helper = fakeHelper();
    const { session } = make(helper);
    const opened = await session.desktopOpen('Notes');
    expect(opened).toContain('opened Notes');
    expect(opened).toContain('[2] button "Save"');
    const pressed = await session.desktopKey('tab');
    expect(pressed).toContain('no visible change');
  });

  it('tells the model plainly when Accessibility permission is missing', async () => {
    const { session } = make(fakeHelper({ failOps: { snapshot: new AxHelperError('not_trusted', 'x') } }));
    await expect(session.desktopSnapshot('Notes')).rejects.toThrow('macOS is asking the user to allow "Remote Hands"');
  });
});
