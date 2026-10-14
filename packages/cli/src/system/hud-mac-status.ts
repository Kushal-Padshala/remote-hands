import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * What the background HUD found about its own permissions when it started. macOS gives Screen Recording to a specific
 * program, and the HUD runs as a login service (its own Node), not as the terminal setup was started from, so only the
 * HUD itself can say whether the permission reaches it.
 */
export interface MacHudStatus {
  /** When it was written (ms since 1970). */
  at: number;
  pid: number;
  /** The Node the HUD runs as: the program that must be switched on in Screen & System Audio Recording. */
  node: string;
  screenRecording: boolean;
  /** Written before the permission check starts, so setup can tell "still checking" from "no". */
  checking?: boolean | undefined;
}

export function macHudStatusPath(home: string = os.homedir()): string {
  return path.join(home, '.remote-hands', 'hud-mac-status.json');
}

export function writeMacHudStatus(status: MacHudStatus, home: string = os.homedir()): void {
  try {
    const file = macHudStatusPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(status), 'utf-8');
  } catch {
    // a missing note must never stop the HUD
  }
}

export function readMacHudStatus(home: string = os.homedir()): MacHudStatus | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(macHudStatusPath(home), 'utf-8'));
    if (typeof parsed?.at === 'number' && typeof parsed?.screenRecording === 'boolean') return parsed as MacHudStatus;
  } catch {
    // none yet
  }
  return null;
}

/** Waits for a status written after `since`; null when the HUD said nothing in time. Waits while it is still checking. */
export async function waitForMacHudStatus(opts: {
  since: number;
  timeoutMs?: number;
  intervalMs?: number;
  read?: () => MacHudStatus | null;
  sleep?: (ms: number) => Promise<void>;
}): Promise<MacHudStatus | null> {
  const read = opts.read ?? (() => readMacHudStatus());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.timeoutMs ?? 40_000;
  const intervalMs = opts.intervalMs ?? 500;
  for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
    const status = read();
    if (status && status.at >= opts.since && !status.checking) return status;
    await sleep(intervalMs);
  }
  return null;
}

/** An hour-long-ish gate so a service that restarts does not open System Settings at every start. */
export function permissionPromptedRecently(home: string = os.homedir(), now: number = Date.now(), windowMs = 24 * 3_600_000): boolean {
  try {
    return now - fs.statSync(path.join(home, '.remote-hands', 'hud-permission-prompted')).mtimeMs < windowMs;
  } catch {
    return false;
  }
}

export function markPermissionPrompted(home: string = os.homedir()): void {
  try {
    const file = path.join(home, '.remote-hands', 'hud-permission-prompted');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(Date.now()), 'utf-8');
  } catch {
    // best effort
  }
}
