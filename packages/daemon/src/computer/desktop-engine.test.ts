import { describe, expect, it, vi } from 'vitest';
import { AxHelperError, type AxHelperPort, type AxNode, type AxSnapshot } from '../desktop/ax-helper.js';
import { DesktopEngine, describeHelperError } from './desktop-engine.js';

const snapshotOf = (nodes: AxNode[], over: Partial<AxSnapshot> = {}): AxSnapshot => ({
  ok: true, app: { name: 'Notes', pid: 7 }, window: { title: 'All Notes' }, nodes, truncated: false, timedOut: false, elapsedMs: 4, ...over,
});
const WIN: AxNode = { id: 1, parent: 0, role: 'AXWindow', x: 0, y: 0, width: 800, height: 600 };
const BTN: AxNode = { id: 2, parent: 1, role: 'AXButton', label: 'New Note', actions: ['AXPress'], x: 10, y: 10, width: 80, height: 24 };

function fake(handler: (op: Record<string, unknown>) => unknown, ready = true): AxHelperPort & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    ready: async () => ready,
    request: (async (op: Record<string, unknown>) => {
      calls.push(op);
      const out = handler(op);
      if (out instanceof Error) throw out;
      return out;
    }) as AxHelperPort['request'],
  };
}

describe('DesktopEngine.snapshot', () => {
  it('asks the helper for the app, returns the compact view and remembers it', async () => {
    const helper = fake(() => snapshotOf([WIN, BTN]));
    const engine = new DesktopEngine(helper);
    const text = await engine.snapshot('Notes');
    expect(text).toBe('app: Notes · window: "All Notes"\n[2] button "New Note"');
    expect(helper.calls[0]).toMatchObject({ op: 'snapshot', app: 'Notes' });
    expect(engine.current()?.view.byId.get(2)?.label).toBe('New Note');
    expect(engine.current()?.app).toBe('Notes');
  });

  it('a filter narrows what is shown but the remembered view keeps every id', async () => {
    const other: AxNode = { id: 3, parent: 1, role: 'AXButton', label: 'Share', actions: ['AXPress'] };
    const engine = new DesktopEngine(fake(() => snapshotOf([WIN, BTN, other])));
    const text = await engine.snapshot('Notes', { filter: 'share' });
    expect(text).toContain('[3] button "Share"');
    expect(text).not.toContain('New Note');
    expect(engine.current()?.view.byId.has(2)).toBe(true);
  });

  it('answers null (use the slower path) when the helper is not ready', async () => {
    const helper = fake(() => snapshotOf([WIN]), false);
    expect(await new DesktopEngine(helper).snapshot('Notes')).toBeNull();
    expect(helper.calls).toHaveLength(0);
  });

  it('answers null when the helper times out, exits or is unavailable', async () => {
    for (const code of ['timeout', 'helper_exited', 'unavailable']) {
      const engine = new DesktopEngine(fake(() => new AxHelperError(code, 'x')));
      expect(await engine.snapshot('Notes')).toBeNull();
      expect(engine.current()).toBeNull();
    }
  });

  it('tells the model plainly about a missing permission or an app that is not running', async () => {
    await expect(new DesktopEngine(fake(() => new AxHelperError('not_trusted', 'x'))).snapshot('Notes')).rejects.toThrow(
      'macOS is asking the user to allow',
    );
    expect(describeHelperError(new AxHelperError('no_app', 'x'), 'Nope')?.message).toBe('No running app matches "Nope". Use desktop_open to start it.');
    expect(describeHelperError(new AxHelperError('no_app', 'x'), '')?.message).toBe('No app is in front.');
    // the slower reader may know that app by another name, so the snapshot falls back
    expect(await new DesktopEngine(fake(() => new AxHelperError('no_app', 'x'))).snapshot('Nope')).toBeNull();
  });

  it('maps stale and unknown helper errors to plain messages, and passes other errors through', async () => {
    expect(describeHelperError(new AxHelperError('stale', 'x'), '')?.message).toBe('That element is no longer there. Call desktop_snapshot again.');
    expect(describeHelperError(new AxHelperError('weird', 'something specific'), '')?.message).toBe('something specific');
    const boom = vi.fn(() => { throw new TypeError('bug'); });
    await expect(new DesktopEngine(fake(boom)).snapshot('Notes')).rejects.toThrow('bug');
  });

  it('says the window is empty or missing instead of an empty list', async () => {
    const engine = new DesktopEngine(fake(() => snapshotOf([], { noWindow: true })));
    expect(await engine.snapshot('Notes')).toContain('note: this app has no open window');
  });
});

describe('DesktopEngine zoom', () => {
  const LIST: AxNode = { id: 3, parent: 1, role: 'AXList', label: 'Changes', x: 0, y: 0, width: 200, height: 300 };
  const ROW: AxNode = { id: 4, parent: 3, role: 'AXButton', label: 'a.ts', actions: ['AXPress'], x: 0, y: 0, width: 100, height: 20 };
  const full = (): AxSnapshot => snapshotOf([WIN, BTN, LIST, ROW], { epoch: 9, frontWindow: 1 });
  const part = (): AxSnapshot => snapshotOf([LIST, ROW], { epoch: 9, frontWindow: 1 });

  it('reads only the named part with the helper, names it in the header and forgets ids from outside it', async () => {
    const helper = fake((op) => (op.root === undefined ? full() : part()));
    const engine = new DesktopEngine(helper);
    await engine.snapshot('Notes');
    const text = await engine.snapshot('', { index: 3 });
    expect(helper.calls[1]).toMatchObject({ op: 'snapshot', app: 'Notes', root: 3, epoch: 9 });
    expect(text).toBe('app: Notes · window: "All Notes" · inside: [3] list "Changes"\n[3] list "Changes"\n  [4] button "a.ts"');
    expect(engine.current()?.view.byId.has(2)).toBe(false);
    expect(() => engine.item(2)).toThrow(/not in last snapshot/);
    expect(engine.item(4).label).toBe('a.ts');
  });

  it('refuses an index that was not in the latest snapshot, and a zoom before any snapshot', async () => {
    const engine = new DesktopEngine(fake(() => full()));
    await expect(engine.snapshot('', { index: 3 })).rejects.toThrow(/No snapshot yet/);
    await engine.snapshot('Notes');
    await expect(engine.snapshot('', { index: 99 })).rejects.toThrow(/Index 99 not in last snapshot/);
  });

  it('keeps reading the same part after an action, and the whole window again once that part is gone', async () => {
    let gone = false;
    const helper = fake((op) => {
      if (op.root !== undefined) return gone ? new AxHelperError('stale', 'x') : part();
      return full();
    });
    const engine = new DesktopEngine(helper);
    await engine.snapshot('Notes');
    await engine.snapshot('', { index: 3 });
    const before = engine.current()!.view;
    const same = await engine.settle('Notes', before, { firstMs: 0, gapMs: 0 });
    expect(same).toContain('no visible change');
    expect(helper.calls.filter((c) => c.root === 3).length).toBeGreaterThanOrEqual(3);
    gone = true;
    const after = await engine.settle('Notes', before, { firstMs: 0, gapMs: 0 });
    expect(after).toContain('[2] button "New Note"');
    expect(engine.current()?.zoom).toBeUndefined();
  });

  it('keeps leaving out {menu} inside a zoomed part of an app that offers it everywhere', async () => {
    const withMenu = (n: AxNode): AxNode => ({ ...n, actions: [...(n.actions ?? []), 'AXShowMenu'] });
    const many = Array.from({ length: 9 }, (_, i): AxNode => withMenu({ id: 10 + i, parent: 3, role: 'AXButton', label: `Row ${i}`, actions: ['AXPress'] }));
    const engine = new DesktopEngine(fake((op) => (op.root === undefined ? snapshotOf([WIN, LIST, ...many], { epoch: 9 }) : snapshotOf([many[0]!], { epoch: 9 }))));
    expect(await engine.snapshot('Notes')).not.toContain('{menu}');
    expect(await engine.snapshot('', { index: 10 })).not.toContain('{menu}');
    expect(await engine.settle('Notes', engine.current()!.view, { firstMs: 0, gapMs: 0 })).not.toContain('{menu}');
  });

  it('does not carry a zoom into another app or another window', async () => {
    const helper = fake((op) => {
      if (op.app === 'Music') return snapshotOf([WIN, BTN], { app: { name: 'Music', pid: 8 }, epoch: 9 });
      if (op.root !== undefined) return part();
      return full();
    });
    const engine = new DesktopEngine(helper);
    await engine.snapshot('Notes');
    await engine.snapshot('', { index: 3 });
    // opening another app: its first look must not name the old app's element
    const music = await engine.settle('Music', engine.current()!.view, { firstMs: 0, gapMs: 0 });
    expect(music).toContain('app: Music');
    expect(helper.calls.filter((c) => c.app === 'Music').every((c) => c.root === undefined)).toBe(true);
    expect(engine.current()?.app).toBe('Music');
    expect(engine.current()?.zoom).toBeUndefined();

    // another window in front (a dialog): the whole window is read
    let dialog = false;
    const second = new DesktopEngine(fake((op) => (op.root !== undefined ? snapshotOf([LIST, ROW], { epoch: 9, frontWindow: dialog ? 2 : 1 }) : full())));
    await second.snapshot('Notes');
    await second.snapshot('', { index: 3 });
    dialog = true;
    const text = await second.settle('Notes', second.current()!.view, { firstMs: 0, gapMs: 0 });
    expect(text).toContain('[2] button "New Note"');
    expect(second.current()?.zoom).toBeUndefined();
  });

  it('tells windows apart by identity, not by title', async () => {
    // a document renamed in the same window keeps the zoom
    let title = 'All Notes';
    const same = new DesktopEngine(fake((op) => (op.root === undefined ? full() : snapshotOf([LIST, ROW], { epoch: 9, frontWindow: 1, window: { title } }))));
    await same.snapshot('Notes');
    await same.snapshot('', { index: 3 });
    title = 'All Notes — Edited';
    expect(await same.settle('Notes', same.current()!.view, { firstMs: 0, gapMs: 0 })).toContain('inside: [3] list "Changes"');

    // another window with the very same title is a different window
    let front = 1;
    const twin = new DesktopEngine(fake((op) => (op.root === undefined ? snapshotOf([WIN, BTN, LIST, ROW], { epoch: 9, frontWindow: front }) : snapshotOf([LIST, ROW], { epoch: 9, frontWindow: front }))));
    await twin.snapshot('Notes');
    await twin.snapshot('', { index: 3 });
    front = 2;
    const text = await twin.settle('Notes', twin.current()!.view, { firstMs: 0, gapMs: 0 });
    expect(text).toContain('[2] button "New Note"');
    expect(text).not.toContain('inside:');

    // another window in front before the first zoom: refused, nothing is mixed up
    front = 1;
    const early = new DesktopEngine(fake((op) => (op.root === undefined ? snapshotOf([WIN, BTN, LIST, ROW], { epoch: 9, frontWindow: front }) : snapshotOf([LIST, ROW], { epoch: 9, frontWindow: front }))));
    await early.snapshot('Notes');
    front = 2;
    await expect(early.snapshot('', { index: 3 })).rejects.toThrow(/window in front changed/);
    expect(early.current()?.zoom).toBeUndefined();
  });

  it('reads the whole window again when the helper says the zoomed part belongs to another app or is scrolled away', async () => {
    for (const code of ['bad_request', 'stale']) {
      let broken = false;
      const engine = new DesktopEngine(fake((op) => (op.root === undefined ? full() : broken ? new AxHelperError(code, 'x') : part())));
      await engine.snapshot('Notes');
      await engine.snapshot('', { index: 3 });
      broken = true;
      const text = await engine.settle('Notes', engine.current()!.view, { firstMs: 0, gapMs: 0 });
      expect(text).toContain('[2] button "New Note"');
      expect(engine.current()?.zoom).toBeUndefined();
    }
  });

  it('answers null when the helper cannot serve the zoom', async () => {
    const engine = new DesktopEngine(fake((op) => (op.root === undefined ? full() : new AxHelperError('timeout', 'x'))));
    await engine.snapshot('Notes');
    expect(await engine.snapshot('', { index: 3 })).toBeNull();
  });
});

describe('DesktopEngine reading a window by sight', () => {
  const reading = {
    ok: true as const,
    app: { name: 'Notes', pid: 7 },
    window: { title: 'All Notes', x: 0, y: 0, width: 800, height: 600 },
    lines: [{ text: 'Hello', x: 100, y: 100, width: 50, height: 20 }],
    truncated: false,
    captureMs: 1,
    ocrMs: 2,
    elapsedMs: 3,
  };

  it('asks the helper for the app and remembers the text for clicks', async () => {
    const helper = fake((op) => (op.op === 'ocr' ? reading : snapshotOf([WIN, BTN])));
    const engine = new DesktopEngine(helper);
    const text = await engine.readOcr('Notes');
    expect(helper.calls[0]).toEqual({ op: 'ocr', app: 'Notes' });
    expect(text).toContain('[100001] "Hello"');
    expect(engine.ocrItem(100001)).toMatchObject({ text: 'Hello', x: 125, y: 110 });
  });

  it('forgets the text on dropOcr, so a click on it is refused', async () => {
    const engine = new DesktopEngine(fake(() => reading));
    await engine.readOcr('Notes');
    engine.dropOcr();
    expect(() => engine.ocrItem(100001)).toThrow('not in last snapshot');
    await expect(engine.clickOcr(100001)).rejects.toThrow('not in last snapshot');
  });

  it('answers null when the helper is not ready, and for an app it cannot find', async () => {
    expect(await new DesktopEngine(fake(() => reading, false)).readOcr('Notes')).toBeNull();
    expect(await new DesktopEngine(fake(() => new AxHelperError('no_app', 'x'))).readOcr('Nope')).toBeNull();
    expect(await new DesktopEngine(fake(() => new AxHelperError('timeout', 'x'))).readOcr('Notes')).toBeNull();
  });

  it('turns a missing Screen Recording permission into words for the model', async () => {
    await expect(new DesktopEngine(fake(() => new AxHelperError('no_screen_recording', 'x'))).readOcr('Notes')).rejects.toThrow(/Screen Recording/);
    expect(describeHelperError(new AxHelperError('no_screen_recording', 'x'), '')?.message).toContain('switch it off and on again');
  });

  it('passes other helper messages through (no window, capture failed, macOS too old)', async () => {
    for (const code of ['no_window', 'capture_failed', 'unsupported']) {
      await expect(new DesktopEngine(fake(() => new AxHelperError(code, `msg for ${code}`))).readOcr('Notes')).rejects.toThrow(`msg for ${code}`);
    }
  });

  it('sends the click with the window it was read in and the right button and count', async () => {
    const helper = fake(() => reading);
    const engine = new DesktopEngine(helper);
    await engine.readOcr('Notes');
    await engine.clickOcr(100001, 'right');
    await engine.clickOcr(100001, 'open');
    const clicks = helper.calls.filter((c) => c.op === 'clickAt');
    expect(clicks[0]).toEqual({ op: 'clickAt', x: 125, y: 110, pid: 7, window: { x: 0, y: 0, width: 800, height: 600 }, button: 'right', count: 1 });
    expect(clicks[1]).toMatchObject({ button: 'left', count: 2 });
  });
});
