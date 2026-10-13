import {
  HudCoordinator,
  HudServiceManager,
  LocalTaskStore,
  SpotlightHudRunner,
  hudHotkeyLabel,
  readHudStatus,
  type ActiveWindowContext,
} from '@remote-hands/daemon';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { CommandContext } from './setup.js';
import { c } from '../output/ui.js';
import { ensureAgyPermissions } from '../system/agy-permissions.js';
import { resolveFastLane } from '../system/fast-lane.js';
import {
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
    stdout(`  listen    Run desktop overlay hotkey listener (${hudHotkeyLabel()}) with standalone auto-execution`);
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
    stdout('Installing Remote Hands Desktop Overlay background service...');
    const res = serviceManager.install();
    if (res.success) {
      // Windows: the shortcut is only reported once the listener has said it holds it
      let confirmed = true;
      if (process.platform === 'win32' && typeof serviceManager.waitForHotkey === 'function') {
        stdout('Starting the HUD...');
        const status = await serviceManager.waitForHotkey();
        if (status?.state === 'failed') {
          stderr(c.yellow('The HUD started, but its shortcut (Ctrl + Shift + Space, or Ctrl + Alt + Space) is already used by another program. Close that program or change its shortcut, then run "rh hud install" again.'));
          return 1;
        }
        if (!status) {
          confirmed = false;
          stdout(c.yellow('The HUD has not confirmed its shortcut yet. Give it a minute, then check with "rh doctor" (log: ~/.remote-hands/logs/hud.log).'));
        }
      }
      stdout(c.brightGreen('✔ Desktop Overlay Assistant installed successfully!'));
      if (confirmed) stdout(`  HotKey:      ${c.bold(hudHotkeyLabel())} (available on any screen)`);
      stdout(`  ${process.platform === 'win32' ? 'Starts at login: ' : 'LaunchAgent: '}${res.plistPath}`);
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
    // Windows: a running service is only "listening" once the listener has said it holds its shortcut
    const winState = process.platform === 'win32' && running ? readHudStatus()?.state : undefined;
    const waiting = process.platform === 'win32' && running && winState === undefined;
    const shortcutFree = process.platform !== 'win32' || winState === 'ready';
    stdout(`  Running:   ${running ? (shortcutFree ? c.brightGreen(`Active (listening for ${hudHotkeyLabel().replace(/ /g, '')})`) : waiting ? c.yellow('Starting, or blocked (see ~/.remote-hands/logs/hud.log)') : c.yellow('Running, but its shortcut is not available')) : c.dim('Inactive')}`);
    if (winState === 'failed') {
      stdout(`  Hotkey:    ${c.yellow('not available: another program uses Ctrl + Shift + Space and Ctrl + Alt + Space')}`);
    }
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
    try {
      const success = await coordinator.triggerPrompt(app);
      if (success) {
        stdout('✓ Action initiated from Spotlight HUD');
      } else {
        stdout('Spotlight HUD prompt cancelled');
      }
      // triggerPrompt starts the task in the background; wait for it before stopping the runner.
      await coordinator.whenIdle?.();
    } finally {
      // Stop the warm agy child so the one-shot process can exit.
      coordinator.dispose?.();
    }
    return 0;
  }

  if (subcommand === 'listen') {
    await ensureAgyPermissions(context.fs);
    if (process.platform === 'win32' && !context.coordinator) {
      // build (or find) the Windows hotkey program now, so a problem is said here and not as a silent hotkey
      const helper = new SpotlightHudRunner().prepare();
      if (!helper.ok) {
        stderr(c.yellow(`Remote Hands cannot start the hotkey: ${helper.error}`));
        return 1;
      }
    }
    if (process.platform === 'darwin' && !context.runner && !args.includes('--skip-permissions') && !checkMacScreenCapture()) {
      await ensureMacPermissions(stdout);
    }

    // Local fast lane (off unless `rh fast-lane enable` was run); absent when the model is not installed.
    const fast = context.coordinator ? undefined : await resolveFastLane(context, stdout);

    const coordinator = context.coordinator ?? new HudCoordinator({
      ...(fast ? { fastLane: fast.fastLane } : {}),
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
    stdout(`  Listening for ${c.bold(hudHotkeyLabel())} across all apps.`);
    stdout(`  Press ${c.bold(hudHotkeyLabel())} anywhere to ${process.platform === 'win32' ? 'control your browser' : 'control browsers or desktop software'}.`);
    stdout(`  Press Ctrl+C to stop.\n`);

    const listener = coordinator.startListening();
    if (context.onListenerReady) {
      context.onListenerReady(listener);
    }
    if (context.once || (context.onListenerReady && context.blockUntilSignal !== true)) {
      return 0;
    }
    await new Promise<void>((resolve) => {
      const keepAlive = setInterval(() => {}, 60000);
      const shutdown = () => {
        clearInterval(keepAlive);
        try {
          listener.stop();
        } catch {}
        // Stop the local model process too, then let the process end.
        Promise.resolve(fast?.dispose()).catch(() => {}).finally(resolve);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
    return 0;
  }

  stderr(`Unknown hud subcommand: ${subcommand}. Use "rh hud --help" for usage.`);
  return 1;
}
