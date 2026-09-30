import { spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  DOM_SNAPSHOT_SCRIPT,
  parseSnapshotOutput,
  type SnapshotResult,
} from './browser-snapshot.js';
import { AxWalker } from './desktop/ax-walker.js';
import { performAxAction, setAxElementValue } from './desktop/ax-actions.js';
import { MacOsDriver } from './desktop/macos-driver.js';

export interface BrowserDriverOptions {
  cdpUrl?: string | undefined;
  forceWebSocket?: boolean | undefined;
  socketPath?: string | undefined;
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
  targetId?: string | undefined;
}

export class BrowserDriver {
  private readonly cdpUrl: string;
  private readonly forceWebSocket: boolean;
  private readonly customSocketPath?: string | undefined;
  private messageSeq = 0;

  constructor(options?: BrowserDriverOptions) {
    this.cdpUrl = (options?.cdpUrl || 'http://127.0.0.1:9222').replace(/\/+$/, '');
    this.forceWebSocket = Boolean(options?.forceWebSocket);
    this.customSocketPath = options?.socketPath;
  }

  private getHarnessSocketPath(): string | null {
    if (this.customSocketPath && fs.existsSync(this.customSocketPath)) {
      return this.customSocketPath;
    }
    if (process.env.BU_SOCK_PATH && fs.existsSync(process.env.BU_SOCK_PATH)) {
      return process.env.BU_SOCK_PATH;
    }
    const buName = process.env.BU_NAME || 'default';
    const defaultPath = path.join(os.homedir(), '.config', 'browser-harness', 'runtime', `bu-${buName}.sock`);
    if (fs.existsSync(defaultPath)) {
      return defaultPath;
    }
    return null;
  }

  private callHarnessSocket<T = any>(req: Record<string, unknown>, timeoutMs = 4000): Promise<T> {
    const sockPath = this.getHarnessSocketPath();
    if (!sockPath) {
      return Promise.reject(new Error('Browser harness socket not found'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const client = net.createConnection(sockPath);
      let buffer = '';

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Browser harness socket request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          client.destroy();
        } catch {}
      };

      client.on('connect', () => {
        client.write(JSON.stringify(req) + '\n');
      });

      client.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        if (buffer.includes('\n')) {
          const line = buffer.slice(0, buffer.indexOf('\n')).trim();
          cleanup();
          try {
            const parsed = JSON.parse(line);
            if (parsed.error) {
              reject(new Error(typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)));
            } else {
              resolve(parsed.result !== undefined ? (parsed.result as T) : (parsed as T));
            }
          } catch (err) {
            reject(err);
          }
        }
      });

      client.on('error', (err) => {
        cleanup();
        reject(err);
      });
    });
  }

  async callCdp(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const sockPath = this.getHarnessSocketPath();
    if (sockPath && !this.forceWebSocket) {
      try {
        const res = await this.callHarnessSocket<any>({
          method,
          params,
          session_id: sessionId,
        });
        return res;
      } catch {}
    }
    return this.executeScript<any>(`cdp(${JSON.stringify(method)}, ${JSON.stringify(params)})`);
  }

  private async dispatchCdpClick(x: number, y: number): Promise<void> {
    const roundX = Math.round(x);
    const roundY = Math.round(y);
    try {
      await this.callCdp('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: roundX,
        y: roundY,
        button: 'left',
        clickCount: 1,
      });
      await this.callCdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: roundX,
        y: roundY,
        button: 'left',
        clickCount: 1,
      });
    } catch {}
  }

  private async dispatchCdpType(x: number, y: number, text: string): Promise<void> {
    await this.dispatchCdpClick(x, y);
    try {
      await this.callCdp('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        modifiers: process.platform === 'darwin' ? 4 : 2,
        commands: ['selectAll'],
      });
      await this.callCdp('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        modifiers: process.platform === 'darwin' ? 4 : 2,
      });
      await this.callCdp('Input.insertText', { text });
    } catch {}
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
        if (tabs.length > 0) return tabs;
      }
    } catch {}

    try {
      const swiftScript = `
import Cocoa
import ApplicationServices
let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.google.Chrome" }
guard let chrome = apps.first else { exit(0) }
let appEl = AXUIElementCreateApplication(chrome.processIdentifier)
var wins: AnyObject?
_ = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wins)
guard let winList = wins as? [AXUIElement], !winList.isEmpty else { exit(0) }
func getAttr(_ el: AXUIElement, _ attr: String) -> String {
    var val: AnyObject?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &val) == .success, let v = val { return "\\(v)" }
    return ""
}
func findAddress(_ el: AXUIElement, depth: Int) -> String {
    if depth > 10 { return "" }
    let role = getAttr(el, kAXRoleAttribute)
    let desc = getAttr(el, kAXDescriptionAttribute)
    if role == "AXTextField" && desc == "Address and search bar" { return getAttr(el, kAXValueAttribute) }
    var children: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success, let list = children as? [AXUIElement] {
        for c in list {
            let u = findAddress(c, depth: depth + 1)
            if !u.isEmpty { return u }
        }
    }
    return ""
}
var frontmostWin: AXUIElement?
var focVal: AnyObject?
if AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &focVal) == .success, let w = focVal { frontmostWin = (w as! AXUIElement) }
if frontmostWin == nil {
    var mainVal: AnyObject?
    if AXUIElementCopyAttributeValue(appEl, kAXMainWindowAttribute as CFString, &mainVal) == .success, let w = mainVal { frontmostWin = (w as! AXUIElement) }
}
if frontmostWin == nil { frontmostWin = winList.first }
for (wIdx, w) in winList.enumerated() {
    let rawTitle = getAttr(w, kAXTitleAttribute)
    var cleanTitle = rawTitle
    if let r = cleanTitle.range(of: " - Google Chrome") { cleanTitle = String(cleanTitle[..<r.lowerBound]) }
    let url = findAddress(w, depth: 0)
    let isAct = frontmostWin != nil && CFEqual(w, frontmostWin!)
    print("\\(wIdx + 1)\\t\\(wIdx + 1)\\t1\\t\\(isAct)\\t\\(cleanTitle)\\t\\(url)")
}
`;
      const res = spawnSync('swift', ['-e', swiftScript], { encoding: 'utf-8', timeout: 2000 });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout.trim().split('\n').filter(Boolean);
        const tabs: BrowserTab[] = [];
        for (const line of lines) {
          const [wid, wIdx, tIdx, isAct, title, url] = line.split('\t');
          const wIdxNum = parseInt(wIdx || '1', 10);
          const tIdxNum = parseInt(tIdx || '1', 10);
          tabs.push({
            id: `w${wIdx || '1'}-t${tIdx || '1'}`,
            title: title || '',
            url: url || '',
            windowIndex: Number.isNaN(wIdxNum) ? 1 : wIdxNum,
            tabIndex: Number.isNaN(tIdxNum) ? 1 : tIdxNum,
            active: isAct === 'true',
            windowId: wid,
          });
        }
        if (tabs.length > 0) return tabs;
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

    try {
      const swiftScript = `
import Cocoa
import ApplicationServices
let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.google.Chrome" }
guard let chrome = apps.first else { exit(0) }
let appEl = AXUIElementCreateApplication(chrome.processIdentifier)
var wins: AnyObject?
_ = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wins)
guard let winList = wins as? [AXUIElement], !winList.isEmpty else { exit(0) }
func getAttr(_ el: AXUIElement, _ attr: String) -> String {
    var val: AnyObject?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &val) == .success, let v = val { return "\\(v)" }
    return ""
}
func findAddress(_ el: AXUIElement, depth: Int) -> String {
    if depth > 10 { return "" }
    let role = getAttr(el, kAXRoleAttribute)
    let desc = getAttr(el, kAXDescriptionAttribute)
    if role == "AXTextField" && desc == "Address and search bar" { return getAttr(el, kAXValueAttribute) }
    var children: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success, let list = children as? [AXUIElement] {
        for c in list {
            let u = findAddress(c, depth: depth + 1)
            if !u.isEmpty { return u }
        }
    }
    return ""
}
var rootWin: AXUIElement?
var focVal: AnyObject?
if AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &focVal) == .success, let w = focVal { rootWin = (w as! AXUIElement) }
if rootWin == nil {
    var mainVal: AnyObject?
    if AXUIElementCopyAttributeValue(appEl, kAXMainWindowAttribute as CFString, &mainVal) == .success, let w = mainVal { rootWin = (w as! AXUIElement) }
}
if rootWin == nil { rootWin = winList.first }
guard let target = rootWin else { exit(0) }
let rawTitle = getAttr(target, kAXTitleAttribute)
var cleanTitle = rawTitle
if let r = cleanTitle.range(of: " - Google Chrome") { cleanTitle = String(cleanTitle[..<r.lowerBound]) }
let url = findAddress(target, depth: 0)
print("\\(url)\\t\\(cleanTitle)")
`;
      const res = spawnSync('swift', ['-e', swiftScript], { encoding: 'utf-8', timeout: 2000 });
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
        if (res.status === 404 || res.statusText === 'Not Found') {
          cdpError = new Error(`Failed to list CDP targets: ${res.statusText}`);
        } else {
          throw new Error(`Failed to list CDP targets: ${res.statusText}`);
        }
      } else {
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
      }
    } catch (err: any) {
      cdpError = err;
      if (err.message && err.message.startsWith('Failed to list CDP targets:') && !err.message.includes('Not Found')) {
        throw err;
      }
    }

    if ((process.env.VITEST !== 'true' || this.customSocketPath) && !this.forceWebSocket) {
      const sockPath = this.getHarnessSocketPath();
      if (sockPath) {
        try {
          const currentTabRes = await this.callHarnessSocket<any>({ meta: 'current_tab' });
          const targetsRes = await this.callHarnessSocket<any>({ method: 'Target.getTargets', params: {} });
          const targetInfos = Array.isArray(targetsRes?.targetInfos) ? targetsRes.targetInfos : [];
          const pageTargets = targetInfos.filter((t: any) => t.type === 'page');
          if (pageTargets.length > 0) {
            return pageTargets.map((t: any, idx: number) => ({
              id: t.targetId || `t${idx + 1}`,
              targetId: t.targetId,
              title: t.title || '',
              url: t.url || '',
              active: t.targetId === currentTabRes?.targetId,
            }));
          }
        } catch {}
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

    const explicitlyActive = tabs.find((t) => t.active);
    if (explicitlyActive) return explicitlyActive;

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

  private async executeScriptViaWs<T>(wsUrl: string, script: string): Promise<T> {
    const ws = await this.createWebSocket(wsUrl);
    return new Promise<T>((resolve, reject) => {
        const id = ++this.messageSeq;
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

  async executeScript<T>(script: string): Promise<T> {
    const tab = await this.getActiveTab();
    const wsUrl = tab.webSocketDebuggerUrl;
    if (wsUrl) {
      return this.executeScriptViaWs<T>(wsUrl, script);
    }

    if ((process.env.VITEST !== 'true' || this.customSocketPath) && !this.forceWebSocket) {
      const sockPath = this.getHarnessSocketPath();
      if (sockPath) {
        try {
          const res = await this.callHarnessSocket<any>({
            method: 'Runtime.evaluate',
            params: {
              expression: script,
              returnByValue: true,
              awaitPromise: true,
            },
          });
          const exc = res?.exceptionDetails || res?.result?.exceptionDetails;
          if (exc) {
            throw new Error(exc.text || exc.exception?.description || 'JavaScript exception during execution');
          }
          const val = res?.result?.value !== undefined ? res.result.value : res?.value !== undefined ? res.value : res;
          return val as T;
        } catch (err: any) {
          if (err?.message?.includes('JavaScript exception') || err?.message?.includes('Target node no longer connected')) {
            throw err;
          }
        }
      }
    }

    throw new Error('Active tab does not provide webSocketDebuggerUrl');
  }

  async snapshotNativeChrome(): Promise<SnapshotResult> {
    const activeTab = this.queryFrontmostActiveTabAppleScript();
    const walker = new AxWalker({ driver: new MacOsDriver() });
    const elements = await walker.walkActiveApp('Google Chrome', {
      allowOcr: false,
      windowTitle: activeTab?.title,
    });
    const mapped = elements.map((e) => ({
      index: e.index,
      id: e.index,
      role: e.role,
      label: e.label,
      tag: e.role,
      bounds: e.bounds,
    }));
    const rawText = mapped.map((e) => `[${e.index}] ${e.role} "${e.label}"`).join('\n');
    return {
      url: activeTab?.url || '',
      title: activeTab?.title || 'Google Chrome',
      elements: mapped,
      formattedTable: rawText || 'No interactive elements found.',
    };
  }

  async snapshot(): Promise<SnapshotResult> {
    if (process.env.VITEST === 'true') {
      try {
        const raw = await this.executeScript<unknown>(DOM_SNAPSHOT_SCRIPT);
        return parseSnapshotOutput(raw);
      } catch {
        return this.snapshotNativeChrome();
      }
    }
    if (process.platform === 'darwin') {
      try {
        const tab = await this.getActiveTab();
        if (!tab.webSocketDebuggerUrl && !this.getHarnessSocketPath()) {
          return this.snapshotNativeChrome();
        }
      } catch {
        return this.snapshotNativeChrome();
      }
    }
    try {
      const raw = await this.executeScript<unknown>(DOM_SNAPSHOT_SCRIPT);
      return parseSnapshotOutput(raw);
    } catch (err) {
      if (process.platform === 'darwin') {
        return this.snapshotNativeChrome();
      }
      throw err;
    }
  }

  async clickIndex(index: number | string): Promise<{ success: boolean; label: string }> {
    const snap = await this.snapshot();
    const target = snap.elements.find((e) => {
      if (typeof index === 'number') {
        return e.index === index || e.id === index || e.id === `e${index}`;
      }
      const s = String(index).trim().toLowerCase();
      return String(e.id).toLowerCase() === s ||
             String(e.index) === s ||
             `e${e.index}`.toLowerCase() === s;
    });
    if (!target) {
      throw new Error(`Index ${index} not found. Run snapshot to view current indexed elements.`);
    }

    if (process.platform === 'darwin' && (target.role.startsWith('AX') || (process.env.VITEST !== 'true' && target.node === undefined && !target.tag))) {
      spawnSync('osascript', ['-e', 'tell application "Google Chrome" to activate'], { timeout: 1000 });
      const activeTab = this.queryFrontmostActiveTabAppleScript();
      const winTitle = snap.title || activeTab?.title;
      let success = await performAxAction(
        'Google Chrome',
        {
          index: target.index,
          role: target.role,
          label: target.label,
          windowTitle: winTitle,
          bounds: (target as any).bounds,
        },
        'AXPress',
      );
      if (!success && winTitle) {
        success = await performAxAction(
          'Google Chrome',
          {
            index: target.index,
            role: target.role,
            label: target.label,
            bounds: (target as any).bounds,
          },
          'AXPress',
        );
      }
      if (success) {
        return { success: true, label: target.label || target.role || 'element' };
      }
      throw new Error(`Failed to click element ${index} (${target.label || target.role}) in Google Chrome`);
    }

    const targetIdVal = typeof target.id === 'number' ? target.id : JSON.stringify(target.id);
    const targetNodeVal = typeof target.node === 'number' ? target.node : 'null';

    try {

      const clickScript = `
        (() => {
          const cache = window.__rhFast || window.__jevFast;
          const node = (typeof ${targetNodeVal} === 'number' ? cache?.nodes?.get(${targetNodeVal}) : null) ||
                       window.__rhFast?.nodes.get(${targetIdVal}) ||
                       window.__jevFast?.nodes.get(${targetIdVal});
          if (node) {
            node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            node.focus();
            if (node.tagName === 'SELECT' && ${JSON.stringify(target.value ?? '')}) {
              node.value = ${JSON.stringify(target.value ?? '')};
              node.dispatchEvent(new Event('input', { bubbles: true }));
              node.dispatchEvent(new Event('change', { bubbles: true }));
            }
            node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
            node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
            node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            node.click();
            const r = node.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, clicked: true };
          }
          const sel = ${JSON.stringify(target.label || '')};
          if (sel) {
            const el = Array.from(document.querySelectorAll('button, a, input, [role="button"], [role="radio"], [role="checkbox"], [role="tab"], label'))
              .find(e => (e.innerText || e.textContent || '').trim().toLowerCase() === sel.toLowerCase() ||
                         e.getAttribute('aria-label') === sel);
            if (el) {
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              el.focus();
              el.click();
              const r = el.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2, clicked: true };
            }
          }
          return null;
        })()
      `;
      const clickResult = await this.executeScript<any>(clickScript);
      if (clickResult && typeof clickResult === 'object' && typeof clickResult.x === 'number') {
        try {
          await this.dispatchCdpClick(clickResult.x, clickResult.y);
        } catch {}
      }
      return { success: true, label: target.label || target.role || 'element' };
    } catch (err: any) {
      if (process.platform === 'darwin') {
        const walker = new AxWalker({ driver: new MacOsDriver() });
        const elements = await walker.walkActiveApp('Google Chrome', { allowOcr: false });
        const target = elements.find((e) => {
          if (typeof index === 'number') return e.index === index;
          const s = String(index).replace(/^e/i, '');
          return String(e.index) === s;
        });
        if (!target) {
          throw new Error(`Index ${index} not found. Run snapshot to view current indexed elements.`);
        }
        const success = await performAxAction(
          'Google Chrome',
          { index: target.index, bounds: target.bounds, role: target.role, label: target.label },
          'AXPress',
        );
        if (success) {
          return { success: true, label: target.label || target.role || 'element' };
        }
      }
      throw err;
    }
  }

  async typeIndex(index: number | string, text: string): Promise<{ success: boolean; label: string }> {
    const snap = await this.snapshot();
    const target = snap.elements.find((e) => {
      if (typeof index === 'number') {
        return e.index === index || e.id === index || e.id === `e${index}`;
      }
      const s = String(index).trim().toLowerCase();
      return String(e.id).toLowerCase() === s ||
             String(e.index) === s ||
             `e${e.index}`.toLowerCase() === s;
    });
    if (!target) {
      throw new Error(`Index ${index} not found. Run snapshot to view current indexed elements.`);
    }

    if (process.platform === 'darwin' && (target.role.startsWith('AX') || (process.env.VITEST !== 'true' && target.node === undefined && !target.tag))) {
      spawnSync('osascript', ['-e', 'tell application "Google Chrome" to activate'], { timeout: 1000 });
      const activeTab = this.queryFrontmostActiveTabAppleScript();
      const winTitle = snap.title || activeTab?.title;
      let success = await setAxElementValue(
        'Google Chrome',
        {
          index: target.index,
          role: target.role,
          label: target.label,
          windowTitle: winTitle,
        },
        text,
      );
      if (!success && winTitle) {
        success = await setAxElementValue(
          'Google Chrome',
          {
            index: target.index,
            role: target.role,
            label: target.label,
          },
          text,
        );
      }
      if (success) {
        return { success: true, label: target.label || target.role || 'element' };
      }
      let pressSuccess = await performAxAction(
        'Google Chrome',
        {
          index: target.index,
          role: target.role,
          label: target.label,
          windowTitle: winTitle,
        },
        'AXPress',
      );
      if (!pressSuccess && winTitle) {
        pressSuccess = await performAxAction(
          'Google Chrome',
          {
            index: target.index,
            role: target.role,
            label: target.label,
          },
          'AXPress',
        );
      }
      if (pressSuccess) {
        const driver = new MacOsDriver();
        await driver.typeText(text);
        return { success: true, label: target.label || target.role || 'element' };
      }
      throw new Error(`Failed to type into element ${index} (${target.label || target.role}) in Google Chrome`);
    }

    const targetIdVal = typeof target.id === 'number' ? target.id : JSON.stringify(target.id);
    const targetNodeVal = typeof target.node === 'number' ? target.node : 'null';
    const escaped = JSON.stringify(text);

    try {
      const typeScript = `
        (() => {
          const cache = window.__rhFast || window.__jevFast;
          const node = (typeof ${targetNodeVal} === 'number' ? cache?.nodes?.get(${targetNodeVal}) : null) ||
                       window.__rhFast?.nodes.get(${targetIdVal}) ||
                       window.__jevFast?.nodes.get(${targetIdVal});
          if (node) {
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
            if ('value' in node) {
              node.value = ${escaped};
            }
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            const r = node.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
          const sel = ${JSON.stringify(target.label || '')};
          if (sel) {
            const el = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
              .find(e => (e.getAttribute('placeholder') || '').toLowerCase() === sel.toLowerCase() ||
                         (e.getAttribute('aria-label') || '').toLowerCase() === sel.toLowerCase());
            if (el) {
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              el.focus();
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, ${escaped});
              if ('value' in el) (el as any).value = ${escaped};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              const r = el.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
          }
          return null;
        })()
      `;
      const typeResult = await this.executeScript<any>(typeScript);
      if (typeResult && typeof typeResult === 'object' && typeof typeResult.x === 'number') {
        try {
          await this.dispatchCdpType(typeResult.x, typeResult.y, text);
        } catch {}
      }
      return { success: true, label: target.label || target.role || 'element' };
    } catch (err: any) {
      if (process.platform === 'darwin') {
        const walker = new AxWalker({ driver: new MacOsDriver() });
        const elements = await walker.walkActiveApp('Google Chrome', { allowOcr: false });
        const target = elements.find((e) => {
          if (typeof index === 'number') return e.index === index;
          const s = String(index).replace(/^e/i, '');
          return String(e.index) === s;
        });
        if (!target) {
          throw new Error(`Index ${index} not found. Run snapshot to view current indexed elements.`);
        }
        const success = await setAxElementValue(
          'Google Chrome',
          { index: target.index, bounds: target.bounds, role: target.role, label: target.label },
          text,
        );
        if (success) {
          return { success: true, label: target.label || target.role || 'element' };
        }
        const pressSuccess = await performAxAction(
          'Google Chrome',
          { index: target.index, bounds: target.bounds, role: target.role, label: target.label },
          'AXPress',
        );
        if (pressSuccess) {
          const driver = new MacOsDriver();
          await driver.typeText(text);
          return { success: true, label: target.label || target.role || 'element' };
        }
      }
      throw err;
    }
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

    if (matched.targetId) {
      try {
        await this.callCdp('Target.activateTarget', { targetId: matched.targetId });
      } catch {}
    } else if (matched.webSocketDebuggerUrl) {
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
            activate
          end tell
        `;
        spawnSync('osascript', ['-e', script], { encoding: 'utf-8', timeout: 1500 });
      } catch {}

      try {
        const escapedTitle = (matched.title || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const swiftScript = `
import Cocoa
import ApplicationServices
let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.google.Chrome" }
guard let chrome = apps.first else { exit(0) }
let appEl = AXUIElementCreateApplication(chrome.processIdentifier)
var wins: AnyObject?
_ = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wins)
guard let winList = wins as? [AXUIElement] else { exit(0) }
let targetTitle = "${escapedTitle}"
for w in winList {
    var t: AnyObject?
    _ = AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t)
    let s = (t as? String) ?? ""
    if !targetTitle.isEmpty && (s.localizedCaseInsensitiveContains(targetTitle) || targetTitle.localizedCaseInsensitiveContains(s)) {
        _ = AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        _ = AXUIElementSetAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, w)
        break
    }
}
_ = chrome.activate(options: [.activateIgnoringOtherApps])
`;
        spawnSync('swift', ['-e', swiftScript], { encoding: 'utf-8', timeout: 1500 });
      } catch {}
    }

    matched.active = true;
    return { success: true, tab: matched };
  }

  private async openUrlViaWs(wsUrl: string, url: string): Promise<{ success: boolean; url: string }> {
    const ws = await this.createWebSocket(wsUrl);
    return new Promise<{ success: boolean; url: string }>((resolve, reject) => {
      const id = ++this.messageSeq;
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

  async openUrl(url: string): Promise<{ success: boolean; url: string }> {
    let tab: BrowserTab | null = null;
    try {
      tab = await this.getActiveTab();
    } catch {
      try {
        const res = await fetch(`${this.cdpUrl}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
        if (res.ok) {
          return { success: true, url };
        }
      } catch {}
      if ((process.env.VITEST !== 'true' || this.customSocketPath) && !this.forceWebSocket) {
        const sockPath = this.getHarnessSocketPath();
        if (sockPath) {
          try {
            await this.callHarnessSocket<any>({ method: 'Target.createTarget', params: { url } });
            return { success: true, url };
          } catch {}
        }
      }
      throw new Error('No active browser tab found');
    }

    const wsUrl = tab?.webSocketDebuggerUrl;
    if (wsUrl) {
      return this.openUrlViaWs(wsUrl, url);
    }

    if ((process.env.VITEST !== 'true' || this.customSocketPath) && !this.forceWebSocket) {
      const sockPath = this.getHarnessSocketPath();
      if (sockPath) {
        try {
          await this.callHarnessSocket<any>({ method: 'Page.navigate', params: { url } });
          return { success: true, url };
        } catch {}
      }
    }

    throw new Error('Active tab does not provide webSocketDebuggerUrl');
  }
}
