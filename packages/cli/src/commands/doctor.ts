import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandContext } from './setup.js';
import { ensureWranglerLogin, defaultRunner } from '../cloudflare/wrangler.js';
import { checkBrowserHarness } from '../system/browser-harness.js';
import { defaultFileSystem } from '../cloudflare/project.js';
import { checkAgyPermissions, ensureAgyPermissions } from '../system/agy-permissions.js';

export async function doctorCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const runner = context.runner ?? defaultRunner;
  const fs = context.fs ?? defaultFileSystem;

  stdout('Running remote-hands health checks...');
  stdout('');

  const nodeVer = process.version;
  const majorNode = parseInt(nodeVer.slice(1).split('.')[0] ?? '0', 10);
  if (majorNode >= 22) {
    stdout(`[✓] Node.js version: ${nodeVer}`);
  } else {
    stdout(`[✗] Node.js version: ${nodeVer} (Node >= 22.0.0 required)`);
  }

  const bhInstalled = await checkBrowserHarness(runner);
  if (bhInstalled) {
    stdout('[✓] Browser automation: browser-harness (browser-use) is installed');
  } else {
    stdout('[!] Browser automation: browser-harness not found (install via: uv tool install --python 3.12 browser-harness)');
  }

  const agyRes = await runner('which', ['agy']);
  if (agyRes.exitCode === 0) {
    stdout('[✓] AI coding agent: agy is installed');
  } else {
    stdout('[!] AI coding agent: agy CLI not found on PATH');
  }

  const permsConfigured = await checkAgyPermissions(fs);
  if (permsConfigured) {
    stdout('[✓] AI coding agent: headless permissions and trusted workspaces configured');
  } else {
    const repaired = await ensureAgyPermissions(fs);
    if (repaired) {
      stdout('[✓] AI coding agent: repaired headless tool permissions & workspaces');
    } else {
      stdout('[!] AI coding agent: headless permissions could not be configured');
    }
  }

  const cfAuth = await ensureWranglerLogin(runner);
  if (cfAuth) {
    stdout('[✓] Cloudflare account: authenticated with Wrangler');
  } else {
    stdout('[!] Cloudflare account: not authenticated (run: npx wrangler login)');
  }

  const homeDir = os.homedir();
  const daemonConfig = path.join(homeDir, '.remote-hands', 'daemon.json');
  const hasConfig = await fs.exists(daemonConfig);
  if (hasConfig) {
    stdout(`[✓] Daemon configuration: ${daemonConfig} exists`);
  } else {
    stdout('[!] Daemon configuration: not found (run: rh setup)');
  }

  if (process.platform === 'darwin') {
    let fdaGranted = false;
    try {
      const fsModule = await import('node:fs');
      fsModule.readdirSync(path.join(os.homedir(), 'Library', 'Safari'));
      fdaGranted = true;
    } catch {}

    if (fdaGranted) {
      stdout('[✓] macOS Full Disk Access: granted');
    } else {
      stdout('[!] macOS Full Disk Access: not granted (System Settings -> Privacy & Security -> Full Disk Access)');
      stdout('    Grant Full Disk Access to Antigravity IDE / Terminal to prevent permission prompts when away');
    }
  }

  stdout('');
  return 0;
}
