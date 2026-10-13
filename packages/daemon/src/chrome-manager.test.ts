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
            name: 'Work',
            user_name: 'work@example.com',
            is_consented_primary_account: true,
          },
          'Profile 11': {
            name: 'FLCC',
            user_name: 'student@university.edu',
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
      name: 'Work',
      email: 'work@example.com',
      directory: 'Profile 4',
      isDefault: false,
    });
    expect(profiles[2]).toEqual({
      id: 'Profile 11',
      name: 'FLCC',
      email: 'student@university.edu',
      directory: 'Profile 11',
      isDefault: false,
    });
  });

  it('resolves profile by human-readable name', () => {
    const resolved = ChromeManager.resolveProfile('Work', tempDir);
    expect(resolved).toBeDefined();
    expect(resolved?.id).toBe('Profile 4');
    expect(resolved?.directory).toBe('Profile 4');
    expect(resolved?.name).toBe('Work');
    const manager = new ChromeManager({ profile: 'Work', customProfileDir: tempDir });
    expect(manager.getResolvedProfile()?.directory).toBe('Profile 4');
  });

  it('resolves profile by email', () => {
    const resolved = ChromeManager.resolveProfile('work@example.com', tempDir);
    expect(resolved).toBeDefined();
    expect(resolved?.id).toBe('Profile 4');
    expect(resolved?.directory).toBe('Profile 4');
    const manager = new ChromeManager({ profile: 'work@example.com', customProfileDir: tempDir });
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
    const manager = new ChromeManager({ profile: 'Work', customProfileDir: tempDir });
    const args = manager.buildLaunchArgs('https://github.com');
    expect(args).toContain('--profile-directory=Profile 4');
    expect(args).toContain(`--user-data-dir=${tempDir}`);
    expect(args[args.length - 1]).toBe('https://github.com');
  });

  it('populates profileName and profileDirectory in checkDebuggerStatus', async () => {
    const manager = new ChromeManager({ profile: 'Work', customProfileDir: tempDir });
    const status = await manager.checkDebuggerStatus();
    expect(status.profileName).toBe('Work');
    expect(status.profileDirectory).toBe('Profile 4');
  });

  it('returns empty array when Local State is missing or malformed', () => {
    const emptyDir = path.join(tempDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    expect(ChromeManager.listProfiles(emptyDir)).toEqual([]);
    fs.writeFileSync(path.join(emptyDir, 'Local State'), 'not json');
    expect(ChromeManager.listProfiles(emptyDir)).toEqual([]);
  });

  it('syncs auth state files to destination directory', () => {
    const srcProfileDir = path.join(tempDir, 'Profile 4');
    fs.mkdirSync(srcProfileDir, { recursive: true });
    fs.writeFileSync(path.join(srcProfileDir, 'Cookies'), 'dummy-cookie-data');
    fs.writeFileSync(path.join(srcProfileDir, 'Login Data'), 'dummy-login-data');
    const netDir = path.join(srcProfileDir, 'Network');
    fs.mkdirSync(netDir, { recursive: true });
    fs.writeFileSync(path.join(netDir, 'Cookies'), 'dummy-net-cookie-data');

    const destDir = path.join(tempDir, 'dest-profile');
    ChromeManager.syncProfileAuthState(tempDir, 'Profile 4', destDir);

    expect(fs.existsSync(path.join(destDir, 'Local State'))).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'Profile 4', 'Cookies'))).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'Profile 4', 'Login Data'))).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'Profile 4', 'Network', 'Cookies'))).toBe(true);
  });

  it('resolves personal profile by keyword', () => {
    const resolved = ChromeManager.resolveProfile('personal', tempDir);
    expect(resolved).toBeDefined();
    expect(resolved?.name).toBe('Personal');
  });
});


describe('ChromeManager.findBrowserExecutable', () => {
  const env = {
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\José Müller\\AppData\\Local',
  };
  const present = (...files: string[]) => (f: string) => files.includes(f);

  it('prefers Chrome in its usual places on Windows, including a per-user install', () => {
    expect(ChromeManager.findBrowserExecutable({ platform: 'win32', env, exists: present('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') })).toEqual({
      path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      kind: 'chrome',
    });
    expect(
      ChromeManager.findBrowserExecutable({
        platform: 'win32',
        env,
        exists: present('C:\\Users\\José Müller\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'),
      }),
    ).toEqual({ path: 'C:\\Users\\José Müller\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe', kind: 'chrome' });
  });

  it('falls back to Edge, which Windows includes, when Chrome is not installed', () => {
    expect(
      ChromeManager.findBrowserExecutable({ platform: 'win32', env, exists: present('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe') }),
    ).toEqual({ path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', kind: 'edge' });
  });

  it('finds nothing when no browser is there, or when the folders are unknown', () => {
    expect(ChromeManager.findBrowserExecutable({ platform: 'win32', env, exists: () => false })).toBeUndefined();
    expect(ChromeManager.findBrowserExecutable({ platform: 'win32', env: {}, exists: () => true })).toBeUndefined();
    expect(ChromeManager.findBrowserExecutable({ platform: 'linux', env, exists: () => true })).toBeUndefined();
  });

  it('finds the Mac app on a Mac', () => {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(ChromeManager.findBrowserExecutable({ platform: 'darwin', exists: present(mac) })).toEqual({ path: mac, kind: 'chrome' });
    expect(ChromeManager.findBrowserExecutable({ platform: 'darwin', exists: () => false })).toBeUndefined();
  });
});

describe('ChromeManager.ensureRunning without a browser', () => {
  it('says so in plain words instead of failing silently, and does not start anything', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-none-'));
    try {
      const manager = new ChromeManager({ mode: 'dedicated', port: 59999, customProfileDir: dir, chromeExecutablePath: '' });
      const status = await manager.ensureRunning();
      expect(status.available).toBe(false);
      expect(status.error).toContain('Google Chrome was not found');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not end the process when the browser program cannot be started', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bad-'));
    try {
      const manager = new ChromeManager({ mode: 'dedicated', port: 59998, customProfileDir: dir, chromeExecutablePath: path.join(dir, 'no-such-browser') });
      const status = await manager.ensureRunning();
      expect(status.available).toBe(false);
      expect(status.error).toBe('The browser could not be started.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
