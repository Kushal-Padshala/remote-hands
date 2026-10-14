import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HudServiceManager, generateHudLauncherScript, generateHudPlistXml, stableNodePath } from './hud-service.js';

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

  it('generates a plist that starts the launcher script, with the log directory and a throttled restart', () => {
    const xml = generateHudPlistXml('/home/u/.remote-hands/bin/rh-hud-launch.sh', '/logs', '/home/u');
    expect(xml).toContain('<string>com.remote-hands.hud</string>');
    expect(xml).toContain('<string>/bin/sh</string>');
    expect(xml).toContain('<string>/home/u/.remote-hands/bin/rh-hud-launch.sh</string>');
    expect(xml).toContain('<string>/logs/hud.log</string>');
    expect(xml).toContain('<string>/home/u</string>');
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('<key>ThrottleInterval</key>');
    // no Node path baked in
    expect(xml).not.toContain('/bin/node');
  });

  it('launcher tries the remembered Node first, then the private one, Homebrew, PATH and nvm, and execs the installed copy', () => {
    const script = generateHudLauncherScript();
    const order = ['$RH/node-path', '$RH/node/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node', 'command -v node', '.nvm/versions/node'];
    let at = -1;
    for (const needle of order) {
      const i = script.indexOf(needle);
      expect(i, needle).toBeGreaterThan(at);
      at = i;
    }
    expect(script).toContain('exec "$NODE" "$RH/cli/index.js" hud listen');
    expect(script.startsWith('#!/bin/sh')).toBe(true);
  });

  it('launcher script is valid shell and runs the program it finds', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-launch-'));
    try {
      fs.mkdirSync(path.join(home, '.remote-hands', 'cli'), { recursive: true });
      fs.writeFileSync(path.join(home, '.remote-hands', 'cli', 'index.js'), 'console.log("ARGS:" + process.argv.slice(2).join(" "))');
      fs.writeFileSync(path.join(home, '.remote-hands', 'node-path'), process.execPath);
      const script = path.join(home, 'launch.sh');
      fs.writeFileSync(script, generateHudLauncherScript(), { mode: 0o755 });
      const res = spawnSync('/bin/sh', [script], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf-8' });
      expect(res.stdout.trim()).toBe('ARGS:hud listen');
      expect(res.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('launcher survives a remembered Node that no longer exists, and says so when none is found', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-launch-'));
    try {
      fs.mkdirSync(path.join(home, '.remote-hands', 'cli'), { recursive: true });
      fs.writeFileSync(path.join(home, '.remote-hands', 'cli', 'index.js'), 'console.log("ok")');
      fs.writeFileSync(path.join(home, '.remote-hands', 'node-path'), '/gone/v1/bin/node');
      const script = path.join(home, 'launch.sh');
      fs.writeFileSync(script, generateHudLauncherScript(), { mode: 0o755 });
      // Node on the PATH is found instead of the vanished one
      const nodeDir = path.dirname(process.execPath);
      const found = spawnSync('/bin/sh', [script], { env: { HOME: home, PATH: `${nodeDir}:/usr/bin:/bin` }, encoding: 'utf-8' });
      expect(found.stdout.trim()).toBe('ok');
      // with no Node anywhere (and none at the fixed Homebrew places) it fails loudly with exit 78
      if (!fs.existsSync('/opt/homebrew/bin/node') && !fs.existsSync('/usr/local/bin/node')) {
        const none = spawnSync('/bin/sh', [script], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf-8' });
        expect(none.status).toBe(78);
        expect(none.stderr).toContain('Node.js was not found');
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('uses the stable Homebrew link instead of the versioned Cellar path', () => {
    const exists = (p: string) => p === '/opt/homebrew/bin/node';
    expect(stableNodePath('/opt/homebrew/Cellar/node/23.4.0/bin/node', exists)).toBe('/opt/homebrew/bin/node');
    expect(stableNodePath('/opt/homebrew/Cellar/node/23.4.0/bin/node', () => false)).toBe('/opt/homebrew/Cellar/node/23.4.0/bin/node');
    expect(stableNodePath('/Users/x/.nvm/versions/node/v22/bin/node', exists)).toBe('/Users/x/.nvm/versions/node/v22/bin/node');
  });

  it('installs the launcher, remembers Node, copies the CLI, writes the plist and loads it, all under the given home', () => {
    const cli = path.join(tmpDir, 'src', 'index.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, 'console.log(1)');
    const manager = new HudServiceManager({ exec: mockExec, plistPath: testPlist, home: tmpDir, nodePath: '/n/bin/node' });

    const res = manager.install(cli);
    expect(res.success).toBe(true);
    const rh = path.join(tmpDir, '.remote-hands');
    expect(fs.readFileSync(path.join(rh, 'cli', 'index.js'), 'utf-8')).toBe('console.log(1)');
    expect(fs.readFileSync(path.join(rh, 'node-path'), 'utf-8')).toBe('/n/bin/node');
    const launcher = path.join(rh, 'bin', 'rh-hud-launch.sh');
    expect(fs.statSync(launcher).mode & 0o111).not.toBe(0);
    const content = fs.readFileSync(testPlist, 'utf-8');
    expect(content).toContain(launcher);
    expect(content).toContain(`<string>${path.join(rh, 'logs', 'hud.log')}</string>`);
    expect(mockExec).toHaveBeenCalledWith('launchctl', ['unload', testPlist]);
    expect(mockExec).toHaveBeenCalledWith('launchctl', ['load', '-w', testPlist]);
  });

  it('refuses, with a reason, when there is no program to run (it never falls back to a guessed folder)', () => {
    const manager = new HudServiceManager({ exec: mockExec, plistPath: testPlist, home: tmpDir });
    const res = manager.install('/does/not/exist/index.js');
    expect(res.success).toBe(false);
    expect(res.error).toContain('/does/not/exist/index.js');
    expect(fs.existsSync(testPlist)).toBe(false);
    expect(mockExec).not.toHaveBeenCalledWith('launchctl', ['load', '-w', testPlist]);
  });

  it('restarts through launchctl kickstart, falling back to unload and load', () => {
    const manager = new HudServiceManager({ exec: mockExec, plistPath: testPlist, home: tmpDir });
    expect(manager.restart()).toBe(true);
    expect(mockExec).toHaveBeenCalledWith('launchctl', ['kickstart', '-k', `gui/${process.getuid?.()}/com.remote-hands.hud`]);

    const calls: string[] = [];
    const flaky = new HudServiceManager({
      exec: (cmd: string, args: string[]) => {
        calls.push(`${cmd} ${args[0]}`);
        return { stdout: '', stderr: '', status: args[0] === 'kickstart' ? 113 : 0 };
      },
      plistPath: testPlist,
      home: tmpDir,
    });
    expect(flaky.restart()).toBe(true);
    expect(calls).toEqual(['launchctl kickstart', 'launchctl unload', 'launchctl load']);
  });

  it('reports a stale installed copy only when it differs from the running program', () => {
    const cli = path.join(tmpDir, 'index.js');
    fs.writeFileSync(cli, 'v1');
    const manager = new HudServiceManager({ exec: mockExec, plistPath: testPlist, home: tmpDir });
    manager.install(cli);
    expect(manager.installedCopyIsStale(cli)).toBe(false);
    fs.writeFileSync(cli, 'v2');
    expect(manager.installedCopyIsStale(cli)).toBe(true);
    manager.install(cli);
    expect(manager.installedCopyIsStale(cli)).toBe(false);
    expect(manager.installedCopyIsStale('')).toBe(false);
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
  // the service is recognised as the program under the home folder; the tests' home is a temp folder
  const ownExe = (home: string) => path.join(home, '.remote-hands', 'bin', 'rh-hud.exe');
  const NODE = 'C:\\Program Files\\nodejs\\node.exe';

  function setup(over: { exec?: (cmd: string, args: string[], home: string) => { stdout: string; stderr: string; status: number | null }; built?: { ok: true; path: string } | { ok: false; error: string } } = {}) {
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
        return over.exec ? over.exec(cmd, args, home) : ok;
      },
      buildWindowsHud: () => over.built ?? { ok: true, path: EXE },
      startDetached: (cmd, args) => {
        started.push([cmd, args]);
      },
      sleep: async () => {},
    });
    return { manager, calls, started, home, cli };
  }
  /** What PowerShell prints for the command line of a process. */
  const commandLine = (text: string) => ({ stdout: `${text}\r\n`, stderr: '', status: 0 });
  const supervisorRow = (home: string) => commandLine(`"${ownExe(home)}" supervise`);

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
    const { manager, calls, home, cli } = setup({ exec: (cmd, _a, home) => (cmd === 'powershell' ? supervisorRow(home) : ok) });
    fs.mkdirSync(path.join(home, '.remote-hands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.remote-hands', 'hud-supervisor.pid'), '4242');
    manager.install(cli);
    const kills = calls.filter(([c]) => c === 'taskkill').map(([, a]) => a.join(' '));
    expect(kills).toEqual(['/PID 4242 /T /F']);
    expect(calls.some(([c, a]) => c === 'taskkill' && a.includes('/IM'))).toBe(false);
  });

  it('does not end a program that only happens to have the supervisor\'s old process id, even another rh-hud.exe (a prompt window)', () => {
    const reusedLines = (home: string) => [
      '"C:\\Windows\\notepad.exe" file.txt',
      `"${ownExe(home)}" prompt --app=Chrome`,
      `"${ownExe(home)}" listen`,
      // role words inside folder names and arguments do not make a prompt the service
      '"C:\\Users\\supervise\\.remote-hands\\bin\\rh-hud.exe" prompt --app=supervise',
      `"${ownExe(home)}" prompt supervise`,
      // the service program, but another copy of it
      '"D:\\elsewhere\\rh-hud.exe" supervise',
    ];
    for (let i = 0; i < 6; i++) {
      const reused = `case ${i}`;
      const { manager, calls, home, cli } = setup({ exec: (cmd, _a, h) => (cmd === 'powershell' ? commandLine(reusedLines(h)[i]!) : ok) });
      fs.mkdirSync(path.join(home, '.remote-hands'), { recursive: true });
      fs.writeFileSync(path.join(home, '.remote-hands', 'hud-supervisor.pid'), '4242');
      manager.install(cli);
      expect(calls.some(([c]) => c === 'taskkill'), reused).toBe(false);
    }
    const gone = setup({ exec: (cmd) => (cmd === 'powershell' ? { stdout: '', stderr: 'no such process', status: 1 } : ok) });
    fs.mkdirSync(path.join(gone.home, '.remote-hands'), { recursive: true });
    fs.writeFileSync(path.join(gone.home, '.remote-hands', 'hud-supervisor.pid'), '4242');
    expect(gone.manager.isRunning()).toBe(false);
  });

  it('recognises the service when its command line reaches the same program through another folder name (a junction or short path)', () => {
    const { manager, calls, home, cli } = setup({
      exec: (cmd, _a, h) => {
        if (cmd !== 'powershell') return ok;
        // the process was started through an alias of the home folder
        return commandLine(`"${path.join(h + '-alias', '.remote-hands', 'bin', 'rh-hud.exe')}" supervise`);
      },
    });
    fs.mkdirSync(path.join(home, '.remote-hands', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.remote-hands', 'bin', 'rh-hud.exe'), 'x');
    fs.symlinkSync(home, `${home}-alias`);
    fs.writeFileSync(path.join(home, '.remote-hands', 'hud-supervisor.pid'), '4242');
    try {
      manager.install(cli);
      expect(calls.filter(([c]) => c === 'taskkill').map(([, a]) => a.join(' '))).toEqual(['/PID 4242 /T /F']);
    } finally {
      fs.rmSync(`${home}-alias`, { force: true });
    }
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
    const alive = setup({ exec: (cmd, args, home) => (cmd === 'reg' && args[0] === 'query' ? ok : supervisorRow(home)) });
    fs.mkdirSync(path.join(alive.home, '.remote-hands'), { recursive: true });
    fs.writeFileSync(path.join(alive.home, '.remote-hands', 'hud-supervisor.pid'), '4242');
    expect(alive.manager.isInstalled()).toBe(true);
    expect(alive.manager.isRunning()).toBe(true);
    const none = setup({ exec: (cmd) => (cmd === 'reg' ? { stdout: '', stderr: 'not found', status: 1 } : { stdout: '', stderr: '', status: 1 }) });
    expect(none.manager.isInstalled()).toBe(false);
    expect(none.manager.isRunning()).toBe(false);
  });

  it('removes the login entry and ends the service by its process id on uninstall', () => {
    const { manager, calls, home } = setup({ exec: (cmd, _a, home) => (cmd === 'powershell' ? supervisorRow(home) : ok) });
    fs.mkdirSync(path.join(home, '.remote-hands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.remote-hands', 'hud-supervisor.pid'), '4242');
    expect(manager.uninstall()).toBe(true);
    expect(calls.map(([c, a]) => `${c} ${a.join(' ')}`)).toEqual([
      'reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v RemoteHandsHud /f',
      expect.stringMatching(/^powershell /),
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
