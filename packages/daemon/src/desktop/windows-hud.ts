import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WINDOWS_HUD_SOURCES } from './windows-hud-source.generated.js';

/**
 * The Windows HUD (hotkey, prompt window, login supervisor) is a small program written in C# 5. Windows includes the
 * compiler for it (`csc.exe`, part of .NET Framework 4, present on every Windows 10 and 11), so setup builds it on the
 * person's PC: nothing to download or install, and nothing prebuilt that antivirus has to trust.
 */

export interface WindowsHudDeps {
  home?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  exists?: ((file: string) => boolean) | undefined;
  /** Runs the compiler; tests replace it. */
  compile?: ((csc: string, args: string[]) => { status: number | null; stderr: string; stdout: string; error?: Error | undefined }) | undefined;
  sources?: Record<string, string> | undefined;
}

export type WindowsHudBuild = { ok: true; path: string } | { ok: false; error: string };

export function windowsHudPaths(home: string = os.homedir()): { dir: string; exe: string; stamp: string } {
  const root = path.win32.join(home, '.remote-hands');
  return {
    dir: path.win32.join(root, 'windows-hud'),
    exe: path.win32.join(root, 'bin', 'rh-hud.exe'),
    stamp: path.win32.join(root, 'windows-hud', 'built.sha256'),
  };
}

/** The compiler that ships with Windows (64-bit first), or undefined when this is not Windows or it is missing. */
export function findCsc(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): string | undefined {
  const windir = env.WINDIR || env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.win32.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.win32.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((c) => exists(c));
}

export function windowsHudSourceHash(sources: Record<string, string> = WINDOWS_HUD_SOURCES): string {
  const hash = createHash('sha256');
  for (const name of Object.keys(sources).sort()) hash.update(name).update('\0').update(sources[name]!).update('\0');
  return hash.digest('hex');
}

const defaultCompile: NonNullable<WindowsHudDeps['compile']> = (csc, args) => {
  const res = spawnSync(csc, args, { encoding: 'utf-8', windowsHide: true });
  return { status: res.status, stderr: res.stderr || '', stdout: res.stdout || '', error: res.error };
};

/** Plain-language reason for a failed build, with the compiler's first complaint for the person who helps them. */
function describeBuildFailure(output: string, error?: Error): string {
  if (error) return `could not run the Windows compiler (${error.message}).`;
  const first = output.split(/\r?\n/).map((l) => l.trim()).find((l) => /error/i.test(l));
  return `the HUD program could not be built${first ? ` (${first.slice(0, 200)})` : ''}. Security software can block this: allow "csc.exe" for a moment and run "rh setup" again.`;
}

/**
 * Makes sure `rh-hud.exe` exists and matches this version of Remote Hands: writes the C# sources, compiles them when
 * the program is missing or out of date, and swaps it in even if an older copy is running (a running program cannot be
 * overwritten, but it can be renamed).
 */
export function ensureWindowsHud(deps: WindowsHudDeps = {}): WindowsHudBuild {
  const home = deps.home ?? os.homedir();
  const exists = deps.exists ?? ((f: string) => fs.existsSync(f));
  const sources = deps.sources ?? WINDOWS_HUD_SOURCES;
  const { dir, exe, stamp } = windowsHudPaths(home);
  const hash = windowsHudSourceHash(sources);
  try {
    if (exists(exe) && exists(stamp) && fs.readFileSync(stamp, 'utf-8').trim() === hash) return { ok: true, path: exe };
  } catch {
    // unreadable stamp: build again
  }
  const csc = findCsc(deps.env ?? process.env, exists);
  if (!csc) {
    return { ok: false, error: 'the Windows compiler was not found (it is part of .NET Framework 4, which Windows 10 and 11 include). Run Windows Update, then "rh setup" again.' };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    const files: string[] = [];
    for (const name of Object.keys(sources)) {
      const file = path.win32.join(dir, name);
      fs.writeFileSync(file, sources[name]!, 'utf-8');
      files.push(file);
    }
    const next = `${exe}.new`;
    const result = (deps.compile ?? defaultCompile)(csc, [
      '/nologo',
      '/target:winexe',
      '/optimize+',
      `/out:${next}`,
      '/r:System.Windows.Forms.dll',
      '/r:System.Drawing.dll',
      ...files,
    ]);
    if (result.status !== 0 || !exists(next)) {
      try {
        fs.rmSync(next, { force: true });
      } catch {
        // nothing to clean up
      }
      return { ok: false, error: describeBuildFailure(`${result.stdout}\n${result.stderr}`, result.error) };
    }
    // an older copy may be running: move it aside (allowed) instead of overwriting it (not allowed)
    const old = `${exe}.old`;
    try {
      fs.rmSync(old, { force: true });
    } catch {
      // a still-running older copy from an earlier update: the rename below replaces what it can
    }
    if (exists(exe)) {
      try {
        fs.renameSync(exe, old);
      } catch {
        fs.rmSync(next, { force: true });
        return { ok: false, error: 'the HUD program is in use and could not be replaced. Close it ("rh hud uninstall") and run "rh setup" again.' };
      }
    }
    fs.renameSync(next, exe);
    try {
      fs.rmSync(old, { force: true });
    } catch {
      // still running: removed at the next update
    }
    fs.writeFileSync(stamp, hash, 'utf-8');
    return { ok: true, path: exe };
  } catch (err) {
    return { ok: false, error: describeBuildFailure('', err instanceof Error ? err : new Error(String(err))) };
  }
}

/** The keys that open the HUD, as the person should read them. */
export function hudHotkeyLabel(platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  if (platform === 'darwin') return 'Shift + Cmd + Space';
  try {
    const saved = fs.readFileSync(path.join(home, '.remote-hands', 'hud-hotkey.txt'), 'utf-8').trim();
    if (/^[A-Za-z+ ]{3,40}$/.test(saved)) return saved.replace(/\+/g, ' + ').replace(/\s+/g, ' ');
  } catch {
    // not started yet
  }
  return 'Ctrl + Shift + Space';
}

/** Remembers which keys the listener actually got (another program may hold the first choice). */
export function saveHudHotkey(keys: string, home: string = os.homedir()): void {
  if (!/^[A-Za-z+]{3,40}$/.test(keys)) return;
  try {
    fs.mkdirSync(path.join(home, '.remote-hands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.remote-hands', 'hud-hotkey.txt'), keys, 'utf-8');
  } catch {
    // the label falls back to the default
  }
}
