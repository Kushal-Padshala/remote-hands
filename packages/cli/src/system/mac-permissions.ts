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

export function openMacPrivacySettings(pane: 'FullDiskAccess' | 'AppManagement' = 'FullDiskAccess'): void {
  if (process.platform !== 'darwin') return;
  const url =
    pane === 'AppManagement'
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
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

  if (checkMacFullDiskAccess()) {
    return true;
  }

  const hostApp = detectHostAppName();
  const hr = '─'.repeat(Math.max(20, termWidth - 2));

  openMacPrivacySettings('FullDiskAccess');

  const targets = [hostApp];
  if (hostApp === 'Antigravity IDE') {
    targets.push('Antigravity');
  }
  if (hostApp !== 'Terminal') {
    targets.push('Terminal (if running from macOS Terminal)');
  }

  stdout(
    '\n' +
      c.cyan(`╭─ ${c.bold('🛡️  macOS Full Disk Access Required')} ${'─'.repeat(Math.max(2, termWidth - 40))}\n`) +
      `${c.cyan('│')}  ${c.white('To run tasks while you are away (and with the lid closed), macOS requires')}\n` +
      `${c.cyan('│')}  ${c.white('Full Disk Access for your terminal application.')}\n` +
      `${c.cyan('│')}\n` +
      `${c.cyan('│')}  ${c.yellow('👉 System Settings has opened to "Full Disk Access".')}\n` +
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
      resolve(checkMacFullDiskAccess());
    };

    if (process.stdin.isTTY) {
      try {
        process.stdin.resume();
        process.stdin.once('data', onData);
      } catch {}
    }

    pollTimer = setInterval(() => {
      if (checkMacFullDiskAccess()) {
        cleanup();
        stdout(`  ${c.brightGreen('✔')} ${c.green('Full Disk Access verified successfully!')}\n\n`);
        resolve(true);
      }
    }, 800);

    timeoutTimer = setTimeout(() => {
      cleanup();
      resolve(checkMacFullDiskAccess());
    }, 45000);
  });
}
