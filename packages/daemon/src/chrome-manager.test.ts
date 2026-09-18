import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChromeManager } from './chrome-manager.js';

describe('ChromeManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-test-'));
    const localState = {
      profile: {
        info_cache: {
          Default: {
            name: 'Personal',
            user_name: 'personal@example.com',
            is_consented_primary_account: true,
          },
          'Profile 4': {
            name: 'kushal',
            user_name: 'kushalp5454@gmail.com',
            is_consented_primary_account: true,
          },
          'Profile 11': {
            name: 'FLCC',
            user_name: 'kushal.padshala@stonybrook.edu',
            is_consented_primary_account: false,
          },
        },
      },
    };
    fs.writeFileSync(path.join(tempDir, 'Local State'), JSON.stringify(localState));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves default ports and profile directories', () => {
    const manager = new ChromeManager({ mode: 'dedicated', port: 9222 });
    expect(manager.getPort()).toBe(9222);
    expect(manager.getMode()).toBe('dedicated');
    expect(manager.getProfileDirectory()).toContain('.remote-hands/chrome-profile');
  });

  it('resolves active profile directory on darwin', () => {
    const manager = new ChromeManager({ mode: 'active' });
    if (process.platform === 'darwin') {
      expect(manager.getProfileDirectory()).toContain('Application Support/Google/Chrome');
    } else {
      expect(manager.getProfileDirectory()).toBeDefined();
    }
  });

  it('builds launch arguments with remote debugging port and profile dir', () => {
    const manager = new ChromeManager({ mode: 'dedicated', port: 9222 });
    const args = manager.buildLaunchArgs('https://github.com');
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args.some((a) => a.startsWith('--user-data-dir='))).toBe(true);
    expect(args).toContain('https://github.com');
  });

  it('rejects command flag injection in launch url', () => {
    const manager = new ChromeManager({ mode: 'dedicated', port: 9222 });
    const args = manager.buildLaunchArgs('--disable-web-security');
    expect(args).not.toContain('--disable-web-security');
    expect(args.some((a) => a === '--disable-web-security')).toBe(false);
  });

  it('detects debugger availability when endpoint responds', async () => {
    const manager = new ChromeManager({ port: 9222 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc-123',
        Browser: 'Chrome/128.0.0.0',
      }),
    } as any);

    const status = await manager.checkDebuggerStatus();
    expect(status.available).toBe(true);
    expect(status.wsUrl).toBe('ws://127.0.0.1:9222/devtools/browser/abc-123');
    fetchSpy.mockRestore();
  });

  it('handles offline debugger gracefully', async () => {
    const manager = new ChromeManager({ port: 9222 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const status = await manager.checkDebuggerStatus();
    expect(status.available).toBe(false);
    expect(status.wsUrl).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('lists profiles from simulated Local State', () => {
    const profiles = ChromeManager.listProfiles(tempDir);
    expect(profiles).toHaveLength(3);
    expect(profiles[0]).toEqual({
      id: 'Default',
      name: 'Personal',
      email: 'personal@example.com',
      directory: 'Default',
      isDefault: true,
    });
    expect(profiles[1]).toEqual({
      id: 'Profile 4',
      name: 'kushal',
      email: 'kushalp5454@gmail.com',
      directory: 'Profile 4',
      isDefault: false,
    });
    expect(profiles[2]).toEqual({
      id: 'Profile 11',
      name: 'FLCC',
      email: 'kushal.padshala@stonybrook.edu',
      directory: 'Profile 11',
      isDefault: false,
    });
  });

  it('resolves profile by human-readable name', () => {
    const resolved = ChromeManager.resolveProfile('kushal', tempDir);
    expect(resolved).toBeDefined();
    expect(resolved?.id).toBe('Profile 4');
    expect(resolved?.directory).toBe('Profile 4');
    expect(resolved?.name).toBe('kushal');
    const manager = new ChromeManager({ profile: 'kushal', customProfileDir: tempDir });
    expect(manager.getResolvedProfile()?.directory).toBe('Profile 4');
  });

  it('resolves profile by email', () => {
    const resolved = ChromeManager.resolveProfile('kushalp5454@gmail.com', tempDir);
    expect(resolved).toBeDefined();
    expect(resolved?.id).toBe('Profile 4');
    expect(resolved?.directory).toBe('Profile 4');
    const manager = new ChromeManager({ profile: 'kushalp5454@gmail.com', customProfileDir: tempDir });
    expect(manager.getResolvedProfile()?.directory).toBe('Profile 4');
  });

  it('resolves profile by folder name', () => {
    const resolved = ChromeManager.resolveProfile('Profile 11', tempDir);
    expect(resolved).toBeDefined();
    expect(resolved?.id).toBe('Profile 11');
    expect(resolved?.directory).toBe('Profile 11');
    expect(resolved?.name).toBe('FLCC');
    const manager = new ChromeManager({ profile: 'Profile 11', customProfileDir: tempDir });
    expect(manager.getResolvedProfile()?.directory).toBe('Profile 11');
  });

  it('appends --profile-directory to launch args when profile is specified', () => {
    const manager = new ChromeManager({ profile: 'kushal', customProfileDir: tempDir });
    const args = manager.buildLaunchArgs('https://github.com');
    expect(args).toContain('--profile-directory=Profile 4');
    expect(args).toContain(`--user-data-dir=${tempDir}`);
    expect(args[args.length - 1]).toBe('https://github.com');
  });

  it('populates profileName and profileDirectory in checkDebuggerStatus', async () => {
    const manager = new ChromeManager({ profile: 'kushal', customProfileDir: tempDir });
    const status = await manager.checkDebuggerStatus();
    expect(status.profileName).toBe('kushal');
    expect(status.profileDirectory).toBe('Profile 4');
  });

  it('returns empty array when Local State is missing or malformed', () => {
    const emptyDir = path.join(tempDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    expect(ChromeManager.listProfiles(emptyDir)).toEqual([]);
    fs.writeFileSync(path.join(emptyDir, 'Local State'), 'not json');
    expect(ChromeManager.listProfiles(emptyDir)).toEqual([]);
  });

  it('returns default user data directory for the current platform', () => {
    const defaultDir = ChromeManager.getDefaultUserDataDir();
    expect(typeof defaultDir).toBe('string');
    expect(defaultDir.length).toBeGreaterThan(0);
  });
});
