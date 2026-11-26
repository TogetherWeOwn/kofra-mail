import { DurableObject } from 'cloudflare:workers';
import type { ObjectKind } from '../../src/object-key.ts';
import { RETENTION_MS } from '../../src/reconcile.ts';
import { Sweeper } from '../../src/sweeper-do.ts';
import { SweepLedger, type ConfirmEntry, type HoldTarget, type SendHolders, type SendReleaseMode } from '../../src/sweep-ledger.ts';
import type { Env } from '../../src/worker.ts';

export type HolderRow = { key: string; holder: string; state: string; expires_at: number | null };
export type GenerationRow = { key: string; holder_count: number; last_ref_at: number; retry_at: number | null };

// The generation_holders schema as the ledger created it before holder states.
// Frozen here so the migration test runs against a ledger written by that code.
const LEGACY_LEDGER = `
CREATE TABLE generations (
  key TEXT PRIMARY KEY NOT NULL,
  prefix TEXT,
  holder_count INTEGER NOT NULL CHECK (holder_count >= 0),
  last_ref_at INTEGER NOT NULL,
  retry_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  CHECK (retry_at IS NULL OR (holder_count = 0 AND prefix IS NOT NULL))
);
CREATE UNIQUE INDEX live_generation ON generations(prefix) WHERE retry_at IS NULL AND prefix IS NOT NULL;
CREATE INDEX due_generation ON generations(last_ref_at, key)
  WHERE holder_count = 0 AND retry_at IS NULL AND prefix IS NOT NULL;
CREATE INDEX due_delete ON generations(retry_at, key) WHERE retry_at IS NOT NULL;
CREATE TABLE generation_holders (
  key TEXT NOT NULL REFERENCES generations(key),
  holder TEXT NOT NULL,
  PRIMARY KEY (key, holder)
);
CREATE TABLE generation_clock (id INTEGER PRIMARY KEY CHECK (id = 1), stamp INTEGER NOT NULL);
INSERT OR IGNORE INTO generation_clock VALUES (1, 0);
`;

// Ledger operations with an explicit clock.
export class ProvisionalLedger extends DurableObject {
  private ledger() { return new SweepLedger(this.ctx.storage); }
  async register(kind: ObjectKind, digest: string, holder: string, now: number) { return this.ledger().register(kind, digest, holder, now); }
  async hold(key: string, holder: string, now: number) { this.ledger().hold(key, holder, now); }
  async holdProvisional(target: HoldTarget, holder: string, now: number) { return this.ledger().holdProvisional(target, holder, now); }
  async confirm(entries: ConfirmEntry[], now: number) { return this.ledger().confirm(entries, now); }
  async release(key: string, holder: string, now: number) { this.ledger().release(key, holder, now); }
  async candidates(now: number) { return this.ledger().candidates(now); }
  async registerSend(mailbox: string, sendId: string, digest: string, holders: SendHolders, now: number) {
    return JSON.stringify(this.ledger().registerSend(mailbox, sendId, digest, holders, now));
  }
  async releaseSend(mailbox: string, sendId: string, mode: SendReleaseMode, now: number) { this.ledger().releaseSend(mailbox, sendId, mode, now); }
  async registration(mailbox: string, sendId: string) {
    this.ledger();
    return JSON.stringify(this.ctx.storage.sql.exec('SELECT digest, key, raw_holder, index_holder, released FROM send_registrations WHERE mailbox = ? AND send_id = ?',
      mailbox, sendId).toArray()[0] ?? null);
  }
  // A stand-in object store, so a test can recreate an object between the two deletes.
  private readonly stored = new Set<string>();
  async putObject(key: string) { this.stored.add(key); }
  async hasObject(key: string) { return this.stored.has(key); }
  async sweepStore(now: number) {
    const removed: string[] = [];
    await this.ledger().sweep(now, async key => { removed.push(key); this.stored.delete(key); });
    return removed.sort();
  }
  async deletedAt(key: string) {
    this.ledger();
    return this.ctx.storage.sql.exec<{ deleted_at: number | null }>('SELECT deleted_at FROM generations WHERE key = ?', key).toArray()[0]?.deleted_at ?? null;
  }

  // The test proxy does not carry rejections, so report the error message instead.
  async failure(method: 'register' | 'hold' | 'holdProvisional' | 'confirm', ...args: unknown[]): Promise<string> {
    try {
      await (this[method] as (...values: unknown[]) => Promise<unknown>)(...args);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  async nextSweepAt() { return this.ledger().nextSweepAt(); }

  // Returns the keys whose DELETE was attempted; a failed DELETE keeps the retired row.
  async sweep(now: number, deletes: 'succeed' | 'fail' = 'succeed') {
    const attempted: string[] = [];
    await this.ledger().sweep(now, async key => {
      attempted.push(key);
      if (deletes === 'fail') throw new Error('DELETE outcome not confirmed');
    });
    return attempted.sort();
  }

  async holders(key?: string): Promise<HolderRow[]> {
    this.ledger();
    const rows = key === undefined
      ? this.ctx.storage.sql.exec<HolderRow>('SELECT key, holder, state, expires_at FROM generation_holders ORDER BY key, holder')
      : this.ctx.storage.sql.exec<HolderRow>('SELECT key, holder, state, expires_at FROM generation_holders WHERE key = ? ORDER BY holder', key);
    return rows.toArray();
  }

  // A JSON string, because the test proxy adds a symbol to returned objects.
  async generation(key: string): Promise<string> {
    this.ledger();
    return JSON.stringify(this.ctx.storage.sql.exec<GenerationRow>('SELECT key, holder_count, last_ref_at, retry_at FROM generations WHERE key = ?', key)
      .toArray()[0] ?? null);
  }

  // M3-3 adds the API that writes tombstones; until then only this fixture does.
  async seedTombstone(key: string, holder: string) {
    this.ledger();
    this.ctx.storage.sql.exec(`INSERT INTO generation_holders(key, holder, state) VALUES (?, ?, 'tombstone')`, key, holder);
  }

  // Writes a ledger exactly as the previous schema did, before any SweepLedger opens it.
  async seedLegacy(key: string, holders: string[], now: number) {
    const sql = this.ctx.storage.sql;
    sql.exec(LEGACY_LEDGER);
    const [kind, digest] = key.split('/');
    sql.exec('INSERT INTO generations(key,prefix,holder_count,last_ref_at) VALUES (?,?,?,?)', key, `${kind}/${digest}`, holders.length, now);
    for (const holder of holders) sql.exec('INSERT INTO generation_holders VALUES (?, ?)', key, holder);
  }

  async holderColumns() {
    this.ledger();
    return this.ctx.storage.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('generation_holders') ORDER BY cid`)
      .toArray().map(row => row.name);
  }

  async expiryIndexPlan(now: number) {
    this.ledger();
    return this.ctx.storage.sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT key, holder FROM generation_holders
      WHERE state = 'provisional' AND expires_at <= ? ORDER BY expires_at, key, holder LIMIT 64`, now).toArray().map(row => row.detail);
  }
}

type FixtureEnv = Env & { ALARM_COMPLETE: Fetcher };

// The Durable Object with its real alarm and switches the test can flip.
export class ProvisionalSweeper extends Sweeper {
  private readonly switches: FixtureEnv;
  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    const switches = { ...env };
    super(ctx, switches);
    this.switches = switches;
  }

  async enableSweeping() { this.switches.MAIL_SWEEP_ENABLED = 'on'; }
  async alarmAt() { return this.ctx.storage.getAlarm(); }
  async setAlarmAt(at: number) { await this.ctx.storage.setAlarm(at); }
  async nextSweep() { return new SweepLedger(this.ctx.storage).nextSweepAt(); }
  // A generation past its retention grace, written without arming the alarm
  // (as a ledger from before off-mode arming could be).
  async seedOverdue(digest: string) {
    const ledger = new SweepLedger(this.ctx.storage);
    const at = Date.now() - RETENTION_MS - 60_000;
    const key = ledger.register('raw', digest, 'delivery:1', at);
    ledger.release(key, 'delivery:1', at);
    return key;
  }
  async holders(): Promise<HolderRow[]> {
    return this.ctx.storage.sql.exec<HolderRow>('SELECT key, holder, state, expires_at FROM generation_holders ORDER BY key, holder').toArray();
  }
  async generation(key: string): Promise<GenerationRow | null> {
    return this.ctx.storage.sql.exec<GenerationRow>('SELECT key, holder_count, last_ref_at, retry_at FROM generations WHERE key = ?', key)
      .toArray()[0] ?? null;
  }

  override async alarm() {
    await super.alarm();
    await this.switches.ALARM_COMPLETE.fetch('https://alarm.invalid/done');
  }

  // Moves every provisional expiry and the armed alarm to just ahead of now,
  // keeping their order. Fails if holdProvisional left no alarm.
  async bringExpiryForward() {
    const armed = await this.ctx.storage.getAlarm();
    if (armed === null) throw new Error('No sweep alarm to advance');
    const due = Date.now() + 50;
    const first = this.ctx.storage.sql.exec<{ at: number }>(`SELECT min(expires_at) AS at FROM generation_holders
      WHERE state = 'provisional'`).one().at;
    if (armed > first) throw new Error('The armed alarm is later than the earliest expiry');
    this.ctx.storage.sql.exec(`UPDATE generation_holders SET expires_at = expires_at - ? WHERE state = 'provisional'`, first - due);
    this.ctx.storage.sql.exec('UPDATE generations SET last_ref_at = last_ref_at - ?', first - due);
    await this.ctx.storage.setAlarm(due - (first - armed));
    return due;
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
