import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findAgyOnWindows } from '@remote-hands/daemon';
import type { CommandRunner } from '../cloudflare/wrangler.js';

/**
 * Mac/Linux: the folders agy's installer and package managers put it in. A new Mac's login shell does not have
 * ~/.local/bin on its PATH until the installer's change reaches a new window, so `which` alone misses a fresh install.
 */
export function findAgyInKnownFolders(
  home: string = os.homedir(),
  isExecutable: (file: string) => boolean = (file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
): string | undefined {
  for (const dir of [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']) {
    const candidate = path.join(dir, 'agy');
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** Makes the folder of a program found by full path part of this process's PATH, so running it by name works (and what it starts inherits it). */
export function putOnPath(program: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!program.includes('/')) return;
  const dir = path.dirname(program);
  const parts = (env.PATH ?? '').split(':').filter(Boolean);
  if (!parts.includes(dir)) env.PATH = [dir, ...parts].join(':');
}

/**
 * Finding the Antigravity command line program (`agy`). On Mac and Linux the shell's `which` answers. Windows has no
 * `which`, and a terminal that was open during the install does not see the new PATH yet, so its own install folder is
 * looked at too.
 */
export async function locateAgy(
  runner: CommandRunner,
  platform: NodeJS.Platform = process.platform,
  findOnWindows: () => string | undefined = findAgyOnWindows,
  findInKnownFolders: () => string | undefined = findAgyInKnownFolders,
): Promise<string | undefined> {
  if (platform === 'win32') return findOnWindows();
  const res = await runner('which', ['agy']);
  const found = res.exitCode === 0 ? res.stdout.trim() : '';
  return found.length > 0 ? found : findInKnownFolders();
}

/** What to run for `agy`: the plain name, or on Windows its full path. */
export function agyShellCommand(located: string | undefined, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && located ? located : 'agy';
}

/**
 * Extra runner options for agy: on Windows the program is started directly (no shell), so a folder name with &, %, !
 * or spaces reaches it exactly as it is. Nothing on other systems: their calls are exactly as before.
 */
export function agyRunOptions(located: string | undefined, platform: NodeJS.Platform = process.platform): { shell: false } | undefined {
  return platform === 'win32' && located ? { shell: false } : undefined;
}

/** The Windows install: Google's own script, run the way it documents (quoted, so the shell does not split it at the pipe). */
export const AGY_WINDOWS_INSTALL: { command: string; args: string[]; manual: string } = {
  command: 'powershell',
  args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '"irm https://antigravity.google/cli/install.ps1 | iex"'],
  manual: 'irm https://antigravity.google/cli/install.ps1 | iex',
};
