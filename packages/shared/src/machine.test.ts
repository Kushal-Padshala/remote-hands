import { describe, expect, it } from 'vitest';
import { isMachineOnline, type Machine } from './machine.js';

function machine(last_seen_at: string | null): Machine {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    user_id: '22222222-2222-4222-8222-222222222222',
    name: 'alice-air',
    hostname: 'alice-air.local',
    agy_version: '1.2.4',
    daemon_version: '0.0.0',
    status: 'offline',
    last_seen_at,
    created_at: '2026-09-16T10:00:00.000Z',
  };
}

describe('isMachineOnline', () => {
  const now = new Date('2026-09-16T10:01:00.000Z');

  it('is online one heartbeat ago', () => {
    expect(isMachineOnline(machine('2026-09-16T10:00:45.000Z'), now)).toBe(true);
  });

  it('is offline after three missed heartbeats', () => {
    expect(isMachineOnline(machine('2026-09-16T10:00:10.000Z'), now)).toBe(false);
  });

  it('is offline when it has never reported', () => {
    expect(isMachineOnline(machine(null), now)).toBe(false);
  });

  it('does not trust the stored status column', () => {
    const stale = { ...machine('2026-09-16T10:00:10.000Z'), status: 'online' as const };
    expect(isMachineOnline(stale, now)).toBe(false);
  });
});
