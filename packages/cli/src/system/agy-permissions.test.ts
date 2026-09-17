import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  STANDARD_AGY_PERMISSIONS,
  checkAgyPermissions,
  ensureAgyPermissions,
} from './agy-permissions.js';
import type { FileSystemAdapter } from '../cloudflare/project.js';

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
