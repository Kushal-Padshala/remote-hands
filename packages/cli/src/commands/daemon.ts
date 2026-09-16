import type { CommandContext } from './setup.js';

export async function daemonCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const log = context.stdout ?? console.log;
  log('Starting remote-hands daemon...');
  return 0;
}
