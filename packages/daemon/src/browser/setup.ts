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
    'set foundBar to missing value',
    'set foundMid to missing value',
    'tell application "System Events"',
    'if not (exists process procName) then error "rh:not_running"',
    'tell process procName',
    'repeat with mbi in (menu bar items of menu bar 1)',
    'try',
    'repeat with mi in (menu items of menu 1 of mbi)',
    'try',
    `if (name of mi) is "${JS_MENU_ITEM}" then`,
    'set foundItem to mi',
    'set foundBar to mbi',
    'exit repeat',
    'end if',
    'end try',
    'try',
    'repeat with si in (menu items of menu 1 of mi)',
    'try',
    `if (name of si) is "${JS_MENU_ITEM}" then`,
    'set foundItem to si',
    'set foundMid to mi',
    'set foundBar to mbi',
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

/**
 * Diagnostics: prints `bar|submenu|item|enabled=<bool>|mark=<char or none>` for the menu
 * item (or `missing`). Read-only. argv: browser process name.
 */
export function buildMenuInfoScript(): string[] {
  return [
    'on run argv',
    ...findMenuItemLines(),
    'if foundItem is missing value then return "missing"',
    'set barName to name of foundBar',
    'set midName to "-"',
    'if foundMid is not missing value then set midName to name of foundMid',
    'set en to enabled of foundItem',
    'set mark to value of attribute "AXMenuItemMarkChar" of foundItem',
    'if mark is missing value then set mark to "none"',
    'return barName & "|" & midName & "|" & (name of foundItem) & "|enabled=" & (en as text) & "|mark=" & (mark as text)',
    'end tell',
    'end tell',
    'end run',
  ];
}

/**
 * Diagnostics with the browser in front and the menu path opened (menu items are only
 * validated, and so enabled or greyed out, while the app is active and the menu is open).
 * Escapes the menus and gives focus back. Prints
 * `windows=<n>|enabled(before open)=<b>|enabled(menu open)=<b>|mark=<char or none>`.
 */
export function buildMenuInfoOpenScript(): string[] {
  return [
    'on run argv',
    ...findMenuItemLines(),
    'if foundItem is missing value then return "missing"',
    'set prevFront to ""',
    'try',
    'set prevFront to name of first application process whose frontmost is true',
    'end try',
    'set winCount to count of windows',
    'set frontmost to true',
    'delay 0.5',
    'set en0 to enabled of foundItem',
    'click foundBar',
    'delay 0.3',
    'if foundMid is not missing value then',
    'click foundMid',
    'delay 0.3',
    'end if',
    'set en1 to enabled of foundItem',
    'set mark to value of attribute "AXMenuItemMarkChar" of foundItem',
    'if mark is missing value then set mark to "none"',
    'end tell',
    'tell application "System Events"',
    'key code 53',
    'delay 0.1',
    'key code 53',
    'try',
    'if prevFront is not "" and prevFront is not procName then set frontmost of process prevFront to true',
    'end try',
    'end tell',
    'end tell',
    'return "windows=" & winCount & "|enabled(before open)=" & (en0 as text) & "|enabled(menu open)=" & (en1 as text) & "|mark=" & (mark as text)',
    'end run',
  ];
}

/** Clicks the menu item and prints `clicked`; `rh:menu_missing` when absent. argv: browser process name. */
export function buildMenuToggleScript(): string[] {
  return [
    'on run argv',
    ...findMenuItemLines(),
    'if foundItem is missing value then error "rh:menu_missing"',
    // Chromium only runs menu commands reliably when the browser is the front app: bring
    // it forward, open the menu path the way a person would, click, then give focus back.
    'set prevFront to ""',
    'try',
    'set prevFront to name of first application process whose frontmost is true',
    'end try',
    'set frontmost to true',
    'delay 0.4',
    'click foundBar',
    'delay 0.2',
    'if foundMid is not missing value then',
    'click foundMid',
    'delay 0.2',
    'end if',
    'click foundItem',
    'delay 0.3',
    'end tell',
    'try',
    'if prevFront is not "" and prevFront is not procName then set frontmost of process prevFront to true',
    'end try',
    'end tell',
    'return "clicked"',
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
  sleep?: (ms: number) => Promise<void>;
}

const MENU_TIMEOUT_MS = 10_000;
const VERIFY_ATTEMPTS = 8;
const VERIFY_INTERVAL_MS = 300;

const defaultOpen = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile('open', [url], (err) => (err ? reject(new Error('could not open System Settings')) : resolve()));
  });

export class BrowserSetup {
  private readonly transport: BrowserSetupDeps['transport'];
  private readonly run: RunOsascript;
  private readonly open: (url: string) => Promise<void>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: BrowserSetupDeps) {
    this.transport = deps.transport;
    this.run = deps.run ?? defaultRunOsascript;
    this.open = deps.open ?? defaultOpen;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

  /**
   * `rh browser setup --debug`: what the menu looks like and what the probe says, before
   * and (only when `click` is true) after one toggle attempt. For bug reports.
   */
  async diagnose(b: BrowserApp, opts: { click: boolean }): Promise<string[]> {
    const lines: string[] = [];
    const info = async (label: string): Promise<void> => {
      const res = await this.runScript(b, buildMenuInfoScript());
      lines.push(`${label} menu: ${res.ok ? res.stdout.trim() : `${res.reason}: ${res.message}`}`);
    };
    lines.push(`probe before: ${(await this.inspect(b)).status}`);
    await info('before');
    const front = await this.runScript(b, buildMenuInfoOpenScript());
    lines.push(`front+open menu: ${front.ok ? front.stdout.trim() : `${front.reason}: ${front.message}`}`);
    if (opts.click) {
      const clicked = await this.runScript(b, buildMenuToggleScript());
      lines.push(`click: ${clicked.ok ? clicked.stdout.trim() : `${clicked.reason}: ${clicked.message}`}`);
      await this.sleep(1500);
      lines.push(`probe after: ${(await this.inspect(b)).status}`);
      await info('after');
    }
    return lines;
  }

  async openAutomationPane(): Promise<void> {
    await this.open(AUTOMATION_PANE_URL);
  }

  async openAccessibilityPane(): Promise<void> {
    await this.open(ACCESSIBILITY_PANE_URL);
  }

  /**
   * What the browser actually does is the truth, not the menu's check mark (Chromium only
   * refreshes the mark when the menu is opened, so reads right after a click can be
   * stale): probe first, and fall back to the menu only when the probe cannot tell
   * (no window, restricted front page).
   */
  private async currentState(b: BrowserApp): Promise<'on' | 'off' | 'missing' | Extract<ToggleOutcome, { ok: false }>> {
    const probe = await this.inspect(b);
    if (probe.status === 'ready') return 'on';
    if (probe.status === 'js_disabled') return 'off';
    if (probe.status === 'not_running') return { ok: false, reason: 'not_running', message: probe.message };
    if (probe.status === 'automation_denied') return { ok: false, reason: 'script_error', message: probe.message };
    const menu = await this.menuState(b);
    if (!menu.ok) return menu;
    if (menu.state === 'missing') return 'missing';
    return menu.state === 'checked' ? 'on' : 'off';
  }

  private async toggleTo(b: BrowserApp, want: 'checked' | 'unchecked'): Promise<ToggleOutcome> {
    const wantState = want === 'checked' ? 'on' : 'off';
    const before = await this.currentState(b);
    if (typeof before === 'object') return before;
    if (before === 'missing') return { ok: false, reason: 'menu_missing', message: menuMissingMessage(b) };
    if (before === wantState) return { ok: true, changed: false, state: want };

    const clicked = await this.runScript(b, buildMenuToggleScript());
    if (!clicked.ok) return clicked;

    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
      const probe = await this.inspect(b);
      const now = probe.status === 'ready' ? 'on' : probe.status === 'js_disabled' ? 'off' : null;
      if (now === wantState) return { ok: true, changed: true, state: want };
      if (now === null) {
        const menu = await this.menuState(b);
        if (menu.ok && menu.state === want) return { ok: true, changed: true, state: want };
      }
      await this.sleep(VERIFY_INTERVAL_MS);
    }
    return {
      ok: false,
      reason: 'script_error',
      message: `I clicked the menu item in ${b.name}, but the setting did not change. Turn it ${want === 'checked' ? 'on' : 'off'} yourself: ${b.name} menu bar > View > Developer > ${JS_MENU_ITEM}.`,
    };
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
