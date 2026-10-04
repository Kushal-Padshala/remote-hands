import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { mcpCommand } from './mcp.js';
import type { FileSystemAdapter } from '../cloudflare/project.js';

const CLI_SETTINGS = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');

/** In-memory fs so install/remove never touch the real agy settings. */
function memoryFs(initial: Record<string, string> = {}): FileSystemAdapter & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    },
    writeFile: async (p, content) => {
      files[p] = content;
    },
    exists: async (p) => p in files,
  };
}

describe('mcpCommand', () => {
  it('install registers the stdio server with agy using this node and cli path', async () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const stdout = vi.fn();
    const code = await mcpCommand(['install'], {
      exec,
      stdout,
      fs: memoryFs(),
      nodePath: '/usr/bin/node',
      cliPath: '/opt/rh/index.js',
    });
    expect(code).toBe(0);
    expect(exec).toHaveBeenCalledWith('agy', [
      'mcp', 'add', 'rh-computer', '--', '/usr/bin/node', '/opt/rh/index.js', 'mcp', 'serve',
    ]);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('rh-computer'));
  });

  it('install surfaces agy failures and does not touch the settings', async () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'agy exploded' });
    const stderr = vi.fn();
    const fs = memoryFs();
    const code = await mcpCommand(['install'], { exec, stderr, fs, nodePath: 'n', cliPath: 'c' });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('agy exploded'));
    expect(fs.files).toEqual({});
  });

  it('install allows the rh-computer tools for headless agy, additively', async () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const stdout = vi.fn();
    const fs = memoryFs({ [CLI_SETTINGS]: JSON.stringify({ model: 'm', permissions: { allow: ['read_file'] } }) });
    expect(await mcpCommand(['install'], { exec, stdout, fs, nodePath: 'n', cliPath: 'c' })).toBe(0);
    expect(JSON.parse(fs.files[CLI_SETTINGS]!)).toEqual({ model: 'm', permissions: { allow: ['read_file', 'mcp(rh-computer/*)'] } });
    expect(stdout).toHaveBeenCalledWith(
      'Allowed MCP tools of rh-computer for headless agy (permissions.allow: mcp(rh-computer/*)).',
    );
    stdout.mockClear();
    expect(await mcpCommand(['install'], { exec, stdout, fs, nodePath: 'n', cliPath: 'c' })).toBe(0);
    expect(stdout).toHaveBeenCalledWith(
      'MCP tools of rh-computer already allowed for headless agy (permissions.allow: mcp(rh-computer/*)).',
    );
  });

  it('install warns and fails when no settings file could take the rule', async () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const stderr = vi.fn();
    const fs = memoryFs({ [CLI_SETTINGS]: '{ broken' });
    expect(await mcpCommand(['install'], { exec, stdout: vi.fn(), stderr, fs, nodePath: 'n', cliPath: 'c' })).toBe(1);
    expect(fs.files[CLI_SETTINGS]).toBe('{ broken');
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('mcp(rh-computer/*)'));
  });

  it('remove unregisters the server and removes only its allow rule', async () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const fs = memoryFs({
      [CLI_SETTINGS]: JSON.stringify({ permissions: { allow: ['read_file', 'mcp(rh-computer/*)', 'mcp(other/*)'] } }),
    });
    expect(await mcpCommand(['remove'], { exec, stdout: vi.fn(), fs })).toBe(0);
    expect(exec).toHaveBeenCalledWith('agy', ['mcp', 'remove', 'rh-computer']);
    expect(JSON.parse(fs.files[CLI_SETTINGS]!).permissions.allow).toEqual(['read_file', 'mcp(other/*)']);
  });

  it('serve starts the server and returns when it ends', async () => {
    const serve = vi.fn().mockResolvedValue(undefined);
    expect(await mcpCommand(['serve'], { serve })).toBe(0);
    expect(serve).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown subcommands', async () => {
    const stderr = vi.fn();
    expect(await mcpCommand(['wat'], { stderr })).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Usage: rh mcp'));
  });

  it('install reports spawn errors when agy is missing', async () => {
    const exec = vi.fn().mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }),
    });
    const stderr = vi.fn();
    expect(await mcpCommand(['install'], { exec, stderr, fs: memoryFs(), nodePath: 'n', cliPath: 'c' })).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('spawn agy ENOENT'));
  });

  it('remove reports spawn errors when agy is missing', async () => {
    const exec = vi.fn().mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }),
    });
    const stderr = vi.fn();
    expect(await mcpCommand(['remove'], { exec, stderr, fs: memoryFs() })).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('spawn agy ENOENT'));
  });
});


describe('mcp install registers a copy background processes can run', () => {
  it('registers the stable copy, not the checkout path', async () => {
    const calls: string[][] = [];
    const exec = (_c: string, a: string[]) => (calls.push(a), { status: 0, stdout: '', stderr: '' });
    await mcpCommand(['install'], {
      exec,
      stdout: vi.fn(),
      stderr: vi.fn(),
      fs: memoryFs(),
      nodePath: 'n',
      installStableCli: (src: string) => `/home/u/.remote-hands/cli/index.js#from:${src.length > 0}`,
    } as any);
    expect(calls[0]).toEqual(['mcp', 'add', 'rh-computer', '--', 'n', '/home/u/.remote-hands/cli/index.js#from:true', 'mcp', 'serve']);
  });

  it('installStableCli copies into <home>/.remote-hands/cli/index.js and falls back to the source when it cannot', async () => {
    const fsm = await import('node:fs');
    const osm = await import('node:os');
    const pathm = await import('node:path');
    const { installStableCli } = await import('./mcp.js');
    const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'rh-stable-'));
    try {
      const src = pathm.join(dir, 'src.js');
      fsm.writeFileSync(src, 'console.log(1)');
      const dest = installStableCli(src, dir);
      expect(dest).toBe(pathm.join(dir, '.remote-hands', 'cli', 'index.js'));
      expect(fsm.readFileSync(dest, 'utf-8')).toBe('console.log(1)');
      expect(installStableCli(pathm.join(dir, 'missing.js'), dir)).toBe(pathm.join(dir, 'missing.js'));
    } finally {
      fsm.rmSync(dir, { recursive: true, force: true });
    }
  });
});
