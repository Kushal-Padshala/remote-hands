import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Remote Hands builds two small helpers on the person's Mac (the shortcut listener and the "Remote Hands" app that holds
 * the Accessibility permission). Apple's compiler comes with the free "Command Line Tools", which a new Mac does not have.
 * Without this check the person meets a macOS pop-up in the middle of the permissions step, or a build error at the end.
 */
export interface XcodeToolsDeps {
  /** Runs a program and returns its exit status and output. */
  run?: ((command: string, args: string[]) => { status: number | null; stdout: string }) | undefined;
  exists?: ((file: string) => boolean) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  stdout?: ((message: string) => void) | undefined;
  /** How long to wait for the person to finish the macOS installer. */
  timeoutMs?: number | undefined;
  intervalMs?: number | undefined;
  platform?: NodeJS.Platform | undefined;
}

const realRun = (command: string, args: string[]): { status: number | null; stdout: string } => {
  const res = spawnSync(command, args, { encoding: 'utf-8', timeout: 20_000 });
  return { status: res.status, stdout: res.stdout || '' };
};

/** True when a Swift compiler exists in the active developer directory (Command Line Tools or Xcode). */
export function hasCommandLineTools(deps: XcodeToolsDeps = {}): boolean {
  if ((deps.platform ?? process.platform) !== 'darwin') return true;
  const run = deps.run ?? realRun;
  const exists = deps.exists ?? fs.existsSync;
  try {
    const res = run('xcode-select', ['-p']);
    const dir = res.stdout.trim();
    return res.status === 0 && dir !== '' && exists(path.join(dir, 'usr', 'bin', 'swiftc'));
  } catch {
    return false;
  }
}

export interface CommandLineToolsHandle {
  /** Resolves true when the tools are there; false when the person did not finish the install in time. */
  wait(): Promise<boolean>;
}

/**
 * Starts the install when the tools are missing (macOS shows its own Install window) and returns at once, so the rest of
 * setup can carry on while Apple's download runs. `wait()` is called where the compiler is first needed.
 */
export function beginCommandLineTools(deps: XcodeToolsDeps = {}): CommandLineToolsHandle {
  const out = deps.stdout ?? (() => {});
  if (hasCommandLineTools(deps)) return { wait: async () => true };

  const run = deps.run ?? realRun;
  out('Apple\'s free "Command Line Tools" are needed to build two small helpers. This Mac does not have them yet.');
  out('A macOS window is about to ask you to install them: click Install and accept the terms.');
  out('The download is about 1 to 3 GB and usually takes 5 to 15 minutes. Setup carries on meanwhile and waits for it where it must.');
  try {
    run('xcode-select', ['--install']);
  } catch {
    // the window may already be open from an earlier try; waiting below still works
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? 30 * 60_000;
  const intervalMs = deps.intervalMs ?? 5_000;
  return {
    async wait(): Promise<boolean> {
      if (hasCommandLineTools(deps)) return true;
      out('Waiting for the Command Line Tools install to finish (finish the macOS window if it is still open)...');
      for (let waited = 0; waited < timeoutMs; waited += intervalMs) {
        await sleep(intervalMs);
        if (hasCommandLineTools(deps)) {
          out('Command Line Tools installed.');
          return true;
        }
      }
      return false;
    },
  };
}
