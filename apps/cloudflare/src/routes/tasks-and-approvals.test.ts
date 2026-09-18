import { describe, expect, it } from 'vitest';
import worker from '../worker.js';
import { hashSessionToken, createSessionToken } from '../auth/session.js';
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
        if (q.startsWith('SELECT * FROM machines WHERE owner_id = ?')) {
          return { success: true, results: tables.machines.filter((m) => m.owner_id === bound[0]) as T[] };
        }
        if (q.startsWith("SELECT id FROM sessions WHERE kind = 'phone'")) {
          return { success: true, results: tables.sessions.filter((s) => s.kind === 'phone') as T[] };
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
        if (q.startsWith('SELECT * FROM tasks WHERE owner_id = ? AND machine_id = ?')) {
          return { success: true, results: tables.tasks.filter((t) => t.owner_id === bound[0] && t.machine_id === bound[1]) as T[] };
        }
        if (q.startsWith('SELECT * FROM tasks WHERE conversation_id = ?')) {
          return { success: true, results: tables.tasks.filter((t) => t.conversation_id === bound[0]) as T[] };
        }
        if (q.startsWith("SELECT * FROM tasks WHERE machine_id = ? AND owner_id = ? AND status = 'queued'")) {
          return { success: true, results: tables.tasks.filter((t) => t.machine_id === bound[0] && t.owner_id === bound[1] && t.status === 'queued') as T[] };
        }
        if (q.startsWith("SELECT * FROM tasks WHERE machine_id = ? AND status = 'queued'")) {
          return { success: true, results: tables.tasks.filter((t) => t.machine_id === bound[0] && t.status === 'queued') as T[] };
        }
        if (q.startsWith('SELECT * FROM tasks WHERE owner_id = ?')) {
          return { success: true, results: tables.tasks.filter((t) => t.owner_id === bound[0]) as T[] };
        }
        if (q.startsWith('UPDATE tasks SET')) {
          const item = tables.tasks.find((t) => t.id === bound[6]);
          if (item) {
            item.status = bound[0];
            if (bound[1]) item.started_at = bound[1];
            if (bound[2]) item.finished_at = bound[2];
            if (bound[3]) item.result_summary = bound[3];
            if (bound[4]) item.error = bound[4];
            if (bound[5]) item.conversation_id = bound[5];
          }
          return { success: true, results: [] as T[] };
        }
        if (q.startsWith('INSERT INTO events')) {
          tables.events.push({
            id: tables.events.length + 1,
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
          return { success: true, results: tables.events.filter((e) => e.task_id === bound[0]) as T[] };
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
          return { success: true, results: tables.approvals.filter((a) => a.id === bound[0]) as T[] };
        }
        if (q.startsWith('SELECT * FROM approvals WHERE task_id = ?')) {
          return { success: true, results: tables.approvals.filter((a) => a.task_id === bound[0]) as T[] };
        }
        if (q.startsWith('UPDATE approvals SET decision = ?')) {
          const item = tables.approvals.find((a) => a.id === bound[2]);
          if (item) {
            item.decision = bound[0];
            item.decided_at = bound[1];
          }
          return { success: true, results: [] as T[] };
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

describe('tasks and approvals route lifecycle', () => {
  it('handles task creation, events, and approval lifecycle with owner scoping', async () => {
    const db = createMockD1();
    const env: Env = {
      DB: db,
      TASK_ROOM: {} as any,
      OWNER_SECRET_HASH: 'hash123',
    };

    const phoneToken = createSessionToken();
    const phoneTokenHash = await hashSessionToken(phoneToken);
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const machineId = '22222222-2222-4222-8222-222222222222';

    const daemonToken = createSessionToken();
    const daemonTokenHash = await hashSessionToken(daemonToken);

    await db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      'sess-phone',
      ownerId,
      null,
      'phone',
      phoneTokenHash,
      new Date(Date.now() + 86400000).toISOString(),
      new Date().toISOString(),
    ).run();

    await db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      'sess-daemon',
      ownerId,
      machineId,
      'daemon',
      daemonTokenHash,
      new Date(Date.now() + 86400000).toISOString(),
      new Date().toISOString(),
    ).run();

    await db.prepare('INSERT INTO machines VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
      machineId,
      ownerId,
      'Primary Mac',
      'mac.local',
      '0.1.0',
      '0.2.0',
      'online',
      new Date().toISOString(),
      new Date().toISOString(),
    ).run();

    const machinesRes = await worker.fetch(
      new Request('https://example.com/machines', {
        headers: { Authorization: `Bearer ${phoneToken}` },
      }),
      env,
    );
    expect(machinesRes.status).toBe(200);
    const machinesData = (await machinesRes.json()) as any;
    expect(machinesData.machines).toHaveLength(1);

    const createTaskRes = await worker.fetch(
      new Request('https://example.com/tasks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${phoneToken}`,
        },
        body: JSON.stringify({
          machine_id: machineId,
          prompt: 'Publish privacy policy',
          kind: 'browser',
        }),
      }),
      env,
    );
    expect(createTaskRes.status).toBe(201);
    const createdTask = ((await createTaskRes.json()) as any).task;
    const taskId = createdTask.id;

    const claimRes = await worker.fetch(
      new Request(`https://example.com/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${daemonToken}` },
      }),
      env,
    );
    expect(claimRes.status).toBe(200);

    const appendEventRes = await worker.fetch(
      new Request(`https://example.com/tasks/${taskId}/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${daemonToken}`,
        },
        body: JSON.stringify({
          kind: 'agent_text',
          payload: { text: 'Navigating to admin page' },
        }),
      }),
      env,
    );
    expect(appendEventRes.status).toBe(201);

    const approvalRes = await worker.fetch(
      new Request('https://example.com/approvals', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${daemonToken}`,
        },
        body: JSON.stringify({
          task_id: taskId,
          action_kind: 'publish',
          summary: 'Publish privacy policy',
          risk: 'high',
          tool_payload: { url: 'https://example.com/privacy' },
        }),
      }),
      env,
    );
    expect(approvalRes.status).toBe(201);
    const createdApproval = ((await approvalRes.json()) as any).approval;

    const awaitingTaskRes = await worker.fetch(
      new Request(`https://example.com/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${daemonToken}` },
      }),
      env,
    );
    expect(((await awaitingTaskRes.json()) as any).task.status).toBe('awaiting_approval');

    const listApprovalsRes = await worker.fetch(
      new Request(`https://example.com/tasks/${taskId}/approvals`, {
        headers: { Authorization: `Bearer ${daemonToken}` },
      }),
      env,
    );
    expect(listApprovalsRes.status).toBe(200);
    expect(((await listApprovalsRes.json()) as any).approvals.length).toBe(1);

    const decideRes = await worker.fetch(
      new Request(`https://example.com/approvals/${createdApproval.id}/decision`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${phoneToken}`,
        },
        body: JSON.stringify({ decision: 'approved' }),
      }),
      env,
    );
    expect(decideRes.status).toBe(200);
    const decidedData = (await decideRes.json()) as any;
    expect(decidedData.approval.decision).toBe('approved');

    const runningRes = await worker.fetch(
      new Request(`https://example.com/tasks/${taskId}/running`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${daemonToken}` },
      }),
      env,
    );
    expect(runningRes.status).toBe(200);



    const completeRes = await worker.fetch(
      new Request(`https://example.com/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${daemonToken}`,
        },
        body: JSON.stringify({ summary: 'Privacy policy published' }),
      }),
      env,
    );
    expect(completeRes.status).toBe(200);

    const listAllRes = await worker.fetch(
      new Request('https://example.com/tasks', {
        headers: { Authorization: `Bearer ${phoneToken}` },
      }),
      env,
    );
    expect(listAllRes.status).toBe(200);
    const listAllData = (await listAllRes.json()) as any;
    expect(listAllData.tasks).toHaveLength(1);
    expect(listAllData.tasks[0].id).toBe(taskId);

    const listMachineRes = await worker.fetch(
      new Request(`https://example.com/tasks?machine_id=${machineId}`, {
        headers: { Authorization: `Bearer ${phoneToken}` },
      }),
      env,
    );
    expect(listMachineRes.status).toBe(200);
    const listMachineData = (await listMachineRes.json()) as any;
    expect(listMachineData.tasks).toHaveLength(1);

    const listOtherMachineRes = await worker.fetch(
      new Request('https://example.com/tasks?machine_id=other-mac', {
        headers: { Authorization: `Bearer ${phoneToken}` },
      }),
      env,
    );
    expect(listOtherMachineRes.status).toBe(200);
    const listOtherData = (await listOtherMachineRes.json()) as any;
    expect(listOtherData.tasks).toHaveLength(0);

    const unauthorizedCreateRes = await worker.fetch(
      new Request('https://example.com/tasks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${phoneToken}`,
        },
        body: JSON.stringify({
          machine_id: '99999999-9999-4999-8999-999999999999',
          prompt: 'Do bad things',
          kind: 'coding',
        }),
      }),
      env,
    );
    expect(unauthorizedCreateRes.status).toBe(404);

    const daemonPhoneSessionRes = await worker.fetch(
      new Request('https://example.com/pairing/phone-session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${daemonToken}` },
      }),
      env,
    );
    expect(daemonPhoneSessionRes.status).toBe(201);

    const unauthPhoneSessionRes = await worker.fetch(
      new Request('https://example.com/pairing/phone-session', {
        method: 'POST',
      }),
      env,
    );
    expect(unauthPhoneSessionRes.status).toBe(401);

    const reSetupRes = await worker.fetch(
      new Request('https://example.com/setup/owner', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner_secret: 'new-secret' }),
      }),
      env,
    );
    expect(reSetupRes.status).toBe(409);
  });
});
