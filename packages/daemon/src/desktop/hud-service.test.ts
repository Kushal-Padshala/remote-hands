import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HudServiceManager, generateHudPlistXml } from './hud-service.js';

describe('HudServiceManager', () => {
  const originalPlatform = process.platform;
  let tmpDir: string;
  let testPlist: string;
  let mockExec: any;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-service-test-'));
    testPlist = path.join(tmpDir, 'test.plist');
    mockExec = vi.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects LaunchAgent installation on Linux without creating a plist or running launchctl', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const manager = new HudServiceManager({ exec: mockExec, plistPath: testPlist });
    expect(manager.install('/custom/path/to/rh').success).toBe(false);
    expect(fs.existsSync(testPlist)).toBe(false);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('generates valid plist xml with node, cli path, and log directory', () => {
    const xml = generateHudPlistXml('/usr/local/bin/node', '/usr/local/bin/rh', '/logs');
    expect(xml).toContain('<string>com.remote-hands.hud</string>');
    expect(xml).toContain('<string>/usr/local/bin/node</string>');
    expect(xml).toContain('<string>/usr/local/bin/rh</string>');
    expect(xml).toContain('<string>hud</string>');
    expect(xml).toContain('<string>listen</string>');
    expect(xml).toContain('<key>KeepAlive</key>');
  });

  it('installs plist file and triggers launchctl load', () => {
    const manager = new HudServiceManager({
      exec: mockExec,
      plistPath: testPlist,
    });

    const res = manager.install('/custom/path/to/rh');
    expect(res.success).toBe(true);
    expect(fs.existsSync(testPlist)).toBe(true);
    const content = fs.readFileSync(testPlist, 'utf-8');
    expect(content).toContain('/custom/path/to/rh');
    expect(mockExec).toHaveBeenCalledWith('launchctl', ['unload', testPlist]);
    expect(mockExec).toHaveBeenCalledWith('launchctl', ['load', '-w', testPlist]);
  });

  it('uninstalls plist file and triggers launchctl unload', () => {
    fs.writeFileSync(testPlist, 'dummy', 'utf-8');
    const manager = new HudServiceManager({
      exec: mockExec,
      plistPath: testPlist,
    });

    expect(manager.isInstalled()).toBe(true);
    const uninstalled = manager.uninstall();
    expect(uninstalled).toBe(true);
    expect(fs.existsSync(testPlist)).toBe(false);
    expect(mockExec).toHaveBeenCalledWith('launchctl', ['unload', '-w', testPlist]);
  });

  it('checks running status via launchctl list', () => {
    mockExec.mockReturnValue({
      stdout: '1234 0 com.remote-hands.hud\n5678 0 other.service',
      stderr: '',
      status: 0,
    });
    const manager = new HudServiceManager({
      exec: mockExec,
      plistPath: testPlist,
    });
    expect(manager.isRunning()).toBe(true);

    mockExec.mockReturnValue({
      stdout: '5678 0 other.service',
      stderr: '',
      status: 0,
    });
    expect(manager.isRunning()).toBe(false);
  });
});

describe('HudServiceManager on Windows', () => {
  const homes: string[] = [];
  const makeHome = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-winservice-'));
    homes.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const ok = { stdout: '', stderr: '', status: 0 };

  function setup(over: { exec?: (cmd: string, args: string[]) => { stdout: string; stderr: string; status: number | null }; built?: { ok: true; path: string } | { ok: false; error: string } } = {}) {
    const home = makeHome();
    const calls: Array<[string, string[]]> = [];
    const started: Array<[string, string[]]> = [];
    const cli = path.join(home, 'dist', 'index.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '// cli');
    const manager = new HudServiceManager({
      platform: 'win32',
      home,
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      exec: (cmd, args) => {
        calls.push([cmd, args]);
        return over.exec ? over.exec(cmd, args) : ok;
      },
      buildWindowsHud: () => over.built ?? { ok: true, path: 'C:\\Users\\Ana Lee\\.remote-hands\\bin\\rh-hud.exe' },
      startDetached: (cmd, args) => {
        started.push([cmd, args]);
      },
    });
    return { manager, calls, started, home, cli };
  }

  it('installs a login entry with every part quoted, copies the CLI to a stable place, replaces a running copy and starts now', () => {
    const { manager, calls, started, home, cli } = setup();
    const res = manager.install(cli);
    expect(res.success).toBe(true);
    const stable = path.join(home, '.remote-hands', 'cli', 'index.js');
    expect(fs.readFileSync(stable, 'utf-8')).toBe('// cli');
    const add = calls.find(([c, a]) => c === 'reg' && a[0] === 'add')!;
    expect(add[1].slice(0, 7)).toEqual(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'RemoteHandsHud', '/t', 'REG_SZ', '/d']);
    expect(add[1][7]).toBe(`"C:\\Users\\Ana Lee\\.remote-hands\\bin\\rh-hud.exe" supervise "--node=C:\\Program Files\\nodejs\\node.exe" "--cli=${stable}"`);
    expect(add[1]).toContain('/f');
    expect(calls.some(([c, a]) => c === 'taskkill' && a.join(' ') === '/IM rh-hud.exe /T /F')).toBe(true);
    // the old copy is ended before the new one starts
    expect(calls.findIndex(([c]) => c === 'taskkill')).toBeGreaterThan(calls.findIndex(([c]) => c === 'reg'));
    expect(started).toEqual([['C:\\Users\\Ana Lee\\.remote-hands\\bin\\rh-hud.exe', ['supervise', '--node=C:\\Program Files\\nodejs\\node.exe', `--cli=${stable}`]]]);
  });

  it('says why when the program cannot be built, and starts nothing', () => {
    const { manager, calls, started } = setup({ built: { ok: false, error: 'the Windows compiler was not found' } });
    const res = manager.install();
    expect(res).toMatchObject({ success: false, error: 'the Windows compiler was not found' });
    expect(calls).toEqual([]);
    expect(started).toEqual([]);
  });

  it('says why when the startup entry cannot be written, and starts nothing', () => {
    const { manager, started, cli } = setup({ exec: (cmd) => (cmd === 'reg' ? { stdout: '', stderr: 'ERROR: Access is denied.', status: 1 } : ok) });
    const res = manager.install(cli);
    expect(res.success).toBe(false);
    expect(res.error).toContain('could not add the startup entry');
    expect(res.error).toContain('Access is denied');
    expect(started).toEqual([]);
  });

  it('knows whether it is installed and running from the registry and the task list', () => {
    const queried = setup({ exec: (cmd, args) => (cmd === 'reg' && args[0] === 'query' ? ok : { stdout: '"rh-hud.exe","4120","Console","1","18,000 K"\r\n', stderr: '', status: 0 }) });
    expect(queried.manager.isInstalled()).toBe(true);
    expect(queried.manager.isRunning()).toBe(true);
    const none = setup({ exec: (cmd) => (cmd === 'reg' ? { stdout: '', stderr: 'not found', status: 1 } : { stdout: 'INFO: No tasks are running which match the specified criteria.', stderr: '', status: 0 }) });
    expect(none.manager.isInstalled()).toBe(false);
    expect(none.manager.isRunning()).toBe(false);
  });

  it('removes the login entry and ends the program on uninstall', () => {
    const { manager, calls } = setup();
    expect(manager.uninstall()).toBe(true);
    expect(calls.map(([c, a]) => `${c} ${a.join(' ')}`)).toEqual([
      'reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v RemoteHandsHud /f',
      'taskkill /IM rh-hud.exe /T /F',
    ]);
    const missing = setup({ exec: (cmd) => (cmd === 'reg' ? { stdout: '', stderr: '', status: 1 } : ok) });
    expect(missing.manager.uninstall()).toBe(false);
  });
});
