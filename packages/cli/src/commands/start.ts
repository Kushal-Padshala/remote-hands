import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { ChromeManager, DynamicPowerManager, type ChromeProfileMode } from '@remote-hands/daemon';

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
  const configDir = context.configDir ?? path.join(os.homedir(), '.remote-hands');
  const daemonConfigFile = path.join(configDir, 'daemon.json');
  let hasConfig = false;
  try {
    if (fs.existsSync(daemonConfigFile)) {
      hasConfig = true;
    }
  } catch {}

  const isCloud =
    args.includes('--cloud') ||
    args.includes('--cloudflare') ||
    (context as any).cloud === true;
  const isLocal = !isCloud;
  const isRemote =
    !args.includes('--no-remote') &&
    (args.includes('--remote') || (context as any).remote === true || !once);

  const browserProfileIdx = args.findIndex((a) => a === '--browser-profile' || a.startsWith('--browser-profile='));
  let rawProfile: string | undefined;
  if (browserProfileIdx !== -1) {
    const arg = args[browserProfileIdx];
    if (arg && arg.startsWith('--browser-profile=')) {
      rawProfile = arg.slice('--browser-profile='.length);
    } else if (browserProfileIdx + 1 < args.length) {
      rawProfile = args[browserProfileIdx + 1];
    }
  }
  let profileMode: ChromeProfileMode = 'active';
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

  const powerManager: DynamicPowerManager = (context as any).powerManager ?? new DynamicPowerManager();
  powerManager.cleanupOrphanedAssertions();
  context.powerManager = powerManager;

  const restoreSleep = () => {
    powerManager.releaseAll();
    if (caffeinateProc) {
      try {
        caffeinateProc.kill('SIGKILL');
      } catch {}
      caffeinateProc = null;
    }
    if (clamshellActive || (!runner && process.env.NODE_ENV !== 'test')) {
      try {
        const pmRes = spawnSync('pmset', ['-g'], { encoding: 'utf-8' });
        if (pmRes.stdout && pmRes.stdout.includes('SleepDisabled\t\t1')) {
          const res = spawnSync('sudo', ['-n', 'pmset', '-a', 'disablesleep', '0'], { stdio: 'ignore' });
          if (res.status === 0 && clamshellActive) {
            stdout(
              '\n' +
                c.cyan(`╭─ ${c.bold('⚡ Remote Hands Stopped')} ${'─'.repeat(Math.max(2, termWidth - 26))}\n`) +
                `${c.cyan('│')}  ${c.brightGreen('✔')} ${c.green('Restored normal sleep behavior (pmset disablesleep = 0)')}\n` +
                c.cyan(`╰${hr}`),
            );
          }
        }
      } catch {}
      clamshellActive = false;
    }
  };

  const forceClamshell = args.includes('--force-clamshell') || args.includes('--permanent-sleep-prevent');
  if (forceClamshell && !runner && process.env.NODE_ENV !== 'test') {
    if (process.platform === 'darwin') {
      const fdaGranted = checkMacFullDiskAccess();
      const hostApp = detectHostAppName();

      stdout(
        '\n' +
          c.yellow(`╭─ ${c.bold('🔒 Administrator Password Required (macOS)')} ${'─'.repeat(Math.max(2, termWidth - 46))}\n`) +
          `${c.yellow('│')}  ${c.white('Please enter your Mac password to enable lid-closed sleep prevention.')}\n` +
          `${c.yellow('│')}  ${c.dim('Allows your MacBook to run agent tasks with the lid closed (pmset disablesleep=1).')}\n` +
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
    } else if (process.platform === 'linux') {
      stdout(
        '\n' +
          c.yellow(`╭─ ${c.bold('🔒 Administrator Password Required (Linux)')} ${'─'.repeat(Math.max(2, termWidth - 46))}\n`) +
          `${c.yellow('│')}  ${c.white('Please enter your Linux password if prompted to inhibit system suspend.')}\n` +
          c.yellow(`╰${hr}\n`),
      );
    }
  } else if (!runner && process.env.NODE_ENV !== 'test' && process.platform === 'darwin') {
    stdout(
      '\n' +
        c.cyan(`╭─ ${c.bold('🍃 Eco-Sleep Thermal Mode Active')} ${'─'.repeat(Math.max(2, termWidth - 36))}\n`) +
        `${c.cyan('│')}  ${c.brightGreen('✔')} ${c.green('Mac stays cool at 0% idle CPU with normal display sleep enabled.')}\n` +
        `${c.cyan('│')}  ${c.brightGreen('✔')} ${c.green('Dynamic wake assertion engages instantly when an agent task arrives.')}\n` +
        c.cyan(`╰${hr}\n`),
    );
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


  if (isCloud && !hasConfig && !noAutoSetup) {
    stdout(
      '\n' +
        c.yellow(`╭─ ${c.bold('⚡ Setup Required')} ${'─'.repeat(Math.max(2, termWidth - 20))}\n`) +
        `${c.yellow('│')}  ${c.white('No paired backend configuration found on this machine.')}\n` +
        `${c.yellow('│')}  ${c.cyan('Launching setup wizard now...')}\n` +
        c.yellow(`╰${hr}\n`),
    );
    try {
      const setupExit = await setupCommand([], context);
      if (setupExit !== 0) {
        stdout(c.yellow('[start] Cloudflare setup was not completed. Seamlessly starting in local embedded mode...'));
      }
    } catch {
      stdout(c.yellow('[start] Cloudflare setup skipped. Seamlessly starting in local embedded mode...'));
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
        process.platform === 'darwin'
          ? c.white('Spotlight Guidance HUD: ') + c.bold(c.cyan('Shift+Cmd+Space'))
          : ''
      }\n` +
      `${c.brightCyan('│')}  ${
        isCloud && hasConfig
          ? c.white('Listening for coding agent tasks from your phone (Cloudflare)...')
          : c.white('Local embedded server with secure remote tunnel (zero-account)...')
      }\n` +
      `${c.brightCyan('│')}  ${c.dim('Press Ctrl+C anytime to stop and restore normal sleep settings.')}\n` +
      c.brightCyan(`╰${hr}`),
  );

  const daemonArgs = [...args];
  if (isCloud && hasConfig && !daemonArgs.includes('--cloud')) {
    daemonArgs.push('--cloud');
  }
  if (!isCloud && !daemonArgs.includes('--local')) {
    daemonArgs.push('--local');
  }
  if (isRemote && !daemonArgs.includes('--remote')) {
    daemonArgs.push('--remote');
  }

  try {
    return await daemonCommand(daemonArgs, {
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
