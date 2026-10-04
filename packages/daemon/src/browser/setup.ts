import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserAutomationError } from './applescript.js';
import type { BrowserApp } from './browsers.js';
import { fastExec } from '../desktop/fast-exec.js';
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

export type ToggleFailure =
  | 'system_events_denied'
  | 'accessibility_denied'
  | 'menu_missing'
  | 'menu_disabled'
  | 'not_running'
  | 'script_error';

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
    'tell application procName to activate',
    'delay 0.9',
    'set winCount to count of windows',
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

/**
 * A short-lived, empty window. Chromium greys the setting out while the browser has no
 * usable window on the current desktop (windows on another Space, minimized, none), so
 * setup opens one on this desktop, flips the setting, and closes it again. Prints the new
 * window's id. argv: none. Never launches a closed browser.
 */
export function buildTempWindowOpenScript(b: BrowserApp): string[] {
  return [
    'on run argv',
    `if not (application "${b.name}" is running) then error "rh:not_running"`,
    `tell application "${b.name}"`,
    'activate',
    'set theWin to make new window',
    'delay 0.4',
    'try',
    'set URL of active tab of theWin to "about:blank"',
    'end try',
    'delay 0.6',
    'return (id of theWin) as text',
    'end tell',
    'end run',
  ];
}

/**
 * Closes the temporary window. argv: window id. SAFETY: only ever closes a window that holds
 * a single empty tab (about:blank or the new-tab page), never a window with the user's tabs.
 * Prints `closed`, `kept` (the window has real content) or `gone`.
 */
export function buildTempWindowCloseScript(b: BrowserApp): string[] {
  return [
    'on run argv',
    'set wid to item 1 of argv',
    `if not (application "${b.name}" is running) then return "gone"`,
    `tell application "${b.name}"`,
    'repeat with w in windows',
    'try',
    'if ((id of w) as text) is wid then',
    'if (count of tabs of w) is 1 then',
    'set u to URL of tab 1 of w',
    'if u is "about:blank" or u starts with "chrome://newtab" or u starts with "brave://newtab" or u starts with "edge://newtab" or u is "" then',
    'close w',
    'return "closed"',
    'end if',
    'end if',
    'return "kept"',
    'end if',
    'end try',
    'end repeat',
    'end tell',
    'return "gone"',
    'end run',
  ];
}

/** Prints the id of every window, one per line (Chromium family). */
export function buildWindowIdsScript(b: BrowserApp): string[] {
  return [
    'on run argv',
    `if not (application "${b.name}" is running) then return ""`,
    'set out to ""',
    `tell application "${b.name}"`,
    'repeat with w in windows',
    'set out to out & ((id of w) as text) & linefeed',
    'end repeat',
    'end tell',
    'return out',
    'end run',
  ];
}

/**
 * Second way to trigger the same menu command, the way a person would: bring the browser
 * forward and use the Help menu's search (Cmd+Shift+/), type the item's name and press
 * Return. argv: browser process name. Prints `searched`.
 */
export function buildHelpSearchScript(): string[] {
  return [
    'on run argv',
    'set procName to item 1 of argv',
    'tell application "System Events"',
    'if not (exists process procName) then error "rh:not_running"',
    'end tell',
    'tell application procName to activate',
    'delay 0.9',
    'tell application "System Events"',
    'keystroke "/" using {command down, shift down}',
    'delay 0.7',
    `keystroke "${JS_MENU_ITEM}"`,
    'delay 0.9',
    'key code 125',
    'delay 0.2',
    'key code 36',
    'end tell',
    'return "searched"',
    'end run',
  ];
}

/**
 * Last resort: brings the browser forward and opens View > Developer (or the item's menu)
 * and LEAVES it open so the user can click the item themselves. Prints `opened`.
 * argv: browser process name.
 */
export function buildOpenMenuForUserScript(): string[] {
  return [
    'on run argv',
    ...findMenuItemLines(),
    'if foundItem is missing value then error "rh:menu_missing"',
    'end tell',
    'end tell',
    'tell application procName to activate',
    'delay 0.9',
    'tell application "System Events"',
    'tell process procName',
    'click foundBar',
    'delay 0.3',
    'if foundMid is not missing value then click foundMid',
    'end tell',
    'end tell',
    'return "opened"',
    'end run',
  ];
}

/**
 * Opens the menu path (browser forward, View > Developer open) and prints the screen
 * centre of the menu item as `x,y` (global points), leaving the menu open for a real mouse
 * click. argv: browser process name.
 */
export function buildLocateMenuItemScript(): string[] {
  return [
    'on run argv',
    ...findMenuItemLines(),
    'if foundItem is missing value then error "rh:menu_missing"',
    'end tell',
    'end tell',
    'tell application procName to activate',
    'delay 0.9',
    'tell application "System Events"',
    'tell process procName',
    'click foundBar',
    'delay 0.3',
    'if foundMid is not missing value then',
    'click foundMid',
    'delay 0.3',
    'end if',
    'set itemPos to position of foundItem',
    'set itemSize to size of foundItem',
    'end tell',
    'end tell',
    'set cx to (item 1 of itemPos) + ((item 1 of itemSize) / 2)',
    'set cy to (item 2 of itemPos) + ((item 2 of itemSize) / 2)',
    'return ((round cx) as text) & "," & ((round cy) as text)',
    'end run',
  ];
}

/**
 * Swift source for one real left click at integer screen coordinates (the pointer is moved
 * back afterwards). The coordinates are top-level `let` literals so the cached-binary
 * runner can hoist them into environment variables and reuse one compiled binary.
 */
export function buildMouseClickSwift(x: number, y: number): string {
  return [
    'import CoreGraphics',
    'import Foundation',
    `let px = ${Math.round(x)}`,
    `let py = ${Math.round(y)}`,
    'let saved = CGEvent(source: nil)?.location ?? CGPoint(x: 0, y: 0)',
    'let target = CGPoint(x: px, y: py)',
    'func post(_ type: CGEventType, _ at: CGPoint) {',
    '    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at, mouseButton: .left)?.post(tap: .cghidEventTap)',
    '}',
    'post(.mouseMoved, target)',
    'usleep(150000)',
    'post(.leftMouseDown, target)',
    'usleep(70000)',
    'post(.leftMouseUp, target)',
    'usleep(200000)',
    'post(.mouseMoved, saved)',
    'print("clicked")',
    '',
  ].join('\n');
}

/** Prints the id of the front window (Chromium family; ids are integers there). */
export function buildFrontWindowIdScript(b: BrowserApp): string[] {
  return [
    'on run argv',
    `if not (application "${b.name}" is running) then error "rh:not_running"`,
    `tell application "${b.name}"`,
    'if (count of windows) is 0 then error "rh:no_window"',
    'return (id of front window) as text',
    'end tell',
    'end run',
  ];
}

export interface BrowserProfile {
  dir: string;
  name: string;
  email: string;
}

/** User-data directory (relative to ~/Library/Application Support) per Chromium browser. */
const USER_DATA_DIRS: Record<string, string> = {
  'Google Chrome': 'Google/Chrome',
  'Brave Browser': 'BraveSoftware/Brave-Browser',
  'Microsoft Edge': 'Microsoft Edge',
};

export function localStatePath(b: BrowserApp, home: string = os.homedir()): string | null {
  const rel = USER_DATA_DIRS[b.name];
  return rel ? path.join(home, 'Library', 'Application Support', rel, 'Local State') : null;
}

/**
 * The profiles that are in use: the ones that had windows open (`last_active_profiles`) plus
 * the last used one, from the browser's Local State. Guest and system profiles are skipped.
 */
export function parseActiveProfiles(localStateJson: string): BrowserProfile[] {
  try {
    const profile = (JSON.parse(localStateJson) as { profile?: Record<string, any> }).profile ?? {};
    const info: Record<string, any> = profile.info_cache ?? {};
    const dirs: string[] = [];
    for (const d of [profile.last_used, ...(Array.isArray(profile.last_active_profiles) ? profile.last_active_profiles : [])]) {
      if (typeof d === 'string' && d && !dirs.includes(d)) dirs.push(d);
    }
    return dirs
      .filter((d) => d !== 'Guest Profile' && d !== 'System Profile')
      .map((d) => ({
        dir: d,
        name: String(info[d]?.name ?? d),
        email: String(info[d]?.user_name ?? ''),
      }));
  } catch {
    return [];
  }
}

/** Escapes any open menus. */
export function buildEscapeScript(): string[] {
  return ['on run argv', 'tell application "System Events"', 'key code 53', 'delay 0.1', 'key code 53', 'end tell', 'return "escaped"', 'end run'];
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
    // `activate` (an Apple event to the browser) also switches to the Space that holds its
    // windows and un-hides it, which setting the System Events process frontmost does not.
    'tell application procName to activate',
    'delay 0.9',
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
  transport: Pick<AppleScriptTransport, 'evaluate' | 'environment'> & Partial<Pick<AppleScriptTransport, 'listTabs' | 'closeTab'>>;
  run?: RunOsascript;
  open?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** One real mouse click at screen coordinates (injectable; default runs a cached Swift helper). */
  clickAt?: (x: number, y: number) => Promise<boolean>;
  /** Reads the browser's Local State file (null when absent); injectable. */
  readLocalState?: (b: BrowserApp) => Promise<string | null>;
  /** Opens an empty window of a profile in the running browser; injectable. */
  openProfileWindow?: (b: BrowserApp, profileDir: string) => Promise<void>;
}

const MENU_TIMEOUT_MS = 10_000;
const VERIFY_INTERVAL_MS = 300;
const GUIDE_SECONDS = 45;

const defaultClickAt = async (x: number, y: number): Promise<boolean> => {
  const res = fastExec('swift', ['-e', buildMouseClickSwift(x, y)]);
  return res.status === 0 && res.stdout.trim() === 'clicked';
};

const defaultReadLocalState = async (b: BrowserApp): Promise<string | null> => {
  const file = localStatePath(b);
  if (!file) return null;
  try {
    return await fsp.readFile(file, 'utf-8');
  } catch {
    return null;
  }
};

/** `open -n -a <browser> --args --profile-directory=<dir> about:blank` hands a new window to the running instance. */
const defaultOpenProfileWindow = (b: BrowserApp, profileDir: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile('open', ['-n', '-a', b.name, '--args', `--profile-directory=${profileDir}`, 'about:blank'], (err) =>
      err ? reject(new Error('could not open a profile window')) : resolve(),
    );
  });

const defaultOpen = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile('open', [url], (err) => (err ? reject(new Error('could not open System Settings')) : resolve()));
  });

export class BrowserSetup {
  private readonly transport: BrowserSetupDeps['transport'];
  private readonly run: RunOsascript;
  private readonly open: (url: string) => Promise<void>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clickAt: (x: number, y: number) => Promise<boolean>;
  private readonly readLocalState: (b: BrowserApp) => Promise<string | null>;
  private readonly openProfileWindow: (b: BrowserApp, profileDir: string) => Promise<void>;

  constructor(deps: BrowserSetupDeps) {
    this.transport = deps.transport;
    this.run = deps.run ?? defaultRunOsascript;
    this.open = deps.open ?? defaultOpen;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // Never let a test (or any process that has not injected a clicker) post a real mouse click by accident.
    this.clickAt = deps.clickAt ?? (process.env.VITEST === 'true' ? async () => false : defaultClickAt);
    this.readLocalState = deps.readLocalState ?? defaultReadLocalState;
    this.openProfileWindow = deps.openProfileWindow ?? defaultOpenProfileWindow;
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
  async enableJs(b: BrowserApp, opts: { onGuide?: (message: string) => void } = {}): Promise<ToggleOutcome> {
    return this.toggleTo(b, 'checked', opts.onGuide);
  }

  /** Turns the setting off; reads first and clicks only when it is checked. */
  async disableJs(b: BrowserApp, opts: { onGuide?: (message: string) => void } = {}): Promise<ToggleOutcome> {
    return this.toggleTo(b, 'unchecked', opts.onGuide);
  }

  private async windowIds(b: BrowserApp): Promise<string[]> {
    try {
      const res = await this.run(buildWindowIdsScript(b), [], MENU_TIMEOUT_MS);
      return res.status === 0 ? res.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  private async tabKeys(b: BrowserApp): Promise<Set<string>> {
    try {
      return new Set((await this.transport.listTabs?.(b) ?? []).map((t) => `${t.windowId}:${t.tabKey}`));
    } catch {
      return new Set();
    }
  }

  /** The about:blank tab that appeared since `before` (the one this setup asked the browser to open). */
  private async newBlankTab(b: BrowserApp, before: Set<string>): Promise<{ windowId: string; tabKey: string } | null> {
    try {
      const fresh = (await this.transport.listTabs?.(b) ?? []).filter(
        (t) => !before.has(`${t.windowId}:${t.tabKey}`) && t.url.startsWith('about:blank'),
      );
      const t = fresh[0];
      return t ? { windowId: t.windowId, tabKey: t.tabKey } : null;
    } catch {
      return null;
    }
  }

  /** Profiles in use (see parseActiveProfiles); empty for browsers without a readable Local State. */
  async activeProfiles(b: BrowserApp): Promise<BrowserProfile[]> {
    const raw = await this.readLocalState(b);
    return raw ? parseActiveProfiles(raw) : [];
  }

  /**
   * Chromium keeps this setting per profile. For each profile in use: open an empty window of
   * that profile, switch the setting on there when it is off, and close the window again.
   */
  async enableForActiveProfiles(
    b: BrowserApp,
    opts: { onGuide?: (message: string) => void; onProgress?: (message: string) => void } = {},
  ): Promise<Array<{ profile: BrowserProfile; ok: boolean; changed: boolean; message?: string }>> {
    const results: Array<{ profile: BrowserProfile; ok: boolean; changed: boolean; message?: string }> = [];
    for (const profile of await this.activeProfiles(b)) {
      const label = profile.email ? `${profile.name} (${profile.email})` : profile.name;
      opts.onProgress?.(`Checking ${b.name} profile ${label}...`);
      // What exists before we open anything: only what we created may be closed afterwards.
      const windowsBefore = await this.windowIds(b);
      const tabsBefore = await this.tabKeys(b);
      let createdWindow: string | null = null;
      let createdTab: { windowId: string; tabKey: string } | null = null;
      try {
        await this.openProfileWindow(b, profile.dir);
        await this.sleep(1500);
        const windowsAfter = await this.windowIds(b);
        createdWindow = windowsAfter.find((id) => !windowsBefore.includes(id)) ?? null;
        if (!createdWindow) {
          // The profile already had a window: the browser opened the about:blank page as a new tab in it.
          createdTab = await this.newBlankTab(b, tabsBefore);
        }
        if (!createdWindow && !createdTab) {
          results.push({ profile, ok: false, changed: false, message: 'could not open a window for this profile' });
          continue;
        }
        const state = await this.inspect(b);
        if (state.status === 'ready') {
          results.push({ profile, ok: true, changed: false });
          continue;
        }
        if (state.status !== 'js_disabled') {
          results.push({ profile, ok: false, changed: false, message: state.message });
          continue;
        }
        const out = await this.flip(b, 'checked', 'on', opts.onGuide);
        results.push(out.ok ? { profile, ok: true, changed: out.changed } : { profile, ok: false, changed: false, message: out.message });
      } catch (err) {
        results.push({ profile, ok: false, changed: false, message: err instanceof Error ? condense(err.message) : 'error' });
      } finally {
        if (createdWindow) await this.closeTempWindow(b, createdWindow);
        else if (createdTab && this.transport.closeTab) {
          await this.transport.closeTab(b, createdTab).catch(() => undefined);
        }
      }
    }
    return results;
  }

  /** Probes the active tab of every window; used to spot profiles where the setting is still off. */
  async windowStatuses(b: BrowserApp): Promise<Array<{ windowIndex: number; status: string }>> {
    if (!this.transport.listTabs) return [];
    const out: Array<{ windowIndex: number; status: string }> = [];
    try {
      for (const t of (await this.transport.listTabs(b)).filter((x) => x.active)) {
        let status = 'ready';
        try {
          await this.transport.evaluate(b, { windowId: t.windowId, tabKey: t.tabKey }, '1');
        } catch (err) {
          status = err instanceof BrowserAutomationError ? err.code : 'error';
        }
        out.push({ windowIndex: t.windowIndex, status });
      }
    } catch {
      return [];
    }
    return out;
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
    // One probe per window (its active tab): different windows can belong to different
    // profiles, and the setting is per profile.
    if (this.transport.listTabs) {
      try {
        const tabs = (await this.transport.listTabs(b)).filter((t) => t.active);
        for (const t of tabs) {
          let status = 'ready';
          try {
            await this.transport.evaluate(b, { windowId: t.windowId, tabKey: t.tabKey }, '1');
          } catch (err) {
            status = err instanceof BrowserAutomationError ? err.code : 'error';
          }
          lines.push(`window ${t.windowIndex}: ${status}`);
        }
        if (tabs.length === 0) lines.push('windows: none listed');
      } catch (err) {
        lines.push(`windows: could not list (${err instanceof Error ? condense(err.message) : 'error'})`);
      }
    }
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

  private usesTempWindow(b: BrowserApp): boolean {
    // Chromium-family browsers with a plain window dictionary; Safari and Arc are handled differently.
    return b.family === 'chromium' && !b.inlineTabSpecifier;
  }

  private async openTempWindow(b: BrowserApp): Promise<string | null> {
    if (!this.usesTempWindow(b)) return null;
    try {
      const res = await this.run(buildTempWindowOpenScript(b), [], MENU_TIMEOUT_MS);
      const id = res.stdout.trim();
      return res.status === 0 && id ? id : null;
    } catch {
      return null;
    }
  }

  private async closeTempWindow(b: BrowserApp, id: string): Promise<void> {
    try {
      await this.run(buildTempWindowCloseScript(b), [id], MENU_TIMEOUT_MS);
    } catch {
      // best effort: an empty window left behind is harmless
    }
  }

  private async toggleTo(b: BrowserApp, want: 'checked' | 'unchecked', onGuide?: (message: string) => void): Promise<ToggleOutcome> {
    const wantState = want === 'checked' ? 'on' : 'off';
    const before = await this.currentState(b);
    if (typeof before === 'object') return before;
    if (before === 'missing') return { ok: false, reason: 'menu_missing', message: menuMissingMessage(b) };
    if (before === wantState) return { ok: true, changed: false, state: want };

    const tempId = await this.openTempWindow(b);
    try {
      return await this.flip(b, want, wantState, onGuide);
    } finally {
      if (tempId) await this.closeTempWindow(b, tempId);
    }
  }

  /** Polls until the browser reports the wanted state (probe first, menu check mark if the probe cannot tell). */
  private async waitFor(b: BrowserApp, wantState: 'on' | 'off', want: 'checked' | 'unchecked', attempts: number): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const probe = await this.inspect(b);
      const now = probe.status === 'ready' ? 'on' : probe.status === 'js_disabled' ? 'off' : null;
      if (now === wantState) return true;
      if (now === null) {
        const menu = await this.menuState(b);
        if (menu.ok && menu.state === want) return true;
      }
      await this.sleep(VERIFY_INTERVAL_MS);
    }
    return false;
  }

  /**
   * Four ways to flip the setting, each verified by probing the browser, tried in order:
   * an accessibility press on the menu item, a real mouse click on the opened menu item,
   * the Help-menu search, and finally opening the menu for the user to click it themselves.
   */
  private async flip(
    b: BrowserApp,
    want: 'checked' | 'unchecked',
    wantState: 'on' | 'off',
    onGuide?: (message: string) => void,
  ): Promise<ToggleOutcome> {
    const hard = (r: Extract<ToggleOutcome, { ok: false }>): boolean =>
      r.reason === 'system_events_denied' || r.reason === 'accessibility_denied' || r.reason === 'not_running';

    const clicked = await this.runScript(b, buildMenuToggleScript());
    if (!clicked.ok) {
      if (hard(clicked) || clicked.reason === 'menu_missing') return clicked;
    } else if (await this.waitFor(b, wantState, want, 4)) {
      return { ok: true, changed: true, state: want };
    }

    // A real mouse click on the opened menu item: the way the user's own click got through.
    const located = await this.runScript(b, buildLocateMenuItemScript());
    if (!located.ok) {
      if (hard(located)) return located;
    } else {
      const m = /^(-?\d+),(-?\d+)$/.exec(located.stdout.trim());
      let clickedOk = false;
      if (m) {
        try {
          clickedOk = await this.clickAt(Number(m[1]), Number(m[2]));
        } catch {
          clickedOk = false;
        }
      }
      if (clickedOk && (await this.waitFor(b, wantState, want, 5))) {
        return { ok: true, changed: true, state: want };
      }
      await this.run(buildEscapeScript(), [], MENU_TIMEOUT_MS).catch(() => undefined);
    }

    const searched = await this.runScript(b, buildHelpSearchScript());
    if (!searched.ok) {
      if (hard(searched)) return searched;
    } else if (await this.waitFor(b, wantState, want, 6)) {
      return { ok: true, changed: true, state: want };
    }

    if (onGuide) {
      const opened = await this.runScript(b, buildOpenMenuForUserScript());
      if (opened.ok) {
        onGuide(
          `I opened ${b.name}'s View > Developer menu. Click "${JS_MENU_ITEM}" there (I will notice and carry on; I wait up to ${GUIDE_SECONDS} seconds).`,
        );
        if (await this.waitFor(b, wantState, want, Math.ceil((GUIDE_SECONDS * 1000) / VERIFY_INTERVAL_MS))) {
          return { ok: true, changed: true, state: want };
        }
        // Close the menu if nobody used it.
        await this.run(buildEscapeScript(), [], MENU_TIMEOUT_MS).catch(() => undefined);
      }
    }

    return {
      ok: false,
      reason: 'script_error',
      message: `I could not switch it ${want === 'checked' ? 'on' : 'off'} automatically in ${b.name}. Do it yourself: ${b.name} menu bar > View > Developer > ${JS_MENU_ITEM} (use a normal window).`,
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

/** Where `rh browser setup` remembers what the user decided per browser. */
export function defaultSetupStatePath(home: string = os.homedir()): string {
  return path.join(home, '.remote-hands', 'browser-setup.json');
}

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
