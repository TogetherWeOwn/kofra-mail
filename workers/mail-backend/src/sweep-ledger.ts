import { ulid } from 'ulid';
import { isObjectKey } from './kofra.ts';
import { isObjectDigest, parseObjectKey, type ObjectKind } from './object-key.ts';
import { RETENTION_MS } from './reconcile.ts';

const SWEEP_BATCH = 4;
const EXPIRY_BATCH = 64;
export const CONFIRM_BATCH = 64;
// Far longer than any normal time from a mailbox commit to its publish
// (docs/m3-outbound-plan.md, section 2.7).
export const PROVISIONAL_TTL = 7 * 24 * 60 * 60 * 1000;
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
-- One registration per send (docs/m3-outbound-plan.md, section 2.4, release
-- step 3), outside the mailbox journal so a restore cannot rewind it. A row
-- with released set and no key is the tombstone of a send released before it
-- registered; a registration is never reused.
CREATE TABLE IF NOT EXISTS send_registrations (
  mailbox TEXT NOT NULL,
  send_id TEXT NOT NULL,
  digest TEXT,
  key TEXT,
  raw_holder TEXT,
  index_holder TEXT,
  released TEXT CHECK (released IS NULL OR released IN ('raw', 'all')),
  PRIMARY KEY (mailbox, send_id),
  CHECK ((key IS NULL) = (digest IS NULL) AND (key IS NULL) = (raw_holder IS NULL) AND (key IS NULL) = (index_holder IS NULL)),
  CHECK (key IS NOT NULL OR released IS NOT NULL)
);
`;
// A retired generation is deleted twice, the second time this long after the
// first, and its row is dropped only after the second delete. An object that a
// late PUT recreated in between is removed by it (section 2.4, release step 3).
export const SECOND_DELETE_MS = 24 * 60 * 60 * 1000;
const GENERATION_COLUMNS = [['deleted_at', 'deleted_at INTEGER']] as const;
// Holder states, added after the first ledgers were written. New and existing
// ledgers both gain these columns by ALTER TABLE, so they share one schema and
// existing rows become held. Only held and provisional count in holder_count.
// expires_at is set only while a holder is provisional.
const HOLDER_COLUMNS = [
  ['state', `state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'provisional', 'expired', 'tombstone'))`],
  ['expires_at', `expires_at INTEGER CHECK ((expires_at IS NOT NULL) = (state = 'provisional'))`],
] as const;
const HOLDER_INDEX = `CREATE INDEX IF NOT EXISTS provisional_expiry ON generation_holders(expires_at, key, holder)
  WHERE state = 'provisional'`;

type HolderState = 'held' | 'provisional' | 'expired' | 'tombstone';
export type HoldTarget = { kind: ObjectKind; digest: string } | { key: string };
export type ConfirmEntry = { key: string; holder: string };
// held: provisional or already held. rehold: expired, held again on its live
// generation. lost: expired on a retired generation, or absent from a deleted
// raw/ or att/ generation. released: otherwise absent, or a tombstone.
export type ConfirmAnswer = 'held' | 'rehold' | 'lost' | 'released';
export type SendHolders = { raw: string; index: string };
// registered: the generation holds both holders. released: the send was
// released before (or instead of) this registration; nothing was added.
// mismatch: the send registered other bytes; nothing was added. Both refusals
// are invariant breaches for the caller, which must not PUT.
export type SendRegistration = { state: 'registered'; key: string } | { state: 'released' } | { state: 'mismatch' };
export type SendReleaseMode = 'all' | 'raw';
const SEND_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class SweepLedger {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    storage.transactionSync(() => {
      this.sql.exec(LEDGER);
      const columns = new Set(this.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('generation_holders')`)
        .toArray().map(row => row.name));
      for (const [name, definition] of HOLDER_COLUMNS) {
        if (!columns.has(name)) this.sql.exec(`ALTER TABLE generation_holders ADD COLUMN ${definition}`);
      }
      const generationColumns = new Set(this.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('generations')`)
        .toArray().map(row => row.name));
      for (const [name, definition] of GENERATION_COLUMNS) {
        if (!generationColumns.has(name)) this.sql.exec(`ALTER TABLE generations ADD COLUMN ${definition}`);
      }
      this.sql.exec(HOLDER_INDEX);
    });
  }

  register(kind: ObjectKind, digest: string, holder: string, now: number): string {
    this.validate(holder, now);
    const prefix = this.prefix(kind, digest);
    return this.storage.transactionSync(() => {
      const key = this.liveGeneration(prefix, now);
      this.addHolder(key, holder, now);
      return key;
    });
  }

  hold(key: string, holder: string, now: number): void {
    this.validate(holder, now);
    this.checkKey(key);
    this.storage.transactionSync(() => {
      this.openGeneration(key, now);
      this.addHolder(key, holder, now);
    });
  }

  // Protects a generation until a published mailbox state confirms the holder,
  // or until PROVISIONAL_TTL passes. Chooses the generation as register (by
  // digest) or hold (by key) do.
  holdProvisional(target: HoldTarget, holder: string, now: number): string {
    this.validate(holder, now);
    if (!Number.isSafeInteger(now + PROVISIONAL_TTL)) throw new Error('Invalid sweeper time');
    if (typeof target !== 'object' || target === null) throw new Error('Invalid sweeper reference');
    // Only raw/ and att/ generation keys: legacy drafts/ keys are never swept
    // and get no new holders (section 2.7).
    if ('key' in target && (typeof target.key !== 'string' || !parseObjectKey(target.key))) {
      throw new Error('Invalid sweeper reference');
    }
    const byKey = 'key' in target ? target.key : undefined;
    const prefix = 'key' in target ? undefined : this.prefix(target.kind, target.digest);
    return this.storage.transactionSync(() => {
      let key: string;
      if (byKey !== undefined) this.openGeneration(key = byKey, now);
      else key = this.liveGeneration(prefix!, now);
      const expires = now + PROVISIONAL_TTL;
      const state = this.holderState(key, holder);
      if (state === 'tombstone') throw new Error('Mail object holder retired');
      if (state === 'provisional') {
        this.sql.exec('UPDATE generation_holders SET expires_at = ? WHERE key = ? AND holder = ?', expires, key, holder);
      } else if (state === 'expired') {
        this.sql.exec(`UPDATE generation_holders SET state = 'provisional', expires_at = ? WHERE key = ? AND holder = ?`,
          expires, key, holder);
        this.count(key, 1, now);
      } else if (state === undefined) {
        this.sql.exec(`INSERT INTO generation_holders(key, holder, state, expires_at) VALUES (?, ?, 'provisional', ?)`,
          key, holder, expires);
        this.count(key, 1, now);
      }
      return key;
    });
  }

  // One transaction for the whole batch. Absent and tombstone holders are never
  // created: they were released by a published state, or their object is gone.
  confirm(entries: ConfirmEntry[], now: number): ConfirmAnswer[] {
    if (!Array.isArray(entries)) throw new Error('Invalid sweeper reference');
    if (entries.length > CONFIRM_BATCH) throw new Error(`Confirm at most ${CONFIRM_BATCH} holders per call`);
    const checked = entries.map(entry => {
      if (typeof entry !== 'object' || entry === null) throw new Error('Invalid sweeper reference');
      const { key, holder } = entry;
      this.validate(holder, now);
      this.checkKey(key);
      return { key, holder };
    });
    return this.storage.transactionSync(() => checked.map(({ key, holder }): ConfirmAnswer => {
      const state = this.holderState(key, holder);
      if (state === 'held') return 'held';
      if (state === 'provisional') {
        this.sql.exec(`UPDATE generation_holders SET state = 'held', expires_at = NULL WHERE key = ? AND holder = ?`, key, holder);
        return 'held';
      }
      if (state === 'expired') {
        if (!this.sql.exec('SELECT 1 FROM generations WHERE key = ? AND retry_at IS NULL', key).toArray().length) return 'lost';
        this.sql.exec(`UPDATE generation_holders SET state = 'held' WHERE key = ? AND holder = ?`, key, holder);
        this.count(key, 1, now);
        return 'rehold';
      }
      // A raw/ or att/ generation row is dropped only after a confirmed DELETE,
      // so an absent holder without one lost its object.
      if (state === undefined && parseObjectKey(key)
        && !this.sql.exec('SELECT 1 FROM generations WHERE key = ?', key).toArray().length) return 'lost';
      return 'released';
    }));
  }

  // One transaction: chooses the generation of raw/<digest> as register does,
  // adds both of the send's holders and persists the registration. A repeat
  // with the same digest returns the record unchanged; a repeat with another
  // digest, or any call after releaseSend tombstoned the send, adds nothing.
  registerSend(mailbox: string, sendId: string, digest: string, holders: SendHolders, now: number): SendRegistration {
    this.checkSend(mailbox, sendId);
    if (typeof holders !== 'object' || holders === null || holders.raw === holders.index) throw new Error('Invalid sweeper reference');
    this.validate(holders.raw, now);
    this.validate(holders.index, now);
    const prefix = this.prefix('raw', digest);
    return this.storage.transactionSync((): SendRegistration => {
      const row = this.registration(mailbox, sendId);
      if (row?.released) return { state: 'released' };
      if (row) return row.digest === digest && row.raw_holder === holders.raw && row.index_holder === holders.index
        ? { state: 'registered', key: row.key! } : { state: 'mismatch' };
      const key = this.liveGeneration(prefix, now);
      this.addHolder(key, holders.raw, now);
      this.addHolder(key, holders.index, now);
      // Holder ids are send-specific, so a tombstone here would mean a reused id.
      if (this.holderState(key, holders.raw) !== 'held' || this.holderState(key, holders.index) !== 'held') {
        throw new Error('Mail object holder retired');
      }
      this.sql.exec(`INSERT INTO send_registrations(mailbox, send_id, digest, key, raw_holder, index_holder, released)
        VALUES (?, ?, ?, ?, ?, ?, NULL)`, mailbox, sendId, digest, key, holders.raw, holders.index);
      return { state: 'registered', key };
    });
  }

  // One transaction: tombstones the send's raw holder, and with `all` its
  // sent-copy index holder too, and leaves a released tombstone for the send,
  // also when it never registered. Idempotent.
  releaseSend(mailbox: string, sendId: string, mode: SendReleaseMode, now: number): void {
    this.checkSend(mailbox, sendId);
    if (mode !== 'all' && mode !== 'raw') throw new Error('Invalid sweeper reference');
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid sweeper time');
    this.storage.transactionSync(() => {
      const row = this.registration(mailbox, sendId);
      if (!row) {
        this.sql.exec(`INSERT INTO send_registrations(mailbox, send_id, released) VALUES (?, ?, ?)`, mailbox, sendId, mode);
        return;
      }
      const released = row.released === 'all' || mode === 'all' ? 'all' : 'raw';
      if (row.key) {
        this.tombstone(row.key, row.raw_holder!, now);
        if (released === 'all') this.tombstone(row.key, row.index_holder!, now);
      }
      this.sql.exec('UPDATE send_registrations SET released = ? WHERE mailbox = ? AND send_id = ?', released, mailbox, sendId);
    });
  }

  private registration(mailbox: string, sendId: string) {
    return this.sql.exec<{ digest: string | null; key: string | null; raw_holder: string | null; index_holder: string | null;
      released: SendReleaseMode | null }>(`SELECT digest, key, raw_holder, index_holder, released FROM send_registrations
      WHERE mailbox = ? AND send_id = ?`, mailbox, sendId).toArray()[0];
  }

  private checkSend(mailbox: string, sendId: string): void {
    if (typeof mailbox !== 'string' || mailbox.length < 1 || mailbox.length > 256 || typeof sendId !== 'string' || !SEND_ID.test(sendId)) {
      throw new Error('Invalid sweeper reference');
    }
  }

  // A released send holder stays as a tombstone, so a late hold or register adds nothing.
  private tombstone(key: string, holder: string, now: number): void {
    const state = this.holderState(key, holder);
    if (state === 'tombstone') return;
    if (state === undefined) {
      // A generation already dropped after its deletes needs no tombstone: a
      // late hold finds no live generation, and a register mints a new one.
      if (this.sql.exec('SELECT 1 FROM generations WHERE key = ?', key).toArray().length) {
        this.sql.exec(`INSERT INTO generation_holders(key, holder, state) VALUES (?, ?, 'tombstone')`, key, holder);
      }
      return;
    }
    this.sql.exec(`UPDATE generation_holders SET state = 'tombstone', expires_at = NULL WHERE key = ? AND holder = ?`, key, holder);
    if (state === 'held' || state === 'provisional') this.count(key, -1, now);
  }

  private prefix(kind: ObjectKind, digest: string): string {
    if ((kind !== 'raw' && kind !== 'att') || !isObjectDigest(digest)) throw new Error('Invalid mail object digest');
    return `${kind}/${digest}`;
  }

  private checkKey(key: string): void {
    if (typeof key !== 'string' || !isObjectKey(key)) throw new Error('Invalid sweeper reference');
  }

  private liveGeneration(prefix: string, now: number): string {
    const key = this.sql.exec<{ key: string }>(`SELECT key FROM generations
      WHERE prefix = ? AND prefix IS NOT NULL AND retry_at IS NULL`, prefix).toArray()[0]?.key;
    if (key) return key;
    // The persistent logical clock makes generations distinct across clock
    // rollback and DO restarts, even after a retired row has been dropped.
    const { stamp } = this.sql.exec<{ stamp: number }>(`UPDATE generation_clock SET stamp = max(stamp + 1, ?)
      WHERE id = 1 RETURNING stamp`, now).one();
    const created = `${prefix}/${ulid(stamp)}`;
    this.sql.exec('INSERT INTO generations(key,prefix,holder_count,last_ref_at) VALUES (?,?,0,?)', created, prefix, now);
    return created;
  }

  private openGeneration(key: string, now: number): void {
    if (!parseObjectKey(key)) {
      // Drafts are never destructive candidates.
      this.sql.exec('INSERT OR IGNORE INTO generations(key,holder_count,last_ref_at) VALUES (?,0,?)', key, now);
    }
    if (!this.sql.exec('SELECT 1 FROM generations WHERE key = ? AND retry_at IS NULL', key).toArray().length) {
      throw new Error('Mail object generation unavailable');
    }
  }

  private holderState(key: string, holder: string): HolderState | undefined {
    return this.sql.exec<{ state: HolderState }>('SELECT state FROM generation_holders WHERE key = ? AND holder = ?', key, holder)
      .toArray()[0]?.state;
  }

  private count(key: string, change: 1 | -1, now: number): void {
    this.sql.exec(`UPDATE generations SET holder_count = holder_count + ?, last_ref_at = max(last_ref_at, ?) WHERE key = ?`,
      change, now, key);
  }

  private addHolder(key: string, holder: string, now: number): void {
    const state = this.holderState(key, holder);
    // A repeated hold after a tombstoning release adds nothing (plan section 2.4).
    if (state === 'held' || state === 'tombstone') return;
    if (state === undefined) this.sql.exec('INSERT INTO generation_holders(key, holder) VALUES (?, ?)', key, holder);
    else this.sql.exec(`UPDATE generation_holders SET state = 'held', expires_at = NULL WHERE key = ? AND holder = ?`, key, holder);
    if (state !== 'provisional') this.count(key, 1, now);
  }

  // Releases a holder of an internal handoff or an internal delivery (section
  // 2.4, release step 6) by leaving a tombstone: it stops counting, and a later
  // hold or register of the same holder adds nothing, so a repeated handoff or
  // expansion never resurrects it. The tombstone goes with its retired generation.
  retire(key: string, holder: string, now: number): void {
    this.validate(holder, now);
    this.checkKey(key);
    this.storage.transactionSync(() => this.tombstone(key, holder, now));
  }

  release(key: string, holder: string, now: number): void {
    this.validate(holder, now);
    if (!isObjectKey(key)) throw new Error('Invalid sweeper reference');
    this.storage.transactionSync(() => {
      // A tombstone is kept; only held and provisional holders count.
      const removed = this.sql.exec<{ state: HolderState }>(`DELETE FROM generation_holders
        WHERE key = ? AND holder = ? AND state != 'tombstone' RETURNING state`, key, holder).toArray()[0]?.state;
      if (removed === 'held' || removed === 'provisional') this.count(key, -1, now);
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
    const expiry = this.sql.exec<{ expires_at: number }>(`SELECT expires_at FROM generation_holders
      WHERE state = 'provisional' ORDER BY expires_at, key, holder LIMIT 1`).toArray()[0];
    const due = [first ? first.last_ref_at + RETENTION_MS : undefined, retry?.retry_at, expiry?.expires_at]
      .filter((at): at is number => at !== undefined);
    return due.length ? Math.min(...due) : null;
  }

  // Due provisional holders stop counting but keep their row, so a later
  // confirm can tell an expiry from a release. The grace counts from now.
  private expire(now: number): void {
    const due = this.sql.exec<{ key: string; holder: string }>(`SELECT key, holder FROM generation_holders
      WHERE state = 'provisional' AND expires_at <= ? ORDER BY expires_at, key, holder LIMIT ?`, now, EXPIRY_BATCH).toArray();
    for (const { key, holder } of due) {
      this.sql.exec(`UPDATE generation_holders SET state = 'expired', expires_at = NULL WHERE key = ? AND holder = ?`, key, holder);
      this.count(key, -1, now);
    }
  }

  // `clock` reads the time a DELETE was confirmed; the second delete is a day after that, not after `now`.
  async sweep(now: number, remove: (key: string) => Promise<void>, clock: () => number = () => now): Promise<void> {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid sweeper time');
    const work = this.storage.transactionSync(() => {
      this.expire(now);
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
      const confirmed = Math.max(now, clock());
      this.storage.transactionSync(() => {
        const row = this.sql.exec<{ deleted_at: number | null }>('SELECT deleted_at FROM generations WHERE key = ? AND retry_at IS NOT NULL', key)
          .toArray()[0];
        if (!row) return;
        if (row.deleted_at === null) {
          // The first confirmed delete: delete once more a day later, for an
          // object that a late PUT may recreate meanwhile. The row stays retired.
          this.sql.exec('UPDATE generations SET deleted_at = ?, retry_at = ?, attempts = 0 WHERE key = ?', confirmed, confirmed + SECOND_DELETE_MS, key);
          return;
        }
        // A retired generation has no counted holders; drop the rows that remain first.
        this.sql.exec(`DELETE FROM generation_holders WHERE key = ? AND state IN ('expired', 'tombstone')`, key);
        this.sql.exec('DELETE FROM generations WHERE key = ? AND retry_at IS NOT NULL', key);
      });
    }));
  }

  private validate(holder: string, now: number): void {
    if (typeof holder !== 'string' || holder.length < 1 || holder.length > 256 || !Number.isSafeInteger(now) || now < 0) {
      throw new Error('Invalid sweeper reference');
    }
  }
}
