import { describe, expect, it, vi, afterEach } from 'vitest';
import { permissionsCommand, checkAllPermissions } from './permissions.js';
import * as os from 'node:os';
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

  describe('rh permissions revert', () => {
    const SETTINGS = `${os.homedir()}/.gemini/antigravity-cli/settings.json`;
    function memFs(initial: Record<string, string>) {
      const files = { ...initial };
      const fs: any = {
        readFile: async (p: string) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
        writeFile: async (p: string, c: string) => { files[p] = c; },
        exists: async (p: string) => p in files,
      };
      return { files, fs };
    }
    const original = { permissions: { defaultAction: 'ask', allow: ['read_file'] } };

    it('restores the settings, stops the background HUD (an older one would put them back at login) and says so', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const { files, fs } = memFs({ [SETTINGS]: JSON.stringify(original) });
      await permissionsCommand(['fix'], { stdout: () => {}, fs });
      expect(JSON.parse(files[SETTINGS]!).permissions.defaultAction).toBe('allow');
      const service = { isInstalled: vi.fn().mockReturnValue(true), uninstall: vi.fn().mockReturnValue(true) };
      const out: string[] = [];
      const code = await permissionsCommand(['revert'], { stdout: (l) => out.push(l), fs, hudServiceManager: service } as CommandContext);
      expect(code).toBe(0);
      expect(JSON.parse(files[SETTINGS]!)).toEqual(original);
      expect(service.uninstall).toHaveBeenCalledTimes(1);
      expect(out.join('\n')).toContain('background HUD was stopped');
      expect(out.join('\n')).toContain('rh setup --hud');
    });

    it('leaves a service alone when none is installed, and says plainly when there was nothing recorded', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const { fs } = memFs({ [SETTINGS]: JSON.stringify(original) });
      const service = { isInstalled: vi.fn().mockReturnValue(false), uninstall: vi.fn() };
      const out: string[] = [];
      expect(await permissionsCommand(['revert'], { stdout: (l) => out.push(l), fs, hudServiceManager: service } as CommandContext)).toBe(0);
      expect(service.uninstall).not.toHaveBeenCalled();
      expect(out.join('\n')).toContain('no record of changes');
    });

    it('fails with exit 1, changing and stopping nothing, when the revert cannot be made lasting', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const { files, fs } = memFs({ [SETTINGS]: JSON.stringify(original) });
      await permissionsCommand(['fix'], { stdout: () => {}, fs });
      const permissive = files[SETTINGS];
      const failing = { ...fs, writeFile: async (p: string, c: string) => { if (p.endsWith('agy-consent.json')) throw new Error('EACCES'); return fs.writeFile(p, c); } };
      const service = { isInstalled: vi.fn().mockReturnValue(true), uninstall: vi.fn() };
      const out: string[] = [];
      expect(await permissionsCommand(['revert'], { stdout: (l) => out.push(l), fs: failing, hudServiceManager: service } as CommandContext)).toBe(1);
      expect(files[SETTINGS]).toBe(permissive);
      expect(service.uninstall).not.toHaveBeenCalled();
      expect(out.join('\n')).toContain('Could not revert');
    });
  });
});
