import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbClient, isSupabaseReachable } from './helpers.js';
import type { Client as PgClient } from 'pg';

interface OwnedForeignKey {
  referencingTable: string;
  referencingColumn: string;
  referencedTable: string;
}

const isAvailable = await isSupabaseReachable();

describe.skipIf(!isAvailable)('every foreign key into a user-owned table', () => {
  let db: PgClient;
  let foreignKeys: OwnedForeignKey[];

  beforeAll(async () => {
    db = createDbClient();
    await db.connect();

    const { rows } = await db.query<{
      referencing_table: string;
      referencing_column: string;
      referenced_table: string;
    }>(`
      select
        rt.relname as referencing_table,
        att.attname as referencing_column,
        ref.relname as referenced_table
      from pg_constraint con
      join pg_class rt on rt.oid = con.conrelid
      join pg_namespace rn on rn.oid = rt.relnamespace
      join pg_class ref on ref.oid = con.confrelid
      join pg_attribute att
        on att.attrelid = con.conrelid
       and att.attnum = con.conkey[1]
      where con.contype = 'f'
        and rn.nspname = 'public'
        and exists (
          select 1
          from pg_attribute ref_col
          where ref_col.attrelid = con.confrelid
            and ref_col.attname = 'user_id'
            and ref_col.attnum > 0
            and not ref_col.attisdropped
        )
      order by rt.relname, att.attname;
    `);

    foreignKeys = rows.map((row) => ({
      referencingTable: row.referencing_table,
      referencingColumn: row.referencing_column,
      referencedTable: row.referenced_table,
    }));
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.end();
    }
  });
  it('found at least the foreign keys this schema is known to have', () => {
    expect(foreignKeys.length).toBeGreaterThan(0);
  });

  it('has an ownership check in the referencing table INSERT policy', async () => {
    const unguarded: string[] = [];

    for (const fk of foreignKeys) {
      const { rows: policies } = await db.query<{ with_check: string | null }>(
        `select with_check
         from pg_policies
         where schemaname = 'public'
           and tablename = $1
           and cmd = 'INSERT'`,
        [fk.referencingTable],
      );

      const directOwnershipCheck = new RegExp(
        `auth\\.uid\\(\\)\\s*=\\s*${fk.referencingColumn}\\b`,
      );
      const parentOwnershipCheck = new RegExp(
        `\\w*_belongs_to_current_user\\(\\s*${fk.referencingColumn}\\s*\\)`,
      );

      const guarded = policies.some((policy) => {
        const check = policy.with_check ?? '';
        return (
          (fk.referencingColumn === 'user_id' && directOwnershipCheck.test(check)) ||
          parentOwnershipCheck.test(check)
        );
      });

      if (!guarded) {
        unguarded.push(
          `${fk.referencingTable}.${fk.referencingColumn} references ` +
            `${fk.referencedTable}(id), which belongs to somebody, but no INSERT ` +
            `policy on ${fk.referencingTable} checks ownership of ${fk.referencingColumn}`,
        );
      }
    }

    expect(unguarded).toEqual([]);
  });
});
