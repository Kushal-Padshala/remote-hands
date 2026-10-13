import { describe, expect, it } from 'vitest';
import { AGY_WINDOWS_INSTALL, agyRunOptions, agyShellCommand, locateAgy } from './agy.js';

const runner = (result: { exitCode: number; stdout: string; stderr?: string }) => async () => ({ stderr: '', ...result });

describe('locateAgy', () => {
  it('asks which on Mac and Linux', async () => {
    expect(await locateAgy(runner({ exitCode: 0, stdout: '/usr/local/bin/agy\n' }), 'darwin')).toBe('/usr/local/bin/agy');
    expect(await locateAgy(runner({ exitCode: 1, stdout: '' }), 'linux')).toBeUndefined();
    expect(await locateAgy(runner({ exitCode: 0, stdout: '   ' }), 'darwin')).toBeUndefined();
  });

  it('looks in the places Windows keeps programs, never running which', async () => {
    let asked = false;
    const spy = async () => {
      asked = true;
      return { exitCode: 0, stdout: 'x', stderr: '' };
    };
    expect(await locateAgy(spy, 'win32', () => 'C:\\Users\\Ana Lee\\AppData\\Local\\agy\\bin\\agy.exe')).toBe('C:\\Users\\Ana Lee\\AppData\\Local\\agy\\bin\\agy.exe');
    expect(await locateAgy(spy, 'win32', () => undefined)).toBeUndefined();
    expect(asked).toBe(false);
  });
});

describe('agyShellCommand and agyRunOptions', () => {
  it('are the plain name and no options except on Windows, where agy is run by its full path, directly, without a shell', () => {
    expect(agyShellCommand('/usr/local/bin/agy', 'darwin')).toBe('agy');
    expect(agyRunOptions('/usr/local/bin/agy', 'darwin')).toBeUndefined();
    expect(agyShellCommand(undefined, 'win32')).toBe('agy');
    expect(agyRunOptions(undefined, 'win32')).toBeUndefined();
    for (const weird of ['C:\\agy\\agy.exe', 'C:\\Users\\Ana Lee\\agy.exe', 'C:\\Users\\Ana&Lee\\agy.exe', 'C:\\Users\\Ana%USERNAME%\\agy.exe', 'C:\\Users\\Ana!\\agy.exe']) {
      expect(agyShellCommand(weird, 'win32')).toBe(weird);
      expect(agyRunOptions(weird, 'win32')).toEqual({ shell: false });
    }
  });
});

describe('the Windows install command', () => {
  it('keeps the whole script in one quoted argument, so the shell does not cut it at the pipe', () => {
    expect(AGY_WINDOWS_INSTALL.command).toBe('powershell');
    const script = AGY_WINDOWS_INSTALL.args.at(-1)!;
    expect(script.startsWith('"') && script.endsWith('"')).toBe(true);
    expect(script).toContain('irm https://antigravity.google/cli/install.ps1 | iex');
    expect(AGY_WINDOWS_INSTALL.args.slice(0, 4)).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command']);
  });
});
