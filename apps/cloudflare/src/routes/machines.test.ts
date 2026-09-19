import { describe, expect, it, vi } from 'vitest';
import { handleMachineHeartbeat } from './machines.js';
import type { Env } from '../env.js';

describe('handleMachineHeartbeat throttling', () => {
  it('skips D1 update when machine is already online and last_seen_at is less than 60s old', async () => {
    const recentIso = new Date(Date.now() - 15000).toISOString();
    const fakeMachine = {
      id: '11111111-1111-4111-8111-111111111111',
      owner_id: '22222222-2222-4222-8222-222222222222',
      name: 'MacBook',
      hostname: 'macbook.local',
      daemon_version: '0.1.0',
      agy_version: '0.2.0',
      status: 'online',
      last_seen_at: recentIso,
      created_at: recentIso,
    };

    const updateSpy = vi.fn().mockResolvedValue(undefined);
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(fakeMachine),
          run: updateSpy,
        }),
      }),
    };

    const fakeSession = {
      id: 'sess-1',
      owner_id: fakeMachine.owner_id,
      kind: 'daemon',
      machine_id: fakeMachine.id,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      created_at: recentIso,
    };

    const req = new Request('https://api/machines/11111111-1111-4111-8111-111111111111/heartbeat', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });

    const env: Env = {
      DB: mockDb as any,
      TASK_ROOM: {} as any,
      CONTROL_PLANE_SECRET: 'test',
    };

    vi.spyOn(await import('../auth/session.js'), 'requireSession').mockResolvedValue(fakeSession as any);

    const res = await handleMachineHeartbeat(fakeMachine.id, req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.machine.id).toBe(fakeMachine.id);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('updates D1 when last_seen_at is older than 60s', async () => {
    const staleIso = new Date(Date.now() - 75000).toISOString();
    const fakeMachine = {
      id: '11111111-1111-4111-8111-111111111111',
      owner_id: '22222222-2222-4222-8222-222222222222',
      name: 'MacBook',
      hostname: 'macbook.local',
      daemon_version: '0.1.0',
      agy_version: '0.2.0',
      status: 'online',
      last_seen_at: staleIso,
      created_at: staleIso,
    };

    const updateSpy = vi.fn().mockResolvedValue(undefined);
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(fakeMachine),
          run: updateSpy,
        }),
      }),
    };

    const fakeSession = {
      id: 'sess-1',
      owner_id: fakeMachine.owner_id,
      kind: 'daemon',
      machine_id: fakeMachine.id,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      created_at: staleIso,
    };

    const req = new Request('https://api/machines/11111111-1111-4111-8111-111111111111/heartbeat', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });

    const env: Env = {
      DB: mockDb as any,
      TASK_ROOM: {} as any,
      CONTROL_PLANE_SECRET: 'test',
    };

    vi.spyOn(await import('../auth/session.js'), 'requireSession').mockResolvedValue(fakeSession as any);

    const res = await handleMachineHeartbeat(fakeMachine.id, req, env);
    expect(res.status).toBe(200);
    expect(updateSpy).toHaveBeenCalled();
  });
});
