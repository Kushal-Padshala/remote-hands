import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import type { BrowserFrame, FrameSource } from './frame-stream.js';
import { MacOsDriver } from './desktop/macos-driver.js';

export const CANDIDATE_FRAME_PATHS = [
  '/tmp/rh_screen_frame.jpg',
  '/tmp/rh_screen_frame.png',
  '/tmp/shot.png',
  '/tmp/shot.jpg',
  path.join(os.homedir(), '.config/browser-harness/tmp/shot.png'),
];

export function cleanupStaleFrameFiles(cutoffTimeMs?: number): void {
  for (const candidate of CANDIDATE_FRAME_PATHS) {
    try {
      if (fs.existsSync(candidate)) {
        if (cutoffTimeMs !== undefined) {
          const stat = fs.statSync(candidate);
          if (stat.mtimeMs < cutoffTimeMs) {
            fs.unlinkSync(candidate);
          }
        } else {
          fs.unlinkSync(candidate);
        }
      }
    } catch {}
  }
}

export interface DefaultFrameSourceOptions {
  taskStartTime?: number | undefined;
  browserActive?: boolean | undefined;
  candidatePaths?: string[] | undefined;
  desktopDriver?: MacOsDriver | undefined;
  desktopCaptureFn?: (() => Promise<Buffer | null>) | undefined;
  enableDesktopCapture?: boolean | undefined;
}

export class DefaultFrameSource implements FrameSource {
  private lastCapturedHash: string | null = null;
  private lastCapturedFrame: BrowserFrame | null = null;
  private lastEmitTime = 0;
  private activeWs: any = null;
  private activeWsUrl: string | null = null;
  private messageSeq = 0;
  private taskStartTime: number;
  private browserActive: boolean;
  private candidatePaths: string[];
  private desktopDriver: MacOsDriver;
  private desktopCaptureFn?: (() => Promise<Buffer | null>) | undefined;
  private enableDesktopCapture: boolean;
  private initialTargetIds = new Set<string>();
  private initialUrls = new Map<string, string>();
  private initialRecorded = false;

  constructor(options?: DefaultFrameSourceOptions) {
    this.taskStartTime = options?.taskStartTime ?? Date.now();
    this.browserActive = options?.browserActive ?? false;
    this.candidatePaths = options?.candidatePaths ?? CANDIDATE_FRAME_PATHS;
    this.desktopDriver = options?.desktopDriver ?? new MacOsDriver();
    this.desktopCaptureFn = options?.desktopCaptureFn;
    this.enableDesktopCapture = options?.enableDesktopCapture ?? (options?.candidatePaths === undefined);
    if (!options?.candidatePaths) {
      cleanupStaleFrameFiles(this.taskStartTime);
    }
  }

  setBrowserActive(active: boolean): void {
    this.browserActive = active;
  }

  dispose(): void {
    if (this.activeWs) {
      try {
        this.activeWs.close();
      } catch {}
      this.activeWs = null;
      this.activeWsUrl = null;
    }
  }

  async captureFrame(): Promise<BrowserFrame | null> {
    const fileResult = await this.captureFromFiles();
    if (fileResult !== undefined) return fileResult;

    const cdpResult = await this.captureFromCdp();
    if (cdpResult !== undefined) return cdpResult;

    if (this.enableDesktopCapture) {
      const desktopResult = await this.captureFromDesktop();
      if (desktopResult !== undefined) return desktopResult;
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
    const now = Date.now();
    for (const candidate of this.candidatePaths) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const stat = await fs.promises.stat(candidate);
        if (stat.mtimeMs < this.taskStartTime) continue;
        if (now - stat.mtimeMs > 60000) continue;
        const buf = await fs.promises.readFile(candidate);
        if (buf.length === 0) continue;

        this.browserActive = true;
        const ext = path.extname(candidate).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
        const base64 = `data:${mime};base64,${buf.toString('base64')}`;

        if (base64 === this.lastCapturedHash) {
          if (now - this.lastEmitTime >= 1500 && this.lastCapturedFrame) {
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
          source: 'browser',
        };
        this.lastCapturedFrame = frame;
        return frame;
      } catch {}
    }
    return undefined;
  }

  private recordInitialPages(pages: Array<{ id?: string; url?: string }>): void {
    if (this.initialRecorded) return;
    this.initialRecorded = true;
    for (const p of pages) {
      if (p.id) {
        this.initialTargetIds.add(p.id);
        if (p.url) {
          this.initialUrls.set(p.id, p.url);
        }
      }
    }
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

      this.recordInitialPages(pages);

      const harnessTargetId = await this.getHarnessTargetId();
      let target: (typeof pages)[number] | undefined;

      if (harnessTargetId) {
        const found = pages.find((p) => p.id === harnessTargetId);
        if (found) {
          const isPreExisting = this.initialTargetIds.has(found.id!);
          const urlChanged = found.url && found.url !== this.initialUrls.get(found.id!);
          if (!isPreExisting || urlChanged) {
            target = found;
          }
        }
      }

      if (!target) {
        const markedPages = pages.filter((p) => p.title?.includes('🐴'));
        for (let i = markedPages.length - 1; i >= 0; i--) {
          const p = markedPages[i]!;
          const isPreExisting = this.initialTargetIds.has(p.id!);
          const urlChanged = p.url && p.url !== this.initialUrls.get(p.id!);
          if (!isPreExisting || urlChanged) {
            target = p;
            break;
          }
        }
      }

      if (!target && this.browserActive) {
        const eligiblePages = pages.filter(
          (p) =>
            p.url &&
            !p.url.startsWith('chrome://') &&
            !p.url.startsWith('devtools://') &&
            !p.url.startsWith('chrome-extension://')
        );
        target = eligiblePages[eligiblePages.length - 1] ?? pages[pages.length - 1];
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
              try {
                this.activeWs.onerror = null;
              } catch {}
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
        let settled = false;
        const cleanup = () => {
          clearTimeout(timeout);
          try {
            if (this.activeWs?.removeEventListener) {
              this.activeWs.removeEventListener('message', handler);
            } else if (this.activeWs) {
              this.activeWs.onmessage = null;
            }
          } catch {}
        };

        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(null);
        }, 800);

        const handler = (event: any) => {
          if (settled) return;
          try {
            const raw =
              typeof event.data === 'string'
                ? event.data
                : new TextDecoder().decode(event.data);
            const msg = JSON.parse(raw);
            if (msg.id === reqId) {
              settled = true;
              cleanup();
              if (msg.result?.data) {
                resolve(msg.result.data);
              } else {
                resolve(null);
              }
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
          if (!settled) {
            settled = true;
            cleanup();
            resolve(null);
          }
        }
      });

      if (!base64Data) return undefined;

      this.browserActive = true;
      const now = Date.now();
      const mime = 'image/jpeg';
      const base64 = `data:${mime};base64,${base64Data}`;

      if (base64 === this.lastCapturedHash) {
        if (now - this.lastEmitTime >= 1500 && this.lastCapturedFrame) {
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
        source: 'browser',
      };
      this.lastCapturedFrame = frame;
      return frame;
    } catch {
      return undefined;
    }
  }

  private async captureFromDesktop(): Promise<BrowserFrame | null | undefined> {
    try {
      const buf = this.desktopCaptureFn
        ? await this.desktopCaptureFn()
        : await this.desktopDriver.captureScreenshot();

      if (!buf || buf.length === 0) return undefined;

      const now = Date.now();
      const mime = 'image/jpeg';
      const base64 = `data:${mime};base64,${buf.toString('base64')}`;

      if (base64 === this.lastCapturedHash) {
        if (now - this.lastEmitTime >= 1500 && this.lastCapturedFrame) {
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
        source: 'desktop',
      };
      this.lastCapturedFrame = frame;
      return frame;
    } catch {
      return undefined;
    }
  }
}
