import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { CommandContext } from './setup.js';
import { c } from '../output/ui.js';

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

  if (!noClamshell && process.platform === 'darwin' && !runner) {
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

  stdout(
    '\n' +
      c.brightCyan(`╭─ ${c.bold('⚡ Remote Hands Daemon Active')} ${'─'.repeat(Math.max(2, termWidth - 32))}\n`) +
      `${c.brightCyan('│')}  ${
        clamshellActive
          ? `${c.brightGreen('✔')} ${c.green('Lid-closed clamshell mode: ACTIVE (disablesleep = 1)')}`
          : c.dim('Lid-closed sleep prevention: OFF')
      }\n` +
      `${c.brightCyan('│')}  ${
        hasConfig
          ? c.white('Listening for coding agent tasks from your phone...')
          : c.yellow('Notice: Setup config not found yet. Run "rh setup --free" to pair.')
      }\n` +
      `${c.brightCyan('│')}  ${c.dim('Press Ctrl+C anytime to stop and restore normal sleep settings.')}\n` +
      c.brightCyan(`╰${hr}`),
  );

  if (once) {
    restoreSleep();
    return 0;
  }

  await new Promise<void>(() => {});
  return 0;
}
