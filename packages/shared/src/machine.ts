export const MACHINE_STATUSES = ['online', 'offline'] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

export interface Machine {
  id: string;
  user_id: string;
  name: string;
  hostname: string;
  agy_version: string | null;
  daemon_version: string | null;
  status: MachineStatus;
  last_seen_at: string | null;
  created_at: string;
}

/** A machine is considered offline once it misses this many milliseconds of heartbeats. */
export const MACHINE_OFFLINE_AFTER_MS = 45_000;

export function isMachineOnline(machine: Machine, now: Date = new Date()): boolean {
  if (machine.last_seen_at === null) return false;
  return now.getTime() - Date.parse(machine.last_seen_at) < MACHINE_OFFLINE_AFTER_MS;
}
