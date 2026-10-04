import { describe, it, expect, beforeEach } from 'vitest';
import { FastBrowserEngine, normalizeOpenUrl } from './engine.js';
import { BrowserAutomationError, type TabTarget } from './applescript.js';
import type { TabInfo } from './transport.js';
import type { BrowserApp } from './browsers.js';
import type { BrowserPort, DoStep } from './port.js';
import { buildReadyProbe, buildSnapshotWithProbe } from './page-scripts.js';

type Responder = string | Error | ((js: string) => string);

function page(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://example.com/signup',
    title: 'Sign up',
    text: 'Create account',
    actions: [
      { node: 7, role: 'textbox', label: 'Email', kind: 'fill', value: '' },
      { node: 7, role: 'textbox', label: 'Open Email', kind: 'click', value: '' },
      { node: 3, role: 'combobox', label: 'Country → Canada', kind: 'select', value: 'ca', current_value: 'US' },
      { node: 9, role: 'checkbox', label: 'I agree', kind: 'click', value: 'on', checked: 'false' },
      { node: 12, role: 'button', label: 'Next', kind: 'click', value: '' },
      { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
    ],
    ...over,
  };
}

class FakeTransport {
  env: { frontmost: string | null; running: string[] } = { frontmost: 'Google Chrome', running: ['Google Chrome'] };
  envCalls = 0;
  evals: Array<{ browser: string; target: TabTarget | null; js: string }> = [];
  /** Snapshot results in order; the last one repeats. */
  snapshots: Responder[] = [JSON.stringify(page())];
  /** Action results in order; default ok. */
  actions: Responder[] = [];
  probes: Responder[] = [];
  extract: Responder = JSON.stringify({ title: 'T', url: 'https://x.test/', text: 'hello' });
  /** Thrown by every evaluate when set. */
  fail: Error | null = null;
  tabList: TabInfo[] = [];
  tabListAfterOpen: TabInfo[] | null = null;
  focused: TabTarget[] = [];
  opened: Array<{ url: string; windowId: string | undefined }> = [];

  async environment(): Promise<{ frontmost: string | null; running: string[] }> {
    this.envCalls += 1;
    return this.env;
  }

  async evaluate(b: BrowserApp, target: TabTarget | null, js: string): Promise<string> {
    this.evals.push({ browser: b.name, target, js });
    if (this.fail) throw this.fail;
    let r: Responder;
    if (js === buildSnapshotWithProbe()) {
      // One evaluate: snapshot + readiness probe. Consumes a scripted probe when present,
      // else reports the snapshot's own page as complete and not navigating.
      const snapR = (this.snapshots.length > 1 ? this.snapshots.shift() : this.snapshots[0])!;
      const probeR = this.probes.shift();
      if (snapR instanceof Error) throw snapR;
      if (probeR instanceof Error) throw probeR;
      const snapText = typeof snapR === 'function' ? snapR(js) : snapR;
      const snap = JSON.parse(snapText) as Record<string, unknown> | null;
      const probeText =
        probeR === undefined
          ? JSON.stringify({
              u: snap?.url ?? '',
              r: 'complete',
              t: snap?.title ?? '',
              o: Array.isArray(snap?.page_key) ? (snap!.page_key as unknown[])[0] : null,
              p: false,
            })
          : typeof probeR === 'function'
            ? probeR(buildReadyProbe())
            : probeR;
      return `{"snap":${snapText},"probe":${probeText}}`;
    } else if (js === buildReadyProbe()) {
      r = this.probes.shift() ?? JSON.stringify({ u: this.currentUrl(), r: 'complete', t: 'Sign up' });
    } else if (js.includes('__rhFast = window.__jevFast')) {
      r = (this.snapshots.length > 1 ? this.snapshots.shift() : this.snapshots[0])!;
    } else if (js.includes('location.href = ')) {
      r = JSON.stringify({ ok: true });
    } else if (js.includes('const op = ')) {
      r = this.actions.shift() ?? JSON.stringify({ ok: true, label: 'x' });
    } else {
      r = this.extract;
    }
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(js) : r;
  }

  private currentUrl(): string {
    const s = this.snapshots[0];
    if (typeof s !== 'string') return '';
    return (JSON.parse(s) as { url?: string } | null)?.url ?? '';
  }

  async listTabs(): Promise<TabInfo[]> {
    if (this.opened.length > 0 && this.tabListAfterOpen) return this.tabListAfterOpen;
    return this.tabList;
  }

  /** Like the real browsers: the tab becomes active and its window comes to the front. */
  async focusTab(_b: BrowserApp, target: TabTarget): Promise<void> {
    this.focused.push(target);
    const w = this.tabList.find((x) => x.windowId === target.windowId)?.windowIndex;
    if (w === undefined) return;
    this.tabList = this.tabList.map((x) =>
      x.windowId === target.windowId
        ? { ...x, active: x.tabKey === target.tabKey, windowIndex: 1 }
        : { ...x, windowIndex: x.windowIndex < w ? x.windowIndex + 1 : x.windowIndex },
    );
  }

  async openUrl(_b: BrowserApp, url: string, windowId?: string): Promise<void> {
    this.opened.push({ url, windowId });
  }

  async closeTab(): Promise<void> {}

  snapshotEvals(): number {
    return this.evals.filter((e) => e.js.includes('__rhFast = window.__jevFast')).length;
  }

  actionEvals(): string[] {
    return this.evals.filter((e) => e.js.includes('const op = ')).map((e) => e.js);
  }
}

class FakeLegacy implements BrowserPort {
  calls: string[] = [];
  private rec(name: string): Promise<string> {
    this.calls.push(name);
    return Promise.resolve(`legacy:${name}`);
  }
  tabs(): Promise<string> { return this.rec('tabs'); }
  focus(): Promise<string> { return this.rec('focus'); }
  open(): Promise<string> { return this.rec('open'); }
  snapshot(): Promise<string> { return this.rec('snapshot'); }
  click(): Promise<string> { return this.rec('click'); }
  type(): Promise<string> { return this.rec('type'); }
  find(): Promise<string> { return this.rec('find'); }
  do(_steps: DoStep[]): Promise<string> { return this.rec('do'); }
  extract(): Promise<string> { return this.rec('extract'); }
}

/** The op object embedded in an action script. */
function opOf(js: string): Record<string, unknown> {
  const m = /const op = (.*);\n/.exec(js);
  if (!m) throw new Error('no op in script');
  return JSON.parse(m[1]!) as Record<string, unknown>;
}

let t: FakeTransport;
let legacy: FakeLegacy;
let clock: number;
let engine: FastBrowserEngine;

function make(env: NodeJS.ProcessEnv = {}): FastBrowserEngine {
  return new FastBrowserEngine({
    transport: t,
    legacy,
    env,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
}

beforeEach(() => {
  t = new FakeTransport();
  legacy = new FakeLegacy();
  clock = 1_000_000;
  engine = make();
});

describe('target selection', () => {
  it('uses the frontmost supported browser', async () => {
    t.env = { frontmost: 'Safari', running: ['Google Chrome', 'Safari'] };
    await engine.snapshot();
    expect(t.evals[0]!.browser).toBe('Safari');
    expect(t.evals[0]!.target).toBeNull();
  });

  it('honours RH_BROWSER when that browser is running', async () => {
    t.env = { frontmost: 'Safari', running: ['Google Chrome', 'Safari'] };
    await make({ RH_BROWSER: 'chrome' }).snapshot();
    expect(t.evals[0]!.browser).toBe('Google Chrome');
  });

  it('uses the legacy port and never evaluates when no supported browser runs', async () => {
    t.env = { frontmost: 'Finder', running: [] };
    expect(await engine.snapshot()).toBe('legacy:snapshot');
    expect(t.evals).toHaveLength(0);
  });

  it('falls back on not_running without caching it', async () => {
    t.fail = new BrowserAutomationError('not_running', 'Google Chrome', 'Google Chrome is not running.');
    expect(await engine.snapshot()).toBe('legacy:snapshot');
    t.fail = null;
    clock += 2000;
    expect(await engine.snapshot()).toContain('page: Sign up');
  });
});

describe('snapshot and actions', () => {
  it('renders the snapshot with node ids', async () => {
    const out = await engine.snapshot();
    expect(out.split('\n')).toEqual([
      'browser: Google Chrome · page: Sign up — https://example.com/signup',
      '[7] textbox "Email"',
      '[3] select "Country" = "US" options: US | Canada',
      '[9] checkbox "I agree"',
      '[12] button "Next"',
      '[wait] wait "Wait for the page to update"',
    ]);
    expect(await engine.snapshot({ text: true })).toContain('text: Create account');
  });

  it('clicks by node id with the base label and returns a delta', async () => {
    await engine.snapshot();
    const after = page();
    (after.actions as Array<Record<string, unknown>>)[3] = { node: 9, role: 'checkbox', label: 'I agree', kind: 'click', value: 'on', checked: 'true' };
    t.snapshots = [JSON.stringify(after)];
    const out = await engine.click(9);
    expect(opOf(t.actionEvals()[0]!)).toEqual({ op: 'click', node: 9, label: 'I agree' });
    expect(out.split('\n')).toEqual([
      'clicked [9] I agree',
      'browser: Google Chrome · page: Sign up — https://example.com/signup (same page)',
      '~ [9] checkbox "I agree" [checked]',
      '(4 unchanged)',
    ]);
  });

  it('a non-navigating action costs one action evaluate + one combined snapshot evaluate, no environment read (I3)', async () => {
    await engine.snapshot();
    t.evals = [];
    const envBefore = t.envCalls;
    const start = clock;
    // The click changes the page (checkbox now checked), so no confirmation read is needed.
    const changed = page();
    (changed.actions as Array<Record<string, unknown>>)[3] = { node: 9, role: 'checkbox', label: 'I agree', kind: 'click', value: 'on', checked: 'true' };
    t.snapshots = [JSON.stringify(changed)];
    const out = await engine.click(12);
    expect(t.evals.map((e) => (e.js.includes('const op = ') ? 'action' : e.js === buildSnapshotWithProbe() ? 'combined' : 'other'))).toEqual([
      'action',
      'combined',
    ]);
    expect(t.envCalls).toBe(envBefore);
    expect(clock - start).toBe(80);
    expect(out).toContain('(same page)');
    t.evals = [];
    await engine.do([{ op: 'type', index: 7, text: 'a' }, { op: 'check', index: 9, checked: true }]);
    expect(t.evals.filter((e) => !e.js.includes('const op = ')).map((e) => e.js === buildSnapshotWithProbe())).toEqual([true]);
  });

  describe('late-starting navigation confirmation (fix pass 5 A)', () => {
    const OLD = JSON.stringify(page({ page_key: [1, 'x'] }));
    const NEW = JSON.stringify(page({ url: 'https://example.com/welcome', title: 'Welcome', page_key: [2, 'x'] }));
    const pr = (u: string, t2: string, o: number, p: boolean, r = 'complete'): string => JSON.stringify({ u, r, t: t2, o, p });
    const kinds = (): string[] =>
      t.evals.map((e) =>
        e.js.includes('const op = ') ? 'action' : e.js === buildSnapshotWithProbe() ? 'combined' : e.js === buildReadyProbe() ? 'probe' : 'snapshot',
      );

    it('a button click whose navigation starts late renders the NEW page', async () => {
      t.snapshots = [OLD];
      await engine.snapshot();
      t.evals = [];
      t.probes = [
        pr('https://example.com/signup', 'Sign up', 1, false),
        pr('https://example.com/signup', 'Sign up', 1, true),
        pr('https://example.com/welcome', 'Welcome', 2, false),
        pr('https://example.com/welcome', 'Welcome', 2, false),
      ];
      t.snapshots = [() => (t.probes.length >= 2 ? OLD : NEW)];
      const out = await engine.click(12);
      expect(kinds()).toEqual(['action', 'combined', 'combined', 'probe', 'probe', 'snapshot']);
      expect(out).toContain('page: Welcome — https://example.com/welcome');
      expect(out).not.toContain('no change detected');
    });

    it('a genuinely no-op button click takes exactly one confirmation read and notes it', async () => {
      await engine.snapshot();
      t.evals = [];
      const out = await engine.click(12);
      expect(kinds()).toEqual(['action', 'combined', 'combined']);
      expect(out.split('\n').slice(-2)).toEqual(['no visible change', 'note: no change detected']);
    });

    it('a type with submit confirms but does not add the note; a link click with a real change does not confirm', async () => {
      await engine.snapshot();
      t.evals = [];
      const out = await engine.type(7, 'q', { submit: true });
      expect(kinds()).toEqual(['action', 'combined', 'combined']);
      expect(out).not.toContain('no change detected');
      const linkPage = page({ actions: [{ node: 4, role: 'link', label: 'Pricing', kind: 'click', value: '' }] });
      t.snapshots = [JSON.stringify(linkPage)];
      await engine.snapshot();
      t.snapshots = [JSON.stringify(page({ actions: [{ node: 4, role: 'link', label: 'Pricing', kind: 'click', value: '' }, { node: 5, role: 'button', label: 'Close', kind: 'click', value: '' }] }))];
      t.evals = [];
      const out2 = await engine.click(4);
      expect(kinds()).toEqual(['action', 'combined']);
      expect(out2).toContain('+ [5] button "Close"');
    });

    it('select, check, scroll and wait never confirm, even with no visible change', async () => {
      await engine.snapshot();
      for (const steps of [
        [{ op: 'select' as const, index: 3, value: 'Canada' }],
        [{ op: 'check' as const, index: 9, checked: true }],
        [{ op: 'scroll' as const, delta: 10 }],
        [{ op: 'wait' as const, ms: 10 }],
      ]) {
        t.evals = [];
        const out = await engine.do(steps);
        expect(kinds().filter((k) => k !== 'action')).toEqual(['combined']);
        expect(out).not.toContain('no change detected');
      }
    });

    it('a do batch ending in a no-op button click confirms once and notes it', async () => {
      await engine.snapshot();
      t.evals = [];
      const out = await engine.do([{ op: 'scroll', delta: 5 }, { op: 'click', index: 12 }]);
      expect(kinds().filter((k) => k !== 'action')).toEqual(['combined', 'combined']);
      expect(out.split('\n').at(-1)).toBe('note: no change detected');
    });
  });

  it('a combined read whose snapshot errored falls back to the slow path (fix pass 5 B)', async () => {
    await engine.snapshot();
    t.evals = [];
    let combinedCalls = 0;
    const ev = t.evaluate.bind(t);
    t.evaluate = async (b, target, js) => {
      if (js === buildSnapshotWithProbe() && combinedCalls++ === 0) {
        t.evals.push({ browser: b.name, target, js });
        return JSON.stringify({ snap: { error: 'snapshot failed: boom' }, probe: { u: 'https://example.com/signup', r: 'complete', t: 'Sign up', o: null, p: false } });
      }
      return ev(b, target, js);
    };
    const out = await engine.click(12);
    expect(out).not.toContain('state unavailable');
    expect(out).toContain('page: Sign up');
    expect(t.snapshotEvals()).toBe(2); // the failed combined read + the slow-path snapshot
  });

  it('a navigating action takes the slow path and renders the new page (I3)', async () => {
    t.snapshots = [JSON.stringify(page({ page_key: [1, 'x'] }))];
    await engine.snapshot();
    t.evals = [];
    const NEW = JSON.stringify(page({ url: 'https://example.com/next', title: 'Next', page_key: [2, 'x'] }));
    const pending = JSON.stringify({ u: 'https://example.com/signup', r: 'complete', t: 'Sign up', o: 1, p: true });
    const done = JSON.stringify({ u: 'https://example.com/next', r: 'complete', t: 'Next', o: 2, p: false });
    t.probes = [pending, done, done];
    t.snapshots = [() => (t.probes.length > 0 ? JSON.stringify(page({ page_key: [1, 'x'] })) : NEW)];
    const out = await engine.click(12);
    const kinds = t.evals.map((e) => (e.js.includes('const op = ') ? 'action' : e.js === buildSnapshotWithProbe() ? 'combined' : e.js === buildReadyProbe() ? 'probe' : 'snapshot'));
    expect(kinds).toEqual(['action', 'combined', 'probe', 'probe', 'snapshot']);
    expect(out).toContain('page: Next — https://example.com/next');
  });

  it('notes a page that is still loading after 3 s', async () => {
    await engine.snapshot();
    t.probes = Array.from({ length: 100 }, () => JSON.stringify({ u: 'https://example.com/signup', r: 'loading', t: 'Sign up' }));
    const out = await engine.click(12);
    expect(out.endsWith('note: page still loading')).toBe(true);
  });

  it('typing into a password field says the value is hidden instead of a bare "no visible change" (minor 2)', async () => {
    const pw = page({ actions: [{ node: 5, role: 'textbox', label: 'Password', kind: 'fill', value: '••••••••' }] });
    t.snapshots = [JSON.stringify(pw)];
    await engine.snapshot();
    const out = await engine.type(5, 'secret');
    expect(out.split('\n').at(-1)).toBe('no visible change (password field: value hidden)');
    const out2 = await engine.do([{ op: 'type', index: 5, text: 'secret' }]);
    expect(out2.split('\n').at(-1)).toBe('no visible change (password field: value hidden)');
    const out3 = await engine.do([{ op: 'scroll', delta: 5 }]);
    expect(out3.split('\n').at(-1)).toBe('no visible change');
  });

  it('passes the field read-back through "value did not stick" (minor 3)', async () => {
    await engine.snapshot();
    t.actions = [JSON.stringify({ ok: false, error: 'failed', message: 'value did not stick', current: '555-12' })];
    await expect(engine.type(7, '555-1234')).rejects.toThrow('value did not stick (field now: "555-12")');
    t.actions = [JSON.stringify({ ok: false, error: 'failed', message: 'value did not stick' })];
    await expect(engine.type(7, 'x')).rejects.toThrow(/^value did not stick$/);
  });

  it('types hostile text as an argv-safe JSON literal', async () => {
    await engine.snapshot();
    const text = 'a"b\'c`d${x}\n</script>\\';
    const out = await engine.type(7, text, { submit: true });
    const js = t.actionEvals()[0]!;
    expect(js).not.toContain('</script>');
    expect(opOf(js)).toEqual({ op: 'type', node: 7, label: 'Email', text, submit: true });
    expect(out.split('\n')[0]).toBe('typed into [7] Email');
  });

  it('rejects ids that are not on the shown page', async () => {
    await expect(engine.click(5)).rejects.toThrow('Index 5 is not on the page I last showed. Call browser_snapshot.');
    await engine.snapshot();
    await expect(engine.click(99)).rejects.toThrow('Index 99 is not on the page I last showed. Call browser_snapshot.');
  });

  it('maps page failures to actionable messages', async () => {
    await engine.snapshot();
    t.actions = [JSON.stringify({ ok: false, error: 'stale' })];
    await expect(engine.click(12)).rejects.toThrow('Element [12] no longer on the page. Call browser_snapshot.');
    t.actions = [JSON.stringify({ ok: false, error: 'changed', current: 'Back' })];
    await expect(engine.click(12)).rejects.toThrow('Element [12] changed (now "Back"). Call browser_snapshot.');
    t.actions = [JSON.stringify({ ok: false, error: 'unsupported', message: 'element is disabled' })];
    await expect(engine.click(12)).rejects.toThrow('element is disabled');
    t.actions = ['garbage'];
    await expect(engine.click(12)).rejects.toThrow('unexpected page result: garbage');
  });

  it('reports a failed snapshot', async () => {
    t.snapshots = [JSON.stringify({ error: 'snapshot failed: boom' })];
    await expect(engine.snapshot()).rejects.toThrow('snapshot failed: boom');
  });

  it('uses the legacy port for actions after a legacy snapshot', async () => {
    t.env = { frontmost: null, running: [] };
    await engine.snapshot();
    expect(await engine.click(3)).toBe('legacy:click');
    expect(await engine.type(3, 'x')).toBe('legacy:type');
  });

  it('maps not_running from the action to "<Name> is not running" and forgets the page (I3)', async () => {
    await engine.snapshot();
    t.fail = new BrowserAutomationError('not_running', 'Google Chrome', 'Google Chrome is not running.');
    await expect(engine.click(12)).rejects.toThrow('Google Chrome is not running. Call browser_snapshot.');
    t.fail = null;
    await expect(engine.click(12)).rejects.toThrow('Index 12 is not on the page I last showed');
  });
});

describe('fast-path availability cache', () => {
  for (const code of ['js_disabled', 'automation_denied'] as const) {
    it(`falls back on ${code} with a one-time note and a 60 s cache`, async () => {
      t.fail = new BrowserAutomationError(code, 'Google Chrome', `msg-${code}`);
      expect(await engine.snapshot()).toBe(
        `note: fast browser path unavailable (msg-${code}); using the slower fallback. Run "rh browser setup" to fix it.\nlegacy:snapshot`,
      );
      const n = t.evals.length;
      clock += 30_000;
      expect(await engine.snapshot()).toBe('legacy:snapshot');
      expect(t.evals).toHaveLength(n);
      clock += 31_000;
      t.fail = null;
      expect(await engine.snapshot()).toContain('page: Sign up');
    });
  }

  it('keeps the fast-path reason when the legacy fallback throws (I1)', async () => {
    legacy.snapshot = async () => {
      throw new Error('CDP unreachable');
    };
    const cases: Array<[BrowserAutomationError, string]> = [
      [new BrowserAutomationError('js_disabled', 'Google Chrome', 'JS off in Chrome.'), 'JS off in Chrome.'],
      [new BrowserAutomationError('automation_denied', 'Google Chrome', 'Automation denied.'), 'Automation denied.'],
      [new BrowserAutomationError('no_window', 'Google Chrome', 'no window'), 'Google Chrome has no open window; use browser_open'],
      [new BrowserAutomationError('not_running', 'Google Chrome', 'gone'), 'Google Chrome is not running'],
    ];
    for (const [err, reason] of cases) {
      engine.reset();
      t.fail = err;
      await expect(engine.snapshot()).rejects.toThrow(`CDP unreachable (fast browser path unavailable: ${reason})`);
    }
    // While the 60 s cache is active the reason is still attached.
    engine.reset();
    t.fail = new BrowserAutomationError('js_disabled', 'Google Chrome', 'JS off in Chrome.');
    await expect(engine.snapshot()).rejects.toThrow('(fast browser path unavailable: JS off in Chrome.)');
    await expect(engine.snapshot()).rejects.toThrow('CDP unreachable (fast browser path unavailable: JS off in Chrome.)');
  });

  it('re-arms the fallback note after a successful fast-path call (minor 4)', async () => {
    t.fail = new BrowserAutomationError('js_disabled', 'Google Chrome', 'off-1');
    expect(await engine.snapshot()).toContain('note: fast browser path unavailable (off-1)');
    clock += 61_000;
    t.fail = null;
    expect(await engine.snapshot()).toContain('page: Sign up');
    t.fail = new BrowserAutomationError('automation_denied', 'Google Chrome', 'off-2');
    expect(await engine.snapshot()).toContain('note: fast browser path unavailable (off-2)');
  });

  it('reset() clears the cache', async () => {
    t.fail = new BrowserAutomationError('js_disabled', 'Google Chrome', 'off');
    await engine.snapshot();
    t.fail = null;
    engine.reset();
    expect(await engine.snapshot()).toContain('page: Sign up');
  });
});

describe('do', () => {
  it('validates every step before running anything', async () => {
    await engine.snapshot();
    const before = t.evals.length;
    await expect(engine.do([{ op: 'click', index: 12 }, { op: 'type', index: 7 }])).rejects.toThrow(
      'step 2 type invalid: text is required. No steps were run.',
    );
    await expect(engine.do([{ op: 'click', index: 44 }])).rejects.toThrow(
      'step 1 click invalid: index 44 is not on the page I last showed. No steps were run.',
    );
    await expect(engine.do([{ op: 'wait', ms: 9000 }])).rejects.toThrow('step 1 wait invalid: ms must be between 0 and 5000. No steps were run.');
    await expect(engine.do([{ op: 'select', index: 3 }])).rejects.toThrow('step 1 select invalid: value is required');
    await expect(engine.do([{ op: 'check', index: 9 }])).rejects.toThrow('step 1 check invalid: checked is required');
    await expect(engine.do([{ op: 'press' }])).rejects.toThrow('step 1 press invalid: key is required');
    await expect(engine.do([{ op: 'scroll' }])).rejects.toThrow('step 1 scroll invalid: delta is required');
    await expect(engine.do([{ op: 'hover' as DoStep['op'] }])).rejects.toThrow('step 1 hover invalid: unknown op');
    await expect(engine.do(Array.from({ length: 16 }, () => ({ op: 'wait' as const, ms: 1 })))).rejects.toThrow('at most 15 steps');
    expect(t.evals).toHaveLength(before);
  });

  it('runs steps against the pre-batch ids and takes one final snapshot', async () => {
    await engine.snapshot();
    const snaps = t.snapshotEvals();
    const out = await engine.do([
      { op: 'type', index: 7, text: 'a@b.c' },
      { op: 'select', index: 3, value: 'Canada' },
      { op: 'check', index: 9, checked: true },
      { op: 'wait', ms: 100 },
      { op: 'scroll', delta: 300 },
    ]);
    expect(t.actionEvals().map(opOf)).toEqual([
      { op: 'type', node: 7, label: 'Email', text: 'a@b.c' },
      { op: 'select', node: 3, label: 'Country', value: 'Canada' },
      { op: 'check', node: 9, label: 'I agree', checked: true },
      { op: 'scroll', delta: 300 },
    ]);
    expect(t.snapshotEvals()).toBe(snaps + 1);
    expect(out.split('\n')[0]).toBe('did: type, select, check, wait, scroll');
    expect(out).toContain('no visible change');
  });

  it('adds a note when an unverified state change shows no visible change', async () => {
    await engine.snapshot();
    t.actions = [JSON.stringify({ ok: true, label: 'I agree', verified: false })];
    const out = await engine.do([{ op: 'check', index: 9, checked: true }]);
    expect(out).toContain('note: could not confirm the state change');
  });

  it('reports the failing step with computer_batch wording', async () => {
    await engine.snapshot();
    t.actions = [JSON.stringify({ ok: true }), JSON.stringify({ ok: true }), JSON.stringify({ ok: false, error: 'stale' })];
    await expect(
      engine.do([
        { op: 'type', index: 7, text: 'x' },
        { op: 'check', index: 9, checked: true },
        { op: 'click', index: 12 },
      ]),
    ).rejects.toThrow('step 3 click failed: Element [12] no longer on the page. Call browser_snapshot. (steps 1-2 ok)');
    t.actions = [JSON.stringify({ ok: false, error: 'no_option', message: 'no option matching "Mars"' })];
    await expect(engine.do([{ op: 'select', index: 3, value: 'Mars' }])).rejects.toThrow(
      'step 1 select failed: no option matching "Mars" (no steps ok)',
    );
  });

  it('stops the batch when a click navigates', async () => {
    await engine.snapshot();
    t.probes = [JSON.stringify({ u: 'https://example.com/next', r: 'loading', t: '' })];
    t.snapshots = [JSON.stringify(page({ url: 'https://example.com/next', title: 'Next' }))];
    const out = await engine.do([
      { op: 'click', index: 12 },
      { op: 'type', index: 7, text: 'never' },
    ]);
    expect(t.actionEvals()).toHaveLength(1);
    const lines = out.split('\n');
    expect(lines[0]).toBe('did: click');
    expect(lines[1]).toBe('step 1 click ok but the page navigated; remaining steps not run');
    expect(lines[2]).toBe('changed: page navigated or re-rendered');
  });
});

describe('find and extract', () => {
  it('ranks matches from a fresh snapshot and updates the shown page', async () => {
    t.snapshots = [JSON.stringify(page({ actions: [
      { node: 1, role: 'link', label: 'Sign in with Google', kind: 'click', value: '' },
      { node: 2, role: 'button', label: 'Sign in', kind: 'click', value: '' },
      { node: 4, role: 'link', label: 'Pricing', kind: 'click', value: '' },
    ] }))];
    const out = await engine.find('sign in');
    expect(out.split('\n')).toEqual([
      'found 2 of 3 elements for "sign in":',
      '[2] button "Sign in"',
      '[1] link "Sign in with Google"',
    ]);
    await engine.click(2);
    expect(opOf(t.actionEvals()[0]!)).toEqual({ op: 'click', node: 2, label: 'Sign in' });
    expect((await engine.find('zzz', 2)).split('\n')).toEqual([
      'no match for "zzz"; first 2 of 3 elements:',
      '[1] link "Sign in with Google"',
      '[2] button "Sign in"',
    ]);
  });

  it('extracts title, url and text', async () => {
    expect(await engine.extract(100)).toBe('T\nhttps://x.test/\n\nhello');
    expect(t.evals[0]!.js).toContain('const max = 100;');
    t.extract = 'oops';
    await expect(engine.extract()).rejects.toThrow('unexpected page result: oops');
  });
});

const TABS: TabInfo[] = [
  { windowId: '11', windowIndex: 1, tabKey: '101', tabIndex: 1, title: 'Inbox', url: 'https://mail.test/inbox', active: true },
  { windowId: '11', windowIndex: 1, tabKey: '102', tabIndex: 2, title: 'Docs', url: 'https://docs.test/a/b?x=1', active: false },
  { windowId: '12', windowIndex: 2, tabKey: '201', tabIndex: 1, title: 'News', url: 'https://news.test/', active: true },
];

describe('tabs, focus and open', () => {
  beforeEach(() => {
    t.tabList = TABS;
  });

  it('snapshot follows the user to another tab after a pin, once with a note (I6)', async () => {
    await engine.focus('docs');
    t.tabList = t.tabList.map((x) => ({ ...x, active: x.windowIndex === 1 ? x.tabKey === '101' : x.active }));
    const out = await engine.snapshot();
    expect(out.split('\n')[0]).toBe('note: following your current tab');
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '101' });
    const again = await engine.snapshot();
    expect(again).not.toContain('following your current tab');
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '101' });
  });

  it('snapshot and find keep the pin while the front tab is unchanged (I6)', async () => {
    await engine.focus('docs');
    const out = await engine.snapshot();
    expect(out).not.toContain('following');
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '102' });
    await engine.find('next');
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '102' });
  });

  it('find follows the user to another tab after a pin (I6)', async () => {
    await engine.focus('docs');
    t.tabList = t.tabList.map((x) => ({ ...x, active: x.windowIndex === 1 ? x.tabKey === '101' : x.active }));
    const out = await engine.find('next');
    expect(out.split('\n')[0]).toBe('note: following your current tab');
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '101' });
  });

  it('lists tabs with the browser header', async () => {
    expect(await engine.tabs()).toBe(
      [
        'browser: Google Chrome',
        '[w1-t1] (active) Inbox - https://mail.test/inbox',
        '[w1-t2] Docs - https://docs.test/a/b?x=1',
        '[w2-t1] (active) News - https://news.test/',
      ].join('\n'),
    );
  });

  it('focus pins the tab for later calls until it expires', async () => {
    const out = await engine.focus('w1-t2');
    expect(t.focused).toEqual([{ windowId: '11', tabKey: '102' }]);
    expect(out.split('\n')[0]).toBe('focused Docs - https://docs.test/a/b?x=1');
    expect(out).toContain('page: Sign up');
    await engine.snapshot();
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '102' });
    clock += 4 * 60_000;
    await engine.snapshot();
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '102' });
    clock += 5 * 60_000 + 1;
    await engine.snapshot();
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '102' }); // the front tab (focusing docs brought it to the front), not null
  });

  it('focus matches numbers, titles and urls; reset() drops the pin', async () => {
    await engine.focus(3);
    expect(t.focused.at(-1)).toEqual({ windowId: '12', tabKey: '201' });
    await engine.focus('docs');
    expect(t.focused.at(-1)).toEqual({ windowId: '11', tabKey: '102' });
    await engine.focus('https://news.test');
    expect(t.focused.at(-1)).toEqual({ windowId: '12', tabKey: '201' });
    await expect(engine.focus('nothing-like-this')).rejects.toThrow('No tab matching "nothing-like-this"');
    engine.reset();
    await engine.snapshot();
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '12', tabKey: '201' }); // the front tab (last focused), not null
  });

  it('no_tab clears the pin and throws the actionable message', async () => {
    await engine.focus('docs');
    t.fail = new BrowserAutomationError('no_tab', 'Google Chrome', 'The target tab is gone. Call browser_tabs and focus a tab again.');
    await expect(engine.snapshot()).rejects.toThrow('The target tab is gone.');
    t.fail = null;
    await engine.snapshot();
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '102' }); // the front tab (focusing docs brought it to the front), not null
  });

  it('open reuses a tab with the same url without navigating it', async () => {
    const out = await engine.open('https://docs.test/a/b?x=1');
    expect(t.opened).toHaveLength(0);
    expect(t.focused).toEqual([{ windowId: '11', tabKey: '102' }]);
    expect(t.evals.filter((e) => e.js.includes('location.href = '))).toHaveLength(0);
    expect(out.split('\n')[0]).toBe('opened https://docs.test/a/b?x=1 (reused tab)');
  });

  it('open navigates a same-path tab whose query differs instead of creating a tab', async () => {
    const out = await engine.open('https://docs.test/a/b/?x=2');
    expect(t.opened).toHaveLength(0);
    expect(t.focused).toEqual([{ windowId: '11', tabKey: '102' }]);
    const nav = t.evals.filter((e) => e.js.includes('location.href = '));
    expect(nav).toHaveLength(1);
    expect(nav[0]!.target).toEqual({ windowId: '11', tabKey: '102' });
    expect(nav[0]!.js).toContain('"https://docs.test/a/b/?x=2"');
    expect(out.split('\n')[0]).toBe('opened https://docs.test/a/b/?x=2 (reused tab)');
  });

  it('open navigates an SPA tab whose url differs only by hash', async () => {
    t.tabList = [{ windowId: '11', windowIndex: 1, tabKey: '101', tabIndex: 1, title: 'App', url: 'https://app.test/#/home', active: true }];
    await engine.open('https://app.test/#/settings');
    expect(t.opened).toHaveLength(0);
    expect(t.evals.filter((e) => e.js.includes('location.href = '))).toHaveLength(1);
  });

  it('open ignores the tab hash when the requested url has none', async () => {
    t.tabList = [{ windowId: '11', windowIndex: 1, tabKey: '101', tabIndex: 1, title: 'Doc', url: 'https://d.test/x/#top', active: true }];
    await engine.open('https://d.test/x');
    expect(t.evals.filter((e) => e.js.includes('location.href = '))).toHaveLength(0);
  });

  it('open creates a tab in the front window and pins it', async () => {
    t.tabListAfterOpen = [
      { ...TABS[0]!, active: false },
      TABS[1]!,
      { windowId: '11', windowIndex: 1, tabKey: '103', tabIndex: 3, title: 'New', url: 'https://new.test/', active: true },
      TABS[2]!,
    ];
    const out = await engine.open('https://new.test/');
    expect(t.opened).toEqual([{ url: 'https://new.test/', windowId: '11' }]);
    expect(out.split('\n')[0]).toBe('opened https://new.test/');
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '103' });
  });

  it('open refuses unsafe schemes before touching the browser', async () => {
    for (const url of ['javascript:alert(1)', 'chrome://settings', 'about:config', 'vbscript:x']) {
      await expect(engine.open(url)).rejects.toThrow(/^Refusing to open [a-z]+: URLs$/);
    }
    expect(t.envCalls).toBe(0);
    expect(t.evals).toHaveLength(0);
    expect(t.opened).toHaveLength(0);
  });
});

describe('open url allow-list (fix round 1)', () => {
  it('rejects control characters, whitespace and disallowed schemes', () => {
    for (const url of ['java\tscript:alert(1)', 'java\nscript:alert(1)', '\u0001javascript:alert(1)', 'a b.com']) {
      expect(() => normalizeOpenUrl(url)).toThrow('Refusing to open a URL containing whitespace or control characters');
    }
    expect(() => normalizeOpenUrl('JaVaScRiPt:alert(1)')).toThrow('Refusing to open javascript: URLs');
    expect(() => normalizeOpenUrl('vbscript:x')).toThrow('Refusing to open vbscript: URLs');
    expect(() => normalizeOpenUrl('about:config')).toThrow('Refusing to open about: URLs');
  });

  it('normalises missing schemes and keeps allowed URLs', () => {
    expect(normalizeOpenUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeOpenUrl('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
    expect(normalizeOpenUrl('example.com:8080/x')).toBe('https://example.com:8080/x');
    expect(normalizeOpenUrl('example.com')).toBe('https://example.com');
    expect(normalizeOpenUrl('  www.x.org/path ')).toBe('https://www.x.org/path');
    expect(normalizeOpenUrl('data:text/html,<p>x</p>')).toBe('data:text/html,<p>x</p>');
    expect(normalizeOpenUrl('about:blank')).toBe('about:blank');
    expect(normalizeOpenUrl('file:///tmp/a.html')).toBe('file:///tmp/a.html');
    expect(normalizeOpenUrl('HTTPS://Example.com/A')).toBe('HTTPS://Example.com/A');
  });

  it('handles bare localhost, IDN hosts, bad ports and explains whitespace (final fix pass)', () => {
    expect(normalizeOpenUrl('localhost')).toBe('http://localhost');
    expect(normalizeOpenUrl('localhost/x')).toBe('http://localhost/x');
    expect(normalizeOpenUrl('https://bücher.de/x')).toBe('https://bücher.de/x');
    expect(normalizeOpenUrl('bücher.de')).toBe('https://bücher.de');
    expect(new URL(normalizeOpenUrl('bücher.de')).host).toBe('xn--bcher-kva.de');
    expect(() => normalizeOpenUrl('example.com:8080abc')).toThrow(/^Not a valid URL: example\.com:8080abc$/);
    expect(() => normalizeOpenUrl('a b.com')).toThrow(
      'Refusing to open a URL containing whitespace or control characters (spaces and control characters must be percent-encoded)',
    );
    expect(() => normalizeOpenUrl('javascript:alert(1)')).toThrow('Refusing to open javascript: URLs');
    expect(() => normalizeOpenUrl('localhost:javascript:alert(1)')).toThrow();
  });

  it('the engine transports nothing for a rejected URL and opens the normalised one', async () => {
    t.tabList = [];
    for (const url of ['java\tscript:alert(1)', 'java\nscript:alert(1)', '\u0001javascript:alert(1)', 'JaVaScRiPt:alert(1)']) {
      await expect(engine.open(url)).rejects.toThrow(/^Refusing to open/);
    }
    expect(t.envCalls).toBe(0);
    expect(t.evals).toHaveLength(0);
    await engine.open('localhost:3000');
    expect(t.opened[0]!.url).toBe('http://localhost:3000');
  });
});

describe('concrete tab targets (fix round 1)', () => {
  const FRONT: TabInfo[] = [
    { windowId: '12', windowIndex: 2, tabKey: '201', tabIndex: 1, title: 'Other', url: 'https://o.test/', active: true },
    { windowId: '11', windowIndex: 1, tabKey: '101', tabIndex: 1, title: 'A', url: 'https://a.test/', active: false },
    { windowId: '11', windowIndex: 1, tabKey: '102', tabIndex: 2, title: 'B', url: 'https://b.test/', active: true },
  ];

  it('resolves the front window active tab before the snapshot (environment, listTabs, evaluate)', async () => {
    t.tabList = FRONT;
    const order: string[] = [];
    const env = t.environment.bind(t);
    const list = t.listTabs.bind(t);
    const ev = t.evaluate.bind(t);
    t.environment = async () => { order.push('environment'); return env(); };
    t.listTabs = async () => { order.push('listTabs'); return list(); };
    t.evaluate = async (b, target, js) => { order.push('evaluate'); return ev(b, target, js); };
    await engine.snapshot();
    expect(order).toEqual(['environment', 'listTabs', 'evaluate']);
    expect(t.evals[0]!.target).toEqual({ windowId: '11', tabKey: '102' });
  });

  it('an action targets the snapshot tab even after the user switches tabs', async () => {
    t.tabList = FRONT;
    await engine.snapshot();
    t.tabList = FRONT.map((x) => ({ ...x, active: x.tabKey === '101' || x.tabKey === '201' }));
    await engine.click(12);
    const action = t.evals.find((e) => e.js.includes('const op = '))!;
    expect(action.target).toEqual({ windowId: '11', tabKey: '102' });
    for (const e of t.evals) expect(e.target).toEqual({ windowId: '11', tabKey: '102' });
    await engine.snapshot();
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '101' });
  });

  it('extract reads the snapshot tab after the user switches tabs, else a concrete front tab', async () => {
    t.tabList = FRONT;
    await engine.extract();
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '102' });
    await engine.snapshot();
    t.tabList = FRONT.map((x) => ({ ...x, active: x.tabKey === '101' || x.tabKey === '201' }));
    await engine.extract();
    const ex = t.evals.at(-1)!;
    expect(ex.js).toContain('const max = ');
    expect(ex.target).toEqual({ windowId: '11', tabKey: '102' });
  });

  it('falls back to the front tab with an origin guard when listTabs fails', async () => {
    t.listTabs = async () => { throw new Error('boom'); };
    t.snapshots = [JSON.stringify(page({ page_key: [1234.5, 'x'] }))];
    await engine.snapshot();
    expect(t.evals[0]!.target).toBeNull();
    await engine.click(12);
    expect(opOf(t.actionEvals()[0]!)).toEqual({ op: 'click', node: 12, label: 'Next', origin: 1234.5 });
  });

  it('every action carries the snapshot origin', async () => {
    t.tabList = FRONT;
    t.snapshots = [JSON.stringify(page({ page_key: [99, 'x'] }))];
    await engine.snapshot();
    await engine.do([{ op: 'type', index: 7, text: 'a' }, { op: 'scroll', delta: 5 }]);
    expect(t.actionEvals().map((js) => opOf(js).origin)).toEqual([99, 99]);
  });
});

describe('slow navigation (fix round 1)', () => {
  const OLD = JSON.stringify(page({ page_key: [1, 'x'] }));
  const NEW = JSON.stringify(page({ url: 'https://example.com/welcome', title: 'Welcome', page_key: [2, 'x'] }));
  const probe = (u: string, r: string, t: string, o: number, p: boolean): string => JSON.stringify({ u, r, t, o, p });
  const oldPending = probe('https://example.com/signup', 'complete', 'Sign up', 1, true);
  const newLoading = probe('https://example.com/welcome', 'loading', 'Welcome', 2, false);
  const newDone = probe('https://example.com/welcome', 'complete', 'Welcome', 2, false);

  /** Snapshots show the old page until the scripted probes are used up. */
  function scriptNavigation(probes: string[]): void {
    t.probes = probes;
    t.snapshots = [() => (t.probes.length > 0 ? OLD : NEW)];
  }

  it('waits through a pending navigation and renders the new page', async () => {
    t.snapshots = [OLD];
    await engine.snapshot();
    scriptNavigation([oldPending, oldPending, newLoading, newDone, newDone]);
    const out = await engine.click(12);
    expect(t.probes).toHaveLength(0);
    expect(out).toContain('page: Welcome — https://example.com/welcome');
    expect(out).not.toContain('(same page)');
    // initial snapshot + the rejected combined read + the snapshot after the slow wait
    expect(t.snapshotEvals()).toBe(3);
  });

  it('notes a navigation that is still pending at the cap', async () => {
    t.snapshots = [OLD];
    await engine.snapshot();
    t.probes = Array.from({ length: 100 }, () => oldPending);
    const out = await engine.click(12);
    expect(out.endsWith('note: page is still navigating')).toBe(true);
  });

  it('do stops after a click whose navigation has not committed yet', async () => {
    t.snapshots = [OLD];
    await engine.snapshot();
    scriptNavigation([oldPending, newLoading, newDone, newDone]);
    const out = await engine.do([
      { op: 'click', index: 12 },
      { op: 'type', index: 7, text: 'never' },
    ]);
    expect(t.actionEvals()).toHaveLength(1);
    const lines = out.split('\n');
    expect(lines[1]).toBe('step 1 click ok but the page navigated; remaining steps not run');
    expect(out).toContain('page: Welcome — https://example.com/welcome');
  });

  it('do treats press "enter" case-insensitively and ignores hash-only changes', async () => {
    t.snapshots = [OLD];
    await engine.snapshot();
    t.probes = [probe('https://example.com/signup#step2', 'complete', 'Sign up', 1, false)];
    await engine.do([{ op: 'press', key: 'enter' }, { op: 'scroll', delta: 10 }]);
    expect(t.actionEvals()).toHaveLength(2);
    t.probes = [probe('https://example.com/signup?page=2', 'complete', 'Sign up', 1, false)];
    const out = await engine.do([{ op: 'press', key: 'enter' }, { op: 'scroll', delta: 10 }]);
    expect(out).toContain('step 1 press ok but the page navigated');
  });

  /** Evaluates the real probe source against a page whose unload flag was set `ageMs` ago. */
  function probeWithFlag(ageMs: number): (js: string) => string {
    return (js) => {
      const win = { __rhNavPending: Date.now() - ageMs };
      const loc = { href: 'https://example.com/signup' };
      const doc = { readyState: 'complete', title: 'Sign up' };
      const perf = { timeOrigin: 1 };
      return new Function('window', 'location', 'document', 'performance', `return ${js};`)(win, loc, doc, perf) as string;
    };
  }

  it('a stale navigation flag (set seconds earlier) causes no 3 s wait and no navigating note', async () => {
    t.snapshots = [OLD];
    await engine.snapshot();
    t.probes = Array.from({ length: 100 }, () => probeWithFlag(5000));
    const start = clock;
    const out = await engine.click(12);
    expect(clock - start).toBeLessThan(1000);
    expect(out).not.toContain('still navigating');
    expect(out).not.toContain('still loading');
  });

  it('do does not abort on a navigation flag set seconds earlier; a fresh flag still stops it', async () => {
    t.snapshots = [OLD];
    await engine.snapshot();
    t.probes = Array.from({ length: 100 }, () => probeWithFlag(5000));
    const out = await engine.do([{ op: 'click', index: 12 }, { op: 'type', index: 7, text: 'x' }]);
    expect(t.actionEvals()).toHaveLength(2);
    expect(out).not.toContain('navigated');
    t.probes = [probeWithFlag(100), ...Array.from({ length: 100 }, () => probeWithFlag(5000))];
    const out2 = await engine.do([{ op: 'click', index: 12 }, { op: 'type', index: 7, text: 'x' }]);
    expect(out2).toContain('step 1 click ok but the page navigated');
  });

  it('open keeps waiting while the new tab is about:blank', async () => {
    t.tabList = [];
    t.tabListAfterOpen = [{ windowId: '11', windowIndex: 1, tabKey: '103', tabIndex: 1, title: 'Welcome', url: 'about:blank', active: true }];
    const blank = probe('about:blank', 'complete', '', 5, false);
    scriptNavigation([blank, blank, blank, newLoading, newDone, newDone]);
    const out = await engine.open('https://example.com/welcome');
    expect(t.probes).toHaveLength(0);
    expect(out).toContain('page: Welcome — https://example.com/welcome');
  });
});

describe('do failure context (fix round 1)', () => {
  it('appends the current state when a later step fails', async () => {
    await engine.snapshot();
    const after = page();
    (after.actions as Array<Record<string, unknown>>)[0] = { node: 7, role: 'textbox', label: 'Email', kind: 'fill', value: 'a@b.c' };
    t.snapshots = [JSON.stringify(after)];
    t.actions = [JSON.stringify({ ok: true }), JSON.stringify({ ok: false, error: 'stale' })];
    const err = await engine.do([{ op: 'type', index: 7, text: 'a@b.c' }, { op: 'click', index: 12 }]).catch((e: Error) => e);
    expect((err as Error).message).toBe(
      [
        'step 2 click failed: Element [12] no longer on the page. Call browser_snapshot. (step 1 ok)',
        'current state:',
        'browser: Google Chrome · page: Sign up — https://example.com/signup (same page)',
        '~ [7] textbox "Email" = "a@b.c"',
        '(4 unchanged)',
      ].join('\n'),
    );
  });

  it('passes the page guard message through and never prints [?]', async () => {
    await engine.snapshot();
    const guard = JSON.stringify({ ok: false, error: 'stale', message: 'page changed since the snapshot' });
    t.actions = [guard];
    await expect(engine.click(12)).rejects.toThrow(/^Element \[12\]: page changed since the snapshot\. Call browser_snapshot\.$/);
    t.actions = [guard];
    const err = await engine.do([{ op: 'press', key: 'Tab' }]).catch((e: Error) => e);
    expect((err as Error).message).toBe(
      'step 1 press failed: The press target: page changed since the snapshot. Call browser_snapshot. (no steps ok)',
    );
    t.actions = [JSON.stringify({ ok: false, error: 'stale' })];
    const err2 = await engine.do([{ op: 'scroll', delta: 5 }]).catch((e: Error) => e);
    expect((err2 as Error).message).not.toContain('[?]');
    expect((err2 as Error).message).toContain('The scroll target no longer on the page');
    t.actions = [JSON.stringify({ ok: false, error: 'changed', current: 'Back', message: 'label differs' })];
    await expect(engine.click(12)).rejects.toThrow('Element [12]: label differs. Call browser_snapshot.');
  });

  it('does not append state when the first step fails', async () => {
    await engine.snapshot();
    t.actions = [JSON.stringify({ ok: false, error: 'stale' })];
    await expect(engine.do([{ op: 'click', index: 12 }])).rejects.toThrow(/^step 1 click failed: .*\(no steps ok\)$/s);
  });

  it('wraps a navigation-probe failure with the step context and drops the pin on no_tab', async () => {
    t.tabList = TABS;
    await engine.focus('docs');
    t.probes = [new BrowserAutomationError('no_tab', 'Google Chrome', 'The target tab is gone.')];
    await expect(engine.do([{ op: 'click', index: 12 }, { op: 'scroll', delta: 1 }])).rejects.toThrow(
      'step 1 click ran, but checking the page afterwards failed: The target tab is gone. (step 1 ok)',
    );
    await engine.snapshot();
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '102' }); // the front tab (focusing docs brought it to the front), not null
  });

  it('a probe failure after a later step counts that step as ok', async () => {
    await engine.snapshot();
    t.probes = [new BrowserAutomationError('js_disabled', 'Google Chrome', 'JavaScript from Apple Events is off.')];
    const err = await engine
      .do([{ op: 'type', index: 7, text: 'a' }, { op: 'click', index: 12 }, { op: 'scroll', delta: 1 }])
      .catch((e: Error) => e);
    expect((err as Error).message.split('\n')[0]).toBe(
      'step 2 click ran, but checking the page afterwards failed: JavaScript from Apple Events is off. (steps 1-2 ok)',
    );
  });
});

describe('open reuse waits for the new document (fix round 1)', () => {
  it('keeps polling while the reused tab still shows the old document', async () => {
    t.tabList = TABS;
    const ev = t.evaluate.bind(t);
    t.evaluate = async (b, target, js) => (js.includes('location.href = ') ? (t.evals.push({ browser: b.name, target, js }), JSON.stringify({ ok: true, o: 1 })) : ev(b, target, js));
    const pr = (o: number, u: string): string => JSON.stringify({ u, r: 'complete', t: 'Docs', o, p: false });
    t.probes = [pr(1, 'https://docs.test/a/b?x=1'), pr(1, 'https://docs.test/a/b?x=1'), pr(2, 'https://docs.test/a/b?x=2'), pr(2, 'https://docs.test/a/b?x=2')];
    await engine.open('https://docs.test/a/b?x=2');
    expect(t.probes).toHaveLength(0);
  });
});

describe('render hygiene (fix round 1)', () => {
  it('find renders a matching select with its full option list', async () => {
    const actions = Array.from({ length: 12 }, (_, i) => ({ node: 4, role: 'combobox', kind: 'select', label: `Place → P${i}`, value: `${i}`, current_value: 'Home' }));
    t.snapshots = [JSON.stringify(page({ actions }))];
    const out = await engine.find('p11');
    expect(out.split('\n')[1]).toBe(`[4] select "Place" = "Home" options: Home | ${Array.from({ length: 12 }, (_, i) => `P${i}`).join(' | ')}`);
  });

  it('tabs output strips control characters from titles', async () => {
    t.tabList = [{ windowId: '1', windowIndex: 1, tabKey: '1', tabIndex: 1, title: 'Evil\nline\u0007', url: 'https://e.test/', active: true }];
    expect(await engine.tabs()).toBe('browser: Google Chrome\n[w1-t1] (active) Evil line - https://e.test/');
  });
});
