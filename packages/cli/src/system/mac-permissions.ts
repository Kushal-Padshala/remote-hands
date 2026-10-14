import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { axHelperEnabledByDefault, axHelperTrust, ensureAxHelperBinary } from '@remote-hands/daemon';
import { c } from '../output/ui.js';

export function checkMacFullDiskAccess(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    fs.readdirSync(path.join(os.homedir(), 'Library', 'Safari'));
    return true;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return true;
    }
    return false;
  }
}

export function detectHostAppName(): string {
  if (process.platform !== 'darwin') return 'Terminal';

  const bundleId = process.env.__CFBundleIdentifier;
  if (bundleId) {
    if (bundleId.includes('antigravity')) return 'Antigravity IDE';
    if (bundleId.includes('cursor')) return 'Cursor';
    if (bundleId.includes('vscode') || bundleId.includes('visualstudio')) return 'Visual Studio Code';
    if (bundleId.includes('Apple_Terminal') || bundleId.includes('terminal')) return 'Terminal';
    if (bundleId.includes('iterm')) return 'iTerm';
    if (bundleId.includes('warp')) return 'Warp';
    if (bundleId.includes('ghostty')) return 'Ghostty';
  }

  const tp = process.env.TERM_PROGRAM;
  if (tp === 'Apple_Terminal') return 'Terminal';
  if (tp === 'iTerm.app' || tp === 'iTerm') return 'iTerm';
  if (tp === 'WarpTerminal' || tp === 'Warp') return 'Warp';
  if (tp === 'ghostty') return 'Ghostty';
  if (tp === 'cursor') return 'Cursor';
  if (tp === 'vscode') {
    if (bundleId?.includes('antigravity')) return 'Antigravity IDE';
    return 'Visual Studio Code';
  }

  try {
    let pid = process.ppid;
    for (let i = 0; i < 6; i++) {
      const res = spawnSync('ps', ['-p', String(pid), '-o', 'ppid=,comm='], { encoding: 'utf-8' });
      const line = (res.stdout || '').trim();
      const parts = line.split(/\s+/);
      const parentPid = parseInt(parts[0] || '0', 10);
      const comm = parts.slice(1).join(' ');
      if (comm.includes('.app/')) {
        const match = comm.match(/\/([^\/]+)\.app\//);
        if (match && match[1]) return match[1];
      }
      if (!parentPid || parentPid <= 1) break;
      pid = parentPid;
    }
  } catch {}

  return 'Terminal';
}

export function probeMacAppDataPermissions(): void {
  if (process.platform !== 'darwin') return;
  const probePaths = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
    path.join(os.homedir(), 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
    path.join(os.homedir(), 'Library', 'Application Support', 'com.apple.TCC'),
  ];
  for (const p of probePaths) {
    try {
      if (fs.existsSync(p)) {
        fs.readdirSync(p);
      }
    } catch {}
  }
}

export function checkMacScreenCapture(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    const binPath = path.join(os.homedir(), '.remote-hands', 'bin', 'rh-screenshot');
    if (fs.existsSync(binPath)) {
      const res = spawnSync(binPath, ['--check'], { encoding: 'utf-8', timeout: 2000 });
      if (res.stdout && res.stdout.includes('AUTHORIZED')) return true;
      if (res.stdout && res.stdout.includes('DENIED')) return false;
    }
    const res = spawnSync('swift', ['-e', 'import CoreGraphics; exit(CGPreflightScreenCaptureAccess() ? 0 : 1)'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

export function requestMacScreenCapture(): void {
  if (process.platform !== 'darwin') return;
  try {
    spawnSync('swift', ['-e', 'import CoreGraphics; _ = CGRequestScreenCaptureAccess()'], {
      stdio: 'ignore',
      timeout: 3000,
    });
  } catch {}
  try {
    const probeFile = path.join(os.tmpdir(), `rh_probe_${Date.now()}.png`);
    spawnSync('screencapture', ['-x', probeFile], { timeout: 3000 });
    if (fs.existsSync(probeFile)) {
      try {
        fs.unlinkSync(probeFile);
      } catch {}
    }
  } catch {}
  try {
    const binPath = path.join(os.homedir(), '.remote-hands', 'bin', 'rh-screenshot');
    if (fs.existsSync(binPath)) {
      spawnSync(binPath, ['--check'], { timeout: 2000 });
    }
  } catch {}
}

export function checkMacAccessibility(): boolean {
  if (process.platform !== 'darwin') return true;
  // Remote Hands' own helper holds the permission ("Remote Hands" in System Settings), whatever started it.
  const own = axHelperTrust();
  if (own !== 'unavailable') return own === 'trusted';
  try {
    const res = spawnSync('swift', ['-e', 'import ApplicationServices; exit(AXIsProcessTrusted() ? 0 : 1)'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

export function openMacPrivacySettings(
  pane: 'FullDiskAccess' | 'AppManagement' | 'Automation' | 'ScreenCapture' | 'Accessibility' = 'FullDiskAccess',
): void {
  if (process.platform !== 'darwin') return;
  let url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
  if (pane === 'AppManagement') {
    url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles';
  } else if (pane === 'Automation') {
    url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';
  } else if (pane === 'ScreenCapture') {
    url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
  } else if (pane === 'Accessibility') {
    url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
  }
  try {
    const child = spawn('open', [url], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {}
}

export interface EnsureMacPermissionsOptions {
  /**
   * Full Disk Access only saves the desktop HUD a few "allow access to Documents" pop-ups. It is mentioned, but not asked
   * for and not waited on (the remote flow, which runs while nobody is at the Mac, still asks for it).
   */
  fullDiskAccessOptional?: boolean | undefined;
}

/** Everything the flow touches in the real world; tests replace it. */
export interface MacPermissionDeps {
  checkScreen?: (() => boolean) | undefined;
  checkFullDisk?: (() => boolean) | undefined;
  checkAccessibility?: (() => boolean) | undefined;
  requestScreen?: (() => void) | undefined;
  openPane?: ((pane: 'FullDiskAccess' | 'ScreenCapture' | 'Accessibility') => void) | undefined;
  /** macOS's own "allow Remote Hands" window for Accessibility; 'unavailable' when the helper is not built. */
  promptAccessibility?: (() => 'trusted' | 'untrusted' | 'unavailable') | undefined;
  helperPresent?: (() => boolean) | undefined;
  prepareHelper?: (() => Promise<unknown>) | undefined;
  isTTY?: boolean | undefined;
  /** How long to wait for the person (a terminal waits much longer: they are reading and clicking). */
  waitMs?: number | undefined;
  pollMs?: number | undefined;
  hostApp?: string | undefined;
  nodePath?: string | undefined;
}

export async function ensureMacPermissions(
  stdout: (msg: string) => void = console.log,
  termWidth: number = 74,
  options: EnsureMacPermissionsOptions = {},
  deps: MacPermissionDeps = {},
): Promise<boolean> {
  if (process.platform !== 'darwin') return true;

  const checkScreen = deps.checkScreen ?? checkMacScreenCapture;
  const checkFullDisk = deps.checkFullDisk ?? checkMacFullDiskAccess;
  const checkAccess = deps.checkAccessibility ?? checkMacAccessibility;
  const openPane = deps.openPane ?? openMacPrivacySettings;
  const promptAccessibility = deps.promptAccessibility ?? (() => axHelperTrust({ prompt: true }));
  const helperPresent = deps.helperPresent ?? (() => axHelperTrust() !== 'unavailable');
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const fdaOptional = options.fullDiskAccessOptional === true;

  probeMacAppDataPermissions();

  // The helper that holds the Accessibility permission has to exist before it can be asked.
  if (deps.prepareHelper) {
    await deps.prepareHelper();
  } else if (axHelperEnabledByDefault()) {
    stdout(`  ${c.dim('Preparing the Remote Hands helper...')}`);
    await ensureAxHelperBinary();
  }

  let screenOk = checkScreen();
  let fdaOk = checkFullDisk();
  let accessOk = checkAccess();
  const done = (): boolean => screenOk && accessOk && (fdaOk || fdaOptional);

  if (screenOk && accessOk && fdaOk) {
    stdout(`  ${c.brightGreen('✔')} ${c.green('Screen & System Audio Recording verified')}`);
    stdout(`  ${c.brightGreen('✔')} ${c.green('Full Disk Access verified')}`);
    stdout(`  ${c.brightGreen('✔')} ${c.green('Accessibility verified')}`);
    return true;
  }
  if (done()) {
    stdout(`  ${c.brightGreen('✔')} ${c.green('Screen & System Audio Recording verified')}`);
    stdout(`  ${c.brightGreen('✔')} ${c.green('Accessibility verified')}`);
    stdout(`  ${c.dim('Full Disk Access is optional: it only saves "allow access to your Documents" pop-ups later.')}`);
    return true;
  }

  const hostApp = deps.hostApp ?? detectHostAppName();
  const nodePath = deps.nodePath ?? process.execPath;
  const hr = '─'.repeat(Math.max(20, termWidth - 2));
  const helperAsks = !accessOk && helperPresent();

  // One permission at a time, in the order the HUD needs them: the next System Settings page opens when the last one is granted.
  type Step = { key: 'screen' | 'access' | 'fda'; granted: () => boolean; open: () => void };
  const steps: Step[] = [
    {
      key: 'screen',
      granted: () => screenOk,
      open: () => {
        (deps.requestScreen ?? requestMacScreenCapture)();
        openPane('ScreenCapture');
      },
    },
    {
      key: 'access',
      granted: () => accessOk,
      // macOS's own "Remote Hands would like to control this computer" window; without the helper, open the page by hand
      open: () => {
        if (promptAccessibility() === 'unavailable') openPane('Accessibility');
      },
    },
  ];
  if (!fdaOptional) steps.push({ key: 'fda', granted: () => fdaOk, open: () => openPane('FullDiskAccess') });

  let opened: Step | undefined;
  const openNext = (): void => {
    const next = steps.find((st) => !st.granted());
    if (next && next !== opened) {
      opened = next;
      next.open();
    }
  };
  openNext();

  const accessOnly = helperAsks && screenOk && (fdaOk || fdaOptional);
  const targets = accessOnly ? ['Remote Hands'] : [hostApp];
  if (!accessOnly) {
    if (hostApp === 'Antigravity IDE') {
      targets.push('Antigravity');
    }
    if (!targets.includes('node')) {
      targets.push(`node   (the program that runs Remote Hands: ${nodePath})`);
    }
    if (hostApp !== 'Terminal') {
      targets.push('Terminal (if running from macOS Terminal)');
    }
  }

  const permissionItems: string[] = [];
  if (!screenOk) {
    permissionItems.push(`${c.bold(c.white('Screen & System Audio Recording'))}  ${c.dim('(System Settings -> Privacy & Security -> Screen & System Audio Recording)')}`);
  }
  if (!accessOk) {
    permissionItems.push(
      helperAsks
        ? `${c.bold(c.white('Accessibility'))}                    ${c.dim('(a macOS window is asking to allow "Remote Hands": click Open System Settings, then switch it on)')}`
        : `${c.bold(c.white('Accessibility'))}                    ${c.dim('(System Settings -> Privacy & Security -> Accessibility)')}`,
    );
  }
  if (!fdaOk && !fdaOptional) {
    permissionItems.push(`${c.bold(c.white('Full Disk Access'))}                 ${c.dim('(System Settings -> Privacy & Security -> Full Disk Access)')}`);
  }

  stdout(
    '\n' +
      c.cyan(`╭─ ${c.bold('🛡️  macOS Permissions Required')} ${'─'.repeat(Math.max(2, termWidth - 36))}\n`) +
      `${c.cyan('│')}  ${c.white('macOS makes you switch these on yourself, in System Settings (one page opens at a time):')}\n` +
      `${c.cyan('│')}\n` +
      permissionItems.map((p, i) => `${c.cyan('│')}  ${c.yellow(`👉 ${i + 1}.`)} ${p}`).join('\n') +
      '\n' +
      `${c.cyan('│')}\n` +
      `${c.cyan('│')}  ${c.white('Find and toggle the switch ')} ${c.brightGreen('ON')} ${c.white('for:')}\n` +
      targets.map((t) => `${c.cyan('│')}  ${c.brightCyan('•')} ${c.bold(c.white(t))}`).join('\n') +
      '\n' +
      `${c.cyan('│')}\n` +
      (accessOnly
        ? ''
        : `${c.cyan('│')}  ${c.dim(`(If it is not in the list, click [+] at the bottom. To reach a hidden folder in the file window, press Cmd+Shift+G and paste the path.)`)}\n`) +
      (!screenOk ? `${c.cyan('│')}  ${c.dim('(After you switch Screen Recording on, macOS may offer "Quit & Reopen": choose Later, setup carries on.)')}\n` : '') +
      (fdaOptional && !fdaOk ? `${c.cyan('│')}  ${c.dim('(Full Disk Access is optional for the HUD and is not asked for now.)')}\n` : '') +
      `${c.cyan('│')}  ${c.dim(isTTY ? 'Waiting for permission... (press Enter at any time to skip the rest)' : 'Waiting for permission...')}\n` +
      c.cyan(`╰${hr}\n`),
  );

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (isTTY && deps.isTTY === undefined) {
        process.stdin.removeListener('data', onData);
        try {
          process.stdin.pause();
        } catch {}
      }
    };

    const finish = (): void => {
      cleanup();
      resolve(checkScreen() && checkAccess() && (fdaOptional || checkFullDisk()));
    };
    const onData = () => finish();

    if (isTTY && deps.isTTY === undefined) {
      try {
        process.stdin.resume();
        process.stdin.once('data', onData);
      } catch {}
    }

    pollTimer = setInterval(() => {
      if (!screenOk && checkScreen()) {
        screenOk = true;
        stdout(`  ${c.brightGreen('✔')} ${c.green('Screen & System Audio Recording access verified!')}`);
      }
      if (!accessOk && checkAccess()) {
        accessOk = true;
        stdout(`  ${c.brightGreen('✔')} ${c.green('Accessibility verified!')}`);
      }
      if (!fdaOk && checkFullDisk()) {
        fdaOk = true;
        if (!fdaOptional) stdout(`  ${c.brightGreen('✔')} ${c.green('Full Disk Access verified!')}`);
      }

      if (done()) {
        cleanup();
        stdout(`  ${c.brightGreen('✔')} ${c.green('All macOS permissions verified successfully!')}\n\n`);
        resolve(true);
        return;
      }
      openNext();
    }, deps.pollMs ?? 800);

    // a person at a terminal is reading and clicking: give them time; with nobody there, move on after a short wait
    timeoutTimer = setTimeout(finish, deps.waitMs ?? (isTTY ? 10 * 60_000 : 45_000));
  });
}
