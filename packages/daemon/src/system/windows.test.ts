import { describe, expect, it, vi } from 'vitest';
import { agyCommand, describeSpawnError, detachedWindowsLaunch, findAgyOnWindows, findOnWindowsPath, killWindowsProcessTree, quoteWindowsArg, shellQuote } from './windows.js';

const present = (...files: string[]) => (f: string) => files.includes(f);

describe('findOnWindowsPath', () => {
  const env = { Path: 'C:\\Windows\\system32; "C:\\Users\\José Müller\\bin" ;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  it('finds a program through PATH and PATHEXT, in folders with spaces and accents', () => {
    expect(findOnWindowsPath('agy', { platform: 'win32', env, exists: present('C:\\Users\\José Müller\\bin\\agy.exe') })).toBe('C:\\Users\\José Müller\\bin\\agy.exe');
  });
  it('prefers an .exe to a script shim in the same folder, and takes a name that already has an extension as it is', () => {
    expect(findOnWindowsPath('agy', { platform: 'win32', env, exists: present('C:\\tools\\agy.cmd', 'C:\\tools\\agy.exe') })).toBe('C:\\tools\\agy.exe');
    expect(findOnWindowsPath('agy.cmd', { platform: 'win32', env, exists: present('C:\\tools\\agy.cmd') })).toBe('C:\\tools\\agy.cmd');
  });
  it('finds nothing when it is not there, and nothing at all off Windows', () => {
    expect(findOnWindowsPath('agy', { platform: 'win32', env, exists: () => false })).toBeUndefined();
    expect(findOnWindowsPath('agy', { platform: 'darwin', env, exists: () => true })).toBeUndefined();
    expect(findOnWindowsPath('agy', { platform: 'win32', env: {}, exists: () => true })).toBeUndefined();
  });
});

describe('agy on Windows', () => {
  const env = { Path: 'C:\\Windows\\system32', LOCALAPPDATA: 'C:\\Users\\Ana Lee\\AppData\\Local' };
  it('is found in the folder the installer uses even when PATH does not have it yet', () => {
    const installed = 'C:\\Users\\Ana Lee\\AppData\\Local\\agy\\bin\\agy.exe';
    expect(findAgyOnWindows({ platform: 'win32', env, exists: present(installed) })).toBe(installed);
    expect(agyCommand({ platform: 'win32', env, exists: present(installed) })).toBe(installed);
  });
  it('uses PATH first', () => {
    expect(agyCommand({ platform: 'win32', env: { ...env, Path: 'C:\\x' }, exists: present('C:\\x\\agy.exe') })).toBe('C:\\x\\agy.exe');
  });
  it('falls back to the plain name when it is not installed, and always on Mac and Linux', () => {
    expect(agyCommand({ platform: 'win32', env, exists: () => false })).toBe('agy');
    expect(agyCommand({ platform: 'darwin', env, exists: () => true })).toBe('agy');
    expect(agyCommand({ platform: 'linux', env, exists: () => true })).toBe('agy');
  });
  it('works out the install folder from the home when LOCALAPPDATA is missing', () => {
    const installed = 'C:\\Users\\Ana\\AppData\\Local\\agy\\bin\\agy.exe';
    expect(agyCommand({ platform: 'win32', env: {}, homedir: 'C:\\Users\\Ana', exists: present(installed) })).toBe(installed);
  });
});

describe('shellQuote', () => {
  it('quotes only what has spaces and is not already quoted', () => {
    expect(shellQuote('agy')).toBe('agy');
    expect(shellQuote('C:\\Users\\Ana Lee\\agy.exe')).toBe('"C:\\Users\\Ana Lee\\agy.exe"');
    expect(shellQuote('"C:\\a b\\agy.exe"')).toBe('"C:\\a b\\agy.exe"');
    // characters cmd.exe would act on, in valid folder names
    expect(shellQuote('C:\\Users\\Ana&Lee\\agy.exe')).toBe('"C:\\Users\\Ana&Lee\\agy.exe"');
    expect(shellQuote('C:\\Users\\Ana(Lee)\\agy.exe')).toBe('"C:\\Users\\Ana(Lee)\\agy.exe"');
    expect(shellQuote('C:\\Users\\Ana,Lee;x=y\\agy.exe')).toBe('"C:\\Users\\Ana,Lee;x=y\\agy.exe"');
  });
});

describe('killWindowsProcessTree', () => {
  it('asks taskkill to end the whole tree', () => {
    const run = vi.fn(() => ({ status: 0 }));
    expect(killWindowsProcessTree(1234, { platform: 'win32', run })).toBe(true);
    expect(run).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/T', '/F']);
  });
  it('says it could not when taskkill fails or throws, and never runs off Windows or for a doubtful id', () => {
    expect(killWindowsProcessTree(1234, { platform: 'win32', run: () => ({ status: 128 }) })).toBe(false);
    expect(killWindowsProcessTree(1234, { platform: 'win32', run: () => { throw new Error('no taskkill'); } })).toBe(false);
    const run = vi.fn(() => ({ status: 0 }));
    expect(killWindowsProcessTree(1234, { platform: 'darwin', run })).toBe(false);
    for (const bad of [undefined, 0, 1, 4, -5, 1.5, NaN]) expect(killWindowsProcessTree(bad as number, { platform: 'win32', run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('only real programs are chosen for agy', () => {
  it('never returns a script shim, which Node cannot start without a shell, and falls through to the installer folder', () => {
    const env = { Path: 'C:\\tools', LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const installed = 'C:\\Users\\Ana\\AppData\\Local\\agy\\bin\\agy.exe';
    expect(agyCommand({ platform: 'win32', env, exists: present('C:\\tools\\agy.cmd', installed) })).toBe(installed);
    expect(agyCommand({ platform: 'win32', env, exists: present('C:\\tools\\agy.cmd', 'C:\\tools\\agy.bat') })).toBe('agy');
    // other programs may still be found as scripts
    expect(findOnWindowsPath('npm', { platform: 'win32', env, exists: present('C:\\tools\\npm.cmd') })).toBe('C:\\tools\\npm.cmd');
  });
});

describe('describeSpawnError', () => {
  it('gives one plain remedy on Windows for the usual failures, and keeps the system message elsewhere', () => {
    for (const code of ['ENOENT', 'EINVAL', 'EACCES', 'EPERM']) {
      const err = Object.assign(new Error(`spawn agy ${code}`), { code });
      expect(describeSpawnError(err, 'agy', 'win32')).toBe('Remote Hands could not start the agent program (agy). Run "rh setup" to install or repair it.');
      expect(describeSpawnError(err, 'agy', 'darwin')).toBe(`spawn agy ${code}`);
    }
    expect(describeSpawnError(new Error('weird'), 'agy', 'win32')).toBe('weird');
    expect(describeSpawnError('text', 'agy', 'win32')).toBe('text');
  });
});

describe('killWindowsProcessTree never targets this program', () => {
  it('refuses this process and its parent', () => {
    const run = vi.fn(() => ({ status: 0 }));
    expect(killWindowsProcessTree(process.pid, { platform: 'win32', run })).toBe(false);
    expect(killWindowsProcessTree(process.ppid, { platform: 'win32', run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('quoteWindowsArg and detachedWindowsLaunch', () => {
  it('quotes only what needs it', () => {
    expect(quoteWindowsArg('--remote-debugging-port=9222')).toBe('--remote-debugging-port=9222');
    expect(quoteWindowsArg('--user-data-dir=C:\\Users\\Ana Lee\\.remote-hands\\chrome-profile')).toBe('"--user-data-dir=C:\\Users\\Ana Lee\\.remote-hands\\chrome-profile"');
    expect(quoteWindowsArg('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).toBe('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"');
    expect(quoteWindowsArg('https://a.example/?x=1&y=2')).toBe('"https://a.example/?x=1&y=2"');
    expect(quoteWindowsArg('')).toBe('""');
    expect(quoteWindowsArg('a"b c')).toBe('"ab c"');
  });

  it('starts a program from outside this process\'s tree, with the whole command in quotes', () => {
    const launch = detachedWindowsLaunch('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--remote-debugging-port=9222', '--user-data-dir=C:\\Users\\José Müller\\.remote-hands\\chrome-profile'], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
    expect(launch.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(launch.args).toEqual([
      '/d',
      '/s',
      '/c',
      '"start "" "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 "--user-data-dir=C:\\Users\\José Müller\\.remote-hands\\chrome-profile""',
    ]);
  });

  it('falls back to cmd.exe when ComSpec is not set', () => {
    expect(detachedWindowsLaunch('chrome.exe', [], {}).file).toBe('cmd.exe');
  });
});
