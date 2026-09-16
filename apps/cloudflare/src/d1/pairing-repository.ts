import type { D1Database } from '../env.js';

export interface PairingTokenRow {
  id: string;
  owner_id: string;
  machine_name: string;
  code_hash: string;
  expires_at: string;
  claimed_at: string | null;
  created_at: string;
}

export class PairingRepository {
  constructor(private db: D1Database) {}

  async create(token: PairingTokenRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pairing_tokens (id, owner_id, machine_name, code_hash, expires_at, claimed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        token.id,
        token.owner_id,
        token.machine_name,
        token.code_hash,
        token.expires_at,
        token.claimed_at,
        token.created_at,
      )
      .run();
  }

  async getByCodeHash(codeHash: string): Promise<PairingTokenRow | null> {
    return this.db
      .prepare(`SELECT * FROM pairing_tokens WHERE code_hash = ?`)
      .bind(codeHash)
      .first<PairingTokenRow>();
  }

  async markClaimed(id: string, claimedAt: string): Promise<void> {
    await this.db
      .prepare(`UPDATE pairing_tokens SET claimed_at = ? WHERE id = ?`)
      .bind(claimedAt, id)
      .run();
  }
}
