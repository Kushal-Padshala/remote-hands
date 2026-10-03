import {
  AppleScriptTransport,
  BROWSERS,
  BrowserAutomationError,
  pickTargetBrowser,
  type BrowserApp,
} from '@remote-hands/daemon';

/** The slice of AppleScriptTransport the doctor needs (injectable in tests). */
export interface BrowserDoctorTransport {
  environment(): Promise<{ frontmost: string | null; running: string[] }>;
  evaluate(browser: BrowserApp, target: null, js: string, timeoutMs?: number): Promise<string>;
}

export interface BrowserDoctorOptions {
  transport?: BrowserDoctorTransport | undefined;
  env?: Record<string, string | undefined> | undefined;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}

interface BrowserReport {
  name: string;
  family: string;
  running: boolean;
  ready: boolean;
  code?: string;
  message?: string;
}

const SECURITY_NOTE =
  'Security: while "Allow JavaScript from Apple Events" is on, any app with Automation permission can run JavaScript in your tabs.';
const USAGE = 'Usage: rh browser doctor [--json]';

async function probe(transport: BrowserDoctorTransport, browser: BrowserApp): Promise<BrowserReport> {
  const base = { name: browser.name, family: browser.family, running: true };
  try {
    await transport.evaluate(browser, null, '1');
    return { ...base, ready: true };
  } catch (err) {
    if (err instanceof BrowserAutomationError) {
      return { ...base, ready: false, code: err.code, message: err.message };
    }
    return { ...base, ready: false, code: 'script_error', message: err instanceof Error ? err.message : String(err) };
  }
}

const SCRIPT_ERROR_HINT = ' (the front tab may be a restricted page such as chrome:// — try a normal web page)';
const TIMEOUT_HINT = ' (a macOS Automation permission prompt may be waiting for a click)';

function line(r: BrowserReport): string {
  if (!r.running) return `– ${r.name}  not running`;
  if (r.ready) return `✔ ${r.name}  fast path ready (checked on the front tab)`;
  if (r.code === 'no_window') return `✖ ${r.name}  ${r.message} Open a window to test it (setting unknown).`;
  if (r.code === 'script_error') return `✖ ${r.name}  ${r.message}${SCRIPT_ERROR_HINT}`;
  // The daemon's timeout message may already name the prompt; do not repeat it.
  if (r.code === 'timeout') return `✖ ${r.name}  ${r.message}${r.message?.includes('permission prompt') ? '' : TIMEOUT_HINT}`;
  return `✖ ${r.name}  ${r.message}`;
}

/**
 * `rh browser doctor [--json]`: read-only diagnosis of the fast browser path. It asks
 * which browsers are running first and only probes those with the harmless JavaScript
 * `1`, so it never launches a closed browser and never changes a setting. Always exits
 * 0 except for usage errors (it is a diagnostic, not a gate).
 */
export async function browserDoctor(args: string[], opts: BrowserDoctorOptions): Promise<number> {
  const json = args.includes('--json');
  if (args.some((a) => a !== '--json')) {
    opts.stderr(USAGE);
    return 1;
  }
  const transport = opts.transport ?? new AppleScriptTransport();
  const env = opts.env ?? process.env;

  let environment: { frontmost: string | null; running: string[] };
  try {
    environment = await transport.environment();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.stdout(json ? JSON.stringify({ target: null, browsers: [], error: message }, null, 2) : `✖ Could not read the running browsers: ${message}`);
    return 0;
  }

  const reports: BrowserReport[] = [];
  for (const browser of BROWSERS) {
    if (!environment.running.includes(browser.name)) {
      reports.push({ name: browser.name, family: browser.family, running: false, ready: false });
      continue;
    }
    reports.push(await probe(transport, browser));
  }
  const target = pickTargetBrowser({
    frontmost: environment.frontmost,
    running: environment.running,
    override: env.RH_BROWSER,
  });

  if (json) {
    opts.stdout(JSON.stringify({ target: target?.name ?? null, browsers: reports }, null, 2));
    return 0;
  }

  const lines = reports.map(line);
  lines.push('', `Target browser: ${target?.name ?? 'none'}`);
  const targetReport = reports.find((r) => r.name === target?.name);
  if (!target) {
    lines.push('Fast path not available: no supported browser is running. The CDP/accessibility fallback (Chrome only) applies.');
  } else if (targetReport?.ready) {
    lines.push(`Fast path ready for ${target.name}.`);
  } else if (targetReport?.code === 'script_error') {
    lines.push(
      `Fast path not confirmed for ${target.name}: the check failed on the front tab, not necessarily the setting. Open a normal web page and run rh browser doctor again.`,
    );
  } else {
    lines.push(`Fast path not available for ${target.name}; the slower CDP/accessibility fallback (Chrome only) applies until it is fixed.`);
  }
  lines.push(SECURITY_NOTE);
  opts.stdout(lines.join('\n'));
  return 0;
}
