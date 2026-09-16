import { describe, expect, it } from 'vitest';
import {
  createSessionToken,
  hashSessionToken,
  authenticateRequest,
} from './session.js';
import { SessionsRepository } from '../d1/sessions-repository.js';
import type { D1Database } from '../env.js';

describe('session authentication middleware', () => {
  it('generates random session tokens and deterministic hashes', async () => {
    const token = createSessionToken();
    expect(token).toHaveLength(64);

    const hash1 = await hashSessionToken(token);
    const hash2 = await hashSessionToken(token);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('rejects requests with missing or malformed Authorization header', async () => {
    const fakeDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database;
    const reqNoAuth = new Request('https://example.com/api/tasks');
    const session1 = await authenticateRequest(reqNoAuth, fakeDb);
    expect(session1).toBeNull();

    const reqBadAuth = new Request('https://example.com/api/tasks', {
      headers: { Authorization: 'Basic user:pass' },
    });
    const session2 = await authenticateRequest(reqBadAuth, fakeDb);
    expect(session2).toBeNull();
  });

  it('authenticates request with valid bearer token', async () => {
    const token = createSessionToken();
    const tokenHash = await hashSessionToken(token);

    const fakeSession = {
      id: 'sess-1',
      owner_id: 'owner-1',
      machine_id: null,
      kind: 'phone' as const,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      created_at: new Date().toISOString(),
    };

    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => fakeSession,
        }),
      }),
    } as unknown as D1Database;

    const req = new Request('https://example.com/api/tasks', {
      headers: { Authorization: `Bearer ${token}` },
    });

    const session = await authenticateRequest(req, fakeDb);
    expect(session).not.toBeNull();
    expect(session?.owner_id).toBe('owner-1');
  });
});
