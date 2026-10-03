import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  STANDARD_AGY_PERMISSIONS,
  checkAgyPermissions,
  ensureAgyMcpPermission,
  ensureAgyPermissions,
  removeAgyMcpPermission,
} from './agy-permissions.js';
import type { FileSystemAdapter } from '../cloudflare/project.js';

/** In-memory fs: never touches the real ~/.gemini. */
function memoryFs(initial: Record<string, string> = {}): { fs: FileSystemAdapter; files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    fs: {
      readFile: async (p) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p]!;
      },
      writeFile: async (p, content) => {
        files[p] = content;
      },
      exists: async (p) => p in files,
    },
  };
}

const CLI_SETTINGS = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
const IDE_SETTINGS = path.join(os.homedir(), '.gemini/antigravity-ide/settings.json');
const RULE = 'mcp(rh-computer/*)';

describe('agy MCP permission for rh-computer', () => {
  it('rh permissions fix includes the per-server MCP rule and never mcp(*)', () => {
    expect(STANDARD_AGY_PERMISSIONS).toContain(RULE);
    expect(STANDARD_AGY_PERMISSIONS).not.toContain('mcp(*)');
  });

  it('appends the rule, preserving every other key, entry and their order, with a one-time backup', async () => {
    const original = JSON.stringify({
      model: 'm',
      permissions: { defaultAction: 'ask', allow: ['read_file', 'command(git)'], deny: ['x'] },
      trustedWorkspaces: ['/a'],
      zeta: 1,
    });
    const { fs, files } = memoryFs({ [CLI_SETTINGS]: original });
    const res = await ensureAgyMcpPermission(fs);
    expect(res).toMatchObject({ updated: [CLI_SETTINGS], alreadyPresent: [] });
    const parsed = JSON.parse(files[CLI_SETTINGS]!);
    expect(Object.keys(parsed)).toEqual(['model', 'permissions', 'trustedWorkspaces', 'zeta']);
    expect(Object.keys(parsed.permissions)).toEqual(['defaultAction', 'allow', 'deny']);
    expect(parsed.permissions.allow).toEqual(['read_file', 'command(git)', RULE]);
    expect(parsed.permissions.defaultAction).toBe('ask');
    expect(parsed.permissions.deny).toEqual(['x']);
    expect(files[`${CLI_SETTINGS}.bak-rh-mcp`]).toBe(original);
    expect(files[IDE_SETTINGS]).toBeUndefined();
  });

  it('is idempotent and keeps the first backup', async () => {
    const { fs, files } = memoryFs({ [CLI_SETTINGS]: JSON.stringify({ permissions: { allow: ['a'] } }) });
    await ensureAgyMcpPermission(fs);
    const once = files[CLI_SETTINGS];
    const backup = files[`${CLI_SETTINGS}.bak-rh-mcp`];
    const res = await ensureAgyMcpPermission(fs);
    expect(res).toMatchObject({ updated: [], alreadyPresent: [CLI_SETTINGS] });
    expect(files[CLI_SETTINGS]).toBe(once);
    expect(files[`${CLI_SETTINGS}.bak-rh-mcp`]).toBe(backup);
    expect(JSON.parse(files[CLI_SETTINGS]!).permissions.allow.filter((r: string) => r === RULE)).toHaveLength(1);
  });

  it('does not overwrite an existing backup', async () => {
    const { fs, files } = memoryFs({
      [CLI_SETTINGS]: JSON.stringify({ permissions: { allow: [] } }),
      [`${CLI_SETTINGS}.bak-rh-mcp`]: 'older backup',
    });
    await ensureAgyMcpPermission(fs);
    expect(files[`${CLI_SETTINGS}.bak-rh-mcp`]).toBe('older backup');
  });

  it('creates permissions.allow when missing and updates the ide variant only if it exists', async () => {
    const { fs, files } = memoryFs({
      [CLI_SETTINGS]: JSON.stringify({ model: 'm' }),
      [IDE_SETTINGS]: JSON.stringify({ permissions: { defaultAction: 'allow' } }),
    });
    const res = await ensureAgyMcpPermission(fs);
    expect(res.updated).toEqual([CLI_SETTINGS, IDE_SETTINGS]);
    expect(JSON.parse(files[CLI_SETTINGS]!)).toEqual({ model: 'm', permissions: { allow: [RULE] } });
    expect(JSON.parse(files[IDE_SETTINGS]!)).toEqual({ permissions: { defaultAction: 'allow', allow: [RULE] } });
  });

  it('creates the cli settings file when it does not exist', async () => {
    const { fs, files } = memoryFs();
    const res = await ensureAgyMcpPermission(fs);
    expect(res.updated).toEqual([CLI_SETTINGS]);
    expect(JSON.parse(files[CLI_SETTINGS]!)).toEqual({ permissions: { allow: [RULE] } });
    expect(files[`${CLI_SETTINGS}.bak-rh-mcp`]).toBeUndefined();
  });

  it('reports and skips a settings file that fails to parse, leaving it untouched', async () => {
    const { fs, files } = memoryFs({ [CLI_SETTINGS]: '{ not json', [IDE_SETTINGS]: JSON.stringify({}) });
    const res = await ensureAgyMcpPermission(fs);
    expect(files[CLI_SETTINGS]).toBe('{ not json');
    expect(files[`${CLI_SETTINGS}.bak-rh-mcp`]).toBeUndefined();
    expect(res.updated).toEqual([IDE_SETTINGS]);
    expect(res.skipped).toEqual([{ path: CLI_SETTINGS, reason: expect.stringContaining('not valid JSON') }]);
  });

  it('skips a file whose permissions.allow is not a list instead of clobbering it', async () => {
    const raw = JSON.stringify({ permissions: { allow: 'everything' } });
    const { fs, files } = memoryFs({ [CLI_SETTINGS]: raw });
    const res = await ensureAgyMcpPermission(fs);
    expect(files[CLI_SETTINGS]).toBe(raw);
    expect(res.updated).toEqual([]);
    expect(res.skipped).toHaveLength(1);
  });

  it('remove deletes only its exact rule and leaves everything else', async () => {
    const { fs, files } = memoryFs({
      [CLI_SETTINGS]: JSON.stringify({ a: 1, permissions: { allow: ['x', RULE, 'mcp(other/*)', 'mcp(rh-computer/click)', 'y'] } }),
    });
    const res = await removeAgyMcpPermission(fs);
    expect(res.updated).toEqual([CLI_SETTINGS]);
    expect(JSON.parse(files[CLI_SETTINGS]!)).toEqual({ a: 1, permissions: { allow: ['x', 'mcp(other/*)', 'mcp(rh-computer/click)', 'y'] } });
    const again = await removeAgyMcpPermission(fs);
    expect(again.updated).toEqual([]);
  });

  it('remove never creates a settings file and skips invalid JSON', async () => {
    const { fs, files } = memoryFs({ [IDE_SETTINGS]: 'nope' });
    const res = await removeAgyMcpPermission(fs);
    expect(res.updated).toEqual([]);
    expect(files[CLI_SETTINGS]).toBeUndefined();
    expect(files[IDE_SETTINGS]).toBe('nope');
    expect(res.skipped).toHaveLength(1);
  });
});

describe('AGY Headless Permissions', () => {
  it('defines standard permissions including file tools and commands', () => {
    expect(STANDARD_AGY_PERMISSIONS).toContain('read_file');
    expect(STANDARD_AGY_PERMISSIONS).toContain('read_file(*)');
    expect(STANDARD_AGY_PERMISSIONS).toContain('write_file');
    expect(STANDARD_AGY_PERMISSIONS).toContain('edit_file');
    expect(STANDARD_AGY_PERMISSIONS).toContain('command(python3)');
    expect(STANDARD_AGY_PERMISSIONS).toContain('command(git)');
    expect(STANDARD_AGY_PERMISSIONS).toContain('command(npm)');
    expect(STANDARD_AGY_PERMISSIONS).toContain('command(curl)');
  });

  it('reports false when settings file does not exist', async () => {
    const mockFs: FileSystemAdapter = {
      readFile: async () => '',
      writeFile: async () => {},
      exists: async () => false,
    };

    const ok = await checkAgyPermissions(mockFs);
    expect(ok).toBe(false);
  });

  it('creates new settings.json with full permissions and trusted workspaces', async () => {
    const files: Record<string, string> = {};
    const mockFs: FileSystemAdapter = {
      readFile: async (p) => files[p] ?? '',
      writeFile: async (p, content) => {
        files[p] = content;
      },
      exists: async (p) => Boolean(files[p]),
    };

    const targetWorkspace = '/workspace/demo';
    const success = await ensureAgyPermissions(mockFs, targetWorkspace);
    expect(success).toBe(true);

    const settingsPath = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
    expect(files[settingsPath]).toBeDefined();

    const parsed = JSON.parse(files[settingsPath]!);
    expect(parsed.permissions.allow).toContain('read_file');
    expect(parsed.permissions.allow).toContain('command(python3)');
    expect(parsed.trustedWorkspaces).toContain(os.homedir());
    expect(parsed.trustedWorkspaces).toContain(process.cwd());
    expect(parsed.trustedWorkspaces).toContain(path.resolve(targetWorkspace));

    const check = await checkAgyPermissions(mockFs, targetWorkspace);
    expect(check).toBe(true);
  });

  it('preserves existing settings and merges permissions without duplicates', async () => {
    const settingsPath = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
    const existingConfig = {
      model: 'Custom-Model',
      colorScheme: 'dark',
      permissions: {
        allow: ['command(custom-tool)', 'read_file'],
      },
      trustedWorkspaces: ['/existing/trusted/path'],
    };

    const files: Record<string, string> = {
      [settingsPath]: JSON.stringify(existingConfig),
    };

    const mockFs: FileSystemAdapter = {
      readFile: async (p) => files[p] ?? '',
      writeFile: async (p, content) => {
        files[p] = content;
      },
      exists: async (p) => Boolean(files[p]),
    };

    const success = await ensureAgyPermissions(mockFs, '/new/workspace');
    expect(success).toBe(true);

    const parsed = JSON.parse(files[settingsPath]!);
    expect(parsed.model).toBe('Custom-Model');
    expect(parsed.colorScheme).toBe('dark');
    expect(parsed.permissions.allow).toContain('command(custom-tool)');
    expect(parsed.permissions.allow).toContain('read_file');
    expect(parsed.permissions.allow).toContain('command(git)');
    expect(parsed.trustedWorkspaces).toContain('/existing/trusted/path');
    expect(parsed.trustedWorkspaces).toContain(path.resolve('/new/workspace'));
  });
});
