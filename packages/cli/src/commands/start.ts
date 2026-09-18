import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { ChromeManager, type ChromeProfileMode } from '@remote-hands/daemon';
import { setupCommand, type CommandContext } from './setup.js';
import { daemonCommand } from './daemon.js';
import { c } from '../output/ui.js';
import { ensureMacPermissions, checkMacFullDiskAccess, detectHostAppName } from '../system/mac-permissions.js';

export interface StartOptions {
  clamshell?: boolean | undefined;
  once?: boolean | undefined;
}

export async function startCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const runner = context.runner;

  const noClamshell = args.includes('--no-clamshell') || args.includes('--no-sleep-prevent');
  const once = args.includes('--once');
  const noAutoSetup = args.includes('--no-auto-setup') || once;

  const browserProfileArg = args.find((a) => a.startsWith('--browser-profile='));
  const rawProfile = browserProfileArg ? browserProfileArg.split('=')[1] : undefined;
  let profileMode: ChromeProfileMode = 'dedicated';
  let targetProfile: string | undefined;

  if (rawProfile) {
    if (rawProfile === 'dedicated' || rawProfile === 'none' || rawProfile === 'active') {
      profileMode = rawProfile;
    } else {
      profileMode = 'active';
      targetProfile = rawProfile;
    }
  }

  const chromeManager =
    context.chromeManager ??
    new ChromeManager({
      mode: profileMode,
      profile: targetProfile,
      port: 9222,
    });
  context.chromeManager = chromeManager;

  let clamshellActive = false;
  let caffeinateProc: ChildProcess | null = null;

  const termWidth = Math.max(
    48,
    Math.min(
      typeof process !== 'undefined' && process.stdout?.columns ? process.stdout.columns : 74,
      74,
    ),
  );
  const hr = '─'.repeat(termWidth - 2);

  const restoreSleep = () => {
    if (!clamshellActive) return;
    clamshellActive = false;
    if (caffeinateProc) {
      try {
        caffeinateProc.kill('SIGKILL');
      } catch {}
      caffeinateProc = null;
    }
    try {
      spawnSync('sudo', ['pmset', '-a', 'disablesleep', '0'], { stdio: 'ignore' });
      stdout(
        '\n' +
          c.cyan(`╭─ ${c.bold('⚡ Remote Hands Stopped')} ${'─'.repeat(Math.max(2, termWidth - 26))}\n`) +
          `${c.cyan('│')}  ${c.brightGreen('✔')} ${c.green('Restored normal sleep behavior (pmset disablesleep = 0)')}\n` +
          c.cyan(`╰${hr}`),
      );
    } catch {}
  };

  if (!noClamshell && !runner) {
    if (process.platform === 'darwin') {
      const fdaGranted = checkMacFullDiskAccess();
      const hostApp = detectHostAppName();

      stdout(
        '\n' +
          c.yellow(`╭─ ${c.bold('🔒 Administrator Password Required (macOS)')} ${'─'.repeat(Math.max(2, termWidth - 46))}\n`) +
          `${c.yellow('│')}  ${c.white('Please enter your Mac password to enable lid-closed sleep prevention.')}\n` +
          `${c.yellow('│')}  ${c.dim('Allows your MacBook to run agent tasks with the lid closed (pmset disablesleep=1).')}\n` +
          `${c.yellow('│')}  ${c.dim('Run "rh start --no-clamshell" or "rh daemon" to run without password.')}\n` +
          (!fdaGranted
            ? `${c.yellow('│')}  ${c.dim(`Tip: Grant Full Disk Access to ${hostApp} to skip permission dialogs.`)}\n`
            : '') +
          c.yellow(`╰${hr}\n`),
      );
      try {
        const res = spawnSync('sudo', ['pmset', '-a', 'disablesleep', '1'], {
          stdio: ['inherit', 'pipe', 'pipe'],
        });
        if (res.status === 0) {
          clamshellActive = true;
        }
      } catch {}

      try {
        caffeinateProc = spawn('caffeinate', ['-dims'], {
          detached: true,
          stdio: 'ignore',
        });
        caffeinateProc.unref();
      } catch {}
    } else if (process.platform === 'win32') {
      stdout(
        '\n' +
          c.yellow(`╭─ ${c.bold('⚡ Windows Power Management')} ${'─'.repeat(Math.max(2, termWidth - 30))}\n`) +
          `${c.yellow('│')}  ${c.white('Configuring Windows power state to keep system awake during tasks.')}\n` +
          `${c.yellow('│')}  ${c.dim('If prompted by Windows User Account Control (UAC), please approve.')}\n` +
          c.yellow(`╰${hr}\n`),
      );
    } else if (process.platform === 'linux') {
      stdout(
        '\n' +
          c.yellow(`╭─ ${c.bold('🔒 Administrator Password Required (Linux)')} ${'─'.repeat(Math.max(2, termWidth - 46))}\n`) +
          `${c.yellow('│')}  ${c.white('Please enter your Linux password if prompted to inhibit system suspend.')}\n` +
          `${c.yellow('│')}  ${c.dim('Run "rh start --no-clamshell" or "rh daemon" to run without password.')}\n` +
          c.yellow(`╰${hr}\n`),
      );
    }
  }

  if (process.platform === 'darwin' && !runner && !once && !args.includes('--skip-permissions')) {
    await ensureMacPermissions(stdout, termWidth);
  }

  const onSignal = () => {
    restoreSleep();
    process.exit(0);
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
  process.once('exit', restoreSleep);

  const configDir = context.configDir ?? path.join(os.homedir(), '.remote-hands');
  const daemonConfigFile = path.join(configDir, 'daemon.json');
  let hasConfig = false;
  try {
    if (fs.existsSync(daemonConfigFile)) {
      hasConfig = true;
    }
  } catch {}

  if (!hasConfig && !noAutoSetup) {
    stdout(
      '\n' +
        c.yellow(`╭─ ${c.bold('⚡ Setup Required')} ${'─'.repeat(Math.max(2, termWidth - 20))}\n`) +
        `${c.yellow('│')}  ${c.white('No paired backend configuration found on this machine.')}\n` +
        `${c.yellow('│')}  ${c.cyan('Launching setup wizard now...')}\n` +
        c.yellow(`╰${hr}\n`),
    );
    const setupExit = await setupCommand([], context);
    if (setupExit !== 0) {
      restoreSleep();
      return setupExit;
    }
    try {
      if (fs.existsSync(daemonConfigFile)) {
        hasConfig = true;
      }
    } catch {}
  }

  stdout(
    '\n' +
      c.brightCyan(`╭─ ${c.bold('⚡ Remote Hands Daemon Active')} ${'─'.repeat(Math.max(2, termWidth - 32))}\n`) +
      `${c.brightCyan('│')}  ${
        clamshellActive
          ? `${c.brightGreen('✔')} ${c.green('Lid-closed clamshell mode: ACTIVE (disablesleep = 1)')}`
          : c.dim('Lid-closed sleep prevention: OFF')
      }\n` +
      `${c.brightCyan('│')}  ${
        targetProfile
          ? c.white(`Browser profile: ${targetProfile} (mode: ${profileMode})`)
          : c.dim(`Browser profile mode: ${profileMode}`)
      }\n` +
      `${c.brightCyan('│')}  ${
        hasConfig
          ? c.white('Listening for coding agent tasks from your phone...')
          : c.yellow('Notice: Setup config not found yet. Run "rh setup" to pair.')
      }\n` +
      `${c.brightCyan('│')}  ${c.dim('Press Ctrl+C anytime to stop and restore normal sleep settings.')}\n` +
      c.brightCyan(`╰${hr}`),
  );

  try {
    return await daemonCommand(args, {
      ...context,
      chromeManager,
      configDir,
      stdout,
      stderr,
      once,
    });
  } finally {
    restoreSleep();
  }
}
