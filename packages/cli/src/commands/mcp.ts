import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDefaultComputerSession, serveComputerMcp } from '@remote-hands/daemon';
import type { CommandContext } from './setup.js';
import { createActionGate } from '../action-gate.js';
import { agyMcpRule, ensureAgyMcpPermission, removeAgyMcpPermission } from '../system/agy-permissions.js';

export const AGY_MCP_NAME = 'rh-computer';

type ExecResult = { status: number | null; stdout: string; stderr: string; error?: Error | undefined };

export interface McpCommandContext extends CommandContext {
  exec?: (command: string, args: string[]) => ExecResult;
  serve?: () => Promise<void>;
  nodePath?: string;
  cliPath?: string;
  /** Puts the CLI where background processes can run it and returns that path (tests replace it). */
  installStableCli?: (source: string) => string;
}

const realExec = (command: string, args: string[]): ExecResult => {
  const res = spawnSync(command, args, { encoding: 'utf-8' });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', error: res.error };
};

function failureDetail(res: ExecResult): string {
  const text = res.stderr.trim() || res.stdout.trim();
  if (text) return text;
  const err = res.error as (Error & { code?: string }) | undefined;
  if (err?.code === 'ENOENT') return `agy not found on PATH (${err.message})`;
  return err?.message ?? `exit status ${res.status}`;
}

/**
 * agy starts the MCP server in the background, where macOS blocks access to protected folders such as
 * ~/Desktop, so a checkout or an npm link living there cannot be launched. Register a copy under
 * ~/.remote-hands/cli instead (the HUD service runs the same copy).
 */
export function installStableCli(source: string, home?: string): string {
  // Tests that did not inject a home must never overwrite the real installed copy.
  if (home === undefined && process.env.VITEST === 'true') return source;
  const dest = path.join(home ?? os.homedir(), '.remote-hands', 'cli', 'index.js');
  try {
    if (path.resolve(source) !== dest) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
    }
    return dest;
  } catch {
    return source;
  }
}

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
    const serve = context.serve ?? (() => serveComputerMcp(createDefaultComputerSession(createActionGate({ env: context.env }))));
    await serve();
    return 0;
  }

  if (sub === 'install') {
    const res = exec('agy', [
      'mcp', 'add', AGY_MCP_NAME, '--',
      context.nodePath ?? process.execPath,
      context.cliPath ?? (context.installStableCli ?? installStableCli)(currentCliPath()),
      'mcp', 'serve',
    ]);
    if (res.status !== 0) {
      stderr(`Failed to register ${AGY_MCP_NAME} with agy: ${failureDetail(res)}`);
      return 1;
    }
    stdout(`Registered MCP server ${AGY_MCP_NAME} with agy.`);
    // Headless agy auto-denies MCP tool calls unless permissions.allow names the server.
    const rule = agyMcpRule(AGY_MCP_NAME);
    const perm = await ensureAgyMcpPermission(context.fs, AGY_MCP_NAME);
    for (const s of perm.skipped) stderr(`Skipped ${s.path}: ${s.reason}`);
    if (perm.updated.length > 0) {
      stdout(`Allowed MCP tools of ${AGY_MCP_NAME} for headless agy (permissions.allow: ${rule}).`);
    } else if (perm.alreadyPresent.length > 0) {
      stdout(`MCP tools of ${AGY_MCP_NAME} already allowed for headless agy (permissions.allow: ${rule}).`);
    } else {
      stderr(`Could not allow the ${AGY_MCP_NAME} tools for headless agy; add "${rule}" to permissions.allow in ~/.gemini/antigravity-cli/settings.json.`);
      return 1;
    }
    return 0;
  }

  if (sub === 'remove') {
    const res = exec('agy', ['mcp', 'remove', AGY_MCP_NAME]);
    if (res.status !== 0) {
      stderr(`Failed to remove ${AGY_MCP_NAME}: ${failureDetail(res)}`);
      return 1;
    }
    stdout(`Removed MCP server ${AGY_MCP_NAME}.`);
    const perm = await removeAgyMcpPermission(context.fs, AGY_MCP_NAME);
    for (const s of perm.skipped) stderr(`Skipped ${s.path}: ${s.reason}`);
    if (perm.updated.length > 0) stdout(`Removed ${agyMcpRule(AGY_MCP_NAME)} from permissions.allow.`);
    return 0;
  }

  stderr('Usage: rh mcp <serve|install|remove>');
  return 1;
}
