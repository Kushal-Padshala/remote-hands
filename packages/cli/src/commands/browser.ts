import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

export async function ensureChromeAutomationReady(options?: { headless?: boolean }): Promise<boolean> {
  const cdpUrl = 'http://127.0.0.1:9222';
  if (await isCdpReady(`${cdpUrl}/json/version`)) {
    return true;
  }

  const chromeBin = findChromeBinary();
  const chromeArgs = [
    '--remote-debugging-port=9222',
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
  const stderr = context.stderr ?? console.error;
  const isHeadless = args.includes('--headless') || process.env.REMOTE_HANDS_HEADLESS === '1';
  const cleanArgs = args.filter((a) => a !== '--headless');

  const ready = await ensureChromeAutomationReady({ headless: isHeadless });
  if (!ready) {
    stderr('Warning: Chrome CDP port 9222 is not responding');
  }

  const cdpUrl = 'http://127.0.0.1:9222';
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
