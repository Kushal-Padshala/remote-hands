import { describe, expect, it, vi, afterEach } from 'vitest';
import { permissionsCommand, checkAllPermissions } from './permissions.js';
import type { CommandContext } from './setup.js';

describe('permissions command', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.restoreAllMocks();
  });

  it('prints help message with --help', async () => {
    const stdout = vi.fn();
    const code = await permissionsCommand(['--help'], { stdout });
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Usage: rh permissions'));
  });

  it('returns JSON report when --json flag is passed on non-darwin', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const stdout = vi.fn();
    const mockFs: any = {
      readFile: async () => JSON.stringify({ permissions: { allow: ['read_file'] } }),
      writeFile: async () => {},
      exists: async () => true,
    };
    const code = await permissionsCommand(['--json'], { stdout, fs: mockFs });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.mock.calls[0][0]);
    expect(parsed.screenCapture).toBe(true);
    expect(parsed.fullDiskAccess).toBe(true);
    expect(parsed.accessibility).toBe(true);
    expect(parsed.antigravity).toBe(true);
    expect(parsed.allGranted).toBe(true);
  });

  it('outputs human-readable status when called without --json', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const stdout = vi.fn();
    const mockFs: any = {
      readFile: async () => JSON.stringify({ permissions: { allow: ['read_file'] } }),
      writeFile: async () => {},
      exists: async () => true,
    };
    const code = await permissionsCommand(['status'], { stdout, fs: mockFs });
    expect(code).toBe(0);
    const output = stdout.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('System Permissions Status');
    expect(output).toContain('Screen & Audio Recording');
  });

  it('checkAllPermissions reports accurately on non-darwin', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const mockFs: any = {
      readFile: async () => JSON.stringify({ permissions: { allow: ['read_file'] } }),
      writeFile: async () => {},
      exists: async () => true,
    };
    const report = await checkAllPermissions({ fs: mockFs });
    expect(report.screenCapture).toBe(true);
    expect(report.fullDiskAccess).toBe(true);
    expect(report.accessibility).toBe(true);
    expect(report.antigravity).toBe(true);
    expect(report.allGranted).toBe(true);
  });
});
