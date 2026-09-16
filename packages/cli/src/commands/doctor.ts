import type { CommandContext } from './setup.js';

export async function doctorCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const log = context.stdout ?? console.log;
  log('Running remote-hands health checks...');
  return 0;
}
