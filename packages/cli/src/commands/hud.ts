import {
  HudCoordinator,
  HudServiceManager,
  LocalTaskStore,
  type ActiveWindowContext,
} from '@remote-hands/daemon';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { CommandContext } from './setup.js';
import { c } from '../output/ui.js';
import { ensureAgyPermissions } from '../system/agy-permissions.js';
import {
  grantMacAutomationPermissions,
  ensureMacPermissions,
  checkMacScreenCapture,
} from '../system/mac-permissions.js';

export interface HudCommandContext extends CommandContext {

  coordinator?: any | undefined;
  serviceManager?: any | undefined;
  onListenerReady?: ((listener: { stop: () => void }) => void) | undefined;
  blockUntilSignal?: boolean | undefined;
}

export async function hudCommand(args: string[], context: HudCommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const subcommand = args[0] || 'status';

  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    stdout('Usage: rh hud <listen|prompt|install|uninstall|status> [options]');
    stdout('');
    stdout('Commands:');
    stdout('  listen    Run desktop overlay hotkey listener (Shift + Cmd + Space) with standalone auto-execution');
    stdout('  prompt    Open Spotlight HUD prompt textbox immediately');
    stdout('  install   Install macOS background LaunchAgent (starts automatically on login)');
    stdout('  uninstall Remove macOS background LaunchAgent');
    stdout('  status    Check if desktop overlay background service is active');
    stdout('');
    return 0;
  }

  const serviceManager = context.serviceManager ?? new HudServiceManager();

  if (subcommand === 'install') {
    stdout('Configuring system permissions for desktop overlay assistant...');
    await ensureAgyPermissions(context.fs);
    grantMacAutomationPermissions();
    stdout('Installing Remote Hands Desktop Overlay background service...');
    const res = serviceManager.install();
    if (res.success) {
      stdout(c.brightGreen('✔ Desktop Overlay Assistant installed successfully!'));
      stdout(`  HotKey:      ${c.bold('Shift + Cmd + Space')} (available on any screen)`);
      stdout(`  LaunchAgent: ${res.plistPath}`);
      stdout(`  Status:      Running in background with 0% idle CPU`);
      return 0;
    } else {
      stderr(c.yellow(`Failed to install LaunchAgent: ${res.error || 'Unknown error'}`));
      return 1;
    }
  }


  if (subcommand === 'uninstall') {
    const uninstalled = serviceManager.uninstall();
    if (uninstalled) {
      stdout('✓ Remote Hands Desktop Overlay background service removed.');
    } else {
      stdout('No active Desktop Overlay service found to remove.');
    }
    return 0;
  }

  if (subcommand === 'status') {
    const installed = serviceManager.isInstalled();
    const running = serviceManager.isRunning();
    stdout('');
    stdout(c.bold('Remote Hands Desktop Overlay Status:'));
    stdout(`  Installed: ${installed ? c.green('Yes') : c.dim('No')}`);
    stdout(`  Running:   ${running ? c.brightGreen('Active (listening for Shift+Cmd+Space)') : c.dim('Inactive')}`);
    if (!installed) {
      stdout(`  To enable: Run "${c.cyan('rh hud install')}" or "${c.cyan('rh setup')}".`);
    }
    stdout('');
    return 0;
  }

  if (subcommand === 'prompt') {
    let app: string | undefined;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!;
      if (arg.startsWith('--app=')) app = arg.slice(6);
      else if (arg === '--app' && i + 1 < args.length) app = args[++i]!;
    }
    const coordinator = context.coordinator ?? new HudCoordinator({
      autoExecute: true,
      onTaskCreated: (task) => {
        stdout(c.brightGreen(`\n⚡ [Spotlight HUD] Autonomous task initiated: "${((task as any).goal || task.prompt).slice(0, 60)}..."`));
      },
      onTaskCompleted: (task, summary) => {
        stdout(c.brightGreen(`\n✔ [Spotlight HUD] Task completed: ${summary}`));
      },
    });
    const success = await coordinator.triggerPrompt(app);
    if (success) {
      stdout('✓ Action initiated from Spotlight HUD');
    } else {
      stdout('Spotlight HUD prompt cancelled');
    }
    return 0;
  }

  if (subcommand === 'listen') {
    await ensureAgyPermissions(context.fs);
    grantMacAutomationPermissions();
    if (process.platform === 'darwin' && !context.runner && !args.includes('--skip-permissions') && !checkMacScreenCapture()) {
      await ensureMacPermissions(stdout);
    }

    const coordinator = context.coordinator ?? new HudCoordinator({

      autoExecute: true,
      onTaskCreated: (task) => {
        stdout(`\n${c.brightGreen('⚡')} [Spotlight HUD] New task initiated: "${((task as any).goal || task.prompt).slice(0, 60)}..."`);
        stdout(c.dim('  Working at full speed on your computer...'));
      },
      onTaskCompleted: (task, summary) => {
        stdout(`\n${c.brightGreen('✔')} [Spotlight HUD] Task completed successfully: ${summary}\n`);
      },
    });

    stdout(`${c.brightCyan('⚡ Remote Hands Desktop Assistant active')}`);
    stdout(`  Listening for ${c.bold('Shift + Cmd + Space')} across all apps.`);
    stdout(`  Press ${c.bold('Shift + Cmd + Space')} anywhere to control browsers or desktop software.`);
    stdout(`  Press Ctrl+C to stop.\n`);

    const listener = coordinator.startListening();
    if (context.onListenerReady) {
      context.onListenerReady(listener);
    }
    if (context.once || (context.onListenerReady && context.blockUntilSignal !== true)) {
      return 0;
    }
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        try {
          listener.stop();
        } catch {}
        resolve();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
    return 0;
  }

  stderr(`Unknown hud subcommand: ${subcommand}. Use "rh hud --help" for usage.`);
  return 1;
}
