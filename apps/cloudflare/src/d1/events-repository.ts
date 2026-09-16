import type { TaskEventRow } from '@remote-hands/shared';
import type { D1Database } from '../env.js';

export class EventsRepository {
  constructor(private db: D1Database) {}

  async append(event: TaskEventRow): Promise<void> {
    const payloadStr = typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);
    await this.db
      .prepare(
        `INSERT INTO events (task_id, owner_id, seq, kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.task_id,
        event.owner_id,
        event.seq,
        event.kind,
        payloadStr,
        event.created_at,
      )
      .run();
  }

  async listForTask(taskId: string): Promise<TaskEventRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC`)
      .bind(taskId)
      .all<any>();

    const rows = res.results ?? [];
    return rows.map((r) => {
      let payload = r.payload;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {}
      }
      return {
        id: r.id,
        task_id: r.task_id,
        owner_id: r.owner_id,
        seq: r.seq,
        kind: r.kind,
        payload,
        created_at: r.created_at,
      };
    });
  }
}
