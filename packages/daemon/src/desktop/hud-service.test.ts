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
  const EXE = 'C:\\Users\\Ana Lee\\.remote-hands\\bin\\rh-hud.exe';
  const NODE = 'C:\\Program Files\\nodejs\\node.exe';

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
      nodePath: NODE,
      exec: (cmd, args) => {
        calls.push([cmd, args]);
        return over.exec ? over.exec(cmd, args) : ok;
      },
      buildWindowsHud: () => over.built ?? { ok: true, path: EXE },
      startDetached: (cmd, args) => {
        started.push([cmd, args]);
      },
      sleep: async () => {},
    });
    return { manager, calls, started, home, cli };
  }
  const supervisorRow = (pid: number) => ({ stdout: `"rh-hud.exe","${pid}","Console","1","18,000 K"\r\n`, stderr: '', status: 0 });

  it('registers a short login entry, keeps the long paths in a settings file, copies the CLI to a stable place and starts now', () => {
    const { manager, calls, started, home, cli } = setup();
    const res = manager.install(cli);
    expect(res.success).toBe(true);
    const stable = path.join(home, '.remote-hands', 'cli', 'index.js');
    expect(fs.readFileSync(stable, 'utf-8')).toBe('// cli');
    expect(JSON.parse(fs.readFileSync(path.join(home, '.remote-hands', 'hud.json'), 'utf-8'))).toEqual({ node: NODE, cli: stable });
    const add = calls.find(([c, a]) => c === 'reg' && a[0] === 'add')!;
    expect(add[1].slice(0, 7)).toEqual(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'RemoteHandsHud', '/t', 'REG_SZ', '/d']);
    expect(add[1][7]).toBe(`"${EXE}" supervise`);
    expect(add[1][7]!.length).toBeLessThan(260);
    expect(started).toEqual([[EXE, ['supervise']]]);
  });

  it('keeps the login entry short even with a very long Node path', () => {
    const { manager, calls, cli } = setup();
    const long = new HudServiceManager({
      platform: 'win32',
      home: path.dirname(path.dirname(cli)),
      nodePath: `C:\\Users\\Alexandra.Catherine.Montgomery-Smith\\AppData\\Local\\fnm_multishells\\1234567890123\\${'x'.repeat(60)}\\node.exe`,
      exec: (cmd, args) => (calls.push([cmd, args]), ok),
      buildWindowsHud: () => ({ ok: true, path: EXE }),
      startDetached: () => {},
    });
    expect(long.install(cli).success).toBe(true);
    const add = calls.filter(([c, a]) => c === 'reg' && a[0] === 'add').pop()!;
    expect(add[1][7]!.length).toBeLessThan(120);
  });

  it('ends only the service it started (checked by its process id and program name), never every rh-hud.exe', () => {
    const { manager, calls, home, cli } = setup({ exec: (cmd, args) => (cmd === 'tasklist' ? supervisorRow(4242) : ok) });
    fs.mkdirSync(path.join(home, '.remote-hands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.remote-hands', 'hud-supervisor.pid'), '4242');
    manager.install(cli);
    const kills = calls.filter(([c]) => c === 'taskkill').map(([, a]) => a.join(' '));
    expect(kills).toEqual(['/PID 4242 /T /F']);
    expect(calls.some(([c, a]) => c === 'taskkill' && a.includes('/IM'))).toBe(false);
  });

  it('does not end a program that only happens to have the supervisor\'s old process id', () => {
    const { manager, calls, home, cli } = setup({ exec: (cmd) => (cmd === 'tasklist' ? { stdout: 'INFO: No tasks are running which match the specified criteria.', stderr: '', status: 0 } : ok) });
    fs.mkdirSync(path.join(home, '.remote-hands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.remote-hands', 'hud-supervisor.pid'), '4242');
    manager.install(cli);
    expect(calls.some(([c]) => c === 'taskkill')).toBe(false);
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

  it('knows whether it is installed and running (the supervisor must still be that program)', () => {
    const alive = setup({ exec: (cmd, args) => (cmd === 'reg' && args[0] === 'query' ? ok : supervisorRow(4242)) });
    fs.mkdirSync(path.join(alive.home, '.remote-hands'), { recursive: true });
    fs.writeFileSync(path.join(alive.home, '.remote-hands', 'hud-supervisor.pid'), '4242');
    expect(alive.manager.isInstalled()).toBe(true);
    expect(alive.manager.isRunning()).toBe(true);
    const none = setup({ exec: (cmd) => (cmd === 'reg' ? { stdout: '', stderr: 'not found', status: 1 } : { stdout: 'INFO: No tasks are running which match the specified criteria.', stderr: '', status: 0 }) });
    expect(none.manager.isInstalled()).toBe(false);
    expect(none.manager.isRunning()).toBe(false);
  });

  it('removes the login entry and ends the service by its process id on uninstall', () => {
    const { manager, calls, home } = setup({ exec: (cmd) => (cmd === 'tasklist' ? supervisorRow(4242) : ok) });
    fs.mkdirSync(path.join(home, '.remote-hands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.remote-hands', 'hud-supervisor.pid'), '4242');
    expect(manager.uninstall()).toBe(true);
    expect(calls.map(([c, a]) => `${c} ${a.join(' ')}`)).toEqual([
      'reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v RemoteHandsHud /f',
      expect.stringMatching(/^tasklist /),
      'taskkill /PID 4242 /T /F',
    ]);
    expect(fs.existsSync(path.join(home, '.remote-hands', 'hud-supervisor.pid'))).toBe(false);
    const missing = setup({ exec: (cmd) => (cmd === 'reg' ? { stdout: '', stderr: '', status: 1 } : ok) });
    expect(missing.manager.uninstall()).toBe(false);
  });

  it('waits for the listener to say whether it got its hotkey, and reports silence instead of guessing', async () => {
    const { manager, home } = setup();
    const status = path.join(home, '.remote-hands', 'hud-status.json');
    fs.mkdirSync(path.dirname(status), { recursive: true });
    expect(await manager.waitForHotkey(900, 300)).toBeNull();
    fs.writeFileSync(status, JSON.stringify({ state: 'ready', keys: 'Ctrl+Alt+Space', at: 1 }));
    expect(await manager.waitForHotkey(900, 300)).toMatchObject({ state: 'ready', keys: 'Ctrl+Alt+Space' });
    fs.writeFileSync(status, JSON.stringify({ state: 'failed', at: 2 }));
    expect(await manager.waitForHotkey(900, 300)).toMatchObject({ state: 'failed' });
  });

  it('clears the old status before starting, so an earlier "ready" is never mistaken for this start', () => {
    const { manager, home, cli } = setup();
    const status = path.join(home, '.remote-hands', 'hud-status.json');
    fs.mkdirSync(path.dirname(status), { recursive: true });
    fs.writeFileSync(status, JSON.stringify({ state: 'ready', keys: 'Ctrl+Shift+Space', at: 1 }));
    manager.install(cli);
    expect(fs.existsSync(status)).toBe(false);
  });
});
