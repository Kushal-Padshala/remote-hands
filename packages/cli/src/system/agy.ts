import { findAgyOnWindows, shellQuote } from '@remote-hands/daemon';
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

/** What to type for `agy` when running it through a shell: the plain name, or on Windows its full path (quoted if it has spaces). */
export function agyShellCommand(located: string | undefined, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && located ? shellQuote(located) : 'agy';
}

/** The Windows install: Google's own script, run the way it documents (quoted, so the shell does not split it at the pipe). */
export const AGY_WINDOWS_INSTALL: { command: string; args: string[]; manual: string } = {
  command: 'powershell',
  args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '"irm https://antigravity.google/cli/install.ps1 | iex"'],
  manual: 'irm https://antigravity.google/cli/install.ps1 | iex',
};
