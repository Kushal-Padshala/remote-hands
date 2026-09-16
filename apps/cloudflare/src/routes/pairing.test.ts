import { describe, expect, it } from 'vitest';
import worker from '../worker.js';
import { hashSessionToken } from '../auth/session.js';
import type { Env, D1Database, D1PreparedStatement } from '../env.js';

function createMockD1(): D1Database {
  const tables = {
    machines: [] as any[],
    tasks: [] as any[],
    events: [] as any[],
    approvals: [] as any[],
    pairing_tokens: [] as any[],
    sessions: [] as any[],
  };

  function makeStatement(query: string, bound: unknown[] = []): D1PreparedStatement {
    return {
      bind(...values: unknown[]) {
        return makeStatement(query, values);
      },
      async first<T = unknown>(colName?: string): Promise<T | null> {
        const res = await this.all<T>();
        if (!res.results || res.results.length === 0) return null;
        const row: any = res.results[0];
        return (colName ? row[colName] : row) as T;
      },
      async run<T = unknown>() {
        const res = await this.all<T>();
        return { success: true, results: res.results };
      },
      async all<T = unknown>() {
        const q = query.trim();
        if (q.startsWith('INSERT INTO sessions')) {
          tables.sessions.push({
            id: bound[0],
            owner_id: bound[1],
            machine_id: bound[2],
            kind: bound[3],
            token_hash: bound[4],
            expires_at: bound[5],
            created_at: bound[6],
          });
          return { success: true, results: [] as T[] };
        }
        if (q.startsWith('SELECT * FROM sessions WHERE token_hash = ?')) {
          const res = tables.sessions.filter((s) => s.token_hash === bound[0]);
          return { success: true, results: res as T[] };
        }
        if (q.startsWith('INSERT INTO pairing_tokens')) {
          tables.pairing_tokens.push({
            id: bound[0],
            owner_id: bound[1],
            machine_name: bound[2],
            code_hash: bound[3],
            expires_at: bound[4],
            claimed_at: bound[5],
            created_at: bound[6],
          });
          return { success: true, results: [] as T[] };
        }
        if (q.startsWith('SELECT * FROM pairing_tokens WHERE claimed_at IS NULL')) {
          return { success: true, results: tables.pairing_tokens.filter((p) => p.claimed_at === null) as T[] };
        }
        if (q.startsWith('UPDATE pairing_tokens SET claimed_at = ? WHERE id = ?')) {
          const item = tables.pairing_tokens.find((p) => p.id === bound[1]);
          if (item) item.claimed_at = bound[0];
          return { success: true, results: [] as T[] };
        }
        if (q.startsWith('INSERT INTO machines')) {
          tables.machines.push({
            id: bound[0],
            owner_id: bound[1],
            name: bound[2],
            hostname: bound[3],
            daemon_version: bound[4],
            agy_version: bound[5],
            status: bound[6],
            last_seen_at: bound[7],
            created_at: bound[8],
          });
          return { success: true, results: [] as T[] };
        }
        if (q.startsWith('SELECT * FROM machines WHERE id = ?')) {
          return { success: true, results: tables.machines.filter((m) => m.id === bound[0]) as T[] };
        }
        return { success: true, results: [] as T[] };
      },
    };
  }

  return {
    prepare: (q: string) => makeStatement(q),
    dump: async () => new ArrayBuffer(0),
    batch: async (stmts: D1PreparedStatement[]) => {
      const out = [];
      for (const s of stmts) out.push(await s.all());
      return out as any;
    },
    exec: async () => ({ count: 0, duration: 0 }),
  };
}

describe('setup and pairing route tests', () => {
  const secret = 'super-secret-owner-key-123';

  it('runs full setup and pairing lifecycle', async () => {
    const db = createMockD1();
    const ownerSecretHash = await hashSessionToken(secret);
    const env: Env = {
      DB: db,
      TASK_ROOM: {} as any,
      OWNER_SECRET_HASH: ownerSecretHash,
    };

    const setupRes = await worker.fetch(
      new Request('https://example.com/setup/owner', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner_secret: secret }),
      }),
      env,
    );

    expect(setupRes.status).toBe(201);
    const setupData = (await setupRes.json()) as any;
    expect(setupData.ok).toBe(true);
    const phoneToken = setupData.session_token;
    expect(phoneToken).toBeDefined();

    const startRes = await worker.fetch(
      new Request('https://example.com/pairing/start', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${phoneToken}`,
        },
        body: JSON.stringify({ machine_name: 'test-macbook' }),
      }),
      env,
    );

    expect(startRes.status).toBe(201);
    const startData = (await startRes.json()) as any;
    expect(startData.pairing_code).toMatch(/^RH-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    const pairingCode = startData.pairing_code;

    const claimRes = await worker.fetch(
      new Request('https://example.com/pairing/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairing_code: pairingCode,
          hostname: 'macbook.local',
          daemon_version: '0.1.0',
        }),
      }),
      env,
    );

    expect(claimRes.status).toBe(201);
    const claimData = (await claimRes.json()) as any;
    expect(claimData.ok).toBe(true);
    expect(claimData.session_token).toBeDefined();

    const claimAgainRes = await worker.fetch(
      new Request('https://example.com/pairing/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pairing_code: pairingCode,
          hostname: 'macbook.local',
        }),
      }),
      env,
    );
    expect(claimAgainRes.status).toBe(404);
  });
});
