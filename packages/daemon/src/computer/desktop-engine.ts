import { AxHelperError, type AxHelperPort, type AxSnapshot } from '../desktop/ax-helper.js';
import { buildView, renderDiff, type View, type ViewItem } from '../desktop/ax-model.js';

/**
 * Native-app control on top of the rh-ax helper: a fast snapshot with stable ids, and (added next to it)
 * actions addressed by those ids. Every method answers `null` when the helper cannot serve, so the caller
 * can run the slower code it had before; real problems (no permission, no such app) are thrown as plain
 * messages for the model.
 */

export interface EngineSnapshot {
  app: string;
  snapshot: AxSnapshot;
  view: View;
}

const SNAPSHOT_TIMEOUT_MS = 15_000;
const MAX_NODES = 600;
const BUDGET_MS = 3000;
const ACTION_TIMEOUT_MS = 10_000;
const SETTLE_MAX_MS = 1500;

export type ClickAction = 'press' | 'open' | 'menu' | 'double' | 'right';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The helper's error codes that mean "use the slower path" rather than "tell the model". */
const FALLBACK_CODES = new Set(['unavailable', 'helper_exited', 'timeout']);

export function describeHelperError(err: AxHelperError, app: string): Error | null {
  if (FALLBACK_CODES.has(err.code)) return null;
  switch (err.code) {
    case 'not_trusted':
      return new Error(
        'Accessibility permission is missing for Remote Hands. Allow it in System Settings > Privacy & Security > Accessibility, then try again.',
      );
    case 'no_app':
      return new Error(app ? `No running app matches "${app}". Use desktop_open to start it.` : 'No app is in front.');
    case 'stale':
      return new Error('That element is no longer there. Call desktop_snapshot again.');
    default:
      return new Error(err.message || 'The accessibility helper reported an error.');
  }
}

export class DesktopEngine {
  private last: EngineSnapshot | null = null;

  constructor(private readonly helper: AxHelperPort) {}

  /** The most recent snapshot that was shown to the model. */
  current(): EngineSnapshot | null {
    return this.last;
  }

  async ready(): Promise<boolean> {
    return this.helper.ready();
  }

  /** Reads `app` (the front app when empty), remembers it, and returns what the model reads. Null: use the slower path. */
  async snapshot(app: string, opts: { filter?: string } = {}): Promise<string | null> {
    const taken = await this.take(app);
    if (!taken) return null;
    const view = buildView(taken.snapshot, opts.filter ? { filter: opts.filter } : {});
    // A filtered view hides lines, so the ids the model may use are those of the whole window.
    this.last = { app: taken.app, snapshot: taken.snapshot, view: opts.filter ? buildView(taken.snapshot) : view };
    return view.text;
  }

  /** Reads the window again without remembering it. Null: use the slower path. */
  async take(app: string): Promise<{ app: string; snapshot: AxSnapshot } | null> {
    if (!(await this.helper.ready())) return null;
    try {
      const snapshot = await this.helper.request<AxSnapshot>({ op: 'snapshot', app, maxNodes: MAX_NODES, budgetMs: BUDGET_MS }, SNAPSHOT_TIMEOUT_MS);
      return { app: snapshot.app.name || app, snapshot };
    } catch (err) {
      if (err instanceof AxHelperError) {
        // an app the helper cannot find by that name may still be found by the slower reader
        if (err.code === 'no_app') return null;
        const told = describeHelperError(err, app);
        if (told) throw told;
        return null;
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

  /** A request to the helper whose failures are worded for the model. */
  private async call<T extends { ok: true }>(op: Record<string, unknown>): Promise<T> {
    try {
      return await this.helper.request<T>(op, ACTION_TIMEOUT_MS);
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
        await this.helper.request({ op: 'perform', h: target, action: named }, ACTION_TIMEOUT_MS);
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
      const res = await this.helper.request<{ ok: true; matches?: boolean; secure?: boolean }>({ op: 'setValue', h: this.item(id).id, value }, ACTION_TIMEOUT_MS);
      return { set: res.matches === true };
    } catch (err) {
      if (err instanceof AxHelperError && (err.code === 'not_settable' || err.code === 'failed')) return { set: false };
      if (err instanceof AxHelperError) throw describeHelperError(err, '') ?? new Error('The accessibility helper stopped responding. Call desktop_snapshot again.');
      throw err;
    }
  }

  async typeText(text: string): Promise<void> {
    await this.call({ op: 'typeText', text });
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
    await this.call({ op: 'drag', from: { h: this.item(fromId).id }, to: { h: this.item(toId).id } });
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
    for (;;) {
      const taken = await this.take(app);
      if (!taken) return null;
      const view = buildView(taken.snapshot);
      this.last = { app: taken.app, snapshot: taken.snapshot, view };
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
