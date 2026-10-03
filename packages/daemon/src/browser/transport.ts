import { execFile } from 'node:child_process';
import type { BrowserApp } from './browsers.js';
import {
  buildCloseScript,
  buildEvalScript,
  buildFocusScript,
  buildOpenScript,
  buildRunningScript,
  buildTabsScript,
  classifyOsascriptError,
  type TabTarget,
} from './applescript.js';

/**
 * Runs an AppleScript given as `-e` lines with `argv` passed to its `on run argv`
 * handler. `status` is null when the process was killed (timeout).
 */
export type RunOsascript = (
  lines: string[],
  argv: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string; status: number | null }>;

export interface TabInfo {
  windowId: string;
  windowIndex: number;
  tabKey: string;
  tabIndex: number;
  title: string;
  url: string;
  active: boolean;
}

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * `osascript -e l1 -e l2 ... -- arg1 arg2`. The literal `--` is required: without it
 * an argument starting with `-` is parsed as an osascript option. osascript does not
 * pass the `--` itself to the script.
 */
export const defaultRunOsascript: RunOsascript = (lines, argv, timeoutMs) =>
  new Promise((resolve) => {
    const args = [...lines.flatMap((l) => ['-e', l]), '--', ...argv];
    execFile(
      'osascript',
      args,
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, status: 0 });
          return;
        }
        const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: unknown };
        if (e.killed && typeof e.code !== 'string') {
          resolve({ stdout, stderr, status: null });
          return;
        }
        const status = typeof e.code === 'number' ? e.code : 1;
        resolve({ stdout, stderr: stderr || e.message, status });
      },
    );
  });

function stripOneNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

function parseTabs(stdout: string): TabInfo[] {
  const tabs: TabInfo[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [windowId = '', windowIndex = '', tabKey = '', tabIndex = '', active = '', title = '', ...rest] =
      line.split('\t');
    if (!windowId || !tabKey) continue;
    tabs.push({
      windowId,
      windowIndex: Number.parseInt(windowIndex, 10) || 0,
      tabKey,
      tabIndex: Number.parseInt(tabIndex, 10) || 0,
      title,
      url: rest.join('\t'),
      active: active === 'true',
    });
  }
  return tabs;
}

/** Drives AppleScript-capable browsers through osascript. Every failure rejects with BrowserAutomationError. */
export class AppleScriptTransport {
  private readonly run: RunOsascript;

  constructor(opts: { run?: RunOsascript } = {}) {
    this.run = opts.run ?? defaultRunOsascript;
  }

  /** Frontmost app name and the running registry browsers (never launches anything). */
  async environment(): Promise<{ frontmost: string | null; running: string[] }> {
    const res = await this.run(buildRunningScript(), [], DEFAULT_TIMEOUT_MS);
    if (res.status !== 0) {
      throw classifyOsascriptError({ name: 'osascript', family: 'chromium', aliases: [] }, res.stderr, res.status);
    }
    const [front = '', ...rest] = stripOneNewline(res.stdout).split('\n');
    return { frontmost: front.trim() || null, running: rest.map((s) => s.trim()).filter(Boolean) };
  }

  async evaluate(b: BrowserApp, target: TabTarget | null, js: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const out = await this.exec(b, buildEvalScript(b), [js, target?.windowId ?? '', target?.tabKey ?? ''], timeoutMs);
    return stripOneNewline(out);
  }

  async listTabs(b: BrowserApp): Promise<TabInfo[]> {
    return parseTabs(await this.exec(b, buildTabsScript(b), []));
  }

  async focusTab(b: BrowserApp, target: TabTarget): Promise<void> {
    await this.exec(b, buildFocusScript(b), [target.windowId, target.tabKey]);
  }

  async openUrl(b: BrowserApp, url: string, windowId?: string): Promise<void> {
    await this.exec(b, buildOpenScript(b), [url, windowId ?? '']);
  }

  async closeTab(b: BrowserApp, target: TabTarget): Promise<void> {
    await this.exec(b, buildCloseScript(b), [target.windowId, target.tabKey]);
  }

  private async exec(b: BrowserApp, lines: string[], argv: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const res = await this.run(lines, argv, timeoutMs);
    if (res.status !== 0) throw classifyOsascriptError(b, res.stderr, res.status);
    return res.stdout;
  }
}
