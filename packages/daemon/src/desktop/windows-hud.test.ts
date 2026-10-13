import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WINDOWS_HUD_SOURCES } from './windows-hud-source.generated.js';
import {
  clearHudStatus,
  ensureWindowsHud,
  findCsc,
  hudHotkeyLabel,
  hudStatusPath,
  parseHudCommandLine,
  readHudStatus,
  readHudSupervisorPid,
  saveHudStatus,
  windowsHudPaths,
  windowsHudSourceHash,
} from './windows-hud.js';

const homes: string[] = [];
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-winhud-'));
  homes.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Tests run on a Mac or Linux: the paths below are Windows paths used as plain strings, so the fake file system is keyed on them.
const CSC64 = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const CSC32 = 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe';

describe('the embedded Windows HUD sources', () => {
  it('are exactly the .cs files, and plain ASCII (the Windows compiler reads them as ANSI)', () => {
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'windows-hud');
    for (const name of ['HudLogic.cs', 'Hud.cs']) {
      const text = fs.readFileSync(path.join(dir, name), 'utf-8');
      expect(WINDOWS_HUD_SOURCES[name]).toBe(text);
      // eslint-disable-next-line no-control-regex
      expect(/[^\u0000-\u007f]/.test(text)).toBe(false);
    }
  });

  it('avoid the newer C# the Windows compiler (C# 5) rejects; the full check is `node packages/daemon/scripts/check-windows-hud.mjs`', () => {
    for (const [name, raw] of Object.entries(WINDOWS_HUD_SOURCES)) {
      const text = raw.replace(/\/\/.*$/gm, '');
      expect(text, `${name} uses an interpolated string`).not.toMatch(/\$"/);
      expect(text, `${name} uses ?.`).not.toMatch(/\w\?\.\w/);
      expect(text, `${name} uses nameof`).not.toMatch(/\bnameof\(/);
    }
  });
});

describe('findCsc', () => {
  it('prefers the 64-bit compiler and falls back to the 32-bit one', () => {
    expect(findCsc({ WINDIR: 'C:\\Windows' }, (f) => f === CSC64 || f === CSC32)).toBe(CSC64);
    expect(findCsc({ WINDIR: 'C:\\Windows' }, (f) => f === CSC32)).toBe(CSC32);
    expect(findCsc({}, (f) => f === CSC32)).toBe(CSC32);
    expect(findCsc({ WINDIR: 'C:\\Windows' }, () => false)).toBeUndefined();
  });
});

describe('ensureWindowsHud', () => {
  const sources = { 'A.cs': 'class A {}', 'B.cs': 'class B {}' };

  /** A fake compiler that writes the output file, like csc does. */
  const compiler = (status = 0, stderr = '') =>
    vi.fn((_csc: string, args: string[]) => {
      const out = args.find((a) => a.startsWith('/out:'))!.slice(5);
      if (status === 0) fs.writeFileSync(out, 'MZ');
      return { status, stderr, stdout: '' };
    });
  const onDisk = (f: string) => fs.existsSync(f);
  const hereCsc = (f: string) => f === CSC64 || fs.existsSync(f);

  it('builds the program once, with the compiler Windows ships, and not again while the sources are unchanged', () => {
    const home = tmp();
    const compile = compiler();
    const first = ensureWindowsHud({ home, sources, exists: hereCsc, compile });
    expect(first.ok).toBe(true);
    const exe = windowsHudPaths(home).exe;
    expect(first).toEqual({ ok: true, path: exe });
    expect(fs.existsSync(exe)).toBe(true);
    const args = compile.mock.calls[0]![1];
    expect(compile.mock.calls[0]![0]).toBe(CSC64);
    expect(args).toEqual(expect.arrayContaining(['/nologo', '/target:winexe', '/optimize+', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll']));
    expect(args.some((a) => a.endsWith('A.cs'))).toBe(true);
    const second = ensureWindowsHud({ home, sources, exists: onDisk, compile });
    expect(second.ok).toBe(true);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('builds again when the sources change, replacing an older program that may be running', () => {
    const home = tmp();
    const compile = compiler();
    ensureWindowsHud({ home, sources, exists: hereCsc, compile });
    const exe = windowsHudPaths(home).exe;
    fs.writeFileSync(exe, 'OLD');
    const changed = ensureWindowsHud({ home, sources: { ...sources, 'A.cs': 'class A2 {}' }, exists: hereCsc, compile });
    expect(changed.ok).toBe(true);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(exe, 'utf-8')).toBe('MZ');
    expect(fs.existsSync(`${exe}.new`)).toBe(false);
    expect(fs.existsSync(`${exe}.old`)).toBe(false);
  });

  it('says in plain words when the compiler is missing, and when the build fails', () => {
    const home = tmp();
    const missing = ensureWindowsHud({ home, sources, exists: () => false, compile: compiler() });
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { error: string }).error).toContain('Windows compiler was not found');
    const failed = ensureWindowsHud({ home, sources, exists: hereCsc, compile: compiler(1, 'Hud.cs(3,4): error CS1002: ; expected') });
    expect(failed).toMatchObject({ ok: false });
    expect((failed as { error: string }).error).toContain('could not be built');
    expect((failed as { error: string }).error).toContain('CS1002');
    expect((failed as { error: string }).error).toContain('allow "csc.exe"');
    expect(fs.existsSync(windowsHudPaths(home).exe)).toBe(false);
    expect(fs.existsSync(`${windowsHudPaths(home).exe}.new`)).toBe(false);
  });

  it('keeps a working older program when a rebuild fails', () => {
    const home = tmp();
    ensureWindowsHud({ home, sources, exists: hereCsc, compile: compiler() });
    const exe = windowsHudPaths(home).exe;
    const failed = ensureWindowsHud({ home, sources: { ...sources, 'A.cs': 'bad' }, exists: hereCsc, compile: compiler(1, 'error') });
    expect(failed.ok).toBe(false);
    expect(fs.readFileSync(exe, 'utf-8')).toBe('MZ');
  });

  it('reports a compiler that cannot even be run', () => {
    const home = tmp();
    const result = ensureWindowsHud({
      home,
      sources,
      exists: hereCsc,
      compile: () => ({ status: null, stderr: '', stdout: '', error: new Error('spawn EACCES') }),
    });
    expect((result as { error: string }).error).toContain('could not run the Windows compiler');
  });

  it('hashes the sources by name and content, whatever order they are given in', () => {
    expect(windowsHudSourceHash({ a: '1', b: '2' })).toBe(windowsHudSourceHash({ b: '2', a: '1' }));
    expect(windowsHudSourceHash({ a: '1', b: '2' })).not.toBe(windowsHudSourceHash({ a: '1', b: '3' }));
    expect(windowsHudSourceHash({ ab: '' })).not.toBe(windowsHudSourceHash({ a: 'b' }));
  });
});

describe('ensureWindowsHud when the new program cannot be put in place', () => {
  const sources = { 'A.cs': 'class A {}' };
  const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const compile = (_csc: string, args: string[]) => {
    fs.writeFileSync(args.find((a) => a.startsWith('/out:'))!.slice(5), 'NEW');
    return { status: 0, stderr: '', stdout: '' };
  };

  it('puts the older program back, so the login entry still points at something that starts', () => {
    const home = tmp();
    const exists = (f: string) => f === CSC || fs.existsSync(f);
    expect(ensureWindowsHud({ home, sources, exists, compile }).ok).toBe(true);
    const exe = windowsHudPaths(home).exe;
    fs.writeFileSync(exe, 'WORKING');
    const stampBefore = fs.readFileSync(windowsHudPaths(home).stamp, 'utf-8');
    const failing = (from: string, to: string) => {
      if (to === exe && from.endsWith('.new')) throw new Error('EBUSY: resource busy or locked');
      fs.renameSync(from, to);
    };
    const result = ensureWindowsHud({ home, sources: { 'A.cs': 'class A2 {}' }, exists, compile, rename: failing });
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(exe, 'utf-8')).toBe('WORKING');
    expect(fs.existsSync(`${exe}.new`)).toBe(false);
    // the stamp still describes what is installed, so the next run builds again
    expect(fs.readFileSync(windowsHudPaths(home).stamp, 'utf-8')).toBe(stampBefore);
  });
});

describe('the hotkey status and label', () => {
  it('is the Mac keys on a Mac, and on Windows what the listener says it got', () => {
    const home = tmp();
    expect(hudHotkeyLabel('darwin', home)).toBe('Shift + Cmd + Space');
    expect(hudHotkeyLabel('win32', home)).toBe('Ctrl + Shift + Space');
    saveHudStatus({ state: 'ready', keys: 'Ctrl+Alt+Space' }, home, 5);
    expect(hudHotkeyLabel('win32', home)).toBe('Ctrl + Alt + Space');
    expect(readHudStatus(home)).toEqual({ state: 'ready', keys: 'Ctrl+Alt+Space', at: 5 });
  });

  it('refuses keys that are not plain key names, and a ready status without keys', () => {
    const home = tmp();
    saveHudStatus({ state: 'ready', keys: 'Ctrl+Alt+Space' }, home);
    saveHudStatus({ state: 'ready', keys: '$(evil)' }, home);
    saveHudStatus({ state: 'ready' }, home);
    expect(readHudStatus(home)?.keys).toBe('Ctrl+Alt+Space');
    fs.writeFileSync(hudStatusPath(home), JSON.stringify({ state: 'ready', keys: '<script>' }));
    expect(readHudStatus(home)).toBeUndefined();
    fs.writeFileSync(hudStatusPath(home), 'not json');
    expect(readHudStatus(home)).toBeUndefined();
    expect(hudHotkeyLabel('win32', home)).toBe('Ctrl + Shift + Space');
  });

  it('records that no key was free, and clears the record', () => {
    const home = tmp();
    saveHudStatus({ state: 'failed' }, home, 9);
    expect(readHudStatus(home)).toEqual({ state: 'failed', at: 9 });
    expect(hudHotkeyLabel('win32', home)).toBe('Ctrl + Shift + Space');
    clearHudStatus(home);
    expect(readHudStatus(home)).toBeUndefined();
  });
});

describe('the supervisor process id', () => {
  it('is read only when it is a plausible id', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.remote-hands'), { recursive: true });
    const file = path.join(home, '.remote-hands', 'hud-supervisor.pid');
    expect(readHudSupervisorPid(home)).toBeUndefined();
    fs.writeFileSync(file, '4242\n');
    expect(readHudSupervisorPid(home)).toBe(4242);
    for (const bad of ['', 'abc', '3', '-5', '12.5x']) {
      fs.writeFileSync(file, bad);
      expect(readHudSupervisorPid(home), bad).toBeUndefined();
    }
  });
});

describe('parseHudCommandLine', () => {
  it('reads the program and its role from the start of a command line', () => {
    expect(parseHudCommandLine('"C:\\Users\\Ana Lee\\.remote-hands\\bin\\rh-hud.exe" supervise')).toEqual({ program: 'C:\\Users\\Ana Lee\\.remote-hands\\bin\\rh-hud.exe', role: 'supervise' });
    expect(parseHudCommandLine('C:\\h\\rh-hud.exe prompt --app=x')).toEqual({ program: 'C:\\h\\rh-hud.exe', role: 'prompt' });
    expect(parseHudCommandLine('  "C:\\h\\RH-HUD.EXE"   LISTEN  ')).toEqual({ program: 'C:\\h\\RH-HUD.EXE', role: 'listen' });
    expect(parseHudCommandLine('"C:/h/rh-hud.exe" supervise')).toEqual({ program: 'C:/h/rh-hud.exe', role: 'supervise' });
  });
  it('does not mistake another program, or a path that merely mentions the words', () => {
    expect(parseHudCommandLine('"C:\\Windows\\notepad.exe" supervise')).toBeUndefined();
    expect(parseHudCommandLine('"C:\\supervise\\notepad.exe" file')).toBeUndefined();
    expect(parseHudCommandLine('')).toBeUndefined();
    expect(parseHudCommandLine('rh-hud.exe')).toBeUndefined();
  });
});
