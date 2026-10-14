import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandContext } from './setup.js';
import { ChromeManager, HudServiceManager, hudHotkeyLabel, readHudStatus } from '@remote-hands/daemon';
import { locateAgy } from '../system/agy.js';
import { ensureWranglerLogin, defaultRunner } from '../cloudflare/wrangler.js';
import { checkBrowserHarness } from '../system/browser-harness.js';
import { readMacHudStatus } from '../system/hud-mac-status.js';
import { defaultFileSystem } from '../cloudflare/project.js';
import { checkAgyPermissions, ensureAgyPermissions } from '../system/agy-permissions.js';
import {
  checkMacFullDiskAccess,
  checkMacScreenCapture,
  checkMacAccessibility,
  ensureMacPermissions,
  detectHostAppName,
} from '../system/mac-permissions.js';

export async function doctorCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const runner = context.runner ?? defaultRunner;
  const fs = context.fs ?? defaultFileSystem;

  stdout('Running remote-hands health checks...');
  stdout('');

  const nodeVer = process.version;
  // node:sqlite (used for the local task store) needs no flag from Node 22.13 / 23.4 on
  const [majorNode = 0, minorNode = 0] = nodeVer.slice(1).split('.').map((n) => parseInt(n, 10) || 0);
  const nodeOk = majorNode >= 24 || (majorNode === 23 && minorNode >= 4) || (majorNode === 22 && minorNode >= 13);
  if (nodeOk) {
    stdout(`[✓] Node.js version: ${nodeVer}`);
  } else {
    stdout(`[✗] Node.js version: ${nodeVer} (Node 22.13.0 or newer required)`);
  }

  const bhInstalled = await checkBrowserHarness(runner);
  if (bhInstalled) {
    stdout('[✓] Browser automation: browser-harness (browser-use) is installed');
  } else {
    stdout('[!] Browser automation: browser-harness not found (install via: uv tool install --python 3.12 browser-harness)');
  }

  const agyPath = await locateAgy(runner);
  if (agyPath !== undefined) {
    stdout('[✓] AI coding agent: agy is installed');
  } else {
    stdout(process.platform === 'win32' ? '[!] AI coding agent: agy CLI not found (run: rh setup)' : '[!] AI coding agent: agy CLI not found on PATH');
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

  if (process.platform === 'win32') {
    const browser = ChromeManager.findBrowserExecutable();
    if (browser) {
      stdout(`[✓] Browser: ${browser.kind === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'} found (Remote Hands opens its own window with its own profile)`);
    } else {
      stdout('[!] Browser: no Chrome or Edge found (install Google Chrome from https://www.google.com/chrome)');
    }
    const hud = new HudServiceManager();
    if (!hud.isInstalled()) {
      stdout('[!] Desktop HUD: not installed (run: rh setup)');
    } else if (!hud.isRunning()) {
      stdout('[!] Desktop HUD: installed but not running (run: rh hud install; log: ~/.remote-hands/logs/hud.log)');
    } else if (readHudStatus()?.state === 'failed') {
      stdout('[!] Desktop HUD: running, but its shortcut is used by another program (Ctrl + Shift + Space and Ctrl + Alt + Space)');
    } else if (readHudStatus()?.state === 'ready') {
      stdout(`[✓] Desktop HUD: running; press ${hudHotkeyLabel()} to open it`);
    } else {
      stdout('[!] Desktop HUD: running but has not confirmed its shortcut (starting, or blocked; log: ~/.remote-hands/logs/hud.log)');
    }
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

    // The login service is its own program: what it was allowed and whether it holds its shortcut is its own answer
    const hud = (context.hudServiceManager as HudServiceManager | undefined) ?? new HudServiceManager();
    if (!hud.isInstalled()) {
      stdout('[!] Desktop HUD: not installed (run: rh setup)');
    } else if (!hud.isRunning()) {
      stdout('[!] Desktop HUD: installed but not running (run: rh hud install; logs: ~/.remote-hands/logs/hud.error.log)');
    } else {
      const shortcut = readHudStatus()?.state;
      if (shortcut === 'ready') stdout(`[✓] Desktop HUD: running; press ${hudHotkeyLabel()} to open it`);
      else if (shortcut === 'failed') stdout(`[!] Desktop HUD: running, but ${hudHotkeyLabel()} is used by another app (for example Raycast or Alfred)`);
      else stdout('[!] Desktop HUD: running but has not confirmed its shortcut (starting; logs: ~/.remote-hands/logs/hud.error.log)');
      const own = readMacHudStatus();
      if (own && !own.screenRecording && !own.checking) {
        stdout(`[!] Desktop HUD Screen Recording: the background HUD does not have it. Switch on "node" (${own.node}) in System Settings -> Privacy & Security -> Screen & System Audio Recording, then run: rh hud install`);
      } else if (own?.screenRecording) {
        stdout('[✓] Desktop HUD Screen Recording: granted to the background HUD');
      }
      if (typeof hud.installedCopyIsStale === 'function' && hud.installedCopyIsStale()) {
        stdout('[!] Desktop HUD: runs an older copy of Remote Hands (run: rh hud install)');
      }
    }

    if (args.includes('--fix') && !context.runner && (!fdaGranted || !screenGranted || !accessGranted)) {
      await ensureMacPermissions(stdout, 74);
    }

    try {
      const pmRes = runner
        ? await runner('pmset', ['-g'])
        : (await import('node:child_process')).spawnSync('pmset', ['-g'], { encoding: 'utf-8' });
      const pmOut = 'stdout' in pmRes ? String(pmRes.stdout) : '';
      if (pmOut.includes('SleepDisabled\t\t1')) {
        if (args.includes('--fix') && !runner) {
          (await import('node:child_process')).spawnSync('sudo', ['pmset', '-a', 'disablesleep', '0'], { stdio: 'inherit' });
          const verifyRes = (await import('node:child_process')).spawnSync('pmset', ['-g'], { encoding: 'utf-8' });
          if (!verifyRes.stdout.includes('SleepDisabled\t\t1')) {
            stdout('[✓] macOS Power Management: normal sleep restored');
          } else {
            stdout('[!] macOS Sleep Prevention: SleepDisabled is ON (normal sleep is prevented)');
            stdout('    To restore normal sleep and save battery, run: sudo pmset -a disablesleep 0');
          }
        } else {
          stdout('[!] macOS Sleep Prevention: SleepDisabled is ON (normal sleep is prevented)');
          stdout('    To restore normal sleep and save battery, run: sudo pmset -a disablesleep 0');
        }
      } else {
        stdout('[✓] macOS Power Management: normal sleep enabled');
      }
    } catch {}
  }

  stdout('');
  return 0;
}
