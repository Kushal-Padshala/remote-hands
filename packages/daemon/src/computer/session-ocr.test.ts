import { describe, expect, it, vi } from 'vitest';
import { ComputerSession, type ComputerSessionDeps } from './session.js';
import { DesktopEngine } from './desktop-engine.js';
import { AxHelperError, type AxHelperPort, type AxNode, type AxSnapshot } from '../desktop/ax-helper.js';
import { BLIND_NOTE, OCR_HEADER, OCR_ID_BASE, type OcrReading } from '../desktop/ocr-model.js';

// Reading a window by sight is the last resort: these tests pin that it never runs unless asked for, that what it reads can
// only be clicked, that a click is judged like any other, and that a stale picture is never clicked.

const WIN: AxNode = { id: 1, parent: 0, role: 'AXWindow', x: 100, y: 100, width: 800, height: 600 };
const CLOSE: AxNode = { id: 2, parent: 1, role: 'AXButton', label: 'close button', actions: ['AXPress'], x: 110, y: 104, width: 14, height: 14 };
const MENU: AxNode = { id: 3, parent: 0, role: 'AXMenuBarItem', label: 'File', actions: ['AXPress'], x: 20, y: 0, width: 30, height: 20 };
const SAVE: AxNode = { id: 4, parent: 1, role: 'AXButton', label: 'Save', actions: ['AXPress'], x: 200, y: 120, width: 60, height: 20 };

const READING: OcrReading = {
  ok: true,
  app: { name: 'Game', pid: 321 },
  window: { title: 'Lobby', id: 55, x: 100, y: 100, width: 800, height: 600 },
  lines: [
    { text: 'Play', x: 400, y: 300, width: 60, height: 20 },
    { text: 'Settings', x: 400, y: 340, width: 80, height: 20 },
    { text: 'Save', x: 215, y: 125, width: 30, height: 10 },
  ],
  truncated: false,
  captureMs: 120,
  ocrMs: 200,
  elapsedMs: 360,
};

interface Fake extends AxHelperPort {
  calls: Array<Record<string, unknown>>;
  nodes: AxNode[];
}

function fakeHelper(over: { nodes?: AxNode[]; ocr?: OcrReading | AxHelperError; clickAt?: AxHelperError } = {}): Fake {
  const fake: Fake = {
    calls: [],
    nodes: over.nodes ?? [WIN, CLOSE, MENU],
    ready: async () => true,
    request: (async (op: Record<string, unknown>) => {
      fake.calls.push(op);
      switch (op.op) {
        case 'snapshot':
          return { ok: true, epoch: 9, app: { name: 'Game', pid: 321 }, window: { title: 'Lobby', x: 100, y: 100, width: 800, height: 600 }, nodes: fake.nodes, truncated: false, timedOut: false, elapsedMs: 1 } satisfies AxSnapshot;
        case 'ocr': {
          const value = over.ocr ?? READING;
          if (value instanceof AxHelperError) throw value;
          return value;
        }
        case 'clickAt':
          if (over.clickAt) throw over.clickAt;
          return { ok: true, x: op.x, y: op.y };
        default:
          return { ok: true };
      }
    }) as AxHelperPort['request'],
  };
  return fake;
}

function make(helper: AxHelperPort, extra: Partial<ComputerSessionDeps> = {}) {
  const deps: ComputerSessionDeps = {
    desktop: {
      openApp: vi.fn().mockResolvedValue(undefined),
      focusWindow: vi.fn().mockResolvedValue(undefined),
      typeText: vi.fn().mockResolvedValue(undefined),
      sendKeyCombo: vi.fn().mockResolvedValue(undefined),
      listWindows: vi.fn().mockResolvedValue([]),
      getActiveWindowContext: vi.fn().mockResolvedValue({ app: 'Game', title: 'Lobby' }),
    },
    walker: { walkActiveApp: vi.fn().mockResolvedValue([]) },
    axAction: vi.fn().mockResolvedValue({ success: true, method: 'ax' }),
    menuSearch: vi.fn(),
    browser: {} as ComputerSessionDeps['browser'],
    settleMs: 0,
    sleep: async () => {},
    engine: new DesktopEngine(helper),
    ...extra,
  };
  return { session: new ComputerSession(deps), deps };
}

const ops = (h: Fake, name: string): Array<Record<string, unknown>> => h.calls.filter((c) => c.op === name);

describe('reading a window by sight is the last resort', () => {
  it('never runs on its own: a plain snapshot, even of a blind window, takes no picture', async () => {
    const helper = fakeHelper();
    const { session } = make(helper);
    const text = await session.desktopSnapshot('Game');
    expect(ops(helper, 'ocr')).toHaveLength(0);
    expect(text).not.toContain(OCR_HEADER);
    // it only says how to get it
    expect(text.endsWith(BLIND_NOTE)).toBe(true);
  });

  it('does not even mention it when Accessibility lists real controls', async () => {
    const helper = fakeHelper({ nodes: [WIN, CLOSE, MENU, SAVE] });
    const { session } = make(helper);
    const text = await session.desktopSnapshot('Game');
    expect(text).not.toContain(BLIND_NOTE);
    expect(ops(helper, 'ocr')).toHaveLength(0);
  });

  it('actions in a blind window do not read by sight either', async () => {
    const helper = fakeHelper();
    const { session } = make(helper);
    await session.desktopSnapshot('Game');
    await session.desktopKey('tab');
    expect(ops(helper, 'ocr')).toHaveLength(0);
  });

  it('ocr=true gives the Accessibility view first, then the text read by sight with ids that cannot clash', async () => {
    const helper = fakeHelper();
    const { session } = make(helper);
    const text = await session.desktopSnapshot('Game', undefined, undefined, true);
    expect(helper.calls.map((c) => c.op)).toEqual(['snapshot', 'ocr']);
    expect(helper.calls[1]).toMatchObject({ op: 'ocr', app: 'Game' });
    expect(text.indexOf('app: Game')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(OCR_HEADER)).toBeGreaterThan(text.indexOf('app: Game'));
    expect(text).toContain(`[${OCR_ID_BASE + 1}] "Play" @`);
    expect(text).toContain(`[${OCR_ID_BASE + 2}] "Settings" @`);
  });

  it('does not repeat text that Accessibility already lists at the same place', async () => {
    const helper = fakeHelper({ nodes: [WIN, CLOSE, MENU, SAVE] });
    const { session } = make(helper);
    const text = await session.desktopSnapshot('Game', undefined, undefined, true);
    expect(text).toContain('[4] button "Save"');
    expect(text).not.toMatch(/\[10000\d\d\] "Save"/);
    expect(text).toContain('already listed above by Accessibility');
  });

  it('reading by sight refuses an index (it reads the whole window)', async () => {
    const { session } = make(fakeHelper());
    await expect(session.desktopSnapshot('Game', undefined, 3, true)).rejects.toThrow('leave out index');
  });

  it('says plainly when the fast reader is not available', async () => {
    const { session } = make(fakeHelper(), { engine: undefined as unknown as DesktopEngine });
    await expect(session.desktopSnapshot('Game', undefined, undefined, true)).rejects.toThrow('needs the fast reader');
  });

  it('tells the model what to ask of the user when Screen Recording is off', async () => {
    const helper = fakeHelper({ ocr: new AxHelperError('no_screen_recording', 'x') });
    const { session } = make(helper);
    await expect(session.desktopSnapshot('Game', undefined, undefined, true)).rejects.toThrow('Screen Recording');
  });
});

describe('clicking text read by sight', () => {
  async function sighted(over: Parameters<typeof fakeHelper>[0] = {}, extra: Partial<ComputerSessionDeps> = {}) {
    const helper = fakeHelper(over);
    const made = make(helper, extra);
    await made.session.desktopSnapshot('Game', undefined, undefined, true);
    helper.calls.length = 0;
    return { helper, ...made };
  }

  it('clicks at the middle of the text, in the window that was read, then reads the window again', async () => {
    const { helper, session } = await sighted();
    const out = await session.desktopClick(OCR_ID_BASE + 1);
    const click = ops(helper, 'clickAt')[0]!;
    expect(click).toMatchObject({ op: 'clickAt', x: 430, y: 310, pid: 321, windowId: 55, button: 'left', count: 1, window: { x: 100, y: 100, width: 800, height: 600 } });
    expect(out.startsWith(`clicked [${OCR_ID_BASE + 1}] text "Play" (read by sight)`)).toBe(true);
    // the click redrew the window: it is read again so the next click has fresh places
    expect(ops(helper, 'ocr')).toHaveLength(1);
    expect(out).toContain(OCR_HEADER);
  });

  it('double and right clicks map to the helper', async () => {
    const { helper, session } = await sighted();
    await session.desktopClick(OCR_ID_BASE + 1, undefined, 'double');
    await session.desktopClick(OCR_ID_BASE + 1, undefined, 'right');
    expect(ops(helper, 'clickAt').map((c) => [c.button, c.count])).toEqual([['left', 2], ['right', 1]]);
  });

  it('is judged by its words like any click: a rejected approval clicks nothing', async () => {
    const gate = vi.fn().mockRejectedValue(new Error('Approval rejected by user'));
    const { helper, session } = await sighted({}, { gate });
    await expect(session.desktopClick(OCR_ID_BASE + 2)).rejects.toThrow('Approval rejected');
    expect(gate).toHaveBeenCalledWith('Settings');
    expect(ops(helper, 'clickAt')).toHaveLength(0);
  });

  it('an approved click goes through the gate with the text first', async () => {
    const gate = vi.fn().mockResolvedValue(undefined);
    const { helper, session } = await sighted({}, { gate });
    await session.desktopClick(OCR_ID_BASE + 1);
    expect(gate).toHaveBeenCalledWith('Play');
    expect(ops(helper, 'clickAt')).toHaveLength(1);
  });

  it('a window that moved is never clicked, and the old places are forgotten', async () => {
    const { session } = await sighted({ clickAt: new AxHelperError('stale', 'The window moved or changed since its text was read: read it again.') });
    await expect(session.desktopClick(OCR_ID_BASE + 1)).rejects.toThrow('desktop_snapshot with ocr=true again');
    await expect(session.desktopClick(OCR_ID_BASE + 1)).rejects.toThrow('not in last snapshot');
  });

  it('another window on top is reported as it is', async () => {
    const { session } = await sighted({ clickAt: new AxHelperError('covered', 'Safari is on top of that spot.') });
    await expect(session.desktopClick(OCR_ID_BASE + 1)).rejects.toThrow('Safari is on top of that spot.');
  });

  it('after any other action the old places are not trusted any more', async () => {
    const { helper, session } = await sighted();
    await session.desktopKey('tab');
    await expect(session.desktopClick(OCR_ID_BASE + 1)).rejects.toThrow('not in last snapshot');
    expect(ops(helper, 'clickAt')).toHaveLength(0);
  });

  it('a plain snapshot also forgets them', async () => {
    const { helper, session } = await sighted();
    await session.desktopSnapshot('Game');
    await expect(session.desktopClick(OCR_ID_BASE + 1)).rejects.toThrow('not in last snapshot');
    expect(ops(helper, 'clickAt')).toHaveLength(0);
  });

  it('an id that was never read does not click', async () => {
    const { helper, session } = await sighted();
    await expect(session.desktopClick(OCR_ID_BASE + 50)).rejects.toThrow('not in last snapshot');
    expect(ops(helper, 'clickAt')).toHaveLength(0);
  });

  it('keeps a click that landed even if reading again fails', async () => {
    const helper = fakeHelper();
    const made = make(helper);
    await made.session.desktopSnapshot('Game', undefined, undefined, true);
    const original = helper.request;
    let reads = 0;
    helper.request = (async (op: Record<string, unknown>) => {
      if (op.op === 'ocr' && (reads += 1) >= 1) throw new AxHelperError('capture_failed', 'boom');
      return original.call(helper, op);
    }) as AxHelperPort['request'];
    const out = await made.session.desktopClick(OCR_ID_BASE + 1);
    expect(out).toContain('could not read the window by sight afterwards');
  });

  it('the approval is judged on everything that was read, not only the shortened line the model saw', async () => {
    const long = `Continue with the selected operation for the current project and all of its resources, including every file, folder and shared link that was ever created in it by anyone: Delete`;
    const gate = vi.fn().mockResolvedValue(undefined);
    const reading: OcrReading = { ...READING, lines: [{ text: long, x: 200, y: 300, width: 400, height: 20 }] };
    const { session } = await sighted({ ocr: reading }, { gate });
    await session.desktopClick(OCR_ID_BASE + 1);
    const judged = gate.mock.calls[0]![0] as string;
    expect(judged).toBe(long);
    expect(judged).toMatch(/Delete$/);
  });

  it('a filter finds a word that is past the shortened line', async () => {
    const long = `${'word '.repeat(30)}Delete`;
    const helper = fakeHelper({ ocr: { ...READING, lines: [{ text: long, x: 200, y: 300, width: 400, height: 20 }] } });
    const { session } = make(helper);
    const text = await session.desktopSnapshot('Game', 'delete', undefined, true);
    expect(text).toContain(`[${OCR_ID_BASE + 1}]`);
  });

  it('the picture is pinned to the app the Accessibility snapshot read, and a different app is refused', async () => {
    const helper = fakeHelper();
    const { session } = make(helper);
    await session.desktopSnapshot(undefined, undefined, undefined, true);
    expect(ops(helper, 'ocr')[0]).toMatchObject({ op: 'ocr', pid: 321 });
    const other = fakeHelper({ ocr: { ...READING, app: { name: 'Mail', pid: 999 } } });
    await expect(make(other).session.desktopSnapshot(undefined, undefined, undefined, true)).rejects.toThrow('app changed');
  });

  it('a read that fails, or an indexed snapshot, leaves no old places to click', async () => {
    const helper = fakeHelper();
    const made = make(helper);
    await made.session.desktopSnapshot('Game', undefined, undefined, true);
    const original = helper.request;
    helper.request = (async (op: Record<string, unknown>) => {
      if (op.op === 'ocr') throw new AxHelperError('capture_failed', 'boom');
      return original.call(helper, op);
    }) as AxHelperPort['request'];
    await expect(made.session.desktopSnapshot('Game', undefined, undefined, true)).rejects.toThrow('boom');
    helper.request = original;
    await expect(made.session.desktopClick(OCR_ID_BASE + 1)).rejects.toThrow('not in last snapshot');

    await made.session.desktopSnapshot('Game', undefined, undefined, true);
    await made.session.desktopSnapshot('Game', undefined, 2).catch(() => undefined);
    await expect(made.session.desktopClick(OCR_ID_BASE + 1)).rejects.toThrow('not in last snapshot');
  });

  it('an action that fails half way still forgets the old places', async () => {
    const { helper, session } = await sighted();
    await expect(session.desktopType('x', undefined, { index: 2, submit: true })).rejects.toBeDefined();
    await expect(session.desktopClick(OCR_ID_BASE + 1)).rejects.toThrow('not in last snapshot');
    expect(ops(helper, 'clickAt')).toHaveLength(0);
  });

  it('text read by sight can only be clicked: other tools say so', async () => {
    const { session } = await sighted();
    const id = OCR_ID_BASE + 1;
    await expect(session.desktopType('x', undefined, { index: id })).rejects.toThrow('only desktop_click can');
    await expect(session.desktopScroll(id, 'down', 3)).rejects.toThrow('only desktop_click can');
    await expect(session.desktopRead(id)).rejects.toThrow('only desktop_click can');
    await expect(session.desktopDrag(id, OCR_ID_BASE + 2)).rejects.toThrow('only desktop_click can');
    await expect(session.desktopSnapshot('Game', undefined, id)).rejects.toThrow('only desktop_click can');
  });
});
