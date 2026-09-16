import type { D1Database } from '../env.js';

export interface SessionRow {
  id: string;
  owner_id: string;
  machine_id: string | null;
  kind: 'phone' | 'daemon';
  token_hash: string;
  expires_at: string;
  created_at: string;
}

export class SessionsRepository {
  constructor(private db: D1Database) {}

  async create(session: SessionRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sessions (id, owner_id, machine_id, kind, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        session.id,
        session.owner_id,
        session.machine_id,
        session.kind,
        session.token_hash,
        session.expires_at,
        session.created_at,
      )
      .run();
  }

  async getByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE token_hash = ?`)
      .bind(tokenHash)
      .first<SessionRow>();
  }

  async deleteExpired(now: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM sessions WHERE expires_at < ?`)
      .bind(now)
      .run();
  }
}
