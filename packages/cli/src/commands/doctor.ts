import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandContext } from './setup.js';
import { ChromeManager } from '@remote-hands/daemon';
import { ensureWranglerLogin, defaultRunner } from '../cloudflare/wrangler.js';
import { checkBrowserHarness } from '../system/browser-harness.js';
import { defaultFileSystem } from '../cloudflare/project.js';
import { checkAgyPermissions, ensureAgyPermissions } from '../system/agy-permissions.js';
import {
  checkMacFullDiskAccess,
  checkMacScreenCapture,
  checkMacAccessibility,
  ensureMacPermissions,
  detectHostAppName,
  grantMacAutomationPermissions,
} from '../system/mac-permissions.js';

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

  const chromeManager = new ChromeManager({ mode: 'dedicated', port: 9222 });
  const chromeStatus = await chromeManager.checkDebuggerStatus();
  if (chromeStatus.available) {
    stdout(`[✓] Chrome remote debugging: active on port ${chromeStatus.port}`);
  } else {
    stdout(`[✓] Chrome remote debugging: ready on demand (port 9222, profile: ${chromeStatus.profileDir})`);
  }

  const profiles = ChromeManager.listProfiles();
  if (profiles.length > 0) {
    const profileNames = profiles.map((p) => p.name).join(', ');
    stdout(`[✓] Chrome profiles: ${profiles.length} detected (${profileNames})`);
  } else {
    stdout('[!] Chrome profiles: 0 detected');
  }

  if (process.platform === 'darwin') {
    const fdaGranted = checkMacFullDiskAccess();
    const screenGranted = checkMacScreenCapture();
    const accessGranted = checkMacAccessibility();
    const hostApp = detectHostAppName();

    if (screenGranted) {
      stdout('[✓] macOS Screen & System Audio Recording: granted');
    } else {
      stdout('[!] macOS Screen & System Audio Recording: not granted (System Settings -> Privacy & Security -> Screen & System Audio Recording)');
      stdout(`    Grant Screen Recording to ${hostApp} (and Terminal) for live desktop streaming`);
    }

    if (fdaGranted) {
      stdout('[✓] macOS Full Disk Access: granted');
      grantMacAutomationPermissions();
      stdout('[✓] macOS Desktop Automation: pre-authorized for Notes, Safari, Chrome, System Events');
    } else {
      stdout('[!] macOS Full Disk Access: not granted (System Settings -> Privacy & Security -> Full Disk Access)');
      stdout(`    Grant Full Disk Access to ${hostApp} (and Terminal) to prevent permission prompts when away`);
    }

    if (accessGranted) {
      stdout('[✓] macOS Accessibility: granted');
    } else {
      stdout('[!] macOS Accessibility: not granted (System Settings -> Privacy & Security -> Accessibility)');
      stdout(`    Grant Accessibility to ${hostApp} (and Terminal) for window and keyboard automation`);
    }

    if (args.includes('--fix') && !context.runner && (!fdaGranted || !screenGranted || !accessGranted)) {
      await ensureMacPermissions(stdout, 74);
    }
  }

  stdout('');
  return 0;
}
