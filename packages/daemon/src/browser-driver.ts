import { spawnSync } from 'node:child_process';
import {
  DOM_SNAPSHOT_SCRIPT,
  parseSnapshotOutput,
  type SnapshotResult,
} from './browser-snapshot.js';

export interface BrowserDriverOptions {
  cdpUrl?: string | undefined;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string | undefined;
  windowId?: string | number | undefined;
  windowIndex?: number | undefined;
  tabIndex?: number | undefined;
  active?: boolean | undefined;
}

export class BrowserDriver {
  private readonly cdpUrl: string;
  private messageSeq = 0;

  constructor(options?: BrowserDriverOptions) {
    this.cdpUrl = (options?.cdpUrl || 'http://127.0.0.1:9222').replace(/\/+$/, '');
  }

  private queryMacChromeTabs(): BrowserTab[] {
    try {
      const script = `
        tell application "Google Chrome"
          if not running then return ""
          set out to ""
          set wIdx to 1
          repeat with w in windows
            set wid to id of w
            set actIdx to active tab index of w
            set tCount to count of tabs of w
            repeat with tIdx from 1 to tCount
              set t to tab tIdx of w
              set isAct to (tIdx is actIdx)
              set out to out & wid & "\t" & wIdx & "\t" & tIdx & "\t" & isAct & "\t" & (title of t) & "\t" & (URL of t) & linefeed
            end repeat
            set wIdx to wIdx + 1
          end repeat
          return out
        end tell
      `;
      const res = spawnSync('osascript', ['-e', script], {
        encoding: 'utf-8',
        timeout: 2000,
      });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout.trim().split('\n').filter(Boolean);
        const tabs: BrowserTab[] = [];
        for (const line of lines) {
          const [wid, wIdx, tIdx, isAct, title, url] = line.split('\t');
          if (url) {
            const wIdxNum = parseInt(wIdx || '1', 10);
            const tIdxNum = parseInt(tIdx || '1', 10);
            const tabObj: BrowserTab = {
              id: `w${wIdx || '1'}-t${tIdx || '1'}`,
              title: title || '',
              url: url || '',
              windowIndex: Number.isNaN(wIdxNum) ? 1 : wIdxNum,
              tabIndex: Number.isNaN(tIdxNum) ? 1 : tIdxNum,
              active: isAct === 'true',
            };
            if (wid) tabObj.windowId = wid;
            tabs.push(tabObj);
          }
        }
        return tabs;
      }
    } catch {}
    return [];
  }

  private queryFrontmostActiveTabAppleScript(): { url?: string; title?: string } | null {
    try {
      const script = `
        tell application "Google Chrome"
          if not running or (count of windows) is 0 then return ""
          set t to active tab of front window
          return (URL of t) & "\t" & (title of t)
        end tell
      `;
      const res = spawnSync('osascript', ['-e', script], {
        encoding: 'utf-8',
        timeout: 1000,
      });
      if (res.status === 0 && res.stdout) {
        const [url, title] = res.stdout.trim().split('\t');
        const result: { url?: string; title?: string } = {};
        if (url) result.url = url;
        if (title) result.title = title;
        if (result.url || result.title) return result;
      }
    } catch {}
    return null;
  }

  async listTabs(): Promise<BrowserTab[]> {
    let cdpError: Error | null = null;
    try {
      const res = await fetch(`${this.cdpUrl}/json`);
      if (!res.ok) {
        throw new Error(`Failed to list CDP targets: ${res.statusText}`);
      }
      const data = (await res.json()) as Array<Record<string, unknown>>;
      const cdpTabs = data
        .filter((t) => t.type === 'page')
        .map((t) => {
          const tab: BrowserTab = {
            id: String(t.id || ''),
            title: String(t.title || ''),
            url: String(t.url || ''),
          };
          if (typeof t.webSocketDebuggerUrl === 'string') {
            tab.webSocketDebuggerUrl = t.webSocketDebuggerUrl;
          }
          return tab;
        });
      return cdpTabs;
    } catch (err: any) {
      cdpError = err;
      if (err.message && err.message.startsWith('Failed to list CDP targets:')) {
        throw err;
      }
    }

    if (process.platform === 'darwin') {
      const macTabs = this.queryMacChromeTabs();
      if (macTabs.length > 0) {
        return macTabs;
      }
    }

    throw cdpError || new Error('No open Chrome tabs found on CDP port or system Chrome');
  }

  async getActiveTab(): Promise<BrowserTab> {
    const tabs = await this.listTabs();
    if (tabs.length === 0) {
      throw new Error('No open Chrome tabs found on CDP port');
    }

    const explicitlyActive = tabs.find((t) => t.active);
    if (explicitlyActive) return explicitlyActive;

    if (process.platform === 'darwin') {
      try {
        const active = this.queryFrontmostActiveTabAppleScript();
        if (active?.url) {
          const matchedByUrl = tabs.find((t) => t.url === active.url);
          if (matchedByUrl) return matchedByUrl;
        }
        const activeTitle = active?.title;
        if (activeTitle) {
          const matchedByTitle = tabs.find(
            (t) => t.title === activeTitle || t.title.startsWith(activeTitle) || activeTitle.startsWith(t.title),
          );
          if (matchedByTitle) return matchedByTitle;
        }
      } catch {}
    }

    return tabs[0]!;
  }

  protected async createWebSocket(url: string): Promise<any> {
    try {
      const wsPkg = 'ws';
      const wsModule: any = await import(wsPkg);
      const Ws = wsModule.WebSocket || wsModule.default;
      if (Ws) {
        return new Ws(url);
      }
    } catch {}
    const GlobalWs = (globalThis as any).WebSocket;
    if (GlobalWs) {
      return new GlobalWs(url);
    }
    throw new Error('WebSocket implementation not found');
  }

  private attachWebSocketEvents(
    ws: any,
    onOpen: () => void,
    onMessage: (data: any) => void,
    onError: (err: any) => void,
    onClose?: () => void,
  ): void {
    if (typeof ws.on === 'function') {
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('error', onError);
      if (onClose) ws.on('close', onClose);
    } else if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', (event: any) => onMessage(event.data));
      ws.addEventListener('error', onError);
      if (onClose) ws.addEventListener('close', onClose);
    } else {
      ws.onopen = onOpen;
      ws.onmessage = (event: any) => onMessage(event.data);
      ws.onerror = onError;
      if (onClose) ws.onclose = onClose;
    }
    if (ws.readyState === 1) {
      queueMicrotask(() => onOpen());
    }
  }

  async executeScript<T>(script: string): Promise<T> {
    const tab = await this.getActiveTab();
    const wsUrl = tab.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new Error('Active tab does not provide webSocketDebuggerUrl');
    }

    const ws = await this.createWebSocket(wsUrl);
    const id = ++this.messageSeq;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('CDP execution timed out after 5000ms'));
      }, 5000);

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {}
      };

      const handleOpen = () => {
        try {
          ws.send(
            JSON.stringify({
              id,
              method: 'Runtime.evaluate',
              params: {
                expression: script,
                returnByValue: true,
                awaitPromise: true,
              },
            }),
          );
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      const handleMessage = (data: any) => {
        if (settled) return;
        try {
          const raw =
            typeof data === 'string'
              ? data
              : data instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(data))
                ? data.toString()
                : String(data);
          const res = JSON.parse(raw);
          if (res.id === id) {
            cleanup();
            if (res.error) {
              reject(new Error(res.error.message || 'CDP execution failed'));
            } else if (res.result?.exceptionDetails) {
              reject(
                new Error(
                  res.result.exceptionDetails.text || 'JavaScript exception during execution',
                ),
              );
            } else {
              resolve(res.result?.result?.value as T);
            }
          }
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      const handleError = (err: any) => {
        cleanup();
        reject(err);
      };

      const handleClose = () => {
        cleanup();
        reject(new Error('WebSocket connection closed before CDP response was received'));
      };

      this.attachWebSocketEvents(ws, handleOpen, handleMessage, handleError, handleClose);
    });
  }

  async snapshot(): Promise<SnapshotResult> {
    const raw = await this.executeScript<unknown>(DOM_SNAPSHOT_SCRIPT);
    return parseSnapshotOutput(raw);
  }

  async clickIndex(index: number): Promise<{ success: boolean; label: string }> {
    const snap = await this.snapshot();
    const target = snap.elements.find((e) => e.index === index);
    if (!target) {
      throw new Error(`Index ${index} not found. Run snapshot to view current indexed elements.`);
    }

    const clickScript = `
      (() => {
        const node = window.__rhFast?.nodes.get(${target.id});
        if (!node) throw new Error('Target node no longer connected');
        node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        node.focus();
        node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        node.click();
        return true;
      })()
    `;
    await this.executeScript<boolean>(clickScript);
    return { success: true, label: target.label || target.role || 'element' };
  }

  async typeIndex(index: number, text: string): Promise<{ success: boolean; label: string }> {
    const snap = await this.snapshot();
    const target = snap.elements.find((e) => e.index === index);
    if (!target) {
      throw new Error(`Index ${index} not found. Run snapshot to view current indexed elements.`);
    }

    const escaped = JSON.stringify(text);
    const typeScript = `
      (() => {
        const node = window.__rhFast?.nodes.get(${target.id});
        if (!node) throw new Error('Target node no longer connected');
        node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        node.focus();
        if (typeof node.select === 'function') {
          node.select();
        } else if (window.getSelection && document.createRange) {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(node);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, ${escaped});
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `;
    await this.executeScript<boolean>(typeScript);
    return { success: true, label: target.label || target.role || 'element' };
  }

  async findTab(query: string): Promise<BrowserTab | undefined> {
    const tabs = await this.listTabs();
    if (tabs.length === 0) return undefined;
    const norm = query.trim().toLowerCase();
    let targetHostPath = '';
    try {
      const u = new URL(query);
      targetHostPath = `${u.host}${u.pathname}`.replace(/\/+$/, '').toLowerCase();
    } catch {}

    return tabs.find((t) => {
      if (t.id.toLowerCase() === norm) return true;
      if (t.url.toLowerCase() === norm) return true;
      if (targetHostPath) {
        try {
          const u = new URL(t.url);
          const hostPath = `${u.host}${u.pathname}`.replace(/\/+$/, '').toLowerCase();
          if (hostPath === targetHostPath) return true;
        } catch {}
      }
      if (t.url.toLowerCase().includes(norm)) return true;
      if (t.title.toLowerCase().includes(norm)) return true;
      return false;
    });
  }

  async focusTab(target: string | number): Promise<{ success: boolean; tab: BrowserTab }> {
    const tabs = await this.listTabs();
    if (tabs.length === 0) {
      throw new Error('No open Chrome tabs found');
    }
    let matched: BrowserTab | undefined;
    if (typeof target === 'number') {
      matched = tabs[target - 1] || tabs.find((t) => t.tabIndex === target);
    } else {
      const norm = target.trim().toLowerCase();
      matched = tabs.find((t) => t.id.toLowerCase() === norm);
      if (!matched) {
        matched = tabs.find((t) => t.url.toLowerCase() === norm);
      }
      if (!matched) {
        matched = tabs.find((t) => t.url.toLowerCase().includes(norm));
      }
      if (!matched) {
        matched = tabs.find((t) => t.title.toLowerCase().includes(norm));
      }
      if (!matched && /^\d+$/.test(norm)) {
        const idx = parseInt(norm, 10);
        matched = tabs[idx - 1];
      }
    }
    if (!matched) {
      throw new Error(`Tab matching "${target}" not found`);
    }

    if (matched.webSocketDebuggerUrl) {
      try {
        await fetch(`${this.cdpUrl}/json/activate/${matched.id}`);
      } catch {}
    }

    if (process.platform === 'darwin') {
      try {
        const widClause = matched.windowId
          ? `window id ${matched.windowId}`
          : matched.windowIndex
            ? `window ${matched.windowIndex}`
            : 'front window';
        const tIdx = matched.tabIndex ?? 1;
        const script = `
          tell application "Google Chrome"
            set active tab index of ${widClause} to ${tIdx}
            set index of ${widClause} to 1
          end tell
        `;
        spawnSync('osascript', ['-e', script], { encoding: 'utf-8', timeout: 1500 });
      } catch {}
    }

    matched.active = true;
    return { success: true, tab: matched };
  }

  async openUrl(url: string): Promise<{ success: boolean; url: string }> {
    const tab = await this.getActiveTab();
    const wsUrl = tab.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new Error('Active tab does not provide webSocketDebuggerUrl');
    }

    const ws = await this.createWebSocket(wsUrl);
    const id = ++this.messageSeq;

    return new Promise<{ success: boolean; url: string }>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Navigation timed out after 10000ms'));
      }, 10000);

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {}
      };

      const handleOpen = () => {
        try {
          ws.send(JSON.stringify({ id, method: 'Page.navigate', params: { url } }));
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      const handleMessage = (data: any) => {
        if (settled) return;
        try {
          const raw =
            typeof data === 'string'
              ? data
              : data instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(data))
                ? data.toString()
                : String(data);
          const res = JSON.parse(raw);
          if (res.id === id) {
            cleanup();
            if (res.error) {
              reject(new Error(res.error.message || 'Navigation failed'));
            } else if (res.result?.errorText) {
              reject(new Error(`Navigation failed: ${res.result.errorText}`));
            } else {
              resolve({ success: true, url });
            }
          }
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      const handleError = (err: any) => {
        cleanup();
        reject(err);
      };

      const handleClose = () => {
        cleanup();
        reject(new Error('WebSocket connection closed before navigation response'));
      };

      this.attachWebSocketEvents(ws, handleOpen, handleMessage, handleError, handleClose);
    });
  }
}
