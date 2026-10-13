import { BrowserAutomationError, type TabTarget } from './applescript.js';
import type { BrowserApp } from './browsers.js';
import type { TabInfo } from './transport.js';

/**
 * The fast browser engine's transport for browsers that are not driven through AppleScript (Windows, Linux): it
 * speaks the Chrome DevTools Protocol to a Chromium browser that was started with a debugging port. It offers the
 * same five methods as `AppleScriptTransport`, so the page scripts, rendering and fall-back logic are shared.
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

export interface CdpTransportOptions {
  port?: number | undefined;
  host?: string | undefined;
  /** Starts the browser when nothing answers on the port; says whether it is up. Called at most once per cool-down. */
  ensureBrowser?: (() => Promise<boolean>) | undefined;
  fetchFn?: typeof fetch | undefined;
  openSocket?: ((url: string) => CdpSocket) | undefined;
  now?: (() => number) | undefined;
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
        for (const [, p] of conn.pending) p.reject(new Error('the browser closed the connection'));
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
        reject(new Error('the browser closed the connection'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeout());
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
        reject(err instanceof Error ? err : new Error(String(err)));
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

class CdpTimeout extends Error {
  constructor() {
    super('the browser did not answer in time');
  }
}

/** The browser's friendly name from `/json/version`'s `Browser` field ("Chrome/130.0.0.0", "Edg/130.0.0.0"). */
export function browserNameFromVersion(version: string | undefined): string {
  return /^Edg(e|A|iOS)?\//i.test(version ?? '') ? 'Microsoft Edge' : 'Google Chrome';
}

export class CdpTransport {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly openSocket: (url: string) => CdpSocket;
  private readonly ensureBrowser: (() => Promise<boolean>) | undefined;
  private readonly now: () => number;
  private readonly connections = new Map<string, CdpConnection>();
  private browserConnection: CdpConnection | null = null;
  /** Tabs keep the position they first appeared at, so labels like w1-t2 stay put while tabs are used. */
  private readonly order = new Map<string, number>();
  private orderCounter = 0;
  private starting: Promise<boolean> | null = null;
  private lastStartFailure = -Infinity;
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
  private async startBrowser(): Promise<boolean> {
    if (!this.ensureBrowser) return false;
    if (this.now() - this.lastStartFailure < START_COOLDOWN_MS) return false;
    if (!this.starting) {
      this.starting = this.ensureBrowser()
        .catch(() => false)
        .then((ok) => {
          if (!ok) this.lastStartFailure = this.now();
          return ok;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  // ---- what the fast engine asks for -------------------------------------------------------

  /** The browser that answers on the port, starting it first when nothing does. Never throws. */
  async environment(): Promise<{ frontmost: string | null; running: string[] }> {
    let v = await this.version();
    if (!v && (await this.startBrowser())) v = await this.version();
    if (!v) {
      this.dropConnections();
      return { frontmost: null, running: [] };
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

  private async browserSocket(): Promise<CdpConnection | null> {
    if (this.browserConnection && !this.browserConnection.closed) return this.browserConnection;
    const v = await this.version();
    if (!v?.webSocketDebuggerUrl) return null;
    try {
      this.browserConnection = await CdpConnection.open(v.webSocketDebuggerUrl, this.openSocket, CONNECT_TIMEOUT_MS);
      return this.browserConnection;
    } catch {
      return null;
    }
  }

  private async connection(target: CdpTarget): Promise<CdpConnection> {
    const known = this.connections.get(target.id);
    if (known && !known.closed) return known;
    if (!target.webSocketDebuggerUrl) {
      throw failure('no_tab', this.name, 'That tab cannot be controlled (another tool is attached to it). Open it in a new tab.');
    }
    try {
      const conn = await CdpConnection.open(target.webSocketDebuggerUrl, this.openSocket, CONNECT_TIMEOUT_MS);
      this.connections.set(target.id, conn);
      return conn;
    } catch {
      throw failure('script_error', this.name, `${this.name} did not accept the connection to that tab.`);
    }
  }

  private dropConnections(): void {
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.browserConnection?.close();
    this.browserConnection = null;
  }

  async listTabs(b: BrowserApp): Promise<TabInfo[]> {
    this.name = b.name;
    const pages = await this.pages();
    const present = new Set(pages.map((p) => p.id));
    for (const id of [...this.order.keys()]) if (!present.has(id)) this.order.delete(id);
    for (const [id, conn] of [...this.connections]) {
      if (!present.has(id)) {
        conn.close();
        this.connections.delete(id);
      }
    }
    for (const p of pages) if (!this.order.has(p.id)) this.order.set(p.id, this.orderCounter++);

    // Which window a tab is in, and which tab of each window is the one showing.
    const browser = await this.browserSocket();
    const windowOf = async (p: CdpTarget): Promise<string> => {
      if (!browser) return '1';
      try {
        const res = await browser.call<{ windowId?: number }>('Browser.getWindowForTarget', { targetId: p.id }, 2000);
        return typeof res?.windowId === 'number' ? String(res.windowId) : '1';
      } catch {
        return '1';
      }
    };
    const visible = async (p: CdpTarget): Promise<boolean> => {
      try {
        const conn = await this.connection(p);
        const res = await conn.call<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression: 'document.visibilityState', returnByValue: true },
          1500,
        );
        return res?.result?.value === 'visible';
      } catch {
        return false;
      }
    };
    const windowIds = await Promise.all(pages.map(windowOf));
    const showing = await Promise.all(pages.map(visible));

    // Windows are numbered in the order their most recently used tab comes (the browser lists tabs most recent first).
    const windowIndex = new Map<string, number>();
    for (const id of windowIds) if (!windowIndex.has(id)) windowIndex.set(id, windowIndex.size + 1);

    const rows = pages.map((p, i) => ({ p, windowId: windowIds[i]!, showing: showing[i]!, seq: this.order.get(p.id)! }));
    const activeIn = new Map<string, string>();
    for (const r of rows) if (r.showing && !activeIn.has(r.windowId)) activeIn.set(r.windowId, r.p.id);
    // A window with no tab that reports showing (all hidden): its most recent tab stands in.
    for (const r of rows) if (!activeIn.has(r.windowId)) activeIn.set(r.windowId, r.p.id);

    const tabs: TabInfo[] = [];
    for (const [windowId, index] of windowIndex) {
      const inWindow = rows.filter((r) => r.windowId === windowId).sort((a, b) => a.seq - b.seq);
      inWindow.forEach((r, i) =>
        tabs.push({
          windowId,
          windowIndex: index,
          tabKey: r.p.id,
          tabIndex: i + 1,
          title: r.p.title ?? '',
          url: r.p.url ?? '',
          active: activeIn.get(windowId) === r.p.id,
        }),
      );
    }
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
    // The front tab: the first of the most recently used that is showing, else the most recent.
    const front = (await this.listTabs(b)).filter((t) => t.active).sort((a, c) => a.windowIndex - c.windowIndex)[0];
    return pages.find((p) => p.id === front?.tabKey) ?? pages[0]!;
  }

  async evaluate(b: BrowserApp, target: TabTarget | null, js: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    this.name = b.name;
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const page = await this.resolveTarget(b, target);
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
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
        // a connection that went away between calls: connect again once
        lastError = err;
        this.connections.delete(page.id);
        conn.close();
      }
    }
    throw failure('script_error', b.name, `${b.name} automation failed: ${lastError instanceof Error ? lastError.message : 'connection lost'}.`);
  }

  async focusTab(b: BrowserApp, target: TabTarget): Promise<void> {
    this.name = b.name;
    const pages = await this.pages();
    if (!pages.some((p) => p.id === target.tabKey)) {
      throw failure('no_tab', b.name, 'The target tab is gone. Call browser_tabs and focus a tab again.');
    }
    const done = await this.http(`/json/activate/${encodeURIComponent(target.tabKey)}`);
    if (done === null) throw failure('script_error', b.name, `${b.name} would not switch to that tab.`);
  }

  async openUrl(b: BrowserApp, url: string, _windowId?: string): Promise<void> {
    this.name = b.name;
    if (!/^(https?:|about:blank$)/i.test(url.trim())) throw failure('script_error', b.name, 'Only web addresses can be opened.');
    // Chrome 111+ wants PUT; older versions answer GET. The address is one component, so & and # stay part of it.
    const encoded = encodeURIComponent(url.trim());
    let made = await this.http(`/json/new?${encoded}`, 'PUT');
    if (made === null) made = await this.http(`/json/new?${encoded}`, 'GET');
    if (made === null) throw failure('script_error', b.name, `${b.name} would not open a new tab.`);
    // Like a person opening a tab, the new tab comes to the front, and the call returns once it has.
    const id = typeof made === 'object' ? (made as { id?: unknown }).id : undefined;
    if (typeof id !== 'string') return;
    await this.http(`/json/activate/${encodeURIComponent(id)}`);
    for (let i = 0; i < 15; i++) {
      const page = (await this.pages().catch(() => [])).find((p) => p.id === id);
      if (!page) return;
      try {
        const conn = await this.connection(page);
        const res = await conn.call<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, 1000);
        if (res?.result?.value === 'visible') return;
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Closes the connections: the browser keeps running. */
  dispose(): void {
    this.dropConnections();
  }
}
