import type { TaskRow } from '@remote-hands/shared';
import type { D1Database } from '../env.js';

export interface UpdateTaskStatusOptions {
  started_at?: string | null | undefined;
  finished_at?: string | null | undefined;
  result_summary?: string | null | undefined;
  error?: string | null | undefined;
  conversation_id?: string | null | undefined;
}


export class TasksRepository {
  constructor(private db: D1Database) {}

  async create(task: TaskRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tasks (
           id, owner_id, machine_id, prompt, kind, workspace_path, model, effort,
           mode, status, conversation_id, parent_task_id, result_summary, error,
           created_at, started_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        task.id,
        task.owner_id,
        task.machine_id,
        task.prompt,
        task.kind,
        task.workspace_path,
        task.model,
        task.effort,
        task.mode,
        task.status,
        task.conversation_id,
        task.parent_task_id,
        task.result_summary,
        task.error,
        task.created_at,
        task.started_at,
        task.finished_at,
      )
      .run();
  }

  async getById(id: string): Promise<TaskRow | null> {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .bind(id)
      .first<TaskRow>();
  }

  async listByOwner(ownerId: string): Promise<TaskRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM tasks WHERE owner_id = ? ORDER BY created_at DESC`)
      .bind(ownerId)
      .all<TaskRow>();
    return res.results ?? [];
  }

  async listQueuedForMachine(machineId: string): Promise<TaskRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM tasks WHERE machine_id = ? AND status = 'queued' ORDER BY created_at ASC`)
      .bind(machineId)
      .all<TaskRow>();
    return res.results ?? [];
  }

  async updateStatus(id: string, status: string, options: UpdateTaskStatusOptions = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE tasks SET
           status = ?,
           started_at = COALESCE(?, started_at),
           finished_at = COALESCE(?, finished_at),
           result_summary = COALESCE(?, result_summary),
           error = COALESCE(?, error),
           conversation_id = COALESCE(?, conversation_id)
         WHERE id = ?`,
      )
      .bind(
        status,
        options.started_at ?? null,
        options.finished_at ?? null,
        options.result_summary ?? null,
        options.error ?? null,
        options.conversation_id ?? null,
        id,
      )
      .run();
  }
}
