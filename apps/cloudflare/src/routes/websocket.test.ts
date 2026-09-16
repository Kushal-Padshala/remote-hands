import { describe, expect, it } from 'vitest';
import worker from '../worker.js';
import { hashSessionToken, createSessionToken } from '../auth/session.js';
import { TasksRepository } from '../d1/tasks-repository.js';
import type { Env, D1Database, D1PreparedStatement } from '../env.js';


function createMockD1(): D1Database {
  const tables = {
    machines: [] as any[],
    tasks: [] as any[],
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
          return { success: true, results: tables.sessions.filter((s) => s.token_hash === bound[0]) as T[] };
        }
        if (q.startsWith('INSERT INTO tasks')) {
          tables.tasks.push({
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

          return { success: true, results: tables.tasks.filter((t) => t.id === bound[0]) as T[] };
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

describe('websocket upgrade routing', () => {
  it('validates session and dispatches to durable object', async () => {
    const db = createMockD1();
    let stubCalledWith = '';

    const fakeTaskRoomNamespace = {
      idFromName(name: string) {
        return { toString: () => name, equals: () => false };
      },
      idFromString(id: string) {
        return { toString: () => id, equals: () => false };
      },
      newUniqueId() {
        return { toString: () => 'uid', equals: () => false };
      },
      get(idObj: any) {
        return {
          async fetch(req: Request) {
            stubCalledWith = idObj.toString();
            return { status: 101, headers: new Headers() } as unknown as Response;
          },
        };
      },
    };

    const env: Env = {
      DB: db,
      TASK_ROOM: fakeTaskRoomNamespace as any,
      OWNER_SECRET_HASH: 'hash123',
    };

    const token = createSessionToken();
    const tokenHash = await hashSessionToken(token);
    const ownerId = '11111111-1111-4111-8111-111111111111';

    await db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      'sess-1',
      ownerId,
      null,
      'phone',
      tokenHash,
      new Date(Date.now() + 86400000).toISOString(),
      new Date().toISOString(),
    ).run();

    const tasksRepo = new TasksRepository(db);
    await tasksRepo.create({
      id: 'task-123',
      owner_id: ownerId,
      machine_id: 'machine-1',
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
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
    });

    const unauthedRes = await worker.fetch(new Request('https://example.com/ws/tasks/task-123'), env);
    expect(unauthedRes.status).toBe(401);

    const authedRes = await worker.fetch(
      new Request('https://example.com/ws/tasks/task-123', {
        headers: {
          Authorization: `Bearer ${token}`,
          Upgrade: 'websocket',
        },
      }),
      env,
    );
    expect(authedRes.status).toBe(101);

    expect(stubCalledWith).toBe('task:task-123');
  });
});
