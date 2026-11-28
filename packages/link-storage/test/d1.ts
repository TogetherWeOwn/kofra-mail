// A D1-shaped adapter over node:sqlite with the real directory migrations, for tests.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { LinkDatabase, LinkStatement } from '../src/store.ts';

const migrations = new URL('../../../workers/mail-backend/migrations/', import.meta.url);
const files = ['0001_directory.sql', '0008_local_mail_api.sql', '0010_link_storage.sql'];

type Value = string | number | null;

export interface TestDatabase extends LinkDatabase {
  raw: DatabaseSync;
  /** Every row of a table, for assertions about what is stored. */
  dump(table: string): Record<string, unknown>[];
}

export function testDatabase(): TestDatabase {
  const raw = new DatabaseSync(':memory:');
  for (const file of files) raw.exec(readFileSync(new URL(file, migrations), 'utf8'));
  const statement = (sql: string, values: Value[] = []): LinkStatement & { exec(): void } => ({
    bind(...next: Value[]) { return statement(sql, next); },
    async first<T>() { return (raw.prepare(sql).get(...values) ?? null) as T | null; },
    async all<T>() { return { results: raw.prepare(sql).all(...values) as T[] }; },
    async run() { return { meta: { changes: Number(raw.prepare(sql).run(...values).changes) } }; },
    exec() { raw.prepare(sql).run(...values); },
  });
  return {
    raw,
    prepare: (sql: string) => statement(sql),
    async batch(statements: LinkStatement[]) {
      raw.exec('BEGIN');
      try {
        for (const s of statements) (s as ReturnType<typeof statement>).exec();
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
      return [];
    },
    dump: (table: string) => {
      if (!/^[a-z_0-9]+$/.test(table)) throw new Error('bad table');
      return raw.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    },
  };
}
