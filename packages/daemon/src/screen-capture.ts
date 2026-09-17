import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserFrame, FrameSource } from './frame-stream.js';

const execFileAsync = promisify(execFile);

export class DefaultFrameSource implements FrameSource {
  private lastCapturedHash: string | null = null;
  private lastCapturedTime = 0;

  async captureFrame(): Promise<BrowserFrame | null> {
    const fileResult = await this.captureFromFiles();
    if (fileResult !== undefined) return fileResult;

    const cdpResult = await this.captureFromCdp();
    if (cdpResult !== undefined) return cdpResult;

    if (process.platform === 'darwin') {
      const nativeResult = await this.captureFromMacScreen();
      if (nativeResult !== undefined) return nativeResult;

      const chromeResult = await this.captureFromChromeTab();
      if (chromeResult !== undefined) return chromeResult;
    }

    return null;
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
        if (now - stat.mtimeMs > 5000) {
          await fs.promises.unlink(candidate).catch(() => {});
          continue;
        }

        const buf = await fs.promises.readFile(candidate);
        if (buf.length === 0) continue;

        const ext = path.extname(candidate).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
        const base64 = `data:${mime};base64,${buf.toString('base64')}`;

        if (base64 === this.lastCapturedHash) {
          return null;
        }

        this.lastCapturedHash = base64;
        return {
          jpegBase64: base64,
          capturedAt: new Date(stat.mtimeMs).toISOString(),
        };
      } catch {}
    }
    return undefined;
  }

  private async captureFromCdp(): Promise<BrowserFrame | null | undefined> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300);
      const res = await fetch('http://127.0.0.1:9222/json', { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) return undefined;
      const targets = (await res.json()) as Array<{ type?: string; id?: string }>;
      const pageTarget = targets.find((t) => t.type === 'page');
      if (!pageTarget?.id) return undefined;

      return undefined;
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
          const base64 = buf.toString('base64');
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

  private async captureFromChromeTab(): Promise<BrowserFrame | null | undefined> {
    const now = Date.now();
    if (now - this.lastCapturedTime < 2000) {
      return null;
    }

    try {
      const script = `
        tell application "Google Chrome"
          if (count of windows) is 0 then return ""
          set t to active tab of front window
          return (title of t) & "|||" & (URL of t)
        end tell
      `;
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 800 });
      const trimmed = stdout.trim();
      if (!trimmed || !trimmed.includes('|||')) return undefined;

      const [title, url] = trimmed.split('|||');
      if (!url || url === 'chrome://newtab/' || url === 'about:blank') return undefined;

      this.lastCapturedTime = now;
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450" width="800" height="450">
          <rect width="800" height="450" fill="#09090b" rx="12"/>
          <rect x="0" y="0" width="800" height="48" fill="#18181b" rx="12"/>
          <circle cx="24" cy="24" r="6" fill="#ef4444"/>
          <circle cx="44" cy="24" r="6" fill="#f59e0b"/>
          <circle cx="64" cy="24" r="6" fill="#10b981"/>
          <rect x="100" y="10" width="600" height="28" rx="6" fill="#27272a"/>
          <text x="120" y="29" font-family="-apple-system, system-ui, sans-serif" font-size="12" fill="#a1a1aa" text-anchor="start">
            ${this.escapeXml(url || '')}
          </text>
          <g transform="translate(40, 90)">
            <rect x="0" y="0" width="720" height="320" rx="8" fill="#121215" stroke="#27272a" stroke-width="1"/>
            <circle cx="360" cy="120" r="32" fill="#0284c7" opacity="0.2"/>
            <circle cx="360" cy="120" r="16" fill="#38bdf8"/>
            <text x="360" y="180" font-family="-apple-system, system-ui, sans-serif" font-size="18" font-weight="600" fill="#f4f4f5" text-anchor="middle">
              ${this.escapeXml(title || 'Active Web Page')}
            </text>
            <text x="360" y="210" font-family="-apple-system, system-ui, sans-serif" font-size="13" fill="#71717a" text-anchor="middle">
              Chrome Session Live • Streaming via Remote Hands
            </text>
          </g>
        </svg>
      `;

      const base64 = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      if (base64 === this.lastCapturedHash) {
        return null;
      }
      this.lastCapturedHash = base64;
      return {
        jpegBase64: base64,
        capturedAt: new Date().toISOString(),
      };
    } catch {
      return undefined;
    }
  }

  private escapeXml(unsafe: string): string {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
