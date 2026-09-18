import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { BrowserDriver } from '@remote-hands/daemon';
import type { CommandContext } from './setup.js';

export function findChromeBinary(): string {
  if (process.platform === 'darwin') {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(macPath)) return macPath;
  }
  return 'google-chrome';
}

export async function isCdpReady(url = 'http://127.0.0.1:9222/json/version'): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureChromeAutomationReady(options?: { headless?: boolean; cdpUrl?: string }): Promise<boolean> {
  const cdpUrl = options?.cdpUrl || process.env.BU_CDP_URL || 'http://127.0.0.1:9222';
  if (await isCdpReady(`${cdpUrl}/json/version`)) {
    return true;
  }

  let port = '9222';
  try {
    const parsed = new URL(cdpUrl);
    if (parsed.port) port = parsed.port;
  } catch {}

  const chromeBin = findChromeBinary();
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    '--user-data-dir=/tmp/rh_chrome_profile',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (options?.headless) {
    chromeArgs.push('--headless=new');
  }

  try {
    const child = spawn(chromeBin, chromeArgs, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (await isCdpReady(`${cdpUrl}/json/version`)) {
        return true;
      }
    }
  } catch {}
  return false;
}

export async function browserCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const isHeadless = args.includes('--headless') || process.env.REMOTE_HANDS_HEADLESS === '1';
  const cleanArgs = args.filter((a) => a !== '--headless');
  const cdpUrl = process.env.BU_CDP_URL || 'http://127.0.0.1:9222';

  const ready = await ensureChromeAutomationReady({ headless: isHeadless, cdpUrl });
  if (!ready) {
    stderr(`Warning: Chrome CDP at ${cdpUrl} is not responding`);
  }
  const subcommand = cleanArgs[0];
  const subArgs = cleanArgs.slice(1);

  if (subcommand === 'snapshot') {
    try {
      const driver = new BrowserDriver({ cdpUrl });
      const res = await driver.snapshot();
      if (subArgs.includes('--json')) {
        stdout(JSON.stringify(res, null, 2));
      } else {
        stdout(res.formattedTable);
      }
      return 0;
    } catch (err: any) {
      stderr(err?.message || String(err));
      return 1;
    }
  }

  if (subcommand === 'click') {
    const indexArg = subArgs[0];
    if (!indexArg || !/^\d+$/.test(indexArg)) {
      stderr('Usage: rh browser click <index>');
      return 1;
    }
    const index = parseInt(indexArg, 10);
    try {
      const driver = new BrowserDriver({ cdpUrl });
      const res = await driver.clickIndex(index);
      stdout(`Clicked [${index}] ${res.label}`);
      return 0;
    } catch (err: any) {
      stderr(err?.message || String(err));
      return 1;
    }
  }

  if (subcommand === 'type') {
    const indexArg = subArgs[0];
    if (!indexArg || !/^\d+$/.test(indexArg) || subArgs.length < 2) {
      stderr('Usage: rh browser type <index> <text>');
      return 1;
    }
    const index = parseInt(indexArg, 10);
    const textArg = subArgs.slice(1).join(' ');
    try {
      const driver = new BrowserDriver({ cdpUrl });
      const res = await driver.typeIndex(index, textArg);
      stdout(`Typed "${textArg}" into [${index}] ${res.label}`);
      return 0;
    } catch (err: any) {
      stderr(err?.message || String(err));
      return 1;
    }
  }

  if (subcommand === 'open') {
    const urlArg = subArgs[0];
    if (!urlArg) {
      stderr('Usage: rh browser open <url>');
      return 1;
    }
    try {
      new URL(urlArg);
    } catch {
      stderr(`Invalid URL: ${urlArg}`);
      return 1;
    }
    try {
      const driver = new BrowserDriver({ cdpUrl });
      const res = await driver.openUrl(urlArg);
      stdout(`Opened ${res.url}`);
      return 0;
    } catch (err: any) {
      stderr(err?.message || String(err));
      return 1;
    }
  }

  if (subcommand === 'tabs') {
    try {
      const driver = new BrowserDriver({ cdpUrl });
      const tabs = await driver.listTabs();
      if (subArgs.includes('--json')) {
        stdout(JSON.stringify(tabs, null, 2));
      } else if (tabs.length === 0) {
        stdout('No open tabs found.');
      } else {
        for (const tab of tabs) {
          stdout(`[${tab.id}] ${tab.title || '(untitled)'} - ${tab.url}`);
        }
      }
      return 0;
    } catch (err: any) {
      stderr(err?.message || String(err));
      return 1;
    }
  }

  return new Promise((resolve) => {
    const proc = spawn('browser-harness', cleanArgs, {
      env: {
        ...process.env,
        BU_CDP_URL: cdpUrl,
      },
      stdio: 'inherit',
    });

    proc.on('error', (err) => {
      stderr(`Error running browser-harness: ${err.message}`);
      resolve(1);
    });

    proc.on('close', (code) => {
      resolve(code ?? 0);
    });
  });
}
