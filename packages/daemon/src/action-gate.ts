import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Called with a control's label right before it is pressed. Resolves to let the action
 * run, rejects (with the user's reason) to stop it. The CLI builds the real one on top of
 * `rh approve`; without a gate every action runs, as before.
 */
export type ActionGate = (label: string, opts?: { goal?: boolean }) => Promise<void>;

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
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ taskId, pid: process.pid }), { mode: 0o600 });
  } catch {}
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
    if (typeof current?.taskId !== 'string' || !current.taskId) return null;
    if (typeof current.pid === 'number' && !pidAlive(current.pid)) return null;
    return current.taskId;
  } catch {
    return null;
  }
}
