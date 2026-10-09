import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ActionKind } from '@remote-hands/shared';

/**
 * Called with a control's label right before it is pressed. Resolves to let the action
 * run, rejects (with the user's reason) to stop it. The CLI builds the real one on top of
 * `rh approve`; without a gate every action runs, as before. `kind` skips label
 * classification for actions already known to be risky (send/delete shortcuts, raw scripts).
 */
export type ActionGate = (label: string, opts?: { goal?: boolean; kind?: ActionKind }) => Promise<void>;

/**
 * The warm agy process and the MCP server it starts are spawned once, so the running task
 * id cannot reach them through the environment. The runner records it here instead.
 */
export function defaultActiveTaskFile(home: string = os.homedir()): string {
  return path.join(home, '.remote-hands', 'active-task.json');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

export function writeActiveTask(taskId: string, file?: string): void {
  // Tests that did not inject a file must never touch the real marker.
  if (file === undefined && process.env.VITEST === 'true') return;
  const target = file ?? defaultActiveTaskFile();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Readers must never see a partially written task or permissive permissions on an old file.
    fs.writeFileSync(temporary, JSON.stringify({ taskId, pid: process.pid }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch (cause) {
    throw new Error('Cannot record the active task; approval enforcement is unavailable.', { cause });
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

export function clearActiveTask(taskId: string, file?: string): void {
  if (file === undefined && process.env.VITEST === 'true') return;
  const target = file ?? defaultActiveTaskFile();
  try {
    const current = JSON.parse(fs.readFileSync(target, 'utf-8'));
    if (current?.taskId === taskId) fs.unlinkSync(target);
  } catch {}
}

/** The task the daemon is running right now, or null (none, or the daemon that wrote it died). */
export function readActiveTask(file?: string): string | null {
  if (file === undefined && process.env.VITEST === 'true') return null;
  try {
    const current = JSON.parse(fs.readFileSync(file ?? defaultActiveTaskFile(), 'utf-8'));
    if (typeof current?.taskId !== 'string' || !current.taskId.trim() || !Number.isSafeInteger(current.pid) || current.pid <= 0) {
      throw new Error('Invalid active task marker');
    }
    if (!pidAlive(current.pid)) return null;
    return current.taskId;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new Error('Cannot read the active task; approval enforcement is unavailable.', { cause });
  }
}
