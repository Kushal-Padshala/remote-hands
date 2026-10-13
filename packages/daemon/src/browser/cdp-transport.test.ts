import { describe, expect, it, vi } from 'vitest';
import { BrowserAutomationError } from './applescript.js';
import { BrowserUnavailableError, CdpTransport, browserNameFromVersion, type CdpSocket } from './cdp-transport.js';
import { FastBrowserEngine } from './engine.js';
import type { BrowserPort } from './port.js';

const CHROME = { name: 'Google Chrome', family: 'chromium', aliases: [] } as const;

interface FakePage { id: string; title: string; url: string; window: number; visible: boolean; focused?: boolean; type?: string; ws?: boolean }

/** A browser that answers the DevTools HTTP and WebSocket calls the transport makes. */
function fakeBrowser(pages: FakePage[], opts: { up?: boolean; evalResult?: (expr: string, page: FakePage) => any; browserName?: string } = {}) {
  const state = { up: opts.up ?? true, pages, calls: [] as string[], sockets: 0, hang: false, dropAfterRun: '' as string, executed: [] as string[], open: new Set<CdpSocket>(), failNextSend: false };
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
        if (state.failNextSend) {
          state.failNextSend = false;
          throw new Error('socket is not writable');
        }
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
          if (msg.params.expression.includes('document.hasFocus')) return reply({ result: { type: 'string', value: JSON.stringify([page.visible ? 'visible' : 'hidden', page.focused === true]) } });
          if (state.dropAfterRun && msg.params.expression === state.dropAfterRun) {
            // the action runs in the page, then the connection dies before the answer
            state.executed.push(msg.params.expression);
            return queueMicrotask(() => socket.close());
          }
          state.executed.push(msg.params.expression);
          const out = opts.evalResult ? opts.evalResult(msg.params.expression, page) : { result: { type: 'string', value: 'ok' } };
          return reply(out);
        }
        fail('unknown');
      },
      close() {
        state.open.delete(socket);
        queueMicrotask(() => socket.onclose?.());
      },
    };
    state.open.add(socket);
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

  it('says why when no browser answers and none can be started', async () => {
    const f = fakeBrowser(pages(), { up: false });
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    await expect(t.environment()).rejects.toBeInstanceOf(BrowserUnavailableError);
    await expect(t.environment()).rejects.toMatchObject({ code: 'not_running', message: expect.stringContaining('browser-control port') });
  });

  it('starts the browser once when nothing answers, then reports it', async () => {
    const f = fakeBrowser(pages(), { up: false });
    const ensure = vi.fn(async () => {
      f.state.up = true;
      return { available: true };
    });
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket, ensureBrowser: ensure });
    const [one, two] = await Promise.all([t.environment(), t.environment()]);
    expect(one.running).toEqual(['Google Chrome']);
    expect(two.running).toEqual(['Google Chrome']);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('does not keep trying to start a browser that will not start, and keeps telling the person why', async () => {
    const f = fakeBrowser(pages(), { up: false });
    let clock = 1000;
    const ensure = vi.fn(async () => ({ available: false, error: 'Google Chrome was not found. Install it from google.com/chrome, then try again.' }));
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket, ensureBrowser: ensure, now: () => clock });
    await expect(t.environment()).rejects.toThrow('Google Chrome was not found');
    await expect(t.environment()).rejects.toThrow('Google Chrome was not found');
    expect(ensure).toHaveBeenCalledTimes(1);
    clock += 25_000;
    await expect(t.environment()).rejects.toThrow('Google Chrome was not found');
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('survives a start that throws', async () => {
    const f = fakeBrowser(pages(), { up: false });
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket, ensureBrowser: async () => { throw new Error('boom'); } });
    await expect(t.environment()).rejects.toMatchObject({ message: 'The browser could not be started.' });
  });

  it('is told apart from a browser that was started but never answered', async () => {
    const f = fakeBrowser(pages(), { up: false });
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket, ensureBrowser: async () => ({ available: true }) });
    await expect(t.environment()).rejects.toMatchObject({ message: 'The browser was started but did not answer in time.' });
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

describe('CdpTransport: an action is never run twice', () => {
  it('does not send a script again when the connection dies after it ran, and says the outcome is unknown', async () => {
    const f = fakeBrowser(pages());
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    f.state.dropAfterRun = 'document.querySelector("#pay").click()';
    const err = await t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'document.querySelector("#pay").click()').catch((e) => e);
    expect(err).toBeInstanceOf(BrowserAutomationError);
    expect(err.message).toContain('may or may not have happened');
    expect(f.state.executed).toEqual(['document.querySelector("#pay").click()']);
    // the next call works on a new connection
    f.state.dropAfterRun = '';
    expect(await t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'read()')).toBe('ok');
  });

  it('sends a script again only when the first try never left, and then once', async () => {
    const f = fakeBrowser(pages());
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    await t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'warm()');
    f.state.failNextSend = true;
    expect(await t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'click()')).toBe('ok');
    expect(f.state.executed.filter((e) => e === 'click()')).toHaveLength(1);
  });
});

describe('CdpTransport: tabs and windows', () => {
  it('reports the tab it opened, and the engine binds to exactly that tab even if another window is in use', async () => {
    const f = fakeBrowser(pages());
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    const opened = await t.openUrl(CHROME, 'https://new.example/');
    expect(opened.tabKey).toBe(f.state.pages.at(-1)!.id);
    expect(opened.windowId).toBe('1');

    // The person is in window 2 (focused) while the new tab was made elsewhere.
    const g = fakeBrowser(pages(), { evalResult: (expr, page) => ({ result: { type: 'string', value: expr.includes('timeOrigin') || expr.includes('JSON.stringify') ? JSON.stringify({ u: page.url, r: 'complete', t: page.title, o: 1, p: false, snap: null }) : 'ok' } }) });
    g.state.pages.find((p) => p.id === 'c')!.focused = true;
    const transport = new CdpTransport({ fetchFn: g.fetchFn, openSocket: g.openSocket });
    const seen: Array<string | undefined> = [];
    const wrapped = {
      environment: () => transport.environment(),
      listTabs: (b: any) => transport.listTabs(b),
      focusTab: (b: any, target: any) => transport.focusTab(b, target),
      evaluate: (b: any, target: any, js: string, ms?: number) => {
        seen.push(target?.tabKey);
        return transport.evaluate(b, target, js, ms);
      },
      openUrl: (b: any, url: string, w?: string) => transport.openUrl(b, url, w),
    };
    const legacy: BrowserPort = {
      tabs: async () => 'legacy', focus: async () => 'legacy', open: async () => 'legacy', snapshot: async () => 'legacy', click: async () => 'legacy',
      type: async () => 'legacy', find: async () => 'legacy', do: async () => 'legacy', extract: async () => 'legacy',
    };
    const engine = new FastBrowserEngine({ transport: wrapped, legacy, sleep: async () => {} });
    await engine.open('https://new.example/').catch(() => undefined);
    const newTab = g.state.pages.at(-1)!;
    expect(newTab.url).toBe('https://new.example/');
    // everything the engine ran after opening went to the new tab, never to another page
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([newTab.id]));
  });

  it('numbers the window the person is using first, following keyboard focus rather than list order', async () => {
    const f = fakeBrowser(pages());
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    f.state.pages.find((p) => p.id === 'b')!.focused = true;
    let tabs = await t.listTabs(CHROME);
    expect(tabs.find((x) => x.tabKey === 'b')!.windowIndex).toBe(1);
    expect(tabs.find((x) => x.tabKey === 'c')!.windowIndex).toBe(2);
    // the person clicks into the other window: it becomes window 1, its showing tab stays that tab
    f.state.pages.find((p) => p.id === 'b')!.focused = false;
    f.state.pages.find((p) => p.id === 'c')!.focused = true;
    tabs = await t.listTabs(CHROME);
    expect(tabs.find((x) => x.tabKey === 'c')!.windowIndex).toBe(1);
    expect(tabs.find((x) => x.tabKey === 'b')!.windowIndex).toBe(2);
    expect(tabs.find((x) => x.tabKey === 'b')!.active).toBe(true);
    // nothing focused (the person is in another program): the last window stays first
    f.state.pages.find((p) => p.id === 'c')!.focused = false;
    tabs = await t.listTabs(CHROME);
    expect(tabs.find((x) => x.tabKey === 'c')!.windowIndex).toBe(1);
  });

  it('lists each window\'s tabs 1..n in the order they were first seen, however the browser orders its list', async () => {
    const f = fakeBrowser([
      { id: 'a', title: 'A', url: 'https://a.example/', window: 1, visible: true },
      { id: 'b', title: 'B', url: 'https://b.example/', window: 1, visible: false },
      { id: 'c', title: 'C', url: 'https://c.example/', window: 1, visible: false },
    ]);
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    expect((await t.listTabs(CHROME)).map((x) => [x.tabKey, x.tabIndex])).toEqual([['a', 1], ['b', 2], ['c', 3]]);
    f.state.pages.splice(0, 1);
    expect((await t.listTabs(CHROME)).map((x) => [x.tabKey, x.tabIndex])).toEqual([['b', 1], ['c', 2]]);
    // a tab dragged to another window is numbered there, with no duplicate label
    f.state.pages.find((p) => p.id === 'b')!.window = 2;
    f.state.pages.push({ id: 'd', title: 'D', url: 'https://d.example/', window: 2, visible: true });
    const moved = await t.listTabs(CHROME);
    const labels = moved.map((x) => `w${x.windowIndex}-t${x.tabIndex}`);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('takes the window that shows a page as the one in use when no page has focus (a minimized window shows none)', async () => {
    const f = fakeBrowser(pages());
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    f.state.pages.find((p) => p.id === 'b')!.focused = true;
    await t.listTabs(CHROME);
    // window 1 is minimized (its pages hidden); the person is in window 2's address bar, so no page has focus
    f.state.pages.find((p) => p.id === 'b')!.focused = false;
    f.state.pages.find((p) => p.id === 'b')!.visible = false;
    const tabs = await t.listTabs(CHROME);
    expect(tabs.find((x) => x.tabKey === 'c')!.windowIndex).toBe(1);
    expect(tabs.find((x) => x.tabKey === 'c')!.active).toBe(true);
  });
});

describe('FastBrowserEngine.focus with labels from an earlier list', () => {
  const legacy: BrowserPort = {
    tabs: async () => 'legacy', focus: async () => 'legacy', open: async () => 'legacy', snapshot: async () => 'legacy', click: async () => 'legacy',
    type: async () => 'legacy', find: async () => 'legacy', do: async () => 'legacy', extract: async () => 'legacy',
  };
  const engineFor = (f: ReturnType<typeof fakeBrowser>) => {
    const transport = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    return new FastBrowserEngine({ transport, legacy, sleep: async () => {} });
  };
  const snapshotOfPage = (_expr: string, page: FakePage) => ({
    result: { type: 'string', value: JSON.stringify({ url: page.url, title: page.title, w: 800, h: 600, text: '', scroll: { y: 0, height: 600 }, actions: [] }) },
  });
  const three = (): FakePage[] => [
    { id: 'a', title: 'Alpha', url: 'https://alpha.example/', window: 1, visible: true },
    { id: 'b', title: 'Beta', url: 'https://beta.example/', window: 1, visible: false },
    { id: 'c', title: 'Gamma', url: 'https://gamma.example/', window: 1, visible: false },
  ];

  it('focuses the tab the label named when the list was shown, even after another tab closed', async () => {
    const f = fakeBrowser(three(), { evalResult: snapshotOfPage });
    const engine = engineFor(f);
    expect(await engine.tabs()).toContain('[w1-t2]');
    f.state.pages.splice(0, 1); // Alpha closes: Beta is now t1, Gamma t2
    const out = await engine.focus('w1-t2');
    expect(out).toContain('focused Beta');
    expect(f.state.calls).toContain('GET /json/activate/b');
  });

  it('says the tab is gone rather than focusing another one', async () => {
    const f = fakeBrowser(three());
    const engine = engineFor(f);
    await engine.tabs();
    f.state.pages.splice(1, 1); // Beta closes
    await expect(engine.focus('w1-t2')).rejects.toThrow(/is gone since browser_tabs/);
    await expect(engine.focus(2)).rejects.toThrow(/is gone since browser_tabs/);
    expect(f.state.calls.some((c) => c.includes('/json/activate/c'))).toBe(false);
  });

  it('still finds a tab by words when no list was shown', async () => {
    const f = fakeBrowser(three());
    expect(await engineFor(fakeBrowser(three(), { evalResult: snapshotOfPage })).focus('gamma')).toContain('focused Gamma');
  });
});

describe('CdpTransport: connections', () => {
  it('opens one connection per tab however many calls ask at once, and closes every one on dispose', async () => {
    const f = fakeBrowser(pages());
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    await Promise.all([1, 2, 3, 4].map((i) => t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, `read(${i})`)));
    expect(f.state.sockets).toBe(1);
    await Promise.all([t.listTabs(CHROME), t.listTabs(CHROME)]);
    // browser socket + one per listed tab (a, b, c), each opened once
    expect(f.state.sockets).toBe(4);
    t.dispose();
    await new Promise((r) => setTimeout(r, 5));
    expect(f.state.open.size).toBe(0);
  });

  it('closes a connection that finishes opening after dispose', async () => {
    const f = fakeBrowser(pages());
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: f.openSocket });
    const pending = t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'x').catch((e) => e);
    await new Promise((r) => setTimeout(r, 0));
    t.dispose();
    await pending;
    await new Promise((r) => setTimeout(r, 10));
    expect(f.state.open.size).toBe(0);
  });
});

describe('CdpTransport: connection attempts that overlap a reset', () => {
  it('lets a superseded attempt finish without disturbing the newer one, and leaks no socket', async () => {
    const f = fakeBrowser(pages());
    const gates: Array<() => void> = [];
    const open = (url: string): CdpSocket => {
      const socket = f.openSocket(url);
      const real = socket.onopen;
      let fire: (() => void) | null = null;
      Object.defineProperty(socket, 'onopen', {
        get: () => real,
        set: (fn) => {
          fire = fn;
        },
      });
      // hold the connection open until the test releases it
      gates.push(() => fire?.());
      return socket;
    };
    const t = new CdpTransport({ fetchFn: f.fetchFn, openSocket: open });
    const a = t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'x').catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    t.dispose(); // a reset while attempt A is still opening
    const b = t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'x').catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    gates[0]!(); // the old attempt finishes
    await new Promise((r) => setTimeout(r, 5));
    const c = t.evaluate(CHROME, { windowId: '1', tabKey: 'a' }, 'x').catch((e) => e); // a third caller must share B's attempt
    await new Promise((r) => setTimeout(r, 5));
    gates[1]!();
    const [, rb, rc] = await Promise.all([a, b, c]);
    expect(rb).toBe('ok');
    expect(rc).toBe('ok');
    expect(f.state.sockets).toBe(2); // A (closed) and B (shared by the third caller)
    t.dispose();
    await new Promise((r) => setTimeout(r, 5));
    expect(f.state.open.size).toBe(0);
  });
});

describe('FastBrowserEngine with a browser that cannot be started', () => {
  it('uses the slower path and tells why', async () => {
    const f = fakeBrowser(pages(), { up: false });
    const transport = new CdpTransport({
      fetchFn: f.fetchFn,
      openSocket: f.openSocket,
      ensureBrowser: async () => ({ available: false, error: 'Google Chrome was not found. Install it from google.com/chrome, then try again.' }),
    });
    const legacy: BrowserPort = {
      tabs: async () => 'the legacy tabs', focus: async () => '', open: async () => '', snapshot: async () => '', click: async () => '',
      type: async () => '', find: async () => '', do: async () => '', extract: async () => '',
    };
    const engine = new FastBrowserEngine({ transport, legacy });
    const out = await engine.tabs();
    expect(out).toContain('the legacy tabs');
    expect(out).toContain('Google Chrome was not found');
  });
});
