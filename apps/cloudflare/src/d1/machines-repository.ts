import type { MachineRow } from '@remote-hands/shared';
import type { D1Database } from '../env.js';

export class MachinesRepository {
  constructor(private db: D1Database) {}

  async upsert(machine: MachineRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO machines (id, owner_id, name, hostname, daemon_version, agy_version, status, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           hostname = excluded.hostname,
           daemon_version = excluded.daemon_version,
           agy_version = excluded.agy_version,
           status = excluded.status,
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(
        machine.id,
        machine.owner_id,
        machine.name,
        machine.hostname,
        machine.daemon_version,
        machine.agy_version,
        machine.status,
        machine.last_seen_at,
        machine.created_at,
      )
      .run();
  }

  async listByOwner(ownerId: string): Promise<MachineRow[]> {
    const res = await this.db
      .prepare(`SELECT * FROM machines WHERE owner_id = ? ORDER BY created_at ASC`)
      .bind(ownerId)
      .all<MachineRow>();
    return res.results ?? [];
  }

  async getById(id: string): Promise<MachineRow | null> {
    return this.db
      .prepare(`SELECT * FROM machines WHERE id = ?`)
      .bind(id)
      .first<MachineRow>();
  }

  async updateHeartbeat(id: string, lastSeenAt: string): Promise<void> {
    await this.db
      .prepare(`UPDATE machines SET last_seen_at = ?, status = 'online' WHERE id = ?`)
      .bind(lastSeenAt, id)
      .run();
  }
}
