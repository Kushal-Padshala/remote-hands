import { BrowserAutomationError, type TabTarget } from './applescript.js';
import type { BrowserApp } from './browsers.js';
import type { TabInfo } from './transport.js';

/**
 * The fast browser engine's transport for browsers that are not driven through AppleScript (Windows, Linux): it
 * speaks the Chrome DevTools Protocol to a Chromium browser that was started with a debugging port. It offers the
 * same methods as `AppleScriptTransport`, so the page scripts, rendering and fall-back logic are shared.
 */

/** The part of a WebSocket the transport uses; a seam for tests. */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** What starting the browser came to. */
export interface BrowserStart {
  available: boolean;
  /** Why it could not be started, in words for the person. */
  error?: string | undefined;
}

export interface CdpTransportOptions {
  port?: number | undefined;
  host?: string | undefined;
  /** Starts the browser when nothing answers on the port. Called at most once per cool-down. */
  ensureBrowser?: (() => Promise<BrowserStart>) | undefined;
  fetchFn?: typeof fetch | undefined;
  openSocket?: ((url: string) => CdpSocket) | undefined;
  now?: (() => number) | undefined;
}

/** No browser can be reached or started: the engine says why while it falls back to the slower path. */
export class BrowserUnavailableError extends BrowserAutomationError {
  constructor(browser: string, message: string) {
    super('not_running', browser, message);
    this.name = 'BrowserUnavailableError';
  }
}

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
const HTTP_TIMEOUT_MS = 3000;
const CONNECT_TIMEOUT_MS = 4000;
/** After a failed start, do not try again for this long. */
const START_COOLDOWN_MS = 20_000;
const MAX_TABS = 60;
/** What the browser answers for a page it cannot show to the page scripts. */
const HIDDEN_URL = /^(devtools|chrome-extension|chrome-untrusted):/i;

const failure = (code: 'not_running' | 'no_window' | 'no_tab' | 'timeout' | 'script_error', browser: string, message: string): BrowserAutomationError =>
  new BrowserAutomationError(code, browser, message);

/** The request never left this program: it is safe to send it again on a new connection. */
class CdpNotSent extends Error {}
/** The request was sent and the answer never came: whether it ran is unknown. */
class CdpLost extends Error {}
class CdpTimeout extends Error {}

/** One DevTools connection: numbered requests and their answers. */
class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  closed = false;

  private constructor(private readonly socket: CdpSocket) {}

  static open(url: string, openSocket: (url: string) => CdpSocket, timeoutMs: number): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      let socket: CdpSocket;
      try {
        socket = openSocket(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const conn = new CdpConnection(socket);
      const timer = setTimeout(() => {
        conn.closed = true;
        try {
          socket.close();
        } catch {
          // already closed
        }
        reject(new Error('timed out connecting to the browser'));
      }, timeoutMs);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve(conn);
      };
      socket.onerror = () => {
        clearTimeout(timer);
        if (!conn.closed) {
          conn.closed = true;
          reject(new Error('could not connect to the browser'));
        }
      };
      socket.onmessage = (event) => conn.onMessage(event.data);
      socket.onclose = () => {
        conn.closed = true;
        for (const [, p] of conn.pending) p.reject(new CdpLost('the browser closed the connection'));
        conn.pending.clear();
      };
    });
  }

  private onMessage(data: unknown): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || 'the browser reported an error'));
    else p.resolve(msg.result);
  }

  call<T = any>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new CdpNotSent('the browser closed the connection'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeout('the browser did not answer in time'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CdpNotSent(err instanceof Error ? err.message : String(err)));
      }
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }
}

/** The browser's friendly name from `/json/version`'s `Browser` field ("Chrome/130.0.0.0", "Edg/130.0.0.0"). */
export function browserNameFromVersion(version: string | undefined): string {
  return /^Edg(e|A|iOS)?\//i.test(version ?? '') ? 'Microsoft Edge' : 'Google Chrome';
}

interface PageFacts {
  visible: boolean;
  focused: boolean;
}

export class CdpTransport {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly openSocket: (url: string) => CdpSocket;
  private readonly ensureBrowser: (() => Promise<BrowserStart>) | undefined;
  private readonly now: () => number;
  private readonly connections = new Map<string, CdpConnection>();
  private readonly connecting = new Map<string, Promise<CdpConnection>>();
  private browserConnection: CdpConnection | null = null;
  private browserConnecting: Promise<CdpConnection | null> | null = null;
  /** Bumped by `dispose`: a connection that finishes opening after that closes itself. */
  private generation = 0;
  /** A tab keeps the number it first got in its window, so a label like w1-t2 never points at another tab later. */
  private readonly tabNumber = new Map<string, number>();
  private readonly tabCounter = new Map<string, number>();
  /** Windows in the order they were first seen; the one the person is using is shown first. */
  private readonly windowSeq = new Map<string, number>();
  private frontWindow: string | null = null;
  private starting: Promise<BrowserStart> | null = null;
  private lastStartFailure = -Infinity;
  private lastStartError: string | undefined;
  private name = 'Google Chrome';

  constructor(opts: CdpTransportOptions = {}) {
    this.base = `http://${opts.host ?? '127.0.0.1'}:${opts.port ?? 9222}`;
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.openSocket = opts.openSocket ?? ((url) => new WebSocket(url) as unknown as CdpSocket);
    this.ensureBrowser = opts.ensureBrowser;
    this.now = opts.now ?? Date.now;
  }

  // ---- HTTP side of the protocol ----------------------------------------------------------

  private async http(path: string, method = 'GET'): Promise<unknown | null> {
    try {
      const res = await this.fetchFn(`${this.base}${path}`, { method, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (!res.ok) return null;
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch {
      return null;
    }
  }

  private async version(): Promise<{ Browser?: string; webSocketDebuggerUrl?: string } | null> {
    const v = await this.http('/json/version');
    return v && typeof v === 'object' ? (v as { Browser?: string; webSocketDebuggerUrl?: string }) : null;
  }

  /** Starts the browser once when nothing answers; many callers at the same moment share one start. */
  private async startBrowser(): Promise<BrowserStart | null> {
    if (!this.ensureBrowser) return null;
    if (this.now() - this.lastStartFailure < START_COOLDOWN_MS) return { available: false, error: this.lastStartError };
    if (!this.starting) {
      this.starting = this.ensureBrowser()
        .catch((): BrowserStart => ({ available: false }))
        .then((result) => {
          if (!result.available) {
            this.lastStartFailure = this.now();
            this.lastStartError = result.error;
          }
          return result;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  // ---- what the fast engine asks for -------------------------------------------------------

  /**
   * The browser that answers on the port, starting it first when nothing does. When no browser can be reached or
   * started it throws `BrowserUnavailableError`, whose message tells the person why.
   */
  async environment(): Promise<{ frontmost: string | null; running: string[] }> {
    let v = await this.version();
    let started: BrowserStart | null = null;
    if (!v) {
      started = await this.startBrowser();
      if (started?.available) v = await this.version();
    }
    if (!v) {
      this.dropConnections();
      throw new BrowserUnavailableError(
        this.name,
        started === null
          ? 'No browser is answering on the browser-control port.'
          : (started.error ?? (started.available ? 'The browser was started but did not answer in time.' : 'The browser could not be started.')),
      );
    }
    this.name = browserNameFromVersion(v.Browser);
    return { frontmost: this.name, running: [this.name] };
  }

  private async pages(): Promise<CdpTarget[]> {
    const list = await this.http('/json/list');
    if (!Array.isArray(list)) throw failure('not_running', this.name, `${this.name} is not reachable: it is closed or was not started by Remote Hands.`);
    return (list as CdpTarget[])
      .filter((t) => t && t.type === 'page' && typeof t.id === 'string' && !HIDDEN_URL.test(t.url ?? ''))
      .slice(0, MAX_TABS);
  }

  private browserSocket(): Promise<CdpConnection | null> {
    if (this.browserConnection && !this.browserConnection.closed) return Promise.resolve(this.browserConnection);
    if (this.browserConnecting) return this.browserConnecting;
    const generation = this.generation;
    const attempt = (async (): Promise<CdpConnection | null> => {
      const v = await this.version();
      if (!v?.webSocketDebuggerUrl) return null;
      try {
        const conn = await CdpConnection.open(v.webSocketDebuggerUrl, this.openSocket, CONNECT_TIMEOUT_MS);
        if (generation !== this.generation) {
          conn.close();
          return null;
        }
        this.browserConnection = conn;
        return conn;
      } catch {
        return null;
      }
    })().finally(() => {
      this.browserConnecting = null;
    });
    this.browserConnecting = attempt;
    return attempt;
  }

  /** One connection per tab; callers asking at the same moment share the one being opened. */
  private async connection(target: CdpTarget): Promise<CdpConnection> {
    const known = this.connections.get(target.id);
    if (known && !known.closed) return known;
    const inFlight = this.connecting.get(target.id);
    if (inFlight) return inFlight;
    if (!target.webSocketDebuggerUrl) {
      throw failure('no_tab', this.name, 'That tab cannot be controlled (another tool is attached to it). Open it in a new tab.');
    }
    const generation = this.generation;
    const attempt = CdpConnection.open(target.webSocketDebuggerUrl, this.openSocket, CONNECT_TIMEOUT_MS)
      .then((conn) => {
        if (generation !== this.generation) {
          conn.close();
          throw new Error('the transport was closed');
        }
        this.connections.set(target.id, conn);
        return conn;
      })
      .catch((): never => {
        throw failure('script_error', this.name, `${this.name} did not accept the connection to that tab.`);
      })
      .finally(() => {
        this.connecting.delete(target.id);
      });
    this.connecting.set(target.id, attempt);
    return attempt;
  }

  private dropConnections(): void {
    this.generation += 1;
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.connecting.clear();
    this.browserConnection?.close();
    this.browserConnection = null;
    this.browserConnecting = null;
  }

  /** The window a tab is in, or '1' when the browser will not say. */
  private async windowOf(targetId: string): Promise<string> {
    const browser = await this.browserSocket();
    if (!browser) return '1';
    try {
      const res = await browser.call<{ windowId?: number }>('Browser.getWindowForTarget', { targetId }, 2000);
      return typeof res?.windowId === 'number' ? String(res.windowId) : '1';
    } catch {
      return '1';
    }
  }

  /** Whether the page is showing and whether it has the keyboard focus (the window the person is using). */
  private async facts(page: CdpTarget): Promise<PageFacts> {
    try {
      const conn = await this.connection(page);
      const res = await conn.call<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: 'JSON.stringify([document.visibilityState, document.hasFocus()])', returnByValue: true },
        1500,
      );
      const parsed = JSON.parse(String(res?.result?.value ?? '[]')) as unknown[];
      return { visible: parsed[0] === 'visible', focused: parsed[1] === true };
    } catch {
      return { visible: false, focused: false };
    }
  }

  async listTabs(b: BrowserApp): Promise<TabInfo[]> {
    this.name = b.name;
    const pages = await this.pages();
    const present = new Set(pages.map((p) => p.id));
    for (const id of [...this.tabNumber.keys()]) if (!present.has(id)) this.tabNumber.delete(id);
    for (const [id, conn] of [...this.connections]) {
      if (!present.has(id)) {
        conn.close();
        this.connections.delete(id);
      }
    }

    const windowIds = await Promise.all(pages.map((p) => this.windowOf(p.id)));
    const facts = await Promise.all(pages.map((p) => this.facts(p)));

    // Each tab keeps the number it first got in its window.
    pages.forEach((p, i) => {
      if (this.tabNumber.has(p.id)) return;
      const windowId = windowIds[i]!;
      const next = (this.tabCounter.get(windowId) ?? 0) + 1;
      this.tabCounter.set(windowId, next);
      this.tabNumber.set(p.id, next);
    });
    for (const id of windowIds) if (!this.windowSeq.has(id)) this.windowSeq.set(id, this.windowSeq.size);

    // The window the person is using is the one with a focused page; with none focused (they are in another program)
    // the last one seen stays, else the window of the most recently used tab.
    const focusedAt = facts.findIndex((f) => f.focused);
    if (focusedAt >= 0) this.frontWindow = windowIds[focusedAt]!;
    else if (!this.frontWindow || !windowIds.includes(this.frontWindow)) this.frontWindow = windowIds[0] ?? null;
    const windowOrder = [...new Set(windowIds)].sort((a, b2) => {
      if (a === this.frontWindow) return -1;
      if (b2 === this.frontWindow) return 1;
      return (this.windowSeq.get(a) ?? 0) - (this.windowSeq.get(b2) ?? 0);
    });

    const rows = pages.map((p, i) => ({ p, windowId: windowIds[i]!, ...facts[i]!, n: this.tabNumber.get(p.id)! }));
    // The tab showing in each window (the focused one first); a window where none reports showing uses its most recent.
    const activeIn = new Map<string, string>();
    for (const r of rows) if (r.focused && !activeIn.has(r.windowId)) activeIn.set(r.windowId, r.p.id);
    for (const r of rows) if (r.visible && !activeIn.has(r.windowId)) activeIn.set(r.windowId, r.p.id);
    for (const r of rows) if (!activeIn.has(r.windowId)) activeIn.set(r.windowId, r.p.id);

    const tabs: TabInfo[] = [];
    windowOrder.forEach((windowId, w) => {
      for (const r of rows.filter((x) => x.windowId === windowId).sort((a, b2) => a.n - b2.n)) {
        tabs.push({
          windowId,
          windowIndex: w + 1,
          tabKey: r.p.id,
          tabIndex: r.n,
          title: r.p.title ?? '',
          url: r.p.url ?? '',
          active: activeIn.get(windowId) === r.p.id,
        });
      }
    });
    return tabs;
  }

  private async resolveTarget(b: BrowserApp, target: TabTarget | null): Promise<CdpTarget> {
    const pages = await this.pages();
    if (target) {
      const found = pages.find((p) => p.id === target.tabKey);
      if (!found) throw failure('no_tab', b.name, 'The target tab is gone. Call browser_tabs and focus a tab again.');
      return found;
    }
    if (pages.length === 0) throw failure('no_window', b.name, `${b.name} has no open window.`);
    // The front tab: the showing tab of the window the person is using.
    const front = (await this.listTabs(b)).filter((t) => t.active).sort((a, c) => a.windowIndex - c.windowIndex)[0];
    return pages.find((p) => p.id === front?.tabKey) ?? pages[0]!;
  }

  async evaluate(b: BrowserApp, target: TabTarget | null, js: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    this.name = b.name;
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const page = await this.resolveTarget(b, target);
    // A request that never left this program may be sent again on a fresh connection once; one that was sent is
    // never repeated (an action may already have happened).
    for (let attempt = 0; ; attempt++) {
      const conn = await this.connection(page);
      try {
        const res = await conn.call<{ result?: { type?: string; value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
          'Runtime.evaluate',
          { expression: js, returnByValue: true },
          limit,
        );
        if (res.exceptionDetails) {
          const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'the page script failed';
          throw failure('script_error', b.name, `${b.name} automation failed: ${detail.split('\n')[0]!.slice(0, 300)}`);
        }
        const value = res.result?.value;
        if (typeof value === 'string') return value;
        return value === undefined ? '' : JSON.stringify(value);
      } catch (err) {
        if (err instanceof BrowserAutomationError) throw err;
        if (err instanceof CdpTimeout) {
          throw failure('timeout', b.name, `${b.name} did not answer in time (a dialog such as an alert may be open in that tab).`);
        }
        if (err instanceof CdpLost) {
          this.connections.delete(page.id);
          throw failure(
            'script_error',
            b.name,
            `${b.name} lost the connection to that tab while the page script was running, so it may or may not have happened. Take a new snapshot to check before trying again.`,
          );
        }
        if (err instanceof CdpNotSent && attempt === 0) {
          this.connections.delete(page.id);
          conn.close();
          continue;
        }
        this.connections.delete(page.id);
        conn.close();
        throw failure('script_error', b.name, `${b.name} automation failed: ${err instanceof Error ? err.message : 'connection lost'}.`);
      }
    }
  }

  async focusTab(b: BrowserApp, target: TabTarget): Promise<void> {
    this.name = b.name;
    const pages = await this.pages();
    if (!pages.some((p) => p.id === target.tabKey)) {
      throw failure('no_tab', b.name, 'The target tab is gone. Call browser_tabs and focus a tab again.');
    }
    const done = await this.http(`/json/activate/${encodeURIComponent(target.tabKey)}`);
    if (done === null) throw failure('script_error', b.name, `${b.name} would not switch to that tab.`);
    // The window of that tab is now the one in use.
    this.frontWindow = await this.windowOf(target.tabKey);
  }

  /** Opens `url` in a new tab that comes to the front, and says which tab it is (so nothing else is mistaken for it). */
  async openUrl(b: BrowserApp, url: string, _windowId?: string): Promise<TabTarget> {
    this.name = b.name;
    if (!/^(https?:|about:blank$)/i.test(url.trim())) throw failure('script_error', b.name, 'Only web addresses can be opened.');
    // Chrome 111+ wants PUT; older versions answer GET. The address is one component, so & and # stay part of it.
    const encoded = encodeURIComponent(url.trim());
    let made = await this.http(`/json/new?${encoded}`, 'PUT');
    if (made === null) made = await this.http(`/json/new?${encoded}`, 'GET');
    if (made === null) throw failure('script_error', b.name, `${b.name} would not open a new tab.`);
    const id = typeof made === 'object' ? (made as { id?: unknown }).id : undefined;
    if (typeof id !== 'string') throw failure('script_error', b.name, `${b.name} opened a tab but would not say which one.`);
    await this.http(`/json/activate/${encodeURIComponent(id)}`);
    const windowId = await this.windowOf(id);
    this.frontWindow = windowId;
    // The call returns once the new tab is showing, as with a person opening a tab.
    for (let i = 0; i < 15; i++) {
      const page = (await this.pages().catch(() => [])).find((p) => p.id === id);
      if (!page) break;
      if ((await this.facts(page)).visible) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { windowId, tabKey: id };
  }

  /** Closes the connections: the browser keeps running. */
  dispose(): void {
    this.dropConnections();
  }
}
