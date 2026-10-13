import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Small, injectable helpers for the places where Windows differs: finding a program, and ending a program together with
 * everything it started. Each takes its surroundings as arguments so it can be tested on any computer.
 */

export interface WindowsLookup {
  platform?: NodeJS.Platform | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  exists?: ((file: string) => boolean) | undefined;
  homedir?: string | undefined;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** The first place on PATH (honouring PATHEXT) that holds `name`; undefined off Windows or when it is not there. */
export function findOnWindowsPath(name: string, lookup: WindowsLookup = {}, opts: { nativeOnly?: boolean } = {}): string | undefined {
  const platform = lookup.platform ?? process.platform;
  if (platform !== 'win32') return undefined;
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? ((file: string) => fs.existsSync(file));
  const rawPath = env.Path ?? env.PATH ?? '';
  // Node cannot start a .cmd or .bat without a shell, so a caller that starts programs itself asks for real programs only.
  const exts = opts.nativeOnly ? ['.exe', '.com'] : (env.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter(Boolean).map((e) => e.toLowerCase());
  const hasExt = exts.some((e) => name.toLowerCase().endsWith(e));
  for (const dir of rawPath.split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)) {
    const candidates = hasExt ? [name] : exts.map((e) => name + e);
    // an .exe is preferred over a script shim in the same folder
    candidates.sort((a, b) => Number(b.toLowerCase().endsWith('.exe')) - Number(a.toLowerCase().endsWith('.exe')));
    for (const candidate of candidates) {
      const full = path.win32.join(dir, candidate);
      if (exists(full)) return full;
    }
  }
  return undefined;
}

/**
 * Where the Antigravity command line program (`agy`) is on Windows: on PATH, else in the folder its installer uses
 * (a terminal that was open during the install does not see the new PATH yet). Undefined elsewhere.
 */
export function findAgyOnWindows(lookup: WindowsLookup = {}): string | undefined {
  const platform = lookup.platform ?? process.platform;
  if (platform !== 'win32') return undefined;
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? ((file: string) => fs.existsSync(file));
  const onPath = findOnWindowsPath('agy', lookup, { nativeOnly: true });
  if (onPath) return onPath;
  const home = lookup.homedir ?? os.homedir();
  const localAppData = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
  const installed = path.win32.join(localAppData, 'agy', 'bin', 'agy.exe');
  return exists(installed) ? installed : undefined;
}

/** What to run for `agy`: its full path on Windows when it can be found, else the plain name (Mac, Linux, not installed). */
export function agyCommand(lookup: WindowsLookup = {}): string {
  return findAgyOnWindows(lookup) ?? 'agy';
}

/** A command as one string for a shell, quoted when it has spaces (only for callers that must use a shell). */
export function shellQuote(command: string): string {
  return /\s/.test(command) && !/^".*"$/.test(command) ? `"${command}"` : command;
}

/**
 * What to tell the person when the agent program could not be started. On Windows the usual causes (not installed, only a
 * script shim on PATH, blocked) all have the same remedy; elsewhere the system's own message is kept.
 */
export function describeSpawnError(err: unknown, command: string, platform: NodeJS.Platform = process.platform): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (platform === 'win32' && (code === 'ENOENT' || code === 'EINVAL' || code === 'EACCES' || code === 'EPERM')) {
    return `Remote Hands could not start the agent program (${command}). Run "rh setup" to install or repair it.`;
  }
  return message;
}

export interface KillTreeDeps {
  platform?: NodeJS.Platform | undefined;
  run?: ((command: string, args: string[]) => { status: number | null }) | undefined;
}

/**
 * Ends a process and everything it started. Windows has no process groups: `taskkill /T` walks the tree. Returns false
 * when it could not be done that way (the caller then ends just the process).
 */
export function killWindowsProcessTree(pid: number | undefined, deps: KillTreeDeps = {}): boolean {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32' || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 4) return false;
  // never this program or the one that started it
  if (pid === process.pid || pid === process.ppid) return false;
  const run = deps.run ?? ((command: string, args: string[]) => spawnSync(command, args, { windowsHide: true, stdio: 'ignore' }));
  try {
    return run('taskkill', ['/pid', String(pid), '/T', '/F']).status === 0;
  } catch {
    return false;
  }
}

/** One argument for a Windows command line: quoted when it has spaces or shell characters, never when it is plain. */
export function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^()%!]/.test(arg)) return arg;
  // a quote inside cannot be written safely for cmd.exe: the arguments Remote Hands passes never contain one
  return `"${arg.replace(/"/g, '')}"`;
}

/**
 * How to start a program so that it is NOT a child of this process. `cmd /c start` hands the program to Windows and
 * exits at once, so the program's parent is gone: ending this process's tree (as `taskkill /T` does for the agent) does
 * not end it. Used for the browser window, which must outlive a cancelled task.
 */
export function detachedWindowsLaunch(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  const parts = [quoteWindowsArg(command), ...args.map(quoteWindowsArg)].join(' ');
  // start's first quoted argument is the window title: an empty one keeps a quoted program path from being taken as it
  // the whole command is wrapped in quotes, which /s strips again, so the quotes inside survive
  return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"start "" ${parts}"`] };
}
