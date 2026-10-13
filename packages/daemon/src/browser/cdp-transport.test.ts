import { describe, expect, it, vi } from 'vitest';
import { BrowserAutomationError } from './applescript.js';
import { CdpTransport, browserNameFromVersion, type CdpSocket } from './cdp-transport.js';

const CHROME = { name: 'Google Chrome', family: 'chromium', aliases: [] } as const;

interface FakePage { id: string; title: string; url: string; window: number; visible: boolean; type?: string; ws?: boolean }

/** A browser that answers the DevTools HTTP and WebSocket calls the transport makes. */
function fakeBrowser(pages: FakePage[], opts: { up?: boolean; evalResult?: (expr: string, page: FakePage) => any; browserName?: string } = {}) {
  const state = { up: opts.up ?? true, pages, calls: [] as string[], sockets: 0, hang: false };
  const listing = () =>
    state.pages.map((p) => ({
      id: p.id, type: p.type ?? 'page', title: p.title, url: p.url,
      ...(p.ws === false ? {} : { webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${p.id}` }),
    }));
  const fetchFn = (async (input: string, init?: { method?: string }) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    state.calls.push(`${method} ${url.pathname}${url.search}`);
    if (!state.up) throw new Error('connection refused');
    const json = (v: unknown, ok = true) => ({ ok, text: async () => JSON.stringify(v) });
    if (url.pathname === '/json/version') return json({ Browser: opts.browserName ?? 'Chrome/130.0.0.0', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/b' });
    if (url.pathname === '/json/list') return json(listing());
    if (url.pathname === '/json/new') {
      if (method !== 'PUT' && (opts as any).putOnly) return json({}, false);
      const created = { id: `n${state.pages.length}`, title: '', url: decodeURIComponent(url.search.slice(1)), window: 1, visible: false };
      state.pages.forEach((p) => (p.visible = false));
      created.visible = true;
      state.pages.push(created);
      return json({ id: created.id, url: created.url });
    }
    if (url.pathname.startsWith('/json/activate/')) {
      const id = decodeURIComponent(url.pathname.slice('/json/activate/'.length));
      const page = state.pages.find((p) => p.id === id);
      if (!page) return json('No such target id', false);
      state.pages.filter((p) => p.window === page.window).forEach((p) => (p.visible = p === page));
      return { ok: true, text: async () => 'Target activated' };
    }
    return json({}, false);
  }) as unknown as typeof fetch;

  const openSocket = (url: string): CdpSocket => {
    state.sockets += 1;
    const socket: CdpSocket = {
      onopen: null, onmessage: null, onclose: null, onerror: null,
      send(data: string) {
        const msg = JSON.parse(data) as { id: number; method: string; params: any };
        const reply = (result: unknown) => queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) }));
        const fail = (message: string) => queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ id: msg.id, error: { message } }) }));
        const pageId = url.split('/').pop()!;
        const page = state.pages.find((p) => p.id === pageId);
        if (msg.method === 'Browser.getWindowForTarget') {
          const target = state.pages.find((p) => p.id === msg.params.targetId);
          return target ? reply({ windowId: target.window }) : fail('No target with given id');
        }
        if (msg.method === 'Runtime.evaluate' && page) {
          if (state.hang) return;
          if (msg.params.expression === 'document.visibilityState') return reply({ result: { type: 'string', value: page.visible ? 'visible' : 'hidden' } });
          const out = opts.evalResult ? opts.evalResult(msg.params.expression, page) : { result: { type: 'string', value: 'ok' } };
          return reply(out);
        }
        fail('unknown');
      },
      close() {
        queueMicrotask(() => socket.onclose?.());
      },
    };
    setTimeout(() => socket.onopen?.(), 0);
    return socket;
  };
  return { state, fetchFn, openSocket };
}

const pages = (): FakePage[] => [
  { id: 'a', title: 'Mail', url: 'https://mail.example.com/', window: 1, visible: false },
  { id: 'b', title: 'Docs', url: 'https://docs.example.com/', window: 1, visible: true },
  { id: 'c', title: 'Other window', url: 'https://other.example.com/', window: 2, visible: true },
  { id: 'x', title: 'DevTools', url: 'devtools://devtools/bundled/inspector.html', window: 1, visible: false },
  { id: 'sw', title: 'worker', url: 'chrome-extension://abc/sw.js', window: 1, visible: false, type: 'service_worker' },
];

describe('browserNameFromVersion', () => {
  it('tells Edge from Chrome', () => {
    expect(browserNameFromVersion('Chrome/130.0.0.0')).toBe('Google Chrome');
    expect(browserNameFromVersion('HeadlessChrome/130.0.0.0')).toBe('Google Chrome');
    expect(browserNameFromVersion('Edg/130.0.0.0')).toBe('Microsoft Edge');
    expect(browserNameFromVersion(undefined)).toBe('Google Chrome');
  });
});

describe('CdpTransport.environment', () => {
  it('names the browser that answers', async () => {
    const f = fakeBrowser(pages(), { browserName: 'Edg/130.0.0.0' });
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    expect(await t.environment()).toEqual({ frontmost: 'Microsoft Edge', running: ['Microsoft Edge'] });
  });

  it('answers "nothing running" instead of throwing when the browser is not there', async () => {
    const f = fakeBrowser(pages(), { up: false });
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    expect(await t.environment()).toEqual({ frontmost: null, running: [] });
  });

  it('starts the browser once when nothing answers, then reports it', async () => {
    const f = fakeBrowser(pages(), { up: false });
    const ensure = vi.fn(async () => {
      f.state.up = true;
      return true;
    });
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket, ensureBrowser: ensure });
    const [one, two] = await Promise.all([t.environment(), t.environment()]);
    expect(one.running).toEqual(['Google Chrome']);
    expect(two.running).toEqual(['Google Chrome']);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('does not keep trying to start a browser that will not start', async () => {
    const f = fakeBrowser(pages(), { up: false });
    let clock = 1000;
    const ensure = vi.fn(async () => false);
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket, ensureBrowser: ensure, now: () => clock });
    await t.environment();
    await t.environment();
    expect(ensure).toHaveBeenCalledTimes(1);
    clock += 25_000;
    await t.environment();
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('survives a start that throws', async () => {
    const f = fakeBrowser(pages(), { up: false });
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket, ensureBrowser: async () => { throw new Error('boom'); } });
    expect(await t.environment()).toEqual({ frontmost: null, running: [] });
  });
});

describe('CdpTransport.listTabs', () => {
  it('lists only real pages, numbers windows and tabs, and marks the showing tab of each window', async () => {
    const f = fakeBrowser(pages());
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    const tabs = await t.listTabs(CHROME);
    expect(tabs.map((x) => [x.tabKey, x.windowIndex, x.tabIndex, x.active])).toEqual([
      ['a', 1, 1, false],
      ['b', 1, 2, true],
      ['c', 2, 1, true],
    ]);
    expect(tabs[0]).toMatchObject({ windowId: '1', title: 'Mail', url: 'https://mail.example.com/' });
    expect(tabs[2]!.windowId).toBe('2');
  });

  it('keeps tab numbers stable when the browser reorders its list, and numbers a new tab last', async () => {
    const f = fakeBrowser(pages());
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    await t.listTabs(CHROME);
    f.state.pages.reverse();
    const again = await t.listTabs(CHROME);
    expect(again.filter((x) => x.windowId === '1').map((x) => x.tabKey)).toEqual(['a', 'b']);
    f.state.pages.unshift({ id: 'new', title: 'New', url: 'https://new.example.com/', window: 1, visible: false });
    expect((await t.listTabs(CHROME)).filter((x) => x.windowId === '1').map((x) => x.tabKey)).toEqual(['a', 'b', 'new']);
  });

  it('still lists tabs when the window or visibility cannot be read', async () => {
    const f = fakeBrowser([{ id: 'a', title: 'A', url: 'https://a.example.com/', window: 1, visible: false, ws: false }]);
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    const tabs = await t.listTabs(CHROME);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.active).toBe(true);
  });

  it('says the browser is not reachable when it is closed', async () => {
    const f = fakeBrowser(pages(), { up: false });
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    await expect(t.listTabs(CHROME)).rejects.toMatchObject({ code: 'not_running' });
  });
});

describe('CdpTransport.evaluate', () => {
  it('runs the script in the named tab and returns its string', async () => {
    const f = fakeBrowser(pages(), { evalResult: (expr, page) => ({ result: { type: 'string', value: `${page.id}:${expr}` } }) });
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    expect(await t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, '1+1')).toBe('a:1+1');
  });

  it('runs it in the front tab when no tab is named', async () => {
    const f = fakeBrowser(pages(), { evalResult: (_e, page) => ({ result: { type: 'string', value: page.id } }) });
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    expect(await t.evaluate(CHROME, null, 'x')).toBe('b');
  });

  it('turns other results into text, and an empty result into an empty string', async () => {
    const f = fakeBrowser(pages(), { evalResult: (e) => (e === 'n' ? { result: { type: 'number', value: 7 } } : { result: { type: 'undefined' } }) });
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    expect(await t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'n')).toBe('7');
    expect(await t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'u')).toBe('');
  });

  it('reports a script that throws as a script error with only the first line', async () => {
    const f = fakeBrowser(pages(), { evalResult: () => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is not a function\n    at <anonymous>:1:1' } } }) });
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    const err = await t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'x()').catch((e) => e);
    expect(err).toBeInstanceOf(BrowserAutomationError);
    expect(err.code).toBe('script_error');
    expect(err.message).toContain('TypeError: x is not a function');
    expect(err.message).not.toContain('at <anonymous>');
  });

  it('times out when the page never answers (for example an alert is open)', async () => {
    const f = fakeBrowser(pages());
    f.state.hang = true;
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    await expect(t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'x', 30)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('says the tab is gone, or the browser has no window', async () => {
    const f = fakeBrowser(pages());
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    await expect(t.evaluate(CHROME, { windowId: '1', tabKey: 'zzz' }, 'x')).rejects.toMatchObject({ code: 'no_tab' });
    f.state.pages.length = 0;
    await expect(t.evaluate(CHROME, null, 'x')).rejects.toMatchObject({ code: 'no_window' });
  });

  it('explains a tab another tool is attached to', async () => {
    const f = fakeBrowser([{ id: 'a', title: 'A', url: 'https://a.example.com/', window: 1, visible: true, ws: false }]);
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    await expect(t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'x')).rejects.toMatchObject({ code: 'no_tab' });
  });

  it('connects again when the connection to a tab was dropped, and reuses it otherwise', async () => {
    const f = fakeBrowser(pages());
    const sockets: CdpSocket[] = [];
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: (u) => { const s = f.openSocket(u); sockets.push(s); return s; } });
    await t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'x');
    const before = f.state.sockets;
    await t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'x');
    expect(f.state.sockets).toBe(before);
    sockets.find((s) => (s as any) && true)!.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(await t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'x')).toBe('ok');
  });
});

describe('CdpTransport.focusTab and openUrl', () => {
  it('brings a tab to the front, or says it is gone', async () => {
    const f = fakeBrowser(pages());
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    await t.focusTab(CHROME, { windowId: '1', tabKey: 'a' });
    expect(f.state.calls).toContain('GET /json/activate/a');
    await expect(t.focusTab(CHROME, { windowId: '1', tabKey: 'gone' })).rejects.toMatchObject({ code: 'no_tab' });
  });

  it('opens a web address in a new tab that comes to the front, keeping & and # in it', async () => {
    const f = fakeBrowser(pages());
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    await t.openUrl(CHROME, 'https://example.com/a?x=1&y=2#top');
    const created = f.state.pages.at(-1)!;
    expect(created.url).toBe('https://example.com/a?x=1&y=2#top');
    expect(f.state.calls.some((c) => c.startsWith('PUT /json/new?https%3A%2F%2Fexample.com'))).toBe(true);
    expect(created.visible).toBe(true);
  });

  it('falls back to GET for an older browser', async () => {
    const f = fakeBrowser(pages(), { putOnly: false } as any);
    const original = f.fetchFn;
    const fetchFn = (async (u: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') return { ok: false, text: async () => '' };
      return original(u as any, init as any);
    }) as unknown as typeof fetch;
    const t = new CdpTransport({ fetchFn, openSocket: f.openSocket });
    await t.openUrl(CHROME, 'https://example.com/');
    expect(f.state.pages.at(-1)!.url).toBe('https://example.com/');
  });

  it('refuses anything that is not a web address', async () => {
    const f = fakeBrowser(pages());
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,hi', '--remote-debugging-port=1']) {
      await expect(t.openUrl(CHROME, bad)).rejects.toMatchObject({ code: 'script_error' });
    }
    expect(f.state.calls.some((c) => c.includes('/json/new'))).toBe(false);
    await t.openUrl(CHROME, 'about:blank');
  });
});
