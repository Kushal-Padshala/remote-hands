import { execFile } from 'node:child_process';
import type { BrowserApp } from './browsers.js';
import {
  buildCloseScript,
  buildEvalScript,
  buildFocusScript,
  buildOpenScript,
  buildRunningScript,
  buildTabsScript,
  BrowserAutomationError,
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
/** Placeholder app for errors raised before any browser is involved. */
const OSASCRIPT: BrowserApp = { name: 'osascript', family: 'chromium', aliases: [] };

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
      { encoding: 'utf8', timeout: normalizeTimeout(timeoutMs), maxBuffer: MAX_BUFFER, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => resolve(osascriptResult(error, stdout, stderr)),
    );
  });

/** A timeout that is not a positive finite number would disable execFile's timeout. */
export function normalizeTimeout(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
}

/**
 * Maps an execFile completion to a run result. Never uses `error.message`: it holds
 * the full command line, i.e. the script and the start of the user's JavaScript.
 */
export function osascriptResult(
  error: Error | null,
  stdout: string,
  stderr: string,
): { stdout: string; stderr: string; status: number | null } {
  if (!error) return { stdout, stderr, status: 0 };
  const e = error as Error & { killed?: boolean; code?: unknown };
  if (typeof e.code === 'string') {
    // Spawn failure (ENOENT ...) or maxBuffer overflow: a fixed message only.
    return { stdout, stderr: stderr || `osascript could not run (${e.code})`, status: 1 };
  }
  if (e.killed) return { stdout, stderr, status: null };
  return { stdout, stderr, status: typeof e.code === 'number' ? e.code : 1 };
}

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
    const stdout = await this.exec(OSASCRIPT, buildRunningScript(), []);
    const [front = '', ...rest] = stripOneNewline(stdout).split('\n');
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
    let res: Awaited<ReturnType<RunOsascript>>;
    try {
      res = await this.run(lines, argv, normalizeTimeout(timeoutMs));
    } catch {
      // The rejection may carry the command line (script and user JS); never surface it.
      throw new BrowserAutomationError('script_error', b.name, `${b.name} automation failed: osascript could not run.`);
    }
    if (res.status !== 0) throw classifyOsascriptError(b, res.stderr, res.status);
    return res.stdout;
  }
}
