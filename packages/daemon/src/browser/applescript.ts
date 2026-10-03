import { BROWSERS, type BrowserApp } from './browsers.js';

/**
 * AppleScript builders and osascript error classification for the fast browser engine.
 *
 * Every builder returns the `-e` line array for `osascript`. User data (JavaScript,
 * URLs, window and tab ids) never appears in the script text: it is passed as
 * `osascript` arguments and read inside `on run argv`. The only interpolated value is
 * the registry browser name, a constant from BROWSERS.
 */

export type BrowserErrorCode =
  | 'not_running'
  | 'no_window'
  | 'no_tab'
  | 'automation_denied'
  | 'js_disabled'
  | 'timeout'
  | 'script_error';

export class BrowserAutomationError extends Error {
  readonly code: BrowserErrorCode;
  readonly browser: string;

  constructor(code: BrowserErrorCode, browser: string, message: string) {
    super(message);
    this.name = 'BrowserAutomationError';
    this.code = code;
    this.browser = browser;
  }
}

/** A tab address: chromium tab id, or Safari tab index as text. */
export interface TabTarget {
  windowId: string;
  tabKey: string;
}

const MAX_DETAIL = 300;

function messageFor(code: BrowserErrorCode, b: BrowserApp, detail: string): string {
  const n = b.name;
  switch (code) {
    case 'js_disabled':
      return b.family === 'safari'
        ? 'Safari has JavaScript from Apple Events turned off. Enable it once: Safari > Settings > Advanced > Show features for web developers, then Develop > Allow JavaScript from Apple Events.'
        : `${n} has JavaScript from Apple Events turned off. Enable it once: ${n} menu bar > View > Developer > Allow JavaScript from Apple Events.`;
    case 'automation_denied':
      return `macOS blocked this app from controlling ${n}. Allow it in System Settings > Privacy & Security > Automation (enable ${n} under the app that runs Remote Hands).`;
    case 'not_running':
      return `${n} is not running.`;
    case 'no_window':
      return `${n} has no open window.`;
    case 'no_tab':
      return 'The target tab is gone. Call browser_tabs and focus a tab again.';
    case 'timeout':
      return `${n} did not answer in time.`;
    case 'script_error':
      return `${n} automation failed: ${detail}`;
  }
}

/** Single line, at most MAX_DETAIL characters. */
function condense(stderr: string): string {
  const oneLine = stderr.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_DETAIL ? `${oneLine.slice(0, MAX_DETAIL)}...` : oneLine;
}

export function classifyOsascriptError(
  browser: BrowserApp,
  stderr: string,
  status: number | null,
): BrowserAutomationError {
  const make = (code: BrowserErrorCode, detail = ''): BrowserAutomationError =>
    new BrowserAutomationError(code, browser.name, messageFor(code, browser, detail));
  if (status === null) return make('timeout');
  // Every pattern is anchored at the start of osascript's own error line, so page data
  // quoted later in an error (e.g. "Can't make {...} into type text") cannot change the class.
  const text = stderr.trim();
  const name = escapeRegExp(browser.name);
  const prefix = String.raw`^(?:-?\d+:-?\d+: )?`;
  const marker = new RegExp(`${prefix}execution error: rh:(not_running|no_window|no_tab) \\(-2700\\)$`).exec(text);
  if (marker) return make(marker[1] as BrowserErrorCode);
  if (new RegExp(`${prefix}(?:execution error: )?(?:${name} got an error: )?Not authorized to send Apple events to ${name}\\. \\(-1743\\)`).test(text)) {
    return make('automation_denied');
  }
  if (
    new RegExp(
      `${prefix}(?:execution error: )?${name} got an error: (?:Executing JavaScript through AppleScript is turned off|You must enable [^\\n]{0,60}Allow JavaScript from Apple Events)`,
    ).test(text)
  ) {
    return make('js_disabled');
  }
  // The script names the app with literal terminology; when the app is not installed
  // osascript cannot load its dictionary and the script fails to compile.
  if (
    new RegExp(`${prefix}syntax error: [^\\n]*\\((?:-2741|-2740)\\)$`).test(text) ||
    new RegExp(`${prefix}(?:execution error: )?Can[’']t get application "${name}"\\. \\(-1728\\)$`).test(text)
  ) {
    return new BrowserAutomationError('not_running', browser.name, `${browser.name} is not installed or not running.`);
  }
  return make('script_error', text === '' ? `osascript exited with status ${status}` : condense(text));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

/** Replaces tab / CR / LF with spaces so one tab stays on one output line. */
const CLEAN_HANDLER: readonly string[] = [
  'on rhClean(s)',
  'if s is missing value then return ""',
  'set s to s as text',
  'set oldDelims to AppleScript\'s text item delimiters',
  'set AppleScript\'s text item delimiters to {character id 9, character id 10, character id 13}',
  'set parts to text items of s',
  'set AppleScript\'s text item delimiters to " "',
  'set s to parts as text',
  'set AppleScript\'s text item delimiters to oldDelims',
  'return s',
  'end rhClean',
];

/** Raises rh:not_running without ever sending an event that would launch the app. */
function guard(b: BrowserApp): string {
  return `if not (application "${b.name}" is running) then error "rh:not_running"`;
}

/**
 * Chromium: resolves `theTab` from `wid` / `tkey` (empty wid = active tab of the
 * front window). Must run inside `tell application`.
 */
const CHROMIUM_FIND_TAB: readonly string[] = [
  'if (count of windows) is 0 then error "rh:no_window"',
  'if wid is "" then',
  'set theTab to active tab of front window',
  'else',
  'set theTab to missing value',
  'repeat with w in windows',
  'if ((id of w) as text) is wid then',
  'repeat with t in tabs of w',
  'if ((id of t) as text) is tkey then',
  'set theTab to contents of t',
  'exit repeat',
  'end if',
  'end repeat',
  'exit repeat',
  'end if',
  'end repeat',
  'if theTab is missing value then error "rh:no_tab"',
  'end if',
];

/** Safari: resolves `theTab` from `wid` / `tkey` (empty wid = current tab of the front window). */
const SAFARI_FIND_TAB: readonly string[] = [
  'if (count of windows) is 0 then error "rh:no_window"',
  'if wid is "" then',
  'set theTab to current tab of front window',
  'else',
  'try',
  'set theTab to tab (tkey as integer) of window id (wid as integer)',
  'get name of theTab',
  'on error',
  'error "rh:no_tab"',
  'end try',
  'end if',
];

function findTab(b: BrowserApp): readonly string[] {
  return b.family === 'safari' ? SAFARI_FIND_TAB : CHROMIUM_FIND_TAB;
}

function tellApp(b: BrowserApp, body: readonly string[]): string[] {
  return [`tell application "${b.name}"`, ...body, 'end tell'];
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * argv: js, windowId, tabKey. An empty windowId targets the front window's active
 * (chromium) / current (Safari) tab. Prints the JavaScript result as text; an
 * undefined / missing result prints an empty line.
 *
 * The `is running` guard and the `tell` are not atomic: if the user quits the browser
 * between the two, the `tell` relaunches it. The window is milliseconds wide and
 * inherent to AppleScript; the guard exists to avoid launching browsers that were
 * never running.
 */
export function buildEvalScript(b: BrowserApp): string[] {
  const exec =
    b.family === 'safari' ? 'set res to do JavaScript js in theTab' : 'set res to execute theTab javascript js';
  return [
    'on run argv',
    'set js to item 1 of argv',
    'set wid to item 2 of argv',
    'set tkey to item 3 of argv',
    'set res to missing value',
    guard(b),
    ...tellApp(b, [...findTab(b), exec]),
    'if res is missing value then return ""',
    'return res as text',
    'end run',
  ];
}

/**
 * Tab listing. No argv. Prints one line per tab, fields separated by a TAB:
 *
 *   windowId  windowIndex  tabKey  tabIndex  active  title  url
 *
 * windowIndex / tabIndex are 1-based, `active` is `true` / `false`, and tabs, CRs and
 * LFs inside title and url are replaced with spaces. tabKey is the chromium tab id
 * or, for Safari, the tab index.
 */
export function buildTabsScript(b: BrowserApp): string[] {
  const perWindow =
    b.family === 'safari'
      ? [
          'try',
          'set wid to (id of w) as text',
          'set actKey to (index of current tab of w) as text',
          'set tKeys to index of tabs of w',
          'set tTitles to name of tabs of w',
          'set tUrls to URL of tabs of w',
          'on error',
          'set tKeys to {}',
          'end try',
        ]
      : [
          'set wid to (id of w) as text',
          'set actKey to (id of active tab of w) as text',
          'set tKeys to id of tabs of w',
          'set tTitles to title of tabs of w',
          'set tUrls to URL of tabs of w',
        ];
  return [
    ...CLEAN_HANDLER,
    'on run argv',
    guard(b),
    'set sep to character id 9',
    'set out to ""',
    ...tellApp(b, [
      'set wIdx to 0',
      'repeat with w in windows',
      'set wIdx to wIdx + 1',
      ...perWindow,
      'repeat with i from 1 to (count of tKeys)',
      'set k to (item i of tKeys) as text',
      'set out to out & wid & sep & wIdx & sep & k & sep & i & sep & ((k is actKey) as text) & sep & (my rhClean(item i of tTitles)) & sep & (my rhClean(item i of tUrls)) & linefeed',
      'end repeat',
      'end repeat',
    ]),
    'return out',
    'end run',
  ];
}

/** argv: windowId, tabKey. Selects the tab, raises its window and activates the browser. */
export function buildFocusScript(b: BrowserApp): string[] {
  const body =
    b.family === 'safari'
      ? [
          'if (count of windows) is 0 then error "rh:no_window"',
          'try',
          'set theWin to window id (wid as integer)',
          'set theTab to tab (tkey as integer) of theWin',
          'get name of theTab',
          'on error',
          'error "rh:no_tab"',
          'end try',
          'set current tab of theWin to theTab',
          'set index of theWin to 1',
          'activate',
        ]
      : [
          'if (count of windows) is 0 then error "rh:no_window"',
          'set found to false',
          'repeat with w in windows',
          'if ((id of w) as text) is wid then',
          'set i to 0',
          'repeat with t in tabs of w',
          'set i to i + 1',
          'if ((id of t) as text) is tkey then',
          // Arc has no `active tab index`; it selects tabs with its `select` command.
          b.name === 'Arc' ? 'tell t to select' : 'set active tab index of w to i',
          'set index of w to 1',
          'set found to true',
          'exit repeat',
          'end if',
          'end repeat',
          'exit repeat',
          'end if',
          'end repeat',
          'if not found then error "rh:no_tab"',
          'activate',
        ];
  return [
    'on run argv',
    'set wid to item 1 of argv',
    'set tkey to item 2 of argv',
    guard(b),
    ...tellApp(b, body),
    'end run',
  ];
}

/** argv: url, windowId. Opens the URL in a new tab; an empty windowId uses the front window. */
export function buildOpenScript(b: BrowserApp): string[] {
  const body =
    b.family === 'safari'
      ? [
          'if wid is "" then',
          'if (count of windows) is 0 then',
          'make new document with properties {URL:u}',
          'else',
          'tell front window to set current tab to (make new tab with properties {URL:u})',
          'end if',
          'else',
          'try',
          'set theWin to window id (wid as integer)',
          'get name of theWin',
          'on error',
          'error "rh:no_window"',
          'end try',
          'tell theWin to set current tab to (make new tab with properties {URL:u})',
          'end if',
        ]
      : [
          'if wid is "" then',
          'if (count of windows) is 0 then',
          'make new window',
          'set URL of active tab of front window to u',
          'else',
          'tell front window to make new tab with properties {URL:u}',
          'end if',
          'else',
          'set theWin to missing value',
          'repeat with w in windows',
          'if ((id of w) as text) is wid then',
          'set theWin to contents of w',
          'exit repeat',
          'end if',
          'end repeat',
          'if theWin is missing value then error "rh:no_window"',
          'tell theWin to make new tab with properties {URL:u}',
          'end if',
        ];
  return [
    'on run argv',
    'set u to item 1 of argv',
    'set wid to item 2 of argv',
    guard(b),
    ...tellApp(b, body),
    'end run',
  ];
}

/** argv: windowId, tabKey. Closes that tab (empty windowId = the front window's active tab). */
export function buildCloseScript(b: BrowserApp): string[] {
  return [
    'on run argv',
    'set wid to item 1 of argv',
    'set tkey to item 2 of argv',
    guard(b),
    ...tellApp(b, [...findTab(b), 'close theTab']),
    'end run',
  ];
}

/**
 * No argv. Line 1: the frontmost application's name (empty when unknown). Each further
 * line: a running registry browser name. Uses only `is running` checks and
 * `path to frontmost application`, so it launches nothing and needs no System Events
 * automation permission.
 */
export function buildRunningScript(): string[] {
  return [
    'on run argv',
    'set out to ""',
    // Derive the name from the bundle path: `info for` would compute the bundle size
    // (seconds for large apps such as Xcode).
    'try',
    'set p to (path to frontmost application) as text',
    'if p ends with ":" then set p to text 1 thru -2 of p',
    'set oldDelims to AppleScript\'s text item delimiters',
    'set AppleScript\'s text item delimiters to ":"',
    'set out to last text item of p',
    'set AppleScript\'s text item delimiters to oldDelims',
    'end try',
    'if out ends with ".app" then set out to text 1 thru -5 of out',
    ...BROWSERS.map(
      (b) => `if application "${b.name}" is running then set out to out & linefeed & "${b.name}"`,
    ),
    'return out',
    'end run',
  ];
}
