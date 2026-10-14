import { AxHelperError, type AxHelperPort, type AxSnapshot } from '../desktop/ax-helper.js';
import { buildView, renderDiff, type View, type ViewItem } from '../desktop/ax-model.js';
import { buildOcrView, type OcrItem, type OcrReading, type OcrView } from '../desktop/ocr-model.js';

/**
 * Native-app control on top of the rh-ax helper: a fast snapshot with stable ids, and (added next to it)
 * actions addressed by those ids. Every method answers `null` when the helper cannot serve, so the caller
 * can run the slower code it had before; real problems (no permission, no such app) are thrown as plain
 * messages for the model.
 */

/** A part of the window (a list, a pane) that is read on its own. */
export interface Zoom {
  id: number;
  /** `[12] list "Changes"`: what the view header says it is inside. */
  text: string;
  /** The window that was in front when it was taken. */
  front: number | undefined;
}

export interface EngineSnapshot {
  app: string;
  snapshot: AxSnapshot;
  view: View;
  zoom?: Zoom;
}

const SNAPSHOT_TIMEOUT_MS = 15_000;
const MAX_NODES = 3000;
const BUDGET_MS = 3000;
const ACTION_TIMEOUT_MS = 10_000;
const SETTLE_MAX_MS = 1500;
/** Reading a window by sight takes about half a second; this only guards against a helper that hangs. */
const OCR_TIMEOUT_MS = 15_000;

export type ClickAction = 'press' | 'open' | 'menu' | 'double' | 'right';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The helper's error codes that mean "use the slower path" rather than "tell the model". */
const FALLBACK_CODES = new Set(['unavailable', 'helper_exited', 'timeout']);

/** The element the model named is gone or changed. */
export class StaleElementError extends Error {}

export function describeHelperError(err: AxHelperError, app: string): Error | null {
  if (FALLBACK_CODES.has(err.code)) return null;
  switch (err.code) {
    case 'not_trusted':
      return new Error(
        'macOS is asking the user to allow "Remote Hands" to control this computer (a window titled "Accessibility Access"; if it was dismissed: System Settings > Privacy & Security > Accessibility > switch on "Remote Hands"). Tell the user to click "Open System Settings" and switch it on, then try again in a few seconds. Do not try to work around it.',
      );
    case 'no_app':
      return new Error(app ? `No running app matches "${app}". Use desktop_open to start it.` : 'No app is in front.');
    case 'stale':
      return new StaleElementError('That element is no longer there. Call desktop_snapshot again.');
    case 'no_screen_recording':
      return new Error(
        'Reading this window by sight needs macOS permission to record the screen: a window titled "Screen Recording" may be asking the user to allow "Remote Hands" (if it was dismissed: System Settings > Privacy & Security > Screen Recording > switch on "Remote Hands"; if it is already on, switch it off and on again). Tell the user to do that, then try again in a few seconds. Do not try to work around it.',
      );
    default:
      return new Error(err.message || 'The accessibility helper reported an error.');
  }
}

/** A window read by sight: the picture's text, kept until the next action so a click can use its places. */
export interface OcrState {
  app: string;
  reading: OcrReading;
  view: OcrView;
}

export class DesktopEngine {
  private last: EngineSnapshot | null = null;
  private lastOcr: OcrState | null = null;

  constructor(private readonly helper: AxHelperPort) {}

  /** The most recent snapshot that was shown to the model. */
  current(): EngineSnapshot | null {
    return this.last;
  }

  async ready(): Promise<boolean> {
    return this.helper.ready();
  }

  /**
   * Reads `app` (the front app when empty), remembers it, and returns what the model reads. With `index`, only
   * that list, pane or element of the latest snapshot is read (and ids from outside it are forgotten).
   * Null: use the slower path.
   */
  async snapshot(app: string, opts: { filter?: string; index?: number } = {}): Promise<string | null> {
    let zoom: Zoom | undefined;
    let target = app;
    if (opts.index !== undefined) {
      const last = this.last;
      if (!last) throw new Error('No snapshot yet. Call desktop_snapshot first, then zoom into an index from it.');
      const region = last.view.regions.get(opts.index);
      const item = last.view.byId.get(opts.index);
      if (!region && !item) throw new Error(`Index ${opts.index} not in last snapshot. Call desktop_snapshot again.`);
      const role = region?.role ?? item!.role;
      const label = region?.label ?? item!.label;
      zoom = { id: opts.index, text: `[${opts.index}] ${role === 'hint' ? 'scroll area' : role}${label ? ` "${label}"` : ''}`, front: last.snapshot.frontWindow };
      target = last.app;
    }
    const inherited = this.last?.view.menuNoise;
    const taken = await this.take(target, zoom?.id);
    if (!taken) return null;
    if (zoom && taken.snapshot.frontWindow !== zoom.front) {
      throw new Error('The window in front changed since that snapshot. Call desktop_snapshot again.');
    }
    const viewOpts = zoom ? { zoom: zoom.text, zoomId: zoom.id, ...(inherited !== undefined ? { menuNoise: inherited } : {}) } : {};
    const view = buildView(taken.snapshot, opts.filter ? { filter: opts.filter, ...viewOpts } : viewOpts);
    // A filtered view hides lines, so the ids the model may use are those of the whole window.
    this.last = {
      app: taken.app,
      snapshot: taken.snapshot,
      view: opts.filter ? buildView(taken.snapshot, viewOpts) : view,
      ...(zoom ? { zoom } : {}),
    };
    return view.text;
  }

  /** Reads the window (or, with `root`, one part of it) again without remembering it. Null: use the slower path. */
  async take(app: string, root?: number): Promise<{ app: string; snapshot: AxSnapshot } | null> {
    if (!(await this.helper.ready())) return null;
    const epoch = this.last?.snapshot.epoch;
    const rootPart = root === undefined ? {} : { root, ...(epoch !== undefined ? { epoch } : {}) };
    try {
      const snapshot = await this.helper.request<AxSnapshot>({ op: 'snapshot', app, maxNodes: MAX_NODES, budgetMs: BUDGET_MS, ...rootPart }, SNAPSHOT_TIMEOUT_MS);
      return { app: snapshot.app.name || app, snapshot };
    } catch (err) {
      if (err instanceof AxHelperError) {
        // an app the helper cannot find by that name may still be found by the slower reader
        if (err.code === 'no_app') return null;
        // a part of the window that is gone, scrolled away, or belongs to another app is no longer the view
        if (root !== undefined && (err.code === 'stale' || err.code === 'bad_request')) throw new StaleElementError('That part of the window is no longer there. Call desktop_snapshot again.');
        const told = describeHelperError(err, app);
        if (told) throw told;
        return null;
      }
      throw err;
    }
  }

  /** Forgets what was read by sight. Any action may change the screen, so the places read before it are no longer to be trusted. */
  dropOcr(): void {
    this.lastOcr = null;
  }

  /**
   * LAST RESORT: reads the window of `app` (the front app when empty) by sight, in one picture, and remembers the text
   * for desktop_click. Slower than Accessibility, so it only runs when asked for. Null: the helper cannot serve.
   */
  async readOcr(app: string, opts: { filter?: string; pid?: number } = {}): Promise<string | null> {
    // what was read before is gone the moment a new read starts: a failed read leaves nothing to click
    this.lastOcr = null;
    if (!(await this.helper.ready())) return null;
    let reading: OcrReading;
    try {
      // pinned to the process of the Accessibility snapshot: "the front app" may be another app by now
      reading = await this.helper.request<OcrReading>({ op: 'ocr', app, ...(opts.pid !== undefined ? { pid: opts.pid } : {}) }, OCR_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof AxHelperError) {
        if (err.code === 'no_app') return null;
        const told = describeHelperError(err, app);
        if (told) throw told;
        return null;
      }
      throw err;
    }
    if (opts.pid !== undefined && reading.app.pid !== opts.pid) {
      throw new Error('The app changed while its window was being read. Call desktop_snapshot with ocr=true again.');
    }
    // Accessibility text at the same places is not repeated, but only when the last look was at this very app.
    const axView = this.last && reading.app.name && this.last.app.toLowerCase() === reading.app.name.toLowerCase() ? this.last.view : null;
    const view = buildOcrView(reading, { ...(opts.filter ? { filter: opts.filter } : {}), axView });
    this.lastOcr = { app: reading.app.name || app, reading, view };
    return view.text;
  }

  /** Whether an id belongs to the latest read by sight. */
  hasOcrItem(id: number): boolean {
    return this.lastOcr?.view.byId.has(id) === true;
  }

  /** The process whose window was read by sight, if any. */
  ocrPid(): number | undefined {
    return this.lastOcr?.reading.app.pid;
  }

  /** The text read by sight for an id the model saw in the latest read. */
  ocrItem(id: number): OcrItem {
    const item = this.lastOcr?.view.byId.get(id);
    if (!item) throw new Error(`Index ${id} not in last snapshot. Call desktop_snapshot with ocr=true again.`);
    return item;
  }

  /** The window a click on read-by-sight text goes to. */
  ocrWindow(): OcrReading['window'] & { pid: number } {
    const state = this.lastOcr;
    if (!state) throw new Error(`No window was read by sight. Call desktop_snapshot with ocr=true first.`);
    return { ...state.reading.window, pid: state.reading.app.pid };
  }

  /**
   * Clicks text that was read by sight. The helper first checks that the window is still where the picture was taken, in
   * front, and the one at that spot; otherwise nothing is clicked.
   */
  async clickOcr(id: number, action: ClickAction = 'press'): Promise<void> {
    const item = this.ocrItem(id);
    const win = this.ocrWindow();
    const double = action === 'double' || action === 'open';
    const right = action === 'right' || action === 'menu';
    try {
      await this.helper.request(
        { op: 'clickAt', x: item.x, y: item.y, pid: win.pid, ...(win.id !== undefined ? { windowId: win.id } : {}), window: { x: win.x, y: win.y, width: win.width, height: win.height }, button: right ? 'right' : 'left', count: double ? 2 : 1 },
        ACTION_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof AxHelperError) {
        // the window moved or was replaced since the picture: what was read is out of date
        if (err.code === 'stale') {
          this.lastOcr = null;
          throw new StaleElementError(`${err.message} Call desktop_snapshot with ocr=true again.`);
        }
        throw describeHelperError(err, '') ?? new Error('The accessibility helper stopped responding. Call desktop_snapshot again.');
      }
      throw err;
    }
  }

  /** The line for an id the model saw in the latest snapshot. */
  item(id: number): ViewItem {
    const item = this.last?.view.byId.get(id);
    if (!item) throw new Error(`Index ${id} not in last snapshot. Call desktop_snapshot again.`);
    return item;
  }

  /** A request about the latest snapshot: carries its epoch, so ids from before a helper restart are refused. */
  private raw<T extends { ok: true }>(op: Record<string, unknown>): Promise<T> {
    const epoch = this.last?.snapshot.epoch;
    return this.helper.request<T>(epoch === undefined ? op : { ...op, epoch }, ACTION_TIMEOUT_MS);
  }

  /** A request to the helper whose failures are worded for the model. */
  private async call<T extends { ok: true }>(op: Record<string, unknown>): Promise<T> {
    try {
      return await this.raw<T>(op);
    } catch (err) {
      if (err instanceof AxHelperError) {
        throw describeHelperError(err, '') ?? new Error('The accessibility helper stopped responding. Call desktop_snapshot again.');
      }
      throw err;
    }
  }

  /** Presses, opens, shows the menu of, double-clicks or right-clicks an element. */
  async click(id: number, action: ClickAction = 'press'): Promise<{ method: 'ax' | 'click' }> {
    const item = this.item(id);
    const physical = async (button: 'left' | 'right', count: number): Promise<{ method: 'click' }> => {
      await this.call({ op: 'click', h: item.id, button, count });
      return { method: 'click' };
    };
    if (action === 'double') return physical('left', 2);
    if (action === 'right') return physical('right', 1);
    const named = action === 'press' ? 'AXPress' : action === 'open' ? 'AXOpen' : 'AXShowMenu';
    const target = item.actionTargets[named];
    if (target !== undefined) {
      try {
        await this.raw({ op: 'perform', h: target, action: named });
        return { method: 'ax' };
      } catch (err) {
        // an element that does not do the action natively gets the click a person would make
        if (!(err instanceof AxHelperError) || (err.code !== 'unsupported' && err.code !== 'failed')) {
          if (err instanceof AxHelperError) throw describeHelperError(err, '') ?? new Error('The accessibility helper stopped responding. Call desktop_snapshot again.');
          throw err;
        }
      }
    }
    return action === 'open' ? physical('left', 2) : action === 'menu' ? physical('right', 1) : physical('left', 1);
  }

  async focus(id: number): Promise<void> {
    await this.call({ op: 'focus', h: this.item(id).id });
  }

  /** Sets a field's whole value. `set` is false when it cannot be set directly or did not take. */
  async setValue(id: number, value: string): Promise<{ set: boolean }> {
    try {
      const res = await this.raw<{ ok: true; matches?: boolean; secure?: boolean }>({ op: 'setValue', h: this.item(id).id, value });
      return { set: res.matches === true };
    } catch (err) {
      if (err instanceof AxHelperError && (err.code === 'not_settable' || err.code === 'failed')) return { set: false };
      if (err instanceof AxHelperError) throw describeHelperError(err, '') ?? new Error('The accessibility helper stopped responding. Call desktop_snapshot again.');
      throw err;
    }
  }

  /** Types into the app of the latest snapshot; with an id, only while the cursor is still in that field. */
  async typeText(text: string, id?: number): Promise<void> {
    await this.call({ op: 'typeText', text, ...this.keyboardTarget(id) });
  }

  /** Return or select-all, with the same checks as typing. */
  async pressKey(key: 'return' | 'selectAll', id?: number): Promise<void> {
    await this.call({ op: 'key', key, ...this.keyboardTarget(id) });
  }

  private keyboardTarget(id?: number): Record<string, number> {
    const pid = this.last?.snapshot.app.pid;
    return {
      ...(pid !== undefined ? { pid } : {}),
      ...(id !== undefined ? { h: this.item(id).id } : {}),
    };
  }

  /** The text of an element; never a password. */
  async readText(id: number, max?: number): Promise<{ text: string; truncated: boolean; selected?: string }> {
    const res = await this.call<{ ok: true; text?: string; truncated?: boolean; selected?: string }>({ op: 'read', h: this.item(id).id, ...(max ? { max } : {}) });
    return { text: res.text ?? '', truncated: res.truncated === true, ...(res.selected ? { selected: res.selected } : {}) };
  }

  /** One unit is about ten lines. Positions are 0..1 when the area reports one. */
  async scroll(id: number, direction: ScrollDirection, amount: number): Promise<{ before?: number; after?: number }> {
    const lines = Math.max(1, Math.min(20, Math.round(amount))) * 10;
    const dy = direction === 'up' ? lines : direction === 'down' ? -lines : 0;
    const dx = direction === 'left' ? lines : direction === 'right' ? -lines : 0;
    const res = await this.call<{ ok: true; before?: number; after?: number }>({ op: 'scroll', h: this.item(id).id, dy, dx });
    return { ...(res.before !== undefined ? { before: res.before } : {}), ...(res.after !== undefined ? { after: res.after } : {}) };
  }

  async drag(fromId: number, toId: number): Promise<void> {
    const from = this.item(fromId);
    // list rows drag what is selected, so the helper selects the row first
    await this.call({ op: 'drag', from: { h: from.id }, to: { h: this.item(toId).id }, ...(from.role === 'row' ? { select: true } : {}) });
  }

  /**
   * Waits for the window to stop changing (two equal looks in a row, at most 1.5 s), remembers the result and
   * returns what changed since `before`. Null: use the slower path.
   */
  async settle(app: string, before: View | null, opts: { firstMs?: number; gapMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<string | null> {
    const sleep = opts.sleep ?? defaultSleep;
    const now = opts.now ?? Date.now;
    const started = now();
    if ((opts.firstMs ?? 120) > 0) await sleep(opts.firstMs ?? 120);
    let previous: string | null = null;
    // a part of the window that was zoomed into stays the view while it is still there
    const lastApp = this.last?.app ?? '';
    let zoom = app === '' || app.toLowerCase() === lastApp.toLowerCase() ? this.last?.zoom : undefined;
    const menuNoise = this.last?.view.menuNoise;
    for (;;) {
      let taken: { app: string; snapshot: AxSnapshot } | null;
      try {
        taken = await this.take(app, zoom?.id);
      } catch (err) {
        if (!zoom || !(err instanceof StaleElementError)) throw err;
        zoom = undefined;
        previous = null;
        taken = await this.take(app);
      }
      if (!taken) return null;
      if (zoom && taken.snapshot.frontWindow !== zoom.front) {
        // another window is in front now (a dialog, a different document): the whole window is the view
        zoom = undefined;
        previous = null;
        taken = await this.take(app);
        if (!taken) return null;
      }
      const view = buildView(taken.snapshot, zoom ? { zoom: zoom.text, zoomId: zoom.id, ...(menuNoise !== undefined ? { menuNoise } : {}) } : {});
      this.last = { app: taken.app, snapshot: taken.snapshot, view, ...(zoom ? { zoom } : {}) };
      if (view.fingerprint === previous || now() - started >= SETTLE_MAX_MS) return renderDiff(before, view);
      previous = view.fingerprint;
      if ((opts.gapMs ?? 150) > 0) await sleep(opts.gapMs ?? 150);
    }
  }

  /** What changed in the current window since `before`, or the whole window when that is shorter. */
  diff(before: View | null, after: View): string {
    return renderDiff(before, after);
  }
}
