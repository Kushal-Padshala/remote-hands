import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { CommandContext } from './setup.js';

function findChromeBinary(): string {
  if (process.platform === 'darwin') {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(macPath)) return macPath;
  }
  return 'google-chrome';
}

async function isCdpReady(url: string): Promise<boolean> {
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

export async function browserCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stderr = context.stderr ?? console.error;
  const cdpUrl = 'http://127.0.0.1:9222';
  const ready = await isCdpReady(`${cdpUrl}/json/version`);

  if (!ready) {
    const chromeBin = findChromeBinary();
    try {
      const child = spawn(
        chromeBin,
        [
          '--remote-debugging-port=9222',
          '--user-data-dir=/tmp/rh_chrome_profile',
          '--no-first-run',
          '--no-default-browser-check',
          '--headless=new',
        ],
        {
          detached: true,
          stdio: 'ignore',
        },
      );
      child.unref();

      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (await isCdpReady(`${cdpUrl}/json/version`)) {
          break;
        }
      }
    } catch (e) {
      stderr(`Failed to launch Chrome automation instance: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return new Promise((resolve) => {
    const proc = spawn('browser-harness', args, {
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
