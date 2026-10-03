import { describe, it, expect, vi } from 'vitest';
import { mcpCommand } from './mcp.js';

describe('mcpCommand', () => {
  it('install registers the stdio server with agy using this node and cli path', async () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const stdout = vi.fn();
    const code = await mcpCommand(['install'], {
      exec,
      stdout,
      nodePath: '/usr/bin/node',
      cliPath: '/opt/rh/index.js',
    });
    expect(code).toBe(0);
    expect(exec).toHaveBeenCalledWith('agy', [
      'mcp', 'add', 'rh-computer', '--', '/usr/bin/node', '/opt/rh/index.js', 'mcp', 'serve',
    ]);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('rh-computer'));
  });

  it('install surfaces agy failures', async () => {
    const exec = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'agy exploded' });
    const stderr = vi.fn();
    const code = await mcpCommand(['install'], { exec, stderr, nodePath: 'n', cliPath: 'c' });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('agy exploded'));
  });

  it('remove unregisters the server', async () => {
    const exec = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    expect(await mcpCommand(['remove'], { exec, stdout: vi.fn() })).toBe(0);
    expect(exec).toHaveBeenCalledWith('agy', ['mcp', 'remove', 'rh-computer']);
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
    expect(await mcpCommand(['install'], { exec, stderr, nodePath: 'n', cliPath: 'c' })).toBe(1);
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
    expect(await mcpCommand(['remove'], { exec, stderr })).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('spawn agy ENOENT'));
  });
});
