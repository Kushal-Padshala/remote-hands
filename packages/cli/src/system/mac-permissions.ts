import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
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

export async function ensureMacPermissions(
  stdout: (msg: string) => void = console.log,
  termWidth: number = 74,
): Promise<boolean> {
  if (process.platform !== 'darwin') return true;

  probeMacAppDataPermissions();

  let screenOk = checkMacScreenCapture();
  let fdaOk = checkMacFullDiskAccess();
  let accessOk = checkMacAccessibility();

  if (screenOk && fdaOk && accessOk) {
    stdout(`  ${c.brightGreen('✔')} ${c.green('Screen & System Audio Recording verified')}`);
    stdout(`  ${c.brightGreen('✔')} ${c.green('Full Disk Access verified')}`);
    stdout(`  ${c.brightGreen('✔')} ${c.green('Accessibility verified')}`);
    return true;
  }

  const hostApp = detectHostAppName();
  const hr = '─'.repeat(Math.max(20, termWidth - 2));

  if (!screenOk) {
    requestMacScreenCapture();
    openMacPrivacySettings('ScreenCapture');
  } else if (!fdaOk) {
    openMacPrivacySettings('FullDiskAccess');
  } else if (!accessOk) {
    openMacPrivacySettings('Accessibility');
  }

  const targets = [hostApp];
  if (hostApp === 'Antigravity IDE') {
    targets.push('Antigravity');
  }
  if (!targets.includes('node')) {
    targets.push('node');
  }
  if (hostApp !== 'Terminal') {
    targets.push('Terminal (if running from macOS Terminal)');
  }

  const permissionItems: string[] = [];
  if (!screenOk) {
    permissionItems.push(`${c.bold(c.white('Screen & System Audio Recording'))}  ${c.dim('(System Settings -> Privacy & Security -> Screen & System Audio Recording)')}`);
  }
  if (!fdaOk) {
    permissionItems.push(`${c.bold(c.white('Full Disk Access'))}                 ${c.dim('(System Settings -> Privacy & Security -> Full Disk Access)')}`);
  }
  if (!accessOk) {
    permissionItems.push(`${c.bold(c.white('Accessibility'))}                    ${c.dim('(System Settings -> Privacy & Security -> Accessibility)')}`);
  }

  stdout(
    '\n' +
      c.cyan(`╭─ ${c.bold('🛡️  macOS Permissions Required')} ${'─'.repeat(Math.max(2, termWidth - 36))}\n`) +
      `${c.cyan('│')}  ${c.white('To stream your desktop to mobile and run unattended tasks, macOS requires')}\n` +
      `${c.cyan('│')}  ${c.white('the following permissions enabled in System Settings:')}\n` +
      `${c.cyan('│')}\n` +
      permissionItems.map((p, i) => `${c.cyan('│')}  ${c.yellow(`👉 ${i + 1}.`)} ${p}`).join('\n') +
      '\n' +
      `${c.cyan('│')}\n` +
      `${c.cyan('│')}  ${c.white('Find and toggle the switch ')} ${c.brightGreen('ON')} ${c.white('for:')}\n` +
      targets.map((t) => `${c.cyan('│')}  ${c.brightCyan('•')} ${c.bold(c.white(t))}`).join('\n') +
      '\n' +
      `${c.cyan('│')}\n` +
      `${c.cyan('│')}  ${c.dim(`(If not in the list, click [+] at the bottom and add ${hostApp} from /Applications)`)}\n` +
      `${c.cyan('│')}  ${c.dim('Waiting for permission... (press Enter once granted, or Enter to skip)')}\n` +
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
      if (process.stdin.isTTY) {
        process.stdin.removeListener('data', onData);
        try {
          process.stdin.pause();
        } catch {}
      }
    };

    const onData = () => {
      cleanup();
      resolve(checkMacScreenCapture() && checkMacFullDiskAccess());
    };

    if (process.stdin.isTTY) {
      try {
        process.stdin.resume();
        process.stdin.once('data', onData);
      } catch {}
    }

    pollTimer = setInterval(() => {
      if (!screenOk && checkMacScreenCapture()) {
        screenOk = true;
        stdout(`  ${c.brightGreen('✔')} ${c.green('Screen & System Audio Recording access verified!')}`);
      }
      if (!fdaOk && checkMacFullDiskAccess()) {
        fdaOk = true;
        stdout(`  ${c.brightGreen('✔')} ${c.green('Full Disk Access verified!')}`);
      }
      if (!accessOk && checkMacAccessibility()) {
        accessOk = true;
        stdout(`  ${c.brightGreen('✔')} ${c.green('Accessibility verified!')}`);
      }

      if (screenOk && fdaOk && accessOk) {
        cleanup();
        stdout(`  ${c.brightGreen('✔')} ${c.green('All macOS permissions verified successfully!')}\n\n`);
        resolve(true);
      }
    }, 800);

    timeoutTimer = setTimeout(() => {
      cleanup();
      resolve(checkMacScreenCapture() && checkMacFullDiskAccess());
    }, 45000);
  });
}
