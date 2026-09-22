import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ActionKind,
  ApprovalDecision,
  ApprovalRow,
  EventKind,
  Machine,
  RiskLevel,
  Task,
  TaskEvent,
  TaskKind,
  TaskMode,
  TaskStatus,
} from '@remote-hands/shared';
import type {
  CompleteTaskInput,
  EventInput,
  FailTaskInput,
  RegisterMachineInput,
  TaskStore,
} from './task-store.js';

export interface LocalTaskStoreOptions {
  dbPath: string;
}

export interface CreateTaskInput {
  id?: string | undefined;
  goal?: string | undefined;
  prompt?: string | undefined;
  workspacePath?: string | undefined;
  workspace_path?: string | null | undefined;
  userId?: string | undefined;
  user_id?: string | undefined;
  machineId?: string | undefined;
  machine_id?: string | undefined;
  kind?: TaskKind | undefined;
  mode?: TaskMode | undefined;
  model?: string | null | undefined;
  effort?: string | null | undefined;
  status?: TaskStatus | undefined;
}

export interface LocalTask extends Task {
  goal: string;
  workspacePath?: string | undefined;
  claimedBy?: string | undefined;
  summary?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface CreateLocalApprovalInput {
  summary: string;
  action?: string | undefined;
  actionKind?: ActionKind | undefined;
  action_kind?: ActionKind | undefined;
  risk?: string | undefined;
  toolPayload?: unknown;
  tool_payload?: unknown;
  framePath?: string | null | undefined;
  frame_path?: string | null | undefined;
  expiresInMs?: number | undefined;
}

export interface LocalApproval extends ApprovalRow {
  taskId: string;
  action: string;
  status: string;
  rejectionReason?: string | undefined;
  resolvedAt?: string | undefined;
  createdAt: string;
}

export class LocalTaskStore implements TaskStore {
  private db: DatabaseSync;
  private decisionResolvers = new Map<string, Array<(approval: ApprovalRow) => void>>();

  constructor(options: LocalTaskStoreOptions) {
    if (options.dbPath !== ':memory:') {
      const dir = path.dirname(options.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        hostname TEXT NOT NULL,
        agy_version TEXT,
        daemon_version TEXT,
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'mixed',
        workspace_path TEXT,
        model TEXT,
        effort TEXT,
        mode TEXT NOT NULL DEFAULT 'default',
        status TEXT NOT NULL DEFAULT 'queued',
        conversation_id TEXT,
        parent_task_id TEXT,
        result_summary TEXT,
        error TEXT,
        claimed_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'local-user',
        seq INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        type TEXT,
        text TEXT,
        data TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        owner_id TEXT NOT NULL DEFAULT 'local-user',
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        tool_payload TEXT,
        frame_path TEXT,
        rejection_reason TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS frames (
        task_id TEXT NOT NULL PRIMARY KEY,
        jpeg_base64 TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  async createTask(input: CreateTaskInput): Promise<LocalTask> {
    const id = input.id ?? randomUUID();
    const prompt = input.prompt ?? input.goal ?? '';
    const workspacePath = input.workspacePath ?? input.workspace_path ?? null;
    const userId = input.userId ?? input.user_id ?? 'local-user';
    const machineId = input.machineId ?? input.machine_id ?? 'machine-local';
    const kind = input.kind ?? 'mixed';
    const mode = input.mode ?? 'default';
    const model = input.model ?? null;
    const effort = input.effort ?? null;
    const status = input.status ?? 'queued';
    const nowIso = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO tasks (id, user_id, machine_id, prompt, kind, workspace_path, model, effort, mode, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, machineId, prompt, kind, workspacePath, model, effort, mode, status, nowIso, nowIso);

    const task = await this.getTask(id);
    return task!;
  }

  async getTask(id: string): Promise<LocalTask | null> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.toTask(row);
  }

  async claimNextTask(machineId: string): Promise<LocalTask | null> {
    let row = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'queued' AND machine_id = ?
      ORDER BY created_at ASC
      LIMIT 1
    `).get(machineId) as any;

    if (!row) {
      row = this.db.prepare(`
        SELECT * FROM tasks
        WHERE status = 'queued' AND machine_id = 'machine-local'
        ORDER BY created_at ASC
        LIMIT 1
      `).get() as any;
    }

    if (!row) {
      row = this.db.prepare(`
        SELECT * FROM tasks
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
      `).get() as any;
    }

    if (!row) return null;

    const nowIso = new Date().toISOString();
    this.db.prepare(`
      UPDATE tasks
      SET status = 'claimed', claimed_by = ?, machine_id = ?, updated_at = ?
      WHERE id = ?
    `).run(machineId, machineId, nowIso, row.id);

    return this.getTask(row.id);
  }

  async updateTaskStatus(id: string, status: TaskStatus, summary?: string): Promise<void> {
    const nowIso = new Date().toISOString();
    let startedAt: string | null = null;
    let finishedAt: string | null = null;
    if (status === 'running') {
      startedAt = nowIso;
    } else if (status === 'done' || status === 'failed' || status === 'cancelled') {
      finishedAt = nowIso;
    }
    this.db.prepare(`
      UPDATE tasks
      SET status = ?,
          result_summary = COALESCE(?, result_summary),
          started_at = COALESCE(started_at, ?),
          finished_at = COALESCE(finished_at, ?),
          updated_at = ?
      WHERE id = ?
    `).run(status, summary ?? null, startedAt, finishedAt, nowIso, id);
  }

  async markTaskRunning(taskId: string): Promise<Task> {
    await this.updateTaskStatus(taskId, 'running');
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  async completeTask(taskId: string, input: CompleteTaskInput): Promise<Task> {
    const nowIso = new Date().toISOString();
    this.db.prepare(`
      UPDATE tasks
      SET status = 'done',
          result_summary = ?,
          conversation_id = COALESCE(?, conversation_id),
          finished_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(input.summary, input.conversationId ?? null, nowIso, nowIso, taskId);
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  async failTask(taskId: string, input: FailTaskInput): Promise<Task> {
    const nowIso = new Date().toISOString();
    this.db.prepare(`
      UPDATE tasks
      SET status = 'failed',
          error = ?,
          finished_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(input.error, nowIso, nowIso, taskId);
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  async cancelTask(taskId: string, reason?: string): Promise<Task> {
    const nowIso = new Date().toISOString();
    this.db.prepare(`
      UPDATE tasks
      SET status = 'cancelled',
          error = ?,
          finished_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(reason ?? 'Task cancelled by user', nowIso, nowIso, taskId);
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  async markTaskAwaitingApproval(taskId: string): Promise<Task> {
    const nowIso = new Date().toISOString();
    this.db.prepare(`
      UPDATE tasks
      SET status = 'awaiting_approval',
          updated_at = ?
      WHERE id = ?
    `).run(nowIso, taskId);
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  async recordEvent(taskId: string, event: Record<string, any>): Promise<void> {
    const task = await this.getTask(taskId);
    const userId = task?.user_id ?? 'local-user';
    const nowIso = new Date().toISOString();
    const countRow = this.db.prepare('SELECT COUNT(*) as count FROM events WHERE task_id = ?').get(taskId) as any;
    const seq = Number(countRow?.count ?? 0);
    const type = event.type ?? event.kind ?? 'text';
    const text = event.text ?? null;
    const kind = event.kind ?? event.type ?? 'agent_text';
    const payloadJson = JSON.stringify(event.payload ?? event);
    const dataJson = JSON.stringify(event);

    this.db.prepare(`
      INSERT INTO events (task_id, user_id, seq, kind, payload, type, text, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, userId, seq, kind, payloadJson, type, text, dataJson, nowIso);
  }

  async getEvents(taskId: string): Promise<any[]> {
    const rows = this.db.prepare(`
      SELECT data FROM events WHERE task_id = ? ORDER BY id ASC
    `).all(taskId) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data));
  }

  async appendEvent<K extends EventKind>(
    taskId: string,
    input: EventInput<K>,
  ): Promise<TaskEvent<K>> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);

    const nowIso = new Date().toISOString();
    const countRow = this.db.prepare('SELECT COUNT(*) as count FROM events WHERE task_id = ?').get(taskId) as any;
    const seq = Number(countRow?.count ?? 0);

    const payloadJson = JSON.stringify(input.payload);
    const dataJson = JSON.stringify({
      kind: input.kind,
      payload: input.payload,
      type: input.kind,
      text: (input.payload as any)?.text ?? null,
    });
    const text = (input.payload as any)?.text ?? null;

    const result = this.db.prepare(`
      INSERT INTO events (task_id, user_id, seq, kind, payload, type, text, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, task.user_id, seq, input.kind, payloadJson, input.kind, text, dataJson, nowIso);

    const eventId = Number(result.lastInsertRowid);
    return {
      id: eventId,
      task_id: taskId,
      user_id: task.user_id,
      seq,
      created_at: nowIso,
      kind: input.kind,
      payload: input.payload,
    };
  }

  async createApproval(
    taskId: string,
    input: CreateLocalApprovalInput,
  ): Promise<LocalApproval> {
    const id = randomUUID();
    const nowIso = new Date().toISOString();
    const action = (input.action ?? input.actionKind ?? input.action_kind ?? 'other') as ActionKind;
    const risk = (input.risk ?? 'medium') as RiskLevel;
    const toolPayload = input.toolPayload ?? input.tool_payload ?? null;
    const toolPayloadStr = toolPayload !== null ? JSON.stringify(toolPayload) : null;
    const framePath = input.framePath ?? input.frame_path ?? null;
    const expiresInMs = input.expiresInMs ?? 600000;
    const expiresAt = new Date(Date.now() + expiresInMs).toISOString();

    const task = await this.getTask(taskId);
    const ownerId = task?.user_id ?? 'local-user';

    this.db.prepare(`
      INSERT INTO approvals (id, task_id, owner_id, action, summary, risk, status, tool_payload, frame_path, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(id, taskId, ownerId, action, input.summary, risk, toolPayloadStr, framePath, nowIso, expiresAt);

    const approval = await this.getApproval(id);
    return approval!;
  }

  async getApproval(id: string): Promise<LocalApproval | null> {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.toApproval(row);
  }

  async listApprovals(taskId: string): Promise<ApprovalRow[]> {
    const rows = this.db.prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as any[];
    return rows.map((r) => this.toApproval(r));
  }

  async getPendingApproval(taskId: string): Promise<ApprovalRow | null> {
    const row = this.db.prepare("SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1").get(taskId) as any;
    if (!row) return null;
    return this.toApproval(row);
  }

  async resolveApproval(
    id: string,
    status: 'approved' | 'rejected',
    reason?: string,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    this.db.prepare(`
      UPDATE approvals
      SET status = ?, rejection_reason = ?, decided_at = ?
      WHERE id = ?
    `).run(status, reason ?? null, nowIso, id);

    const updated = await this.getApproval(id);
    if (updated) {
      const resolvers = this.decisionResolvers.get(id);
      if (resolvers) {
        for (const res of resolvers) {
          res(updated);
        }
        this.decisionResolvers.delete(id);
      }
    }
  }

  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<ApprovalRow> {
    await this.resolveApproval(approvalId, decision, reason);
    const updated = await this.getApproval(approvalId);
    if (!updated) throw new Error(`Unknown approval: ${approvalId}`);
    return updated;
  }

  async waitForApprovalDecision(
    approvalId: string,
    timeoutMs = 600000,
    signal?: AbortSignal,
  ): Promise<ApprovalRow> {
    const current = await this.getApproval(approvalId);
    if (current && current.status !== 'pending') {
      return current;
    }

    return new Promise<ApprovalRow>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(new Error('Aborted while waiting for approval decision'));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      const onDecision = (approval: ApprovalRow) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(approval);
      };

      const list = this.decisionResolvers.get(approvalId) ?? [];
      list.push(onDecision);
      this.decisionResolvers.set(approvalId, list);

      timer = setTimeout(async () => {
        signal?.removeEventListener('abort', onAbort);
        const cur = await this.getApproval(approvalId);
        if (cur && cur.status !== 'pending') {
          resolve(cur);
        } else {
          reject(new Error('Approval request timed out'));
        }
      }, timeoutMs);
    });
  }

  async pushFrame(taskId: string, frame: { jpegBase64: string; capturedAt: string }): Promise<void> {
    this.db.prepare(`
      INSERT INTO frames (task_id, jpeg_base64, captured_at)
      VALUES (?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET jpeg_base64 = excluded.jpeg_base64, captured_at = excluded.captured_at
    `).run(taskId, frame.jpegBase64, frame.capturedAt);
  }

  async registerMachine(input: RegisterMachineInput): Promise<Machine> {
    const existing = this.db.prepare('SELECT * FROM machines WHERE user_id = ? AND name = ?').get(input.userId, input.name) as any;
    const nowIso = new Date().toISOString();
    if (existing) {
      this.db.prepare(`
        UPDATE machines
        SET hostname = ?, agy_version = ?, daemon_version = ?
        WHERE id = ?
      `).run(input.hostname, input.agyVersion ?? null, input.daemonVersion ?? null, existing.id);
      return {
        id: existing.id,
        user_id: input.userId,
        name: input.name,
        hostname: input.hostname,
        agy_version: input.agyVersion,
        daemon_version: input.daemonVersion,
        status: existing.status,
        last_seen_at: existing.last_seen_at,
        created_at: existing.created_at,
      };
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO machines (id, user_id, name, hostname, agy_version, daemon_version, status, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'offline', NULL, ?)
    `).run(id, input.userId, input.name, input.hostname, input.agyVersion ?? null, input.daemonVersion ?? null, nowIso);

    return {
      id,
      user_id: input.userId,
      name: input.name,
      hostname: input.hostname,
      agy_version: input.agyVersion,
      daemon_version: input.daemonVersion,
      status: 'offline',
      last_seen_at: null,
      created_at: nowIso,
    };
  }

  async getMachine(): Promise<Machine> {
    const row = this.db.prepare('SELECT * FROM machines ORDER BY created_at ASC LIMIT 1').get() as any;
    if (row) {
      return {
        id: row.id,
        user_id: row.user_id,
        name: row.name,
        hostname: row.hostname,
        agy_version: row.agy_version,
        daemon_version: row.daemon_version,
        status: row.status,
        last_seen_at: row.last_seen_at,
        created_at: row.created_at,
      };
    }
    return this.registerMachine({
      userId: 'local-user',
      name: 'local-machine',
      hostname: 'localhost',
      agyVersion: null,
      daemonVersion: null,
    });
  }

  async heartbeat(machineId: string): Promise<Machine> {
    const nowIso = new Date().toISOString();
    this.db.prepare(`
      UPDATE machines
      SET status = 'online', last_seen_at = ?
      WHERE id = ?
    `).run(nowIso, machineId);
    const row = this.db.prepare('SELECT * FROM machines WHERE id = ?').get(machineId) as any;
    if (!row) throw new Error(`Unknown machine: ${machineId}`);
    return {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      hostname: row.hostname,
      agy_version: row.agy_version,
      daemon_version: row.daemon_version,
      status: row.status,
      last_seen_at: row.last_seen_at,
      created_at: row.created_at,
    };
  }

  private toTask(row: any): LocalTask {
    const createdAtNum = Date.parse(row.created_at) || Date.now();
    const updatedAtNum = Date.parse(row.updated_at) || createdAtNum;
    const task: LocalTask = {
      id: row.id,
      user_id: row.user_id,
      machine_id: row.machine_id,
      prompt: row.prompt,
      goal: row.prompt,
      kind: row.kind,
      workspace_path: row.workspace_path ?? null,
      model: row.model ?? null,
      effort: row.effort ?? null,
      mode: row.mode,
      status: row.status,
      conversation_id: row.conversation_id ?? null,
      parent_task_id: row.parent_task_id ?? null,
      result_summary: row.result_summary ?? null,
      error: row.error ?? null,
      created_at: row.created_at,
      started_at: row.started_at ?? null,
      finished_at: row.finished_at ?? null,
      createdAt: createdAtNum,
      updatedAt: updatedAtNum,
    };
    if (row.workspace_path !== null && row.workspace_path !== undefined) {
      task.workspacePath = row.workspace_path;
    }
    if (row.claimed_by !== null && row.claimed_by !== undefined) {
      task.claimedBy = row.claimed_by;
    }
    if (row.result_summary !== null && row.result_summary !== undefined) {
      task.summary = row.result_summary;
    }
    return task;
  }

  private toApproval(row: any): LocalApproval {
    const res: LocalApproval = {
      id: row.id,
      task_id: row.task_id,
      taskId: row.task_id,
      owner_id: row.owner_id ?? 'local-user',
      action_kind: (row.action as ActionKind) ?? 'other',
      action: row.action,
      summary: row.summary,
      risk: (row.risk as RiskLevel) ?? 'medium',
      tool_payload: row.tool_payload ? JSON.parse(row.tool_payload) : null,
      frame_path: row.frame_path ?? null,
      decision: (row.status as ApprovalDecision) ?? 'pending',
      status: row.status,
      rejection_reason: row.rejection_reason ?? null,
      created_at: row.created_at,
      createdAt: row.created_at,
      decided_at: row.decided_at ?? null,
      expires_at: row.expires_at ?? new Date(Date.now() + 600000).toISOString(),
    };
    if (row.rejection_reason !== null && row.rejection_reason !== undefined) {
      res.rejectionReason = row.rejection_reason;
    }
    if (row.decided_at !== null && row.decided_at !== undefined) {
      res.resolvedAt = row.decided_at;
    }
    return res;
  }
}
