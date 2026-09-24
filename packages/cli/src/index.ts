#!/usr/bin/env node
import { setupCommand, type CommandContext } from './commands/setup.js';
import { deployCommand } from './commands/deploy.js';
import { daemonCommand } from './commands/daemon.js';
import { startCommand } from './commands/start.js';
import { doctorCommand } from './commands/doctor.js';
import { pairCommand } from './commands/pair.js';
import { browserCommand } from './commands/browser.js';
import { profilesCommand } from './commands/profiles.js';
import { approveCommand } from './commands/approve.js';
import { desktopCommand } from './commands/desktop.js';
import { hudCommand } from './commands/hud.js';
import { guideCommand, executeGuideCommand } from './commands/guide.js';

import { permissionsCommand } from './commands/permissions.js';

export {
  setupCommand,
  deployCommand,
  daemonCommand,
  startCommand,
  doctorCommand,
  pairCommand,
  browserCommand,
  profilesCommand,
  approveCommand,
  desktopCommand,
  hudCommand,
  permissionsCommand,
  guideCommand,
  executeGuideCommand,
  type CommandContext,
};

export async function main(argv: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;

  const [command, ...args] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    stdout('Usage: remote-hands <command> [options] (or: rh <command>)');
    stdout('');
    stdout('Commands:');
    stdout('  start       Start daemon with lid-closed clamshell sleep prevention');
    stdout('  pair        Display phone pairing QR code and direct link');
    stdout('  daemon      Run the local execution daemon');
    stdout('  desktop     Control native desktop applications and GUI automation');
    stdout('  hud         Manage desktop overlay assistant and hotkey background service');
    stdout('  permissions Inspect and pre-authorize macOS and AI agent permissions');
    stdout('  browser     Run headless browser automation bridge with live screen streaming');
    stdout('  guide       Interactive visual guidance and annotation overlays');
    stdout('  approve     Request human-in-the-loop approval on the mobile app');
    stdout('  profiles    List detected Chrome browser profiles and launch commands');
    stdout('  setup       Set up Cloudflare resources and pair this computer');
    stdout('  deploy      Deploy backend Worker and phone PWA to Cloudflare');
    stdout('  doctor      Check system prerequisites and connectivity');
    stdout('');
    return 0;
  }

  if (command === 'start') {
    return await startCommand(args, context);
  }

  if (command === 'pair') {
    return await pairCommand(args, context);
  }

  if (command === 'desktop') {
    return await desktopCommand(args, context);
  }

  if (command === 'hud') {
    return await hudCommand(args, context);
  }

  if (command === 'permissions') {
    return await permissionsCommand(args, context);
  }


  if (command === 'browser') {
    return await browserCommand(args, context);
  }

  if (command === 'guide') {
    return await guideCommand(args, context);
  }

  if (command === 'approve') {
    return await approveCommand(args, context);
  }

  if (command === 'profiles') {
    return await profilesCommand(args, context);
  }

  if (command === 'setup') {
    return await setupCommand(args, context);
  }

  if (command === 'deploy') {
    return await deployCommand(args, context);
  }

  if (command === 'daemon') {
    return await daemonCommand(args, context);
  }

  if (command === 'doctor') {
    return await doctorCommand(args, context);
  }

  stderr(`Unknown command: ${command}. Use --help for usage.`);
  return 1;
}

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import path from 'node:path';

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const binaryName = path.basename(process.argv[1] || '');
  if (binaryName === 'rh-browser') {
    browserCommand(process.argv.slice(2)).then((code) => {
      if (code !== 0) process.exit(code);
    });
  } else if (binaryName === 'rh-desktop') {
    desktopCommand(process.argv.slice(2)).then((code) => {
      if (code !== 0) process.exit(code);
    });
  } else if (binaryName === 'rh-hud') {
    hudCommand(process.argv.slice(2)).then((code) => {
      if (code !== 0) process.exit(code);
    });
  } else if (binaryName === 'rh-guide') {
    guideCommand(process.argv.slice(2)).then((code) => {
      if (code !== 0) process.exit(code);
    });
  } else {
    main(process.argv.slice(2)).then((code) => {
      if (code !== 0) process.exit(code);
    });
  }
}
