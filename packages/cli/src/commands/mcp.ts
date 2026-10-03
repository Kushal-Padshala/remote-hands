import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createDefaultComputerSession, serveComputerMcp } from '@remote-hands/daemon';
import type { CommandContext } from './setup.js';

export const AGY_MCP_NAME = 'rh-computer';

type ExecResult = { status: number | null; stdout: string; stderr: string };

export interface McpCommandContext extends CommandContext {
  exec?: (command: string, args: string[]) => ExecResult;
  serve?: () => Promise<void>;
  nodePath?: string;
  cliPath?: string;
}

const realExec = (command: string, args: string[]): ExecResult => {
  const res = spawnSync(command, args, { encoding: 'utf-8' });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
};

function currentCliPath(): string {
  const entry = process.argv[1];
  if (!entry) throw new Error('Cannot determine rh entry path');
  return realpathSync(entry);
}

export async function mcpCommand(args: string[], context: McpCommandContext = {}): Promise<number> {
  const stdout = context.stdout ?? console.log;
  const stderr = context.stderr ?? console.error;
  const exec = context.exec ?? realExec;
  const sub = args[0] ?? 'serve';

  if (sub === 'serve') {
    const serve = context.serve ?? (() => serveComputerMcp(createDefaultComputerSession()));
    await serve();
    return 0;
  }

  if (sub === 'install') {
    const res = exec('agy', [
      'mcp', 'add', AGY_MCP_NAME, '--',
      context.nodePath ?? process.execPath,
      context.cliPath ?? currentCliPath(),
      'mcp', 'serve',
    ]);
    if (res.status !== 0) {
      stderr(`Failed to register ${AGY_MCP_NAME} with agy: ${res.stderr.trim() || res.stdout.trim()}`);
      return 1;
    }
    stdout(`Registered MCP server ${AGY_MCP_NAME} with agy.`);
    return 0;
  }

  if (sub === 'remove') {
    const res = exec('agy', ['mcp', 'remove', AGY_MCP_NAME]);
    if (res.status !== 0) {
      stderr(`Failed to remove ${AGY_MCP_NAME}: ${res.stderr.trim() || res.stdout.trim()}`);
      return 1;
    }
    stdout(`Removed MCP server ${AGY_MCP_NAME}.`);
    return 0;
  }

  stderr('Usage: rh mcp <serve|install|remove>');
  return 1;
}
