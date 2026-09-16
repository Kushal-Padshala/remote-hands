export interface CommandContext {
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  env?: Record<string, string | undefined>;
}

export async function setupCommand(args: string[], context: CommandContext = {}): Promise<number> {
  const log = context.stdout ?? console.log;
  log('Starting remote-hands setup...');
  return 0;
}
