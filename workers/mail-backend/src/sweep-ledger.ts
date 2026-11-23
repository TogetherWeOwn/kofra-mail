import { ulid } from 'ulid';
import { isObjectKey } from './kofra.ts';
import { isObjectDigest, parseObjectKey, type ObjectKind } from './object-key.ts';
import { RETENTION_MS } from './reconcile.ts';

const SWEEP_BATCH = 4;
const MIN_BACKOFF = 60_000;
const MAX_BACKOFF = 6 * 60 * MIN_BACKOFF;
const LEDGER = `
CREATE TABLE IF NOT EXISTS generations (
  key TEXT PRIMARY KEY NOT NULL,
  prefix TEXT,
  holder_count INTEGER NOT NULL CHECK (holder_count >= 0),
  last_ref_at INTEGER NOT NULL,
  retry_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  CHECK (retry_at IS NULL OR (holder_count = 0 AND prefix IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS live_generation ON generations(prefix) WHERE retry_at IS NULL AND prefix IS NOT NULL;
CREATE INDEX IF NOT EXISTS due_generation ON generations(last_ref_at, key)
  WHERE holder_count = 0 AND retry_at IS NULL AND prefix IS NOT NULL;
CREATE INDEX IF NOT EXISTS due_delete ON generations(retry_at, key) WHERE retry_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS generation_holders (
  key TEXT NOT NULL REFERENCES generations(key),
  holder TEXT NOT NULL,
  PRIMARY KEY (key, holder)
);
CREATE TABLE IF NOT EXISTS generation_clock (id INTEGER PRIMARY KEY CHECK (id = 1), stamp INTEGER NOT NULL);
INSERT OR IGNORE INTO generation_clock VALUES (1, 0);
`;

export class SweepLedger {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(LEDGER);
  }

  register(kind: ObjectKind, digest: string, holder: string, now: number): string {
    this.validate(holder, now);
    if ((kind !== 'raw' && kind !== 'att') || !isObjectDigest(digest)) throw new Error('Invalid mail object digest');
    const prefix = `${kind}/${digest}`;
    return this.storage.transactionSync(() => {
      let key = this.sql.exec<{ key: string }>(`SELECT key FROM generations
        WHERE prefix = ? AND prefix IS NOT NULL AND retry_at IS NULL`, prefix).toArray()[0]?.key;
      if (!key) {
        // The persistent logical clock makes generations distinct across clock
        // rollback and DO restarts, even after a retired row has been dropped.
        const { stamp } = this.sql.exec<{ stamp: number }>(`UPDATE generation_clock SET stamp = max(stamp + 1, ?)
          WHERE id = 1 RETURNING stamp`, now).one();
        key = `${prefix}/${ulid(stamp)}`;
        this.sql.exec('INSERT INTO generations(key,prefix,holder_count,last_ref_at) VALUES (?,?,0,?)', key, prefix, now);
      }
      this.addHolder(key, holder, now);
      return key;
    });
  }

  hold(key: string, holder: string, now: number): void {
    this.validate(holder, now);
    if (!isObjectKey(key)) throw new Error('Invalid sweeper reference');
    this.storage.transactionSync(() => {
      if (!parseObjectKey(key)) {
        // Drafts are never destructive candidates.
        this.sql.exec('INSERT OR IGNORE INTO generations(key,holder_count,last_ref_at) VALUES (?,0,?)', key, now);
      }
      if (!this.sql.exec('SELECT 1 FROM generations WHERE key = ? AND retry_at IS NULL', key).toArray().length) {
        throw new Error('Mail object generation unavailable');
      }
      this.addHolder(key, holder, now);
    });
  }

  private addHolder(key: string, holder: string, now: number): void {
    const inserted = this.sql.exec('INSERT OR IGNORE INTO generation_holders VALUES (?, ?) RETURNING holder', key, holder).toArray();
    if (inserted.length) this.sql.exec(`UPDATE generations SET holder_count = holder_count + 1,
      last_ref_at = max(last_ref_at, ?) WHERE key = ?`, now, key);
  }

  release(key: string, holder: string, now: number): void {
    this.validate(holder, now);
    if (!isObjectKey(key)) throw new Error('Invalid sweeper reference');
    this.storage.transactionSync(() => {
      const removed = this.sql.exec('DELETE FROM generation_holders WHERE key = ? AND holder = ? RETURNING holder', key, holder).toArray();
      if (removed.length) this.sql.exec(`UPDATE generations SET holder_count = holder_count - 1,
        last_ref_at = max(last_ref_at, ?) WHERE key = ?`, now, key);
    });
  }

  candidates(now: number, limit = 64): string[] {
    return this.sql.exec<{ key: string }>(`SELECT key FROM generations
      WHERE holder_count = 0 AND retry_at IS NULL AND prefix IS NOT NULL AND last_ref_at <= ?
      ORDER BY last_ref_at, key LIMIT ?`, now - RETENTION_MS, limit).toArray().map(row => row.key);
  }

  nextSweepAt(): number | null {
    const first = this.sql.exec<{ last_ref_at: number }>(`SELECT last_ref_at FROM generations
      WHERE holder_count = 0 AND retry_at IS NULL AND prefix IS NOT NULL ORDER BY last_ref_at, key LIMIT 1`).toArray()[0];
    const retry = this.sql.exec<{ retry_at: number }>(`SELECT retry_at FROM generations WHERE retry_at IS NOT NULL
      ORDER BY retry_at, key LIMIT 1`).toArray()[0];
    if (first && retry) return Math.min(first.last_ref_at + RETENTION_MS, retry.retry_at);
    return first ? first.last_ref_at + RETENTION_MS : retry?.retry_at ?? null;
  }

  async sweep(now: number, remove: (key: string) => Promise<void>): Promise<void> {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid sweeper time');
    const work = this.storage.transactionSync(() => {
      for (const key of this.candidates(now, SWEEP_BATCH)) {
        // Non-null retry_at is the durable retirement flag. It is never cleared.
        this.sql.exec('UPDATE generations SET retry_at = ? WHERE key = ?', now, key);
      }
      const rows = this.sql.exec<{ key: string; attempts: number }>(`SELECT key, attempts FROM generations
        WHERE retry_at IS NOT NULL AND retry_at <= ? ORDER BY retry_at, key LIMIT ?`, now, SWEEP_BATCH).toArray();
      for (const row of rows) {
        const retry = now + Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** row.attempts);
        this.sql.exec('UPDATE generations SET retry_at = ?, attempts = min(attempts + 1, 9) WHERE key = ?', retry, row.key);
      }
      return rows;
    });
    if (!work.length) return;
    await this.storage.sync();
    await Promise.all(work.map(async ({ key }) => {
      try { await remove(key); }
      catch { return; } // Unknown outcome; keep the retired row for its next attempt.
      this.sql.exec('DELETE FROM generations WHERE key = ? AND retry_at IS NOT NULL', key);
    }));
  }

  private validate(holder: string, now: number): void {
    if (typeof holder !== 'string' || holder.length < 1 || holder.length > 256 || !Number.isSafeInteger(now) || now < 0) {
      throw new Error('Invalid sweeper reference');
    }
  }
}
