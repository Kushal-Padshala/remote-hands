import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FastBrowserEngine, normalizeOpenUrl } from './engine.js';
import { BrowserAutomationError, type TabTarget } from './applescript.js';
import type { TabInfo } from './transport.js';
import type { BrowserApp } from './browsers.js';
import type { BrowserPort, DoStep } from './port.js';
import { buildReadyProbe, buildSnapshotWithProbe } from './page-scripts.js';
import { runInCallScope } from '../computer/call-scope.js';

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

  it('asks the gate with the label before clicking, and a rejection stops the click', async () => {
    const asked: string[] = [];
    const gated = new FastBrowserEngine({
      transport: t,
      legacy,
      env: {},
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      gate: async (label) => {
        asked.push(label);
        throw new Error('Approval rejected by user: not yet.');
      },
    });
    await gated.snapshot();
    await expect(gated.click(12)).rejects.toThrow('Approval rejected by user: not yet.');
    await expect(gated.do([{ op: 'type', index: 7, text: 'a' }, { op: 'click', index: 12 }])).rejects.toThrow(
      /step 2 click failed: Approval rejected/,
    );
    expect(asked).toEqual(['Next', 'Next']);
    // Only the type step reached the page.
    expect(t.actionEvals().map((js) => opOf(js).op)).toEqual(['type']);
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
        `note: fast browser path unavailable (msg-${code}); using the slower fallback.\nlegacy:snapshot`,
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
    await expect(engine.do([{ op: 'drag' as DoStep['op'] }])).rejects.toThrow('step 1 drag invalid: unknown op');
    await expect(engine.do(Array.from({ length: 31 }, () => ({ op: 'wait' as const, ms: 1 })))).rejects.toThrow('at most 30 steps');
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

  it('pages a long page: caps one call, asks the script for offset + window, names the next offset', async () => {
    const body = 'abcdefghij'.repeat(500);
    t.extract = JSON.stringify({ title: 'T', url: 'https://x.test/', text: `${body.slice(0, 3000)}\u2026`, more: true });
    const first = await engine.extract(20000);
    expect(t.evals.at(-1)!.js).toContain('const max = 3000;');
    expect(first).toContain('\n\nabcdefghij');
    expect(first.endsWith('… more text on this page: call browser_extract with offset=3000')).toBe(true);
    t.extract = JSON.stringify({ title: 'T', url: 'https://x.test/', text: body, more: false });
    const second = await engine.extract(2000, 3000);
    expect(t.evals.at(-1)!.js).toContain('const max = 5000;');
    expect(second).toBe(`T\n(text from character 3000)\n\n${body.slice(3000, 5000)}`);
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

describe('self-healing at task time (autoEnable)', () => {
  function withAutoEnable(autoEnable: (b: any) => Promise<{ ok: boolean; message?: string }>): FastBrowserEngine {
    return new FastBrowserEngine({
      transport: t,
      legacy,
      env: {},
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      autoEnable,
    });
  }
  const off = () => new BrowserAutomationError('js_disabled', 'Google Chrome', 'JS off in Chrome.');

  it('switches the setting on, retries the fast path and says so once', async () => {
    const auto = vi.fn(async () => {
      t.fail = null;
      return { ok: true };
    });
    engine = withAutoEnable(auto);
    t.fail = off();
    const first = await engine.snapshot();
    expect(first.startsWith('note: switched on fast browser control for this profile (one-time).\n')).toBe(true);
    expect(first).toContain('page: Sign up');
    expect(legacy.calls).toEqual([]);
    expect(auto).toHaveBeenCalledTimes(1);
    expect((auto.mock.calls[0] as unknown[])[0]).toMatchObject({ name: 'Google Chrome' });
    expect(await engine.snapshot()).not.toContain('switched on');
  });

  it('falls back with the reason when the automatic setup fails, and does not retry for 10 minutes', async () => {
    const auto = vi.fn(async () => ({ ok: false, message: 'Accessibility denied' }));
    engine = withAutoEnable(auto);
    t.fail = off();
    const out = await engine.snapshot();
    expect(out).toContain('automatic setup failed: Accessibility denied');
    expect(out).toContain('legacy:snapshot');
    clock += 61_000; // the 60 s availability cache expires, the 10 minute auto-retry guard does not
    await engine.snapshot();
    expect(auto).toHaveBeenCalledTimes(1);
    clock += 10 * 60_000;
    await engine.snapshot();
    expect(auto).toHaveBeenCalledTimes(2);
  });

  it('does not loop when the setting is still off after a reported success', async () => {
    const auto = vi.fn(async () => ({ ok: true }));
    engine = withAutoEnable(auto);
    t.fail = off();
    const out = await engine.snapshot();
    expect(auto).toHaveBeenCalledTimes(1);
    expect(out).toContain('legacy:snapshot');
  });

  it('is only used for js_disabled (not for denied automation) and never when no hook is given', async () => {
    const auto = vi.fn(async () => ({ ok: true }));
    engine = withAutoEnable(auto);
    t.fail = new BrowserAutomationError('automation_denied', 'Google Chrome', 'denied');
    await engine.snapshot();
    expect(auto).not.toHaveBeenCalled();
    const plain = make();
    t.fail = off();
    expect(await plain.snapshot()).toContain('legacy:snapshot');
  });
});

describe('do: label targets, hover and limits', () => {
  const twoSaves = (): string =>
    JSON.stringify(page({ actions: [
      { node: 21, role: 'button', label: 'Save', kind: 'click', value: '' },
      { node: 22, role: 'button', label: 'Save', kind: 'click', value: '' },
      { node: 23, role: 'button', label: 'Next steps', kind: 'click', value: '' },
      { node: 24, role: 'button', label: 'Next', kind: 'click', value: '' },
    ] }));

  it('resolves labels against the last shown page and sends the stable ids', async () => {
    await engine.snapshot();
    await engine.do([
      { op: 'type', target: 'email', text: 'a@b.c' },
      { op: 'select', target: 'country', value: 'Canada' },
      { op: 'check', target: 'I agree', checked: true },
      { op: 'click', target: 'Next' },
    ]);
    expect(t.actionEvals().map(opOf)).toEqual([
      { op: 'type', node: 7, label: 'Email', text: 'a@b.c' },
      { op: 'select', node: 3, label: 'Country', value: 'Canada' },
      { op: 'check', node: 9, label: 'I agree', checked: true },
      { op: 'click', node: 12, label: 'Next' },
    ]);
  });

  it('takes its own snapshot first when no page has been shown yet', async () => {
    const out = await engine.do([{ op: 'click', target: 'Next' }]);
    expect(t.actionEvals().map(opOf)).toEqual([{ op: 'click', node: 12, label: 'Next' }]);
    expect(t.snapshotEvals()).toBeGreaterThanOrEqual(2);
    expect(out.split('\n')[0]).toBe('did: click');
  });

  it('prefers the exact label over a longer one', async () => {
    t.snapshots = [twoSaves()];
    await engine.snapshot();
    await engine.do([{ op: 'click', target: 'next' }]);
    expect(t.actionEvals().map(opOf)).toEqual([{ op: 'click', node: 24, label: 'Next' }]);
  });

  it('refuses an ambiguous or unknown label before running any step', async () => {
    t.snapshots = [twoSaves()];
    await engine.snapshot();
    const before = t.actionEvals().length;
    await expect(engine.do([{ op: 'click', target: 'Save' }])).rejects.toThrow(
      'step 1 click invalid: target "Save" is ambiguous (matches [21] button "Save", [22] button "Save"); use index. No steps were run.',
    );
    await expect(engine.do([{ op: 'click', target: 'Pay' }])).rejects.toThrow('step 1 click invalid: no element matches target "Pay"');
    expect(t.actionEvals()).toHaveLength(before);
  });

  it('rejects index together with target, and a step with neither', async () => {
    await engine.snapshot();
    await expect(engine.do([{ op: 'click', index: 12, target: 'Next' }])).rejects.toThrow(
      'step 1 click invalid: give either index or target, not both. No steps were run.',
    );
    await expect(engine.do([{ op: 'click' }])).rejects.toThrow('step 1 click invalid: index or target is required. No steps were run.');
  });

  it('sends hover with the stable id', async () => {
    await engine.snapshot();
    await engine.do([{ op: 'hover', index: 12 }, { op: 'hover', target: 'Next' }]);
    expect(t.actionEvals().map(opOf)).toEqual([
      { op: 'hover', node: 12, label: 'Next' },
      { op: 'hover', node: 12, label: 'Next' },
    ]);
  });

  it('accepts 30 steps', async () => {
    await engine.snapshot();
    const out = await engine.do(Array.from({ length: 30 }, () => ({ op: 'wait' as const, ms: 0 })));
    expect(out.split('\n')[0]!.startsWith('did: wait, wait')).toBe(true);
  });

  it('uses the legacy port (no snapshot of its own) when no supported browser runs', async () => {
    t.env = { frontmost: 'Finder', running: [] };
    expect(await engine.do([{ op: 'click', target: 'Next' }])).toBe('legacy:do');
    expect(t.evals).toHaveLength(0);
  });
});

describe('action hints', () => {
  const NOTE = 'note: that link opens in a new tab; if the page did not change, use browser_tabs then browser_focus to switch to it';

  it('browser_click adds the new-tab note after the state', async () => {
    await engine.snapshot();
    t.actions = [JSON.stringify({ ok: true, label: 'Next', opened: true })];
    const out = await engine.click(12);
    expect(out.split('\n')[0]).toBe('clicked [12] Next');
    expect(out.split('\n').at(-1)).toBe(NOTE);
  });

  it('browser_click adds nothing for ordinary clicks', async () => {
    await engine.snapshot();
    expect(await engine.click(12)).not.toContain('new tab');
  });

  it('browser_do reports the new-tab note once and the last focus move', async () => {
    await engine.snapshot();
    t.actions = [
      JSON.stringify({ ok: true, opened: true }),
      JSON.stringify({ ok: true, focused: 'Second' }),
      JSON.stringify({ ok: true, focused: 'Go "now"' }),
    ];
    const out = await engine.do([
      { op: 'hover', index: 12 },
      { op: 'press', key: 'Tab' },
      { op: 'press', key: 'Tab' },
    ]);
    const lines = out.split('\n');
    expect(lines.filter((l) => l === NOTE)).toHaveLength(1);
    expect(lines.at(-1)).toBe('tab moved focus to: "Go \\"now\\""');
  });

  it('drops the focus line when any later step (hover, another key) could have moved focus', async () => {
    await engine.snapshot();
    t.actions = [JSON.stringify({ ok: true, focused: 'Second' }), JSON.stringify({ ok: true })];
    expect(await engine.do([{ op: 'press', key: 'Tab' }, { op: 'hover', index: 12 }])).not.toContain('tab moved focus to');
    t.actions = [JSON.stringify({ ok: true, focused: 'Second' }), JSON.stringify({ ok: true })];
    expect(await engine.do([{ op: 'press', key: 'Tab' }, { op: 'press', key: 'Escape' }])).not.toContain('tab moved focus to');
    t.actions = [JSON.stringify({ ok: true, focused: 'Second' }), JSON.stringify({ ok: true })];
    expect(await engine.do([{ op: 'press', key: 'Tab' }, { op: 'scroll', delta: 100 }])).toContain('tab moved focus to: "Second"');
  });
});

describe('do: a label that an earlier step reveals', () => {
  const base = (extra: Array<Record<string, unknown>> = []): string =>
    JSON.stringify(page({ actions: [{ node: 1, role: 'button', label: 'Add option', kind: 'click', value: '' }, ...extra] }));
  const field = { node: 2, role: 'textbox', label: 'textbox', kind: 'fill', value: '' };

  it('types into a field the click just revealed, in one call', async () => {
    t.snapshots = [base(), base(), base([field])];
    await engine.snapshot();
    const out = await engine.do([{ op: 'click', target: 'Add option' }, { op: 'type', target: 'textbox', text: 'hi' }]);
    expect(t.actionEvals().map(opOf)).toEqual([
      { op: 'click', node: 1, label: 'Add option' },
      { op: 'type', node: 2, label: 'textbox', text: 'hi' },
    ]);
    expect(out.split('\n')[0]).toBe('did: click, type');
  });

  it('waits for a field that renders a moment after the click', async () => {
    t.snapshots = [base(), base(), base(), base(), base([field])];
    await engine.snapshot();
    await engine.do([{ op: 'click', target: 'Add option' }, { op: 'type', target: 'textbox', text: 'hi' }]);
    expect(t.actionEvals().map(opOf)[1]).toEqual({ op: 'type', node: 2, label: 'textbox', text: 'hi' });
  });

  it('stops with the usual failure when the field never shows up, after the click that ran', async () => {
    t.snapshots = [base()];
    await engine.snapshot();
    const err = await engine.do([{ op: 'click', target: 'Add option' }, { op: 'type', target: 'textbox', text: 'hi' }]).catch((e: Error) => e);
    expect(String((err as Error).message)).toContain('step 2 type failed: no text field matches target "textbox"');
    expect(String((err as Error).message)).not.toContain('No steps were run');
    expect(t.actionEvals().map(opOf)).toEqual([{ op: 'click', node: 1, label: 'Add option' }]);
  });

  it('runs no deferred step once the call was abandoned or out of time while it looked for the field', async () => {
    await engine.snapshot();
    let abort!: () => void;
    t.snapshots = [base(), (): string => { abort(); return base([field]); }];
    const call = runInCallScope(() => engine.do([{ op: 'click', target: 'Add option' }, { op: 'type', target: 'textbox', text: 'hi' }]));
    abort = call.abort;
    await expect(call.result).rejects.toThrow('step 2 type failed: this call was abandoned after the tool timed out; remaining steps not run');
    expect(t.actionEvals().map(opOf)).toEqual([{ op: 'click', node: 1, label: 'Add option' }]);

    t.evals.length = 0;
    t.snapshots = [base(), base(), (): string => { clock += 61_000; return base([field]); }];
    await engine.snapshot();
    await expect(engine.do([{ op: 'click', target: 'Add option' }, { op: 'type', target: 'textbox', text: 'hi' }])).rejects.toThrow(
      'step 2 type failed:',
    );
    expect(t.actionEvals().map(opOf)).toEqual([{ op: 'click', node: 1, label: 'Add option' }]);
  });

  it('does not type into a field on another address that the click moved the page to', async () => {
    const elsewhere = JSON.stringify(page({ url: 'https://example.com/other', actions: [field] }));
    t.snapshots = [base(), base(), elsewhere];
    await engine.snapshot();
    // the click's own navigation check still sees the old address (the route changes a moment later)
    t.probes = [JSON.stringify({ r: 'complete', p: false, o: null, u: 'https://example.com/signup', t: 'Sign up' })];
    const out = await engine.do([{ op: 'click', target: 'Add option' }, { op: 'type', target: 'textbox', text: 'hi' }]);
    expect(t.actionEvals().map(opOf)).toEqual([{ op: 'click', node: 1, label: 'Add option' }]);
    expect(out).toContain('step 2 type not run: the page changed to a different document or address');
  });

  it('still refuses before running anything when the label is of the wrong kind or the step is incomplete', async () => {
    t.snapshots = [base()];
    await engine.snapshot();
    await expect(engine.do([{ op: 'click', target: 'Add option' }, { op: 'type', target: 'Add option', text: 'x' }])).rejects.toThrow(
      'step 2 type invalid: target "Add option" is not a text field here',
    );
    await expect(engine.do([{ op: 'click', target: 'Add option' }, { op: 'type', target: 'textbox' }])).rejects.toThrow(
      'step 2 type invalid: text is required. No steps were run.',
    );
    await expect(engine.do([{ op: 'type', target: 'textbox', text: 'x' }])).rejects.toThrow('step 1 type invalid: no text field matches target "textbox"');
    expect(t.actionEvals()).toHaveLength(0);
  });
});

describe('do: label safety (review fixes)', () => {
  const buttons = (n: number, extra: Record<string, unknown> = {}): string =>
    JSON.stringify(page({ actions: Array.from({ length: n }, (_, i) => ({ node: 100 + i, role: 'button', label: i === 0 ? 'Remove' : `Other ${i}`, kind: 'click', value: '' })), ...extra }));

  it('never rebinds numeric ids through an implicit snapshot when the batch also uses index', async () => {
    await expect(engine.do([{ op: 'type', target: 'Email', text: 'x' }, { op: 'click', index: 2 }])).rejects.toThrow(
      'step 1 type invalid: no page has been shown yet; call browser_snapshot first. No steps were run.',
    );
    await expect(engine.do([{ op: 'click', index: 2 }, { op: 'click', target: 'Next' }])).rejects.toThrow('step 1 click invalid: index 2 is not on the page I last showed');
    expect(t.evals).toHaveLength(0);
    expect(t.actionEvals()).toHaveLength(0);
  });

  it('refuses a label when the snapshot left controls out, so a hidden duplicate cannot be clicked by mistake', async () => {
    t.snapshots = [buttons(5, { omitted_actions: 1 })];
    await engine.snapshot();
    await expect(engine.do([{ op: 'click', target: 'Remove' }])).rejects.toThrow('a label cannot be proven unique');
    expect(t.actionEvals()).toHaveLength(0);
    await engine.do([{ op: 'click', index: 100 }]);
    expect(t.actionEvals().map(opOf)).toEqual([{ op: 'click', node: 100, label: 'Remove' }]);
  });

  it('refuses an exact label of the wrong kind, running nothing (no typing into a lookalike field, no Save)', async () => {
    t.snapshots = [JSON.stringify(page({ actions: [
      { node: 31, role: 'button', label: 'Email', kind: 'click', value: '' },
      { node: 32, role: 'textbox', label: 'Recovery email', kind: 'fill', value: '' },
      { node: 33, role: 'textbox', label: 'Recovery email', kind: 'click', value: '' },
      { node: 34, role: 'button', label: 'Save', kind: 'click', value: '' },
    ] }))];
    await engine.snapshot();
    await expect(engine.do([{ op: 'type', target: 'Email', text: 'new@example.test' }, { op: 'click', target: 'Save' }])).rejects.toThrow(
      'step 1 type invalid: target "Email" is not a text field here',
    );
    expect(t.actionEvals()).toHaveLength(0);
  });

  it('limits the total wait time of one call', async () => {
    await engine.snapshot();
    const wait = (ms: number) => ({ op: 'wait' as const, ms });
    await expect(engine.do(Array.from({ length: 7 }, () => wait(5000)))).rejects.toThrow(
      'browser_do waits add up to 35000 ms; the limit is 30000 ms per call. No steps were run.',
    );
    await expect(engine.do(Array.from({ length: 6 }, () => wait(5000)))).resolves.toContain('did: wait');
  });

  it('forgets an earlier Tab report once a later step moves focus itself', async () => {
    await engine.snapshot();
    t.actions = [JSON.stringify({ ok: true, focused: 'Second' }), JSON.stringify({ ok: true, label: 'Next' })];
    const out = await engine.do([{ op: 'press', key: 'Tab' }, { op: 'click', index: 12 }]);
    expect(out).not.toContain('tab moved focus to');
    t.actions = [JSON.stringify({ ok: true, label: 'Next' }), JSON.stringify({ ok: true, focused: 'Second' })];
    expect(await engine.do([{ op: 'click', index: 12 }, { op: 'press', key: 'Tab' }])).toContain('tab moved focus to: "Second"');
  });

  it('a first label call goes through the same automatic setup as browser_snapshot', async () => {
    const heal = vi.fn(async () => {
      t.fail = null;
      return { ok: true as const };
    });
    const healing = new FastBrowserEngine({
      transport: t, legacy, env: {}, now: () => clock, sleep: async (ms) => { clock += ms; }, autoEnable: heal,
    });
    t.fail = new BrowserAutomationError('js_disabled', 'Google Chrome', 'JS off in Chrome.');
    const out = await healing.do([{ op: 'click', target: 'Next' }]);
    expect(heal).toHaveBeenCalledTimes(1);
    expect(t.actionEvals().map(opOf)).toEqual([{ op: 'click', node: 12, label: 'Next' }]);
    expect(out.split('\n')[0]).toBe('did: click');
  });

  it('a first label call falls back to the slower path when setup is refused', async () => {
    const refuse = vi.fn(async () => ({ ok: false as const, message: 'declined' }));
    const stuck = new FastBrowserEngine({
      transport: t, legacy, env: {}, now: () => clock, sleep: async (ms) => { clock += ms; }, autoEnable: refuse,
    });
    t.fail = new BrowserAutomationError('js_disabled', 'Google Chrome', 'JS off in Chrome.');
    expect(await stuck.do([{ op: 'click', target: 'Next' }])).toBe('legacy:do');
    expect(t.actionEvals()).toHaveLength(0);
  });
});

describe('do and find: fresh labels, deadline, notes (review fixes)', () => {
  const save = (...nodes: number[]): string =>
    JSON.stringify(page({ actions: nodes.map((n) => ({ node: n, role: 'button', label: 'Save', kind: 'click', value: '' })) }));

  it('matches labels against a fresh look, so a second Save that appeared after the last state is seen', async () => {
    t.snapshots = [save(21)];
    await engine.snapshot();
    t.snapshots = [save(21, 22)];
    await expect(engine.do([{ op: 'click', target: 'Save' }])).rejects.toThrow(
      'step 1 click invalid: target "Save" is ambiguous (matches [21] button "Save", [22] button "Save"); use index. No steps were run.',
    );
    expect(t.actionEvals()).toHaveLength(0);
  });

  it('keeps numeric ids working after the fresh look when the element is still there', async () => {
    t.snapshots = [save(21, 22)];
    await engine.snapshot();
    await engine.do([{ op: 'click', index: 22 }, { op: 'wait', ms: 1 }]);
    t.snapshots = [save(21, 22)];
    await engine.do([{ op: 'click', index: 21 }]);
    expect(t.actionEvals().map(opOf).map((o) => o.node)).toEqual([22, 21]);
  });

  it('does not click after an approval wait that ran past the call deadline', async () => {
    const slow = new FastBrowserEngine({
      transport: t, legacy, env: {}, now: () => clock, sleep: async (ms) => { clock += ms; },
      gate: async () => { clock += 61_000; },
    });
    await slow.snapshot();
    await expect(slow.do([{ op: 'click', index: 12 }])).rejects.toThrow('this call ran out of time (60 s); the click was not performed');
    expect(t.actionEvals()).toHaveLength(0);
  });

  it('starts no new step once the call deadline has passed', async () => {
    await engine.snapshot();
    t.actions = [(): string => { clock += 61_000; return JSON.stringify({ ok: true, label: 'x' }); }];
    await expect(engine.do([{ op: 'check', index: 9, checked: true }, { op: 'click', index: 12 }])).rejects.toThrow(
      'step 2 click failed: this call ran out of time (60 s); remaining steps not run (step 1 ok)',
    );
    expect(t.actionEvals()).toHaveLength(1);
    // the deadline belongs to one call: the next call starts fresh
    await expect(engine.do([{ op: 'click', index: 12 }])).resolves.toContain('did: click');
  });

  it('browser_find repeats the notes about frames it cannot read and a page it could not read fully', async () => {
    t.snapshots = [JSON.stringify(page({ frames_blocked: 2, scan_truncated: true }))];
    const out = await engine.find('Next');
    expect(out).toContain('2 embedded frames cannot be read here');
    expect(out).toContain('note: this page is very large');
  });
});

describe('do: documents, deadlines and focus (round 3 fixes)', () => {
  const doc = (origin: number, nodes: Array<[number, string]>): string =>
    JSON.stringify(page({
      page_key: [origin],
      actions: nodes.map(([node, label]) => ({ node, role: 'button', label, kind: 'click', value: '' })),
    }));

  it('rejects a batch whose numeric ids belong to a document that has been replaced, and forgets the old ids', async () => {
    t.snapshots = [doc(1, [[1, 'Open details']])];
    await engine.snapshot();
    t.snapshots = [doc(2, [[1, 'Delete account'], [2, 'Menu']])]; // the page reloaded; numbering restarted
    await expect(engine.do([{ op: 'click', index: 1 }, { op: 'hover', target: 'Menu' }])).rejects.toThrow(
      'The page was reloaded or replaced since you last looked, so the ids you hold no longer apply. Call browser_snapshot. No steps were run.',
    );
    expect(t.actionEvals()).toHaveLength(0);
    // the old ids must not land on the new page afterwards either
    await expect(engine.click(1)).rejects.toThrow('not on the page I last showed');
    expect(t.actionEvals()).toHaveLength(0);
  });

  it('describes a label batch relative to what the model last saw, so a replaced page shows up as changed', async () => {
    t.snapshots = [doc(1, [[1, 'Open details']])];
    await engine.snapshot();
    t.snapshots = [JSON.stringify(page({ url: 'https://example.com/other', title: 'Other', page_key: [2], actions: [{ node: 1, role: 'button', label: 'Menu', kind: 'click', value: '' }] }))];
    const out = await engine.do([{ op: 'hover', target: 'Menu' }]);
    expect(out).toContain('changed: page navigated or re-rendered');
    expect(out).toContain('[1] button "Menu"');
  });

  it('keeps numeric ids working in a mixed batch when the document is the same', async () => {
    t.snapshots = [doc(1, [[1, 'Open details'], [2, 'Menu']])];
    await engine.snapshot();
    await engine.do([{ op: 'click', index: 1 }, { op: 'hover', target: 'Menu' }]);
    expect(t.actionEvals().map(opOf)).toEqual([
      { op: 'click', node: 1, label: 'Open details', origin: 1 },
      { op: 'hover', node: 2, label: 'Menu', origin: 1 },
    ]);
  });

  it('gives each call its own deadline: an overlapping call neither extends nor clears it', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const gated = new FastBrowserEngine({
      transport: t, legacy, env: {}, now: () => clock, sleep: async (ms) => { clock += ms; },
      gate: async () => { calls += 1; if (calls === 1) await held; },
    });
    await gated.snapshot();
    const first = gated.do([{ op: 'click', index: 12 }]); // waits at its approval gate
    await Promise.resolve();
    clock += 90_000;
    await gated.do([{ op: 'click', index: 12 }]); // a later call starts, runs and finishes
    clock += 2_000;
    release();
    await expect(first).rejects.toThrow('this call ran out of time (60 s); the click was not performed');
    expect(t.actionEvals()).toHaveLength(1); // only the later call acted
  });

  it('drops the Tab focus line after a wait, which gives the page time to move focus', async () => {
    await engine.snapshot();
    t.actions = [JSON.stringify({ ok: true, focused: 'Second' })];
    expect(await engine.do([{ op: 'press', key: 'Tab' }, { op: 'wait', ms: 10 }])).not.toContain('tab moved focus to');
  });
});

describe('do: label guards and abandonment (round 4 fixes)', () => {
  it('keeps the label the model saw for a numeric step, even if the page now calls that control something else', async () => {
    const one = (label: string): string => JSON.stringify(page({ page_key: [1], actions: [
      { node: 1, role: 'button', label, kind: 'click', value: '' },
      { node: 2, role: 'button', label: 'Menu', kind: 'click', value: '' },
    ] }));
    t.snapshots = [one('Open details')];
    await engine.snapshot();
    t.snapshots = [one('Delete account')]; // same document, same node, different meaning
    await engine.do([{ op: 'click', index: 1 }, { op: 'hover', target: 'Menu' }]);
    expect(t.actionEvals().map(opOf)[0]).toMatchObject({ op: 'click', node: 1, label: 'Open details' }); // the page guard then refuses
  });

  it('keeps the label the model saw after a refused or finished batch, so a later numeric id cannot take on the new meaning', async () => {
    const one = (label: string): string => JSON.stringify(page({ page_key: [1], actions: [
      { node: 1, role: 'button', label, kind: 'click', value: '' },
      { node: 2, role: 'button', label: 'Menu', kind: 'click', value: '' },
    ] }));
    t.snapshots = [one('Open details')];
    await engine.snapshot();
    t.snapshots = [one('Delete account')];
    // a batch that fails before it returns any state (the label names a button, not a text field)
    await expect(engine.do([{ op: 'click', index: 1 }, { op: 'type', target: 'Menu', text: 'x' }])).rejects.toThrow('is not a text field here');
    expect(t.actionEvals()).toHaveLength(0);
    await engine.click(1); // the model still holds [1] "Open details"
    expect(t.actionEvals().map(opOf)[0]).toMatchObject({ op: 'click', node: 1, label: 'Open details' });
  });

  it('refuses to click after an approval wait when the tool call was abandoned meanwhile (browser_do and browser_click)', async () => {
    for (const run of [(e: FastBrowserEngine) => e.do([{ op: 'click', index: 12 }]), (e: FastBrowserEngine) => e.click(12)]) {
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const gated = new FastBrowserEngine({
        transport: t, legacy, env: {}, now: () => clock, sleep: async (ms) => { clock += ms; },
        gate: async () => { await held; },
      });
      await gated.snapshot();
      const call = runInCallScope(() => run(gated));
      await Promise.resolve();
      call.abort(); // the MCP timeout fired
      release();
      await expect(call.result).rejects.toThrow('this call was abandoned after the tool timed out; the click was not performed');
    }
    expect(t.actionEvals()).toHaveLength(0);
  });

  it('starts no further step once abandoned, even when the batch started after the abort, and later calls are unaffected', async () => {
    await engine.snapshot();
    let abort!: () => void;
    t.actions = [(): string => { abort(); return JSON.stringify({ ok: true, label: 'x' }); }];
    const call = runInCallScope(() => engine.do([{ op: 'check', index: 9, checked: true }, { op: 'click', index: 12 }]));
    abort = call.abort;
    await expect(call.result).rejects.toThrow('step 2 click failed: this call was abandoned after the tool timed out; remaining steps not run (step 1 ok)');
    expect(t.actionEvals()).toHaveLength(1);
    // a batch that merely starts inside an already-abandoned call (a resumed computer_batch)
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const resumed = runInCallScope(async () => { await held; return engine.do([{ op: 'click', index: 12 }]); });
    resumed.abort();
    release();
    await expect(resumed.result).rejects.toThrow('step 1 click failed: this call was abandoned after the tool timed out; remaining steps not run');
    expect(t.actionEvals()).toHaveLength(1);
    await expect(engine.do([{ op: 'click', index: 12 }])).resolves.toContain('did: click');
  });
});
