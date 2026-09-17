import { describe, expect, it } from 'vitest';
import worker from './worker.js';
import type { Env } from './env.js';

describe('worker health smoke test', () => {
  const fakeEnv = {
    DB: {} as Env['DB'],
    TASK_ROOM: {} as Env['TASK_ROOM'],
    OWNER_SECRET_HASH: 'hash123',
  };

  it('returns 200 ok for /health', async () => {
    const req = new Request('https://example.com/health');
    const res = await worker.fetch(req, fakeEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 404 for unknown route', async () => {
    const req = new Request('https://example.com/unknown');
    const res = await worker.fetch(req, fakeEnv);
    expect(res.status).toBe(404);
  });

  it('rejects frame push when unauthenticated', async () => {
    const req = new Request('https://example.com/tasks/123/frames', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jpeg_base64: 'abc' }),
    });
    const res = await worker.fetch(req, fakeEnv);
    expect(res.status).toBe(401);
  });
});
