import { describe, expect, it } from 'vitest';
import { MachinesRepository } from './machines-repository.js';
import { TasksRepository } from './tasks-repository.js';
import { EventsRepository } from './events-repository.js';
import { ApprovalsRepository } from './approvals-repository.js';
import { PairingRepository } from './pairing-repository.js';
import { SessionsRepository } from './sessions-repository.js';
import type { D1Database, D1PreparedStatement } from '../env.js';

function createMockD1Database(): D1Database {
  const tables = new Map<string, any[]>();
  tables.set('machines', []);
  tables.set('tasks', []);
  tables.set('events', []);
  tables.set('approvals', []);
  tables.set('pairing_tokens', []);
  tables.set('sessions', []);

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
        if (q.startsWith('INSERT INTO machines')) {
          const list = tables.get('machines')!;
          const existing = list.findIndex((m) => m.id === bound[0]);
          const row = {
            id: bound[0],
            owner_id: bound[1],
            name: bound[2],
            hostname: bound[3],
            daemon_version: bound[4],
            agy_version: bound[5],
            status: bound[6],
            last_seen_at: bound[7],
            created_at: bound[8],
          };
          if (existing >= 0) list[existing] = row;
          else list.push(row);
          return { success: true, results: [] as T[] };
        }
        if (q.startsWith('SELECT * FROM machines WHERE owner_id = ?')) {
          const list = tables.get('machines')!.filter((m) => m.owner_id === bound[0]);
          return { success: true, results: list as T[] };
        }
        if (q.startsWith('SELECT * FROM machines WHERE id = ?')) {
          const list = tables.get('machines')!.filter((m) => m.id === bound[0]);
          return { success: true, results: list as T[] };
        }
        if (q.startsWith('UPDATE machines SET last_seen_at')) {
          const list = tables.get('machines')!;
          const match = list.find((m) => m.id === bound[1]);
          if (match) {
            match.last_seen_at = bound[0];
            match.status = 'online';
          }
          return { success: true, results: [] as T[] };
        }
        if (q.startsWith('INSERT INTO tasks')) {
          const list = tables.get('tasks')!;
          list.push({
            id: bound[0],
            owner_id: bound[1],
            machine_id: bound[2],
            prompt: bound[3],
            kind: bound[4],
            workspace_path: bound[5],
            model: bound[6],
            effort: bound[7],
            mode: bound[8],
            status: bound[9],
            conversation_id: bound[10],
            parent_task_id: bound[11],
            result_summary: bound[12],
            error: bound[13],
            created_at: bound[14],
            started_at: bound[15],
            finished_at: bound[16],
          });
          return { success: true, results: [] as T[] };
        }
        if (q.startsWith('SELECT * FROM tasks WHERE id = ?')) {
          const list = tables.get('tasks')!.filter((t) => t.id === bound[0]);
          return { success: true, results: list as T[] };
        }
        if (q.startsWith('INSERT INTO events')) {
          const list = tables.get('events')!;
          list.push({
            id: list.length + 1,
            task_id: bound[0],
            owner_id: bound[1],
            seq: bound[2],
            kind: bound[3],
            payload: bound[4],
            created_at: bound[5],
          });
          return { success: true, results: [] as T[] };
        }
        if (q.startsWith('SELECT * FROM events WHERE task_id = ?')) {
          const list = tables.get('events')!.filter((e) => e.task_id === bound[0]);
          return { success: true, results: list as T[] };
        }
        if (q.startsWith('INSERT INTO approvals')) {
          const list = tables.get('approvals')!;
          list.push({
            id: bound[0],
            task_id: bound[1],
            owner_id: bound[2],
            action_kind: bound[3],
            summary: bound[4],
            risk: bound[5],
            tool_payload: bound[6],
            frame_path: bound[7],
            decision: bound[8],
            decided_at: bound[9],
            expires_at: bound[10],
            created_at: bound[11],
          });
          return { success: true, results: [] as T[] };
        }
        if (q.startsWith('SELECT * FROM approvals WHERE id = ?')) {
          const list = tables.get('approvals')!.filter((a) => a.id === bound[0]);
          return { success: true, results: list as T[] };
        }
        if (q.startsWith('INSERT INTO pairing_tokens')) {
          const list = tables.get('pairing_tokens')!;
          list.push({
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
        if (q.startsWith('SELECT * FROM pairing_tokens WHERE code_hash = ?')) {
          const list = tables.get('pairing_tokens')!.filter((p) => p.code_hash === bound[0]);
          return { success: true, results: list as T[] };
        }
        if (q.startsWith('INSERT INTO sessions')) {
          const list = tables.get('sessions')!;
          list.push({
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
          const list = tables.get('sessions')!.filter((s) => s.token_hash === bound[0]);
          return { success: true, results: list as T[] };
        }
        return { success: true, results: [] as T[] };
      },
    };
  }

  return {
    prepare(query: string) {
      return makeStatement(query);
    },
    async dump() {
      return new ArrayBuffer(0);
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const results: Array<{ success: boolean; results: T[] }> = [];
      for (const stmt of statements) {
        results.push(await stmt.all<T>());
      }
      return results;
    },
    async exec() {
      return { count: 0, duration: 0 };
    },
  };
}

describe('D1 repositories', () => {
  const db = createMockD1Database();

  it('manages machines repository operations', async () => {
    const machines = new MachinesRepository(db);
    const nowIso = new Date().toISOString();
    await machines.upsert({
      id: '11111111-1111-4111-8111-111111111111',
      owner_id: 'owner-1',
      name: 'MacBook',
      hostname: 'macbook.local',
      daemon_version: '0.1.0',
      agy_version: '0.2.0',
      status: 'online',
      last_seen_at: nowIso,
      created_at: nowIso,
    });

    const list = await machines.listByOwner('owner-1');
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('MacBook');
    expect(list[0]?.status).toBe('online');

    const staleIso = new Date(Date.now() - 60_000).toISOString();
    await machines.updateHeartbeat('11111111-1111-4111-8111-111111111111', staleIso);
    const staleGet = await machines.getById('11111111-1111-4111-8111-111111111111');
    expect(staleGet?.status).toBe('offline');
  });

  it('manages tasks and events repository operations', async () => {
    const tasks = new TasksRepository(db);
    const events = new EventsRepository(db);

    await tasks.create({
      id: '22222222-2222-4222-8222-222222222222',
      owner_id: 'owner-1',
      machine_id: '11111111-1111-4111-8111-111111111111',
      prompt: 'Test prompt',
      kind: 'browser',
      workspace_path: null,
      model: null,
      effort: null,
      mode: 'default',
      status: 'queued',
      conversation_id: null,
      parent_task_id: null,
      result_summary: null,
      error: null,
      created_at: '2026-09-16T12:00:00.000Z',
      started_at: null,
      finished_at: null,
    });

    const fetched = await tasks.getById('22222222-2222-4222-8222-222222222222');
    expect(fetched?.prompt).toBe('Test prompt');

    await events.append({
      id: 1,
      task_id: '22222222-2222-4222-8222-222222222222',
      owner_id: 'owner-1',
      seq: 0,
      kind: 'agent_text',
      payload: { text: 'Running' },
      created_at: '2026-09-16T12:00:01.000Z',
    });

    const taskEvents = await events.listForTask('22222222-2222-4222-8222-222222222222');
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0]?.seq).toBe(0);
    expect((taskEvents[0]?.payload as any).text).toBe('Running');
  });

  it('manages approvals, pairing, and sessions', async () => {
    const approvals = new ApprovalsRepository(db);
    const pairing = new PairingRepository(db);
    const sessions = new SessionsRepository(db);

    await approvals.create({
      id: '33333333-3333-4333-8333-333333333333',
      task_id: '22222222-2222-4222-8222-222222222222',
      owner_id: 'owner-1',
      action_kind: 'publish',
      summary: 'Publish policy',
      risk: 'high',
      tool_payload: {},
      frame_path: null,
      decision: 'pending',
      decided_at: null,
      expires_at: '2026-09-16T12:10:00.000Z',
      created_at: '2026-09-16T12:00:00.000Z',
    });
    expect((await approvals.getById('33333333-3333-4333-8333-333333333333'))?.decision).toBe('pending');

    await pairing.create({
      id: 'token-1',
      owner_id: 'owner-1',
      machine_name: 'MacBook',
      code_hash: 'hash654321',
      expires_at: '2026-09-16T12:10:00.000Z',
      claimed_at: null,
      created_at: '2026-09-16T12:00:00.000Z',
    });
    expect((await pairing.getByCodeHash('hash654321'))?.machine_name).toBe('MacBook');

    await sessions.create({
      id: 'session-1',
      owner_id: 'owner-1',
      machine_id: null,
      kind: 'phone',
      token_hash: 'sessionhash123',
      expires_at: '2026-09-17T12:00:00.000Z',
      created_at: '2026-09-16T12:00:00.000Z',
    });
    expect((await sessions.getByTokenHash('sessionhash123'))?.kind).toBe('phone');
  });
});
