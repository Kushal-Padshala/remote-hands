import worker, { TaskRoom } from '../../../apps/cloudflare/src/worker.js';
import type { Env, D1Database, D1PreparedStatement } from '../../../apps/cloudflare/src/env.js';

export function createInMemoryD1(): D1Database {
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

        if (q.startsWith('INSERT INTO machines')) {
          const idx = tables.machines.findIndex((m) => m.id === bound[0]);
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
          if (idx >= 0) tables.machines[idx] = row;
          else tables.machines.push(row);
          return { success: true, results: [] as T[] };
        }

        if (q.startsWith('SELECT * FROM machines WHERE owner_id = ?')) {
          const list = tables.machines.filter((m) => m.owner_id === bound[0]);
          return { success: true, results: list as T[] };
        }

        if (q.startsWith('SELECT * FROM machines WHERE id = ?')) {
          const list = tables.machines.filter((m) => m.id === bound[0]);
          return { success: true, results: list as T[] };
        }

        if (q.startsWith('UPDATE machines SET last_seen_at = ?')) {
          const m = tables.machines.find((x) => x.id === bound[1]);
          if (m) {
            m.last_seen_at = bound[0];
            m.status = 'online';
          }
          return { success: true, results: [] as T[] };
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
          const list = tables.tasks.filter((t) => t.id === bound[0]);
          return { success: true, results: list as T[] };
        }

        if (q.startsWith('SELECT * FROM tasks WHERE owner_id = ?')) {
          const list = tables.tasks.filter((t) => t.owner_id === bound[0]);
          return { success: true, results: list as T[] };
        }

        if (q.startsWith("SELECT * FROM tasks WHERE machine_id = ? AND status = 'queued'")) {
          const list = tables.tasks.filter((t) => t.machine_id === bound[0] && t.status === 'queued');
          return { success: true, results: list as T[] };
        }

        if (q.startsWith('UPDATE tasks SET')) {
          const t = tables.tasks.find((x) => x.id === bound[6]);
          if (t) {
            t.status = bound[0];
            if (bound[1] !== null) t.started_at = bound[1];
            if (bound[2] !== null) t.finished_at = bound[2];
            if (bound[3] !== null) t.result_summary = bound[3];
            if (bound[4] !== null) t.error = bound[4];
            if (bound[5] !== null) t.conversation_id = bound[5];
          }
          return { success: true, results: [] as T[] };
        }

        if (q.startsWith('INSERT INTO events')) {
          const seq = bound[2];
          const newEvent = {
            id: tables.events.length + 1,
            task_id: bound[0],
            owner_id: bound[1],
            seq,
            kind: bound[3],
            payload: bound[4],
            created_at: bound[5],
          };
          tables.events.push(newEvent);
          return { success: true, results: [] as T[] };
        }

        if (q.startsWith('SELECT * FROM events WHERE task_id = ?')) {
          const list = tables.events.filter((e) => e.task_id === bound[0]);
          return { success: true, results: list as T[] };
        }

        if (q.startsWith('SELECT COALESCE(MAX(seq), -1) AS max_seq')) {
          const list = tables.events.filter((e) => e.task_id === bound[0]);
          const maxSeq = list.length === 0 ? -1 : Math.max(...list.map((e) => e.seq));
          return { success: true, results: [{ max_seq: maxSeq }] as T[] };
        }

        if (q.startsWith('INSERT INTO approvals')) {
          tables.approvals.push({
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
          const list = tables.approvals.filter((a) => a.id === bound[0]);
          return { success: true, results: list as T[] };
        }

        if (q.startsWith("SELECT * FROM approvals WHERE task_id = ? AND decision = 'pending'")) {
          const list = tables.approvals.filter((a) => a.task_id === bound[0] && a.decision === 'pending');
          return { success: true, results: list as T[] };
        }

        if (q.startsWith('UPDATE approvals SET decision = ?')) {
          const a = tables.approvals.find((x) => x.id === bound[2]);
          if (a) {
            a.decision = bound[0];
            a.decided_at = bound[1];
          }
          return { success: true, results: [] as T[] };
        }

        if (q.startsWith('INSERT INTO pairing_tokens')) {
          tables.pairing_tokens.push({
            id: bound[0],
            owner_id: bound[1],
            machine_name: bound[2],
            code_hash: bound[3],
            expires_at: bound[4],
            claimed_at: bound[5] ?? null,
            created_at: bound[6],
          });
          return { success: true, results: [] as T[] };
        }

        if (q.startsWith('SELECT * FROM pairing_tokens WHERE claimed_at IS NULL')) {
          const list = tables.pairing_tokens.filter((p) => p.claimed_at === null);
          return { success: true, results: list as T[] };
        }

        if (q.startsWith('SELECT * FROM pairing_tokens WHERE code_hash = ?')) {
          const list = tables.pairing_tokens.filter((p) => p.code_hash === bound[0]);
          return { success: true, results: list as T[] };
        }

        if (q.startsWith('UPDATE pairing_tokens SET claimed_at = ?')) {
          const p = tables.pairing_tokens.find((x) => x.id === bound[1]);
          if (p) p.claimed_at = bound[0];
          return { success: true, results: [] as T[] };
        }

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
          const list = tables.sessions.filter((s) => s.token_hash === bound[0]);
          return { success: true, results: list as T[] };
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

export function createTestCloudflareHarness(options?: { ownerSecretHash?: string }) {
  const db = createInMemoryD1();
  const rooms = new Map<string, TaskRoom>();

  const fakeTaskRoomNamespace = {
    idFromName(name: string) {
      return { toString: () => name };
    },
    idFromString(id: string) {
      return { toString: () => id };
    },
    newUniqueId() {
      return { toString: () => 'uid' };
    },
    get(idObj: any) {
      const idStr = idObj.toString();
      if (!rooms.has(idStr)) {
        rooms.set(idStr, new TaskRoom({} as any, env));
      }
      return {
        async fetch(req: Request) {
          return new Response('ws-upgraded', { status: 200 });
        },
      };
    },
  };

  const env: Env = {
    DB: db,
    TASK_ROOM: fakeTaskRoomNamespace as any,
    OWNER_SECRET_HASH: options?.ownerSecretHash ?? '',
  };

  const dispatchFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let req: Request;
    if (input instanceof Request) {
      req = input;
    } else {
      const urlStr = typeof input === 'string' ? input : input.toString();
      const absoluteUrl = urlStr.startsWith('http') ? urlStr : `https://example.com${urlStr.startsWith('/') ? '' : '/'}${urlStr}`;
      req = new Request(absoluteUrl, init);
    }
    return await worker.fetch(req, env);
  };

  return {
    db,
    env,
    dispatchFetch,
  };
}
