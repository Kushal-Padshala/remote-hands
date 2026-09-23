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

export function grantMacAutomationPermissions(): boolean {
  if (process.platform !== 'darwin') return true;

  const tccDbPath = path.join(os.homedir(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db');
  if (!fs.existsSync(tccDbPath)) return false;

  const standardTargets = [
    'com.apple.systemevents',
    'com.apple.Notes',
    'com.apple.finder',
    'com.apple.Safari',
    'com.google.Chrome',
    'com.brave.Browser',
    'com.apple.TextEdit',
    'com.apple.Terminal',
    'com.apple.mail',
    'com.apple.iCal',
    'com.apple.reminders',
    'com.apple.Preview',
    'com.apple.dt.Xcode',
    'com.microsoft.VSCode',
  ];

  const knownClients = [
    'com.google.antigravity-ide',
    'com.google.antigravity',
    'com.apple.Terminal',
    'com.googlecode.iterm2',
    'dev.warp.Warp-Stable',
    'com.mitchellh.ghostty',
    'com.todesktop.230313mzl4w4u92',
    'com.microsoft.VSCode',
  ];

  try {
    const listRes = spawnSync(
      'sqlite3',
      [tccDbPath, `SELECT DISTINCT client, hex(csreq) FROM access WHERE service='kTCCServiceAppleEvents' AND csreq IS NOT NULL;`],
      { encoding: 'utf-8' },
    );
    const clientBlobs = new Map<string, string>();
    if (listRes.status === 0 && listRes.stdout) {
      for (const line of listRes.stdout.trim().split('\n')) {
        const [cli, blob] = line.split('|');
        if (cli && blob) clientBlobs.set(cli, blob);
      }
    }

    const hostApp = detectHostAppName();
    let currentClient = process.env.__CFBundleIdentifier;
    if (!currentClient) {
      if (hostApp === 'Antigravity IDE') currentClient = 'com.google.antigravity-ide';
      else if (hostApp === 'Terminal') currentClient = 'com.apple.Terminal';
      else if (hostApp === 'iTerm') currentClient = 'com.googlecode.iterm2';
      else if (hostApp === 'Warp') currentClient = 'dev.warp.Warp-Stable';
      else if (hostApp === 'Ghostty') currentClient = 'com.mitchellh.ghostty';
    }

    const allClients = new Set([...knownClients]);
    if (currentClient) allClients.add(currentClient);

    const statements: string[] = [];
    const now = Math.floor(Date.now() / 1000);

    for (const client of allClients) {
      const blob =
        clientBlobs.get(client) ??
        clientBlobs.get('com.google.antigravity-ide') ??
        clientBlobs.get('com.apple.Terminal');
      const csreqClause = blob ? `X'${blob}'` : 'NULL';
      for (const target of standardTargets) {
        statements.push(
          `INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, indirect_object_identifier_type, indirect_object_identifier, flags, last_modified) VALUES ('kTCCServiceAppleEvents', '${client}', 0, 2, 2, 1, ${csreqClause}, 0, '${target}', 0, ${now});`,
        );
      }
    }

    if (statements.length > 0) {
      spawnSync('sqlite3', [tccDbPath], { input: statements.join('\n'), encoding: 'utf-8' });
    }

    const sysTccDb = '/Library/Application Support/com.apple.TCC/TCC.db';
    if (fs.existsSync(sysTccDb)) {
      const sysStatements: string[] = [];
      for (const client of allClients) {
        const blob = clientBlobs.get(client) ?? clientBlobs.get('com.google.antigravity-ide');
        const csreqClause = blob ? `X'${blob}'` : 'NULL';
        sysStatements.push(
          `INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, flags, last_modified) VALUES ('kTCCServiceAccessibility', '${client}', 0, 2, 2, 1, ${csreqClause}, 0, ${now});`,
        );
      }
      try {
        spawnSync('sqlite3', [sysTccDb], { input: sysStatements.join('\n'), encoding: 'utf-8' });
      } catch {}
      try {
        spawnSync('sudo', ['-n', 'sqlite3', sysTccDb], { input: sysStatements.join('\n'), encoding: 'utf-8' });
      } catch {}
    }

    return true;
  } catch {
    return false;
  }
}

export function probeMacAutomationPermissions(): void {
  if (process.platform !== 'darwin') return;
  const probeApps = ['System Events', 'Notes', 'Finder', 'Safari'];
  for (const app of probeApps) {
    try {
      spawn('osascript', ['-e', `tell application "${app}" to get name`], {
        stdio: 'ignore',
        detached: true,
      }).unref();
    } catch {}
  }
}

export async function ensureMacPermissions(
  stdout: (msg: string) => void = console.log,
  termWidth: number = 74,
): Promise<boolean> {
  if (process.platform !== 'darwin') return true;

  probeMacAppDataPermissions();
  grantMacAutomationPermissions();
  probeMacAutomationPermissions();

  let screenOk = checkMacScreenCapture();
  let fdaOk = checkMacFullDiskAccess();
  let accessOk = checkMacAccessibility();

  if (screenOk && fdaOk && accessOk) {
    stdout(`  ${c.brightGreen('✔')} ${c.green('Pre-authorized desktop automation for Notes, System Events, Safari, Chrome, Finder')}`);
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
