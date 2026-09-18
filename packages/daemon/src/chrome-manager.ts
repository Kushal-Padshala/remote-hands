import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';

export type ChromeProfileMode = 'active' | 'dedicated' | 'none';

export interface ChromeManagerOptions {
  mode?: ChromeProfileMode | undefined;
  port?: number | undefined;
  customProfileDir?: string | undefined;
  chromeExecutablePath?: string | undefined;
}

export interface ChromeStatus {
  available: boolean;
  port: number;
  mode: ChromeProfileMode;
  wsUrl?: string | undefined;
  browser?: string | undefined;
  profileDir?: string | undefined;
}

export class ChromeManager {
  private mode: ChromeProfileMode;
  private port: number;
  private customProfileDir?: string | undefined;
  private chromeExecutablePath: string;
  private process: ChildProcess | null = null;

  constructor(options?: ChromeManagerOptions) {
    this.mode = options?.mode ?? 'dedicated';
    this.port = options?.port ?? 9222;
    this.customProfileDir = options?.customProfileDir;
    this.chromeExecutablePath =
      options?.chromeExecutablePath ??
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : 'google-chrome');
  }

  getMode(): ChromeProfileMode {
    return this.mode;
  }

  getPort(): number {
    return this.port;
  }

  getProfileDirectory(): string {
    if (this.customProfileDir) return this.customProfileDir;
    if (this.mode === 'active') {
      return path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
    }
    return path.join(os.homedir(), '.remote-hands/chrome-profile');
  }

  async checkDebuggerStatus(): Promise<ChromeStatus> {
    const base: ChromeStatus = {
      available: false,
      port: this.port,
      mode: this.mode,
      profileDir: this.getProfileDirectory(),
    };

    if (this.mode === 'none') return base;

    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!res.ok) return base;
      const data = (await res.json()) as any;
      return {
        available: true,
        port: this.port,
        mode: this.mode,
        wsUrl: data.webSocketDebuggerUrl,
        browser: data.Browser,
        profileDir: this.getProfileDirectory(),
      };
    } catch {
      return base;
    }
  }

  buildLaunchArgs(url?: string): string[] {
    const profileDir = this.getProfileDirectory();
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ];
    if (url) {
      args.push(url);
    }
    return args;
  }

  async ensureRunning(initialUrl?: string): Promise<ChromeStatus> {
    if (this.mode === 'none') {
      return this.checkDebuggerStatus();
    }

    const current = await this.checkDebuggerStatus();
    if (current.available) {
      return current;
    }

    const profileDir = this.getProfileDirectory();
    fs.mkdirSync(profileDir, { recursive: true });

    const args = this.buildLaunchArgs(initialUrl);
    this.process = spawn(this.chromeExecutablePath, args, {
      detached: true,
      stdio: 'ignore',
    });
    this.process.unref();

    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const status = await this.checkDebuggerStatus();
      if (status.available) {
        return status;
      }
    }

    return this.checkDebuggerStatus();
  }

  close(): void {
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {}
      this.process = null;
    }
  }
}
