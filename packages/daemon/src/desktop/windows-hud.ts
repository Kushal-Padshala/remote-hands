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
  /** Moves a file; tests make it fail. */
  rename?: ((from: string, to: string) => void) | undefined;
}

export type WindowsHudBuild = { ok: true; path: string } | { ok: false; error: string };

export function windowsHudPaths(home: string = os.homedir()): { dir: string; exe: string; stamp: string } {
  // the paths of the computer this runs on (on Windows these are Windows paths)
  const root = path.join(home, '.remote-hands');
  return {
    dir: path.join(root, 'windows-hud'),
    exe: path.join(root, 'bin', 'rh-hud.exe'),
    stamp: path.join(root, 'windows-hud', 'built.sha256'),
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
      const file = path.join(dir, name);
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
    const rename = deps.rename ?? ((from: string, to: string) => fs.renameSync(from, to));
    const old = `${exe}.old`;
    try {
      fs.rmSync(old, { force: true });
    } catch {
      // a still-running older copy from an earlier update: the rename below replaces what it can
    }
    let movedAside = false;
    if (exists(exe)) {
      try {
        rename(exe, old);
        movedAside = true;
      } catch {
        fs.rmSync(next, { force: true });
        return { ok: false, error: 'the HUD program is in use and could not be replaced. Close it ("rh hud uninstall") and run "rh setup" again.' };
      }
    }
    try {
      rename(next, exe);
    } catch (err) {
      // the program that worked before must still be there: the login entry points at it
      if (movedAside) {
        try {
          rename(old, exe);
        } catch {
          // nothing more can be done here
        }
      }
      try {
        fs.rmSync(next, { force: true });
      } catch {
        // left behind: removed at the next build
      }
      return { ok: false, error: describeBuildFailure('', err instanceof Error ? err : new Error(String(err))) };
    }
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

const remoteHandsDir = (home: string): string => path.join(home, '.remote-hands');

/**
 * The program and its role (the first argument: `supervise`, `listen` or `prompt`) from a process's command line, so a
 * process is taken for the service by what it is running, not by words that happen to appear in a folder name.
 */
export function parseHudCommandLine(line: string): { program: string; role: string } | undefined {
  const m = /^\s*(?:"([^"]+)"|(\S+))\s+(\S+)/.exec(line);
  if (!m) return undefined;
  const program = (m[1] ?? m[2] ?? '').replace(/\//g, '\\');
  return /rh-hud\.exe$/i.test(program) ? { program, role: m[3]!.replace(/^"|"$/g, '').toLowerCase() } : undefined;
}

/** What the hotkey listener last said: it holds the keys, or no key was free. */
export interface HudStatus {
  state: 'ready' | 'failed';
  keys?: string | undefined;
  at: number;
}

export function hudStatusPath(home: string = os.homedir()): string {
  return path.join(remoteHandsDir(home), 'hud-status.json');
}

export function saveHudStatus(status: { state: 'ready' | 'failed'; keys?: string | undefined }, home: string = os.homedir(), now: number = Date.now()): void {
  if (status.state === 'ready' && !(typeof status.keys === 'string' && /^[A-Za-z+]{3,40}$/.test(status.keys))) return;
  try {
    fs.mkdirSync(remoteHandsDir(home), { recursive: true });
    fs.writeFileSync(hudStatusPath(home), JSON.stringify({ state: status.state, ...(status.keys ? { keys: status.keys } : {}), at: now }), 'utf-8');
  } catch {
    // the label falls back to the default
  }
}

export function readHudStatus(home: string = os.homedir()): HudStatus | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(hudStatusPath(home), 'utf-8')) as { state?: unknown; keys?: unknown; at?: unknown };
    if (parsed.state !== 'ready' && parsed.state !== 'failed') return undefined;
    const keys = typeof parsed.keys === 'string' && /^[A-Za-z+]{3,40}$/.test(parsed.keys) ? parsed.keys : undefined;
    if (parsed.state === 'ready' && !keys) return undefined;
    return { state: parsed.state, ...(keys ? { keys } : {}), at: typeof parsed.at === 'number' ? parsed.at : 0 };
  } catch {
    return undefined;
  }
}

/** Forgets a "ready" (the listener that said it has ended) but keeps a "failed", which stays true until a listener says otherwise. */
export function clearHudReadyStatus(home: string = os.homedir()): void {
  if (readHudStatus(home)?.state === 'ready') clearHudStatus(home);
}

export function clearHudStatus(home: string = os.homedir()): void {
  try {
    fs.rmSync(hudStatusPath(home), { force: true });
  } catch {
    // nothing to clear
  }
}

/** The keys that open the HUD, as the person should read them. */
export function hudHotkeyLabel(platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  if (platform === 'darwin') return 'Shift + Cmd + Space';
  const keys = readHudStatus(home)?.keys;
  return keys ? keys.replace(/\+/g, ' + ') : 'Ctrl + Shift + Space';
}

/** Where the supervisor reads which Node and which CLI to run (kept out of the login entry, which has a short limit). */
export function hudSettingsPath(home: string = os.homedir()): string {
  return path.join(remoteHandsDir(home), 'hud.json');
}

export function writeHudSettings(settings: { node: string; cli: string }, home: string = os.homedir()): void {
  fs.mkdirSync(remoteHandsDir(home), { recursive: true });
  fs.writeFileSync(hudSettingsPath(home), JSON.stringify({ node: settings.node, cli: settings.cli }), 'utf-8');
}

/** The supervisor writes its process id here when it starts. */
export function hudSupervisorPidPath(home: string = os.homedir()): string {
  return path.join(remoteHandsDir(home), 'hud-supervisor.pid');
}

export function readHudSupervisorPid(home: string = os.homedir()): number | undefined {
  try {
    const text = fs.readFileSync(hudSupervisorPidPath(home), 'utf-8').trim();
    const pid = /^\d{1,10}$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
    return Number.isInteger(pid) && pid > 4 ? pid : undefined;
  } catch {
    return undefined;
  }
}
