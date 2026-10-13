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
      'Accessibility permission is missing, so apps cannot be read',
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
