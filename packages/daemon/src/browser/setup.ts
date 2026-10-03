import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { BrowserAutomationError } from './applescript.js';
import type { BrowserApp } from './browsers.js';
import { defaultRunOsascript, type AppleScriptTransport, type RunOsascript } from './transport.js';

/**
 * First-run setup for the fast browser path: reads and (with consent) toggles the
 * browser's "Allow JavaScript from Apple Events" menu item through System Events UI
 * scripting, verifies with a probe, and remembers what the user decided.
 *
 * Nothing here runs unless a caller asks; the CLI is responsible for asking the user.
 */

export const JS_MENU_ITEM = 'Allow JavaScript from Apple Events';
export const AUTOMATION_PANE_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';
export const ACCESSIBILITY_PANE_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

export type MenuState = 'checked' | 'unchecked' | 'missing';
export type InspectStatus = 'ready' | 'js_disabled' | 'automation_denied' | 'no_window' | 'not_running' | 'error';

export interface InspectResult {
  browser: string;
  status: InspectStatus;
  message: string;
}

export type ToggleFailure = 'system_events_denied' | 'accessibility_denied' | 'menu_missing' | 'not_running' | 'script_error';

export type ToggleOutcome =
  | { ok: true; changed: boolean; state: MenuState }
  | { ok: false; reason: ToggleFailure; message: string };

/**
 * Lines shared by both scripts: look the menu item up under the browser's System
 * Events process. argv: process name. The item is searched in every top-level menu and
 * one submenu level deeper (View > Developer, Safari's Develop menu). Leaves the item in
 * `foundItem` (or `missing value`). A closed browser raises `rh:not_running`; System
 * Events does not launch anything.
 */
function findMenuItemLines(): string[] {
  return [
    'set procName to item 1 of argv',
    'set foundItem to missing value',
    'tell application "System Events"',
    'if not (exists process procName) then error "rh:not_running"',
    'tell process procName',
    'repeat with mbi in (menu bar items of menu bar 1)',
    'try',
    'repeat with mi in (menu items of menu 1 of mbi)',
    'try',
    `if (name of mi) is "${JS_MENU_ITEM}" then`,
    'set foundItem to mi',
    'exit repeat',
    'end if',
    'end try',
    'try',
    'repeat with si in (menu items of menu 1 of mi)',
    'try',
    `if (name of si) is "${JS_MENU_ITEM}" then`,
    'set foundItem to si',
    'exit repeat',
    'end if',
    'end try',
    'end repeat',
    'end try',
    'if foundItem is not missing value then exit repeat',
    'end repeat',
    'end try',
    'if foundItem is not missing value then exit repeat',
    'end repeat',
  ];
}

/** Prints `checked`, `unchecked` or `missing`. argv: browser process name. */
export function buildMenuStateScript(): string[] {
  return [
    'on run argv',
    ...findMenuItemLines(),
    'if foundItem is missing value then return "missing"',
    'set mark to value of attribute "AXMenuItemMarkChar" of foundItem',
    'if mark is missing value then return "unchecked"',
    'return "checked"',
    'end tell',
    'end tell',
    'end run',
  ];
}

/** Clicks the menu item and prints `clicked`; `rh:menu_missing` when absent. argv: browser process name. */
export function buildMenuToggleScript(): string[] {
  return [
    'on run argv',
    ...findMenuItemLines(),
    'if foundItem is missing value then error "rh:menu_missing"',
    'click foundItem',
    'return "clicked"',
    'end tell',
    'end tell',
    'end run',
  ];
}

const MAX_DETAIL = 200;

function condense(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL);
}

export function classifyToggleError(b: BrowserApp, stderr: string, status: number | null): { reason: ToggleFailure; message: string } {
  const text = stderr.trim();
  if (/execution error: rh:not_running \(-2700\)\s*$/.test(text)) {
    return { reason: 'not_running', message: `${b.name} is not running.` };
  }
  if (/execution error: rh:menu_missing \(-2700\)\s*$/.test(text)) {
    return { reason: 'menu_missing', message: menuMissingMessage(b) };
  }
  if (/not allowed assistive access|\(-25211\)|\(-1719\)|assistive/i.test(text)) {
    return {
      reason: 'accessibility_denied',
      message:
        'macOS has not given this app the Accessibility permission, which is needed to click the browser menu for you. Enable it in System Settings > Privacy & Security > Accessibility.',
    };
  }
  if (/not authorized to send apple events to system events|\(-1743\)/i.test(text)) {
    return {
      reason: 'system_events_denied',
      message:
        'macOS blocked this app from controlling System Events. Allow it in System Settings > Privacy & Security > Automation (enable System Events under the app that runs Remote Hands).',
    };
  }
  if (status === null) {
    return { reason: 'script_error', message: `${b.name} menu scripting did not answer in time.` };
  }
  return { reason: 'script_error', message: `${b.name} menu scripting failed: ${condense(text) || `exit status ${status}`}` };
}

export function menuMissingMessage(b: BrowserApp): string {
  if (b.family === 'safari') {
    return 'Safari has no Develop menu yet. Turn it on: Safari > Settings > Advanced > Show features for web developers, then choose Develop > Allow JavaScript from Apple Events.';
  }
  return `Could not find "${JS_MENU_ITEM}" in ${b.name}'s menus (the browser may use a non-English interface or have no open window). Enable it manually: ${b.name} menu bar > View > Developer > ${JS_MENU_ITEM}.`;
}

export interface BrowserSetupDeps {
  transport: Pick<AppleScriptTransport, 'evaluate' | 'environment'>;
  run?: RunOsascript;
  open?: (url: string) => Promise<void>;
}

const MENU_TIMEOUT_MS = 10_000;

const defaultOpen = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile('open', [url], (err) => (err ? reject(new Error('could not open System Settings')) : resolve()));
  });

export class BrowserSetup {
  private readonly transport: BrowserSetupDeps['transport'];
  private readonly run: RunOsascript;
  private readonly open: (url: string) => Promise<void>;

  constructor(deps: BrowserSetupDeps) {
    this.transport = deps.transport;
    this.run = deps.run ?? defaultRunOsascript;
    this.open = deps.open ?? defaultOpen;
  }

  /** Probes a RUNNING browser with a harmless evaluate. Never touches a closed browser. */
  async inspect(b: BrowserApp): Promise<InspectResult> {
    let running: string[];
    try {
      running = (await this.transport.environment()).running;
    } catch (err) {
      return { browser: b.name, status: 'error', message: errMessage(err) };
    }
    if (!running.includes(b.name)) {
      return { browser: b.name, status: 'not_running', message: `${b.name} is not running.` };
    }
    try {
      await this.transport.evaluate(b, null, '1');
      return { browser: b.name, status: 'ready', message: `${b.name} is ready.` };
    } catch (err) {
      if (err instanceof BrowserAutomationError) {
        const status: InspectStatus =
          err.code === 'js_disabled' || err.code === 'automation_denied' || err.code === 'no_window' || err.code === 'not_running'
            ? err.code
            : 'error';
        return { browser: b.name, status, message: err.message };
      }
      return { browser: b.name, status: 'error', message: errMessage(err) };
    }
  }

  /** Reads the menu item's check mark. */
  async menuState(b: BrowserApp): Promise<{ ok: true; state: MenuState } | Extract<ToggleOutcome, { ok: false }>> {
    const res = await this.runScript(b, buildMenuStateScript());
    if (!res.ok) return res;
    const out = res.stdout.trim();
    if (out === 'checked' || out === 'unchecked' || out === 'missing') return { ok: true, state: out };
    return { ok: false, reason: 'script_error', message: `${b.name} menu scripting returned an unexpected answer.` };
  }

  /** Turns the setting on; reads first and clicks only when it is unchecked. */
  async enableJs(b: BrowserApp): Promise<ToggleOutcome> {
    return this.toggleTo(b, 'checked');
  }

  /** Turns the setting off; reads first and clicks only when it is checked. */
  async disableJs(b: BrowserApp): Promise<ToggleOutcome> {
    return this.toggleTo(b, 'unchecked');
  }

  async openAutomationPane(): Promise<void> {
    await this.open(AUTOMATION_PANE_URL);
  }

  async openAccessibilityPane(): Promise<void> {
    await this.open(ACCESSIBILITY_PANE_URL);
  }

  private async toggleTo(b: BrowserApp, want: 'checked' | 'unchecked'): Promise<ToggleOutcome> {
    const before = await this.menuState(b);
    if (!before.ok) return before;
    if (before.state === 'missing') {
      return { ok: false, reason: 'menu_missing', message: menuMissingMessage(b) };
    }
    if (before.state === want) return { ok: true, changed: false, state: before.state };

    const clicked = await this.runScript(b, buildMenuToggleScript());
    if (!clicked.ok) return clicked;

    const after = await this.menuState(b);
    if (!after.ok) return after;
    if (after.state !== want) {
      return {
        ok: false,
        reason: 'script_error',
        message: `Clicked the menu item in ${b.name}, but the setting did not change.`,
      };
    }
    return { ok: true, changed: true, state: after.state };
  }

  private async runScript(
    b: BrowserApp,
    lines: string[],
  ): Promise<{ ok: true; stdout: string } | Extract<ToggleOutcome, { ok: false }>> {
    let res: Awaited<ReturnType<RunOsascript>>;
    try {
      res = await this.run(lines, [b.name], MENU_TIMEOUT_MS);
    } catch {
      return { ok: false, reason: 'script_error', message: `${b.name} menu scripting could not run osascript.` };
    }
    if (res.status !== 0) {
      const c = classifyToggleError(b, res.stderr, res.status);
      return { ok: false, reason: c.reason, message: c.message };
    }
    return { ok: true, stdout: res.stdout };
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? condense(err.message) : 'unknown error';
}

/* ---- remembered decisions ---- */

export type SetupDecision = 'enabled' | 'declined' | 'manual';

export interface SetupState {
  browsers: Record<string, { decision: SetupDecision; at: string }>;
}

/** Minimal file-system surface so tests never touch the real disk. */
export interface SetupFs {
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(p: string): Promise<void>;
}

export const nodeSetupFs: SetupFs = {
  readFile: (p) => fsp.readFile(p, 'utf-8'),
  writeFile: (p, data) => fsp.writeFile(p, data, { encoding: 'utf-8', mode: 0o600 }),
  rename: (a, b) => fsp.rename(a, b),
  mkdir: async (p) => {
    await fsp.mkdir(p, { recursive: true });
  },
};

export async function readSetupState(fs: SetupFs, file: string): Promise<SetupState> {
  try {
    const parsed = JSON.parse(await fs.readFile(file)) as unknown;
    if (parsed && typeof parsed === 'object' && 'browsers' in parsed) {
      const raw = (parsed as { browsers: unknown }).browsers;
      if (raw && typeof raw === 'object') {
        const browsers: SetupState['browsers'] = {};
        for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
          const e = entry as { decision?: unknown; at?: unknown } | null;
          if (e && (e.decision === 'enabled' || e.decision === 'declined' || e.decision === 'manual') && typeof e.at === 'string') {
            browsers[name] = { decision: e.decision, at: e.at };
          }
        }
        return { browsers };
      }
    }
  } catch {
    // missing or invalid file: nothing has been offered yet
  }
  return { browsers: {} };
}

/** Records a decision, keeping every other entry, via temp file + rename. */
export async function recordDecision(
  fs: SetupFs,
  file: string,
  browser: string,
  decision: SetupDecision,
  now: () => Date = () => new Date(),
): Promise<void> {
  const state = await readSetupState(fs, file);
  state.browsers[browser] = { decision, at: now().toISOString() };
  await fs.mkdir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(tmp, file);
}

/** Automatic offers only for browsers the user has never been asked about. */
export function shouldOffer(state: SetupState, browserName: string): boolean {
  return !(browserName in state.browsers);
}
