import { findAgyOnWindows } from '@remote-hands/daemon';
import type { CommandRunner } from '../cloudflare/wrangler.js';

/**
 * Finding the Antigravity command line program (`agy`). On Mac and Linux the shell's `which` answers. Windows has no
 * `which`, and a terminal that was open during the install does not see the new PATH yet, so its own install folder is
 * looked at too.
 */
export async function locateAgy(
  runner: CommandRunner,
  platform: NodeJS.Platform = process.platform,
  findOnWindows: () => string | undefined = findAgyOnWindows,
): Promise<string | undefined> {
  if (platform === 'win32') return findOnWindows();
  const res = await runner('which', ['agy']);
  const found = res.exitCode === 0 ? res.stdout.trim() : '';
  return found.length > 0 ? found : undefined;
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
