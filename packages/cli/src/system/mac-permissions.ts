import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
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

  const hr = '─'.repeat(Math.max(20, termWidth - 2));

  openMacPrivacySettings('FullDiskAccess');

  stdout(
    '\n' +
      c.cyan(`╭─ ${c.bold('🛡️  macOS Full Disk Access Required')} ${'─'.repeat(Math.max(2, termWidth - 40))}\n`) +
      `${c.cyan('│')}  ${c.white('To run autonomous tasks while you are away (and with the lid closed),')}\n` +
      `${c.cyan('│')}  ${c.white('macOS requires Full Disk Access for your terminal or IDE.')}\n` +
      `${c.cyan('│')}\n` +
      `${c.cyan('│')}  ${c.yellow('👉 System Settings has opened to "Full Disk Access".')}\n` +
      `${c.cyan('│')}  ${c.white('Please toggle the switch ')} ${c.brightGreen('ON')} ${c.white('for this application.')}\n` +
      `${c.cyan('│')}\n` +
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
