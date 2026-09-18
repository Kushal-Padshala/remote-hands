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
}

export class BrowserDriver {
  private readonly cdpUrl: string;
  private messageSeq = 0;

  constructor(options?: BrowserDriverOptions) {
    this.cdpUrl = (options?.cdpUrl || 'http://127.0.0.1:9222').replace(/\/+$/, '');
  }

  async listTabs(): Promise<BrowserTab[]> {
    const res = await fetch(`${this.cdpUrl}/json`);
    if (!res.ok) {
      throw new Error(`Failed to list CDP targets: ${res.statusText}`);
    }
    const data = (await res.json()) as Array<Record<string, unknown>>;
    return data
      .filter((t) => t.type === 'page')
      .map((t) => ({
        id: String(t.id || ''),
        title: String(t.title || ''),
        url: String(t.url || ''),
        webSocketDebuggerUrl:
          typeof t.webSocketDebuggerUrl === 'string' ? t.webSocketDebuggerUrl : undefined,
      }));
  }

  async getActiveTab(): Promise<BrowserTab> {
    const tabs = await this.listTabs();
    if (tabs.length === 0) {
      throw new Error('No open Chrome tabs found on CDP port');
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

  private async executeScript<T>(script: string): Promise<T> {
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
        if (typeof node.select === 'function') node.select();
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
