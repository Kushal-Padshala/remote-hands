#!/usr/bin/env node
import { setupCommand, type CommandContext } from './commands/setup.js';
import { deployCommand } from './commands/deploy.js';
import { daemonCommand } from './commands/daemon.js';
import { doctorCommand } from './commands/doctor.js';

export { setupCommand, deployCommand, daemonCommand, doctorCommand, type CommandContext };

export async function main(argv: string[], context: CommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;

  const [command, ...args] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    stdout('Usage: remote-hands <command> [options]');
    stdout('');
    stdout('Commands:');
    stdout('  setup    Set up Cloudflare resources and pair this computer');
    stdout('  deploy   Deploy backend Worker and phone PWA to Cloudflare');
    stdout('  daemon   Run the local execution daemon');
    stdout('  doctor   Check system prerequisites and connectivity');
    stdout('');
    return 0;
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

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
