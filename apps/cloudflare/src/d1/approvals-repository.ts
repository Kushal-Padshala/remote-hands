import type { ApprovalRow } from '@remote-hands/shared';
import type { D1Database } from '../env.js';

export class ApprovalsRepository {
  constructor(private db: D1Database) {}

  async create(approval: ApprovalRow): Promise<void> {
    const payloadStr =
      typeof approval.tool_payload === 'string'
        ? approval.tool_payload
        : JSON.stringify(approval.tool_payload);

    await this.db
      .prepare(
        `INSERT INTO approvals (
           id, task_id, owner_id, action_kind, summary, risk,
           tool_payload, frame_path, decision, decided_at, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        approval.id,
        approval.task_id,
        approval.owner_id,
        approval.action_kind,
        approval.summary,
        approval.risk,
        payloadStr,
        approval.frame_path,
        approval.decision,
        approval.decided_at,
        approval.expires_at,
        approval.created_at,
      )
      .run();
  }

  async getById(id: string): Promise<ApprovalRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM approvals WHERE id = ?`)
      .bind(id)
      .first<any>();
    if (!row) return null;
    return this.mapRow(row);
  }

  async listByTask(taskId: string): Promise<ApprovalRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at ASC`)
      .bind(taskId)
      .all<any>();
    return (res.results ?? []).map((r) => this.mapRow(r));
  }

  async listByOwner(ownerId: string): Promise<ApprovalRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM approvals WHERE owner_id = ? ORDER BY created_at DESC`)
      .bind(ownerId)
      .all<any>();
    return (res.results ?? []).map((r) => this.mapRow(r));
  }

  async updateDecision(id: string, decision: string, decidedAt: string, reason?: string | null): Promise<void> {
    const existing = await this.getById(id);
    let toolPayload = existing?.tool_payload ?? {};
    if (typeof toolPayload === 'string') {
      try {
        toolPayload = JSON.parse(toolPayload);
      } catch {}
    }
    if (reason && typeof toolPayload === 'object' && toolPayload !== null) {
      (toolPayload as any).rejection_reason = reason;
    }
    const payloadStr = JSON.stringify(toolPayload);
    await this.db
      .prepare(`UPDATE approvals SET decision = ?, decided_at = ?, tool_payload = ? WHERE id = ?`)
      .bind(decision, decidedAt, payloadStr, id)
      .run();
  }

  private mapRow(row: any): ApprovalRow {
    let toolPayload = row.tool_payload;
    if (typeof toolPayload === 'string') {
      try {
        toolPayload = JSON.parse(toolPayload);
      } catch {}
    }
    return {
      id: row.id,
      task_id: row.task_id,
      owner_id: row.owner_id,
      action_kind: row.action_kind,
      summary: row.summary,
      risk: row.risk,
      tool_payload: toolPayload,
      frame_path: row.frame_path,
      decision: row.decision,
      decided_at: row.decided_at,
      expires_at: row.expires_at,
      created_at: row.created_at,
      rejection_reason: row.rejection_reason ?? (toolPayload as any)?.rejection_reason ?? null,
    };
  }
}
