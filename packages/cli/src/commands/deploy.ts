import type { CommandContext } from './setup.js';

export async function deployCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const log = context.stdout ?? console.log;
  log('Deploying remote-hands stack...');
  return 0;
}
