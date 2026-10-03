import { describe, it, expect, beforeEach } from 'vitest';
import { FastBrowserEngine, normalizeOpenUrl } from './engine.js';
import { BrowserAutomationError, type TabTarget } from './applescript.js';
import type { TabInfo } from './transport.js';
import type { BrowserApp } from './browsers.js';
import type { BrowserPort, DoStep } from './port.js';
import { buildReadyProbe } from './page-scripts.js';

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
    if (js === buildReadyProbe()) {
      r = this.probes.shift() ?? JSON.stringify({ u: this.currentUrl(), r: 'complete', t: 'Sign up' });
    } else if (js.includes('__rhFast = window.__jevFast')) {
      r = (this.snapshots.length > 1 ? this.snapshots.shift() : this.snapshots[0])!;
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

  async focusTab(_b: BrowserApp, target: TabTarget): Promise<void> {
    this.focused.push(target);
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
      'page: Sign up — https://example.com/signup',
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
      'page: Sign up — https://example.com/signup (same page)',
      '~ [9] checkbox "I agree" [checked]',
      '(4 unchanged)',
    ]);
  });

  it('waits about two probes after a non-navigating action', async () => {
    await engine.snapshot();
    t.evals = [];
    await engine.click(12);
    const probes = t.evals.filter((e) => e.js === buildReadyProbe()).length;
    expect(probes).toBe(2);
  });

  it('notes a page that is still loading after 3 s', async () => {
    await engine.snapshot();
    t.probes = Array.from({ length: 100 }, () => JSON.stringify({ u: 'https://example.com/signup', r: 'loading', t: 'Sign up' }));
    const out = await engine.click(12);
    expect(out.endsWith('note: page still loading')).toBe(true);
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

  it('refuses to act when the browser has quit since the snapshot', async () => {
    await engine.snapshot();
    t.env = { frontmost: null, running: [] };
    clock += 2000;
    await expect(engine.click(12)).rejects.toThrow('Google Chrome is no longer running. Call browser_snapshot.');
    expect(t.actionEvals()).toHaveLength(0);
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
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '101' }); // front tab, not null
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
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '101' }); // front tab, not null
  });

  it('no_tab clears the pin and throws the actionable message', async () => {
    await engine.focus('docs');
    t.fail = new BrowserAutomationError('no_tab', 'Google Chrome', 'The target tab is gone. Call browser_tabs and focus a tab again.');
    await expect(engine.snapshot()).rejects.toThrow('The target tab is gone.');
    t.fail = null;
    await engine.snapshot();
    expect(t.evals.at(-1)!.target).toEqual({ windowId: '11', tabKey: '101' }); // front tab, not null
  });

  it('open reuses a tab with the same host and path', async () => {
    const out = await engine.open('https://docs.test/a/b/');
    expect(t.opened).toHaveLength(0);
    expect(t.focused).toEqual([{ windowId: '11', tabKey: '102' }]);
    expect(out.split('\n')[0]).toBe('opened https://docs.test/a/b/ (reused tab Docs - https://docs.test/a/b?x=1)');
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
