import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserFrame, FrameSource } from './frame-stream.js';

const execFileAsync = promisify(execFile);

export class DefaultFrameSource implements FrameSource {
  private lastCapturedHash: string | null = null;
  private lastCapturedFrame: BrowserFrame | null = null;
  private lastEmitTime = 0;
  private activeWs: any = null;
  private activeWsUrl: string | null = null;
  private messageSeq = 0;

  async captureFrame(): Promise<BrowserFrame | null> {
    const fileResult = await this.captureFromFiles();
    if (fileResult !== undefined) return fileResult;

    const cdpResult = await this.captureFromCdp();
    if (cdpResult !== undefined) return cdpResult;

    if (process.platform === 'darwin') {
      const nativeResult = await this.captureFromMacScreen();
      if (nativeResult !== undefined) return nativeResult;
    }

    return null;
  }

  private getHarnessTargetId(): Promise<string | null> {
    return new Promise((resolve) => {
      const sockPath = path.join(os.homedir(), '.config/browser-harness/runtime/bu-default.sock');
      if (!fs.existsSync(sockPath)) {
        resolve(null);
        return;
      }
      const client = net.createConnection(sockPath, () => {
        client.write(JSON.stringify({ meta: 'current_tab' }) + '\n');
      });
      client.setTimeout(250);
      client.on('data', (chunk) => {
        try {
          const obj = JSON.parse(chunk.toString());
          resolve(obj.targetId || null);
        } catch {
          resolve(null);
        }
        client.end();
      });
      client.on('error', () => resolve(null));
      client.on('timeout', () => {
        client.destroy();
        resolve(null);
      });
    });
  }

  private async captureFromFiles(): Promise<BrowserFrame | null | undefined> {
    const candidatePaths = [
      '/tmp/rh_screen_frame.jpg',
      '/tmp/rh_screen_frame.png',
      '/tmp/shot.png',
      '/tmp/shot.jpg',
      path.join(os.homedir(), '.config/browser-harness/tmp/shot.png'),
    ];

    const now = Date.now();
    for (const candidate of candidatePaths) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const stat = await fs.promises.stat(candidate);
        if (now - stat.mtimeMs > 5000) continue;
        const buf = await fs.promises.readFile(candidate);
        if (buf.length === 0) continue;

        const ext = path.extname(candidate).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
        const base64 = `data:${mime};base64,${buf.toString('base64')}`;

        if (base64 === this.lastCapturedHash) {
          if (now - this.lastEmitTime >= 2000 && this.lastCapturedFrame) {
            this.lastEmitTime = now;
            return {
              ...this.lastCapturedFrame,
              capturedAt: new Date().toISOString(),
            };
          }
          return null;
        }

        this.lastCapturedHash = base64;
        this.lastEmitTime = now;
        const frame: BrowserFrame = {
          jpegBase64: base64,
          capturedAt: new Date(stat.mtimeMs).toISOString(),
        };
        this.lastCapturedFrame = frame;
        return frame;
      } catch {}
    }
    return undefined;
  }

  private async captureFromCdp(): Promise<BrowserFrame | null | undefined> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 400);
      const res = await fetch('http://127.0.0.1:9222/json', { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) return undefined;
      const targets = (await res.json()) as Array<{
        type?: string;
        id?: string;
        url?: string;
        title?: string;
        webSocketDebuggerUrl?: string;
      }>;
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pages.length === 0) return undefined;

      const harnessTargetId = await this.getHarnessTargetId();
      let target = harnessTargetId ? pages.find((p) => p.id === harnessTargetId) : undefined;

      if (!target) {
        const markedPages = pages.filter((p) => p.title?.includes('🐴'));
        target = markedPages.length > 0 ? markedPages[markedPages.length - 1] : undefined;
      }

      if (!target && pages.length > 1 && process.platform === 'darwin') {
        try {
          const { stdout } = await execFileAsync(
            'osascript',
            ['-e', 'tell application "Google Chrome" to get URL of active tab of front window'],
            { timeout: 300 },
          );
          const frontUrl = stdout.trim();
          if (frontUrl) {
            const matched = pages.find((p) => p.url === frontUrl);
            if (matched) target = matched;
          }
        } catch {}
      }

      if (!target) {
        target = pages[pages.length - 1] ?? pages[0];
      }

      if (!target?.webSocketDebuggerUrl) return undefined;

      const wsUrl = target.webSocketDebuggerUrl;
      const WsClass = (globalThis as any).WebSocket;
      if (!WsClass) return undefined;

      if (this.activeWsUrl !== wsUrl || !this.activeWs || this.activeWs.readyState !== 1) {
        if (this.activeWs) {
          try {
            this.activeWs.close();
          } catch {}
          this.activeWs = null;
        }
        try {
          this.activeWs = new WsClass(wsUrl);
          this.activeWsUrl = wsUrl;
          await new Promise<void>((resolve, reject) => {
            const connectTimer = setTimeout(() => reject(new Error('timeout')), 500);
            this.activeWs.onopen = () => {
              clearTimeout(connectTimer);
              resolve();
            };
            this.activeWs.onerror = (err: any) => {
              clearTimeout(connectTimer);
              reject(err);
            };
          });
        } catch {
          this.activeWs = null;
          this.activeWsUrl = null;
          return undefined;
        }
      }

      const reqId = ++this.messageSeq;
      const base64Data = await new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.activeWs) {
            try {
              this.activeWs.close();
            } catch {}
            this.activeWs = null;
            this.activeWsUrl = null;
          }
          resolve(null);
        }, 800);

        const handler = (event: any) => {
          try {
            const raw =
              typeof event.data === 'string'
                ? event.data
                : new TextDecoder().decode(event.data);
            const msg = JSON.parse(raw);
            if (msg.id === reqId && msg.result?.data) {
              clearTimeout(timeout);
              if (this.activeWs?.removeEventListener) {
                this.activeWs.removeEventListener('message', handler);
              }
              resolve(msg.result.data);
            }
          } catch {}
        };

        if (this.activeWs.addEventListener) {
          this.activeWs.addEventListener('message', handler);
        } else {
          this.activeWs.onmessage = handler;
        }

        try {
          this.activeWs.send(
            JSON.stringify({
              id: reqId,
              method: 'Page.captureScreenshot',
              params: { format: 'jpeg', quality: 60 },
            }),
          );
        } catch {
          clearTimeout(timeout);
          resolve(null);
        }
      });

      if (!base64Data) return undefined;

      const now = Date.now();
      const mime = 'image/jpeg';
      const base64 = `data:${mime};base64,${base64Data}`;

      if (base64 === this.lastCapturedHash) {
        if (now - this.lastEmitTime >= 2000 && this.lastCapturedFrame) {
          this.lastEmitTime = now;
          return {
            ...this.lastCapturedFrame,
            capturedAt: new Date().toISOString(),
          };
        }
        return null;
      }

      this.lastCapturedHash = base64;
      this.lastEmitTime = now;
      const frame: BrowserFrame = {
        jpegBase64: base64,
        capturedAt: new Date().toISOString(),
      };
      this.lastCapturedFrame = frame;
      return frame;
    } catch {
      return undefined;
    }
  }

  private async captureFromMacScreen(): Promise<BrowserFrame | null | undefined> {
    const tmpFile = `/tmp/rh_screencap_${Date.now()}.jpg`;
    try {
      await execFileAsync('screencapture', ['-m', '-x', '-t', 'jpg', '-T', '0', tmpFile], {
        timeout: 1000,
      });

      if (fs.existsSync(tmpFile)) {
        const stat = await fs.promises.stat(tmpFile);
        if (stat.size > 500) {
          const buf = await fs.promises.readFile(tmpFile);
          await fs.promises.unlink(tmpFile).catch(() => {});
          const base64 = `data:image/jpeg;base64,${buf.toString('base64')}`;
          if (base64 === this.lastCapturedHash) {
            return null;
          }
          this.lastCapturedHash = base64;
          return {
            jpegBase64: base64,
            capturedAt: new Date().toISOString(),
          };
        }
        await fs.promises.unlink(tmpFile).catch(() => {});
      }
    } catch {
      try {
        if (fs.existsSync(tmpFile)) await fs.promises.unlink(tmpFile);
      } catch {}
    }
    return undefined;
  }
}
