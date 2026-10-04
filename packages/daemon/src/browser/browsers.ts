/** Browsers the fast engine can drive through AppleScript, in preference order. */
export type BrowserFamily = 'chromium' | 'safari';

export interface BrowserApp {
  /** Exact macOS application / process name. */
  name: string;
  family: BrowserFamily;
  /** Lower-case names a user or model may use for this browser. */
  aliases: readonly string[];
  /**
   * Arc: tab and window objects cannot be stored in AppleScript variables (they fail with
   * -1700 "Can't make «class» id ... into type specifier"), so scripts must address tabs
   * with inline specifiers (`tell tab id X of window id Y`).
   */
  inlineTabSpecifier?: boolean;
  /** Arc returns JavaScript results JSON-encoded (a string arrives wrapped in quotes). */
  jsonEncodedResult?: boolean;
}

export const BROWSERS: readonly BrowserApp[] = [
  { name: 'Google Chrome', family: 'chromium', aliases: ['chrome', 'google chrome'] },
  { name: 'Brave Browser', family: 'chromium', aliases: ['brave', 'brave browser'] },
  { name: 'Arc', family: 'chromium', aliases: ['arc'], inlineTabSpecifier: true, jsonEncodedResult: true },
  { name: 'Microsoft Edge', family: 'chromium', aliases: ['edge', 'microsoft edge'] },
  { name: 'Safari', family: 'safari', aliases: ['safari'] },
];

/** Case-insensitive lookup by app name or alias. */
export function findBrowser(name: string): BrowserApp | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return BROWSERS.find((b) => b.name.toLowerCase() === key || b.aliases.includes(key));
}

/**
 * Choose the browser to drive: a running override, else the frontmost app when it
 * is a supported browser, else the first running supported browser.
 */
export function pickTargetBrowser(opts: {
  frontmost?: string | null | undefined;
  running: readonly string[];
  override?: string | undefined;
}): BrowserApp | undefined {
  const isRunning = (b: BrowserApp): boolean => opts.running.includes(b.name);
  if (opts.override) {
    const wanted = findBrowser(opts.override);
    if (wanted && isRunning(wanted)) return wanted;
  }
  if (opts.frontmost) {
    const front = BROWSERS.find((b) => b.name === opts.frontmost);
    if (front) return front;
  }
  return BROWSERS.find(isRunning);
}
