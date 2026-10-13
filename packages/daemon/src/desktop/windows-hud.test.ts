import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WINDOWS_HUD_SOURCES } from './windows-hud-source.generated.js';
import { ensureWindowsHud, findCsc, hudHotkeyLabel, saveHudHotkey, windowsHudPaths, windowsHudSourceHash } from './windows-hud.js';

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

describe('the hotkey label', () => {
  it('is the Mac keys on a Mac, and on Windows what the listener says it got', () => {
    const home = tmp();
    expect(hudHotkeyLabel('darwin', home)).toBe('Shift + Cmd + Space');
    expect(hudHotkeyLabel('win32', home)).toBe('Ctrl + Shift + Space');
    saveHudHotkey('Ctrl+Alt+Space', home);
    expect(hudHotkeyLabel('win32', home)).toBe('Ctrl + Alt + Space');
    saveHudHotkey('$(evil)', home);
    expect(hudHotkeyLabel('win32', home)).toBe('Ctrl + Alt + Space');
  });
});
