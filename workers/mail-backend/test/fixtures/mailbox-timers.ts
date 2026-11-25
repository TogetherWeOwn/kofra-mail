import { DurableObject } from 'cloudflare:workers';
import { Mailbox } from '../../src/mailbox-do.ts';
import { MailboxIndex, storedLifecycle } from '../../src/mailbox-index.ts';
import { MailboxRecovery, readyLife, type Lifecycle } from '../../src/mailbox-recovery.ts';
import { TimerTable } from '../../src/mailbox-timers.ts';
import type { Env } from '../../src/worker.ts';

const scope = { workspaceId: 'workspace', mailboxId: 'mailbox' };
// What the test-only handler does with the row it runs.
type Plan = 'delete' | 'keep' | 'throw' | 'move-and-throw' | 'crash';

// A mailbox with two test-only timer kinds. Fixture tables live in the same
// SQLite database, so a handler's record commits atomically with its row change.
export class TimerMailbox extends Mailbox {
  private clockOffset = 0;
  private label = '';
  private armed: number | null = null;
  private rebuildFault = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, SWEEPER: { getByName: () => ({
      register: async () => { throw new Error('Unexpected timer fixture registration'); },
      hold: async () => {}, release: async () => {},
    }) } });
    const storage = ctx.storage;
    const setAlarm = storage.setAlarm.bind(storage);
    const deleteAlarm = storage.deleteAlarm.bind(storage);
    // Record what the mailbox armed: an immediate alarm fires (and is cleared) before a test can read it.
    Object.defineProperty(storage, 'setAlarm', { value: (...args: Parameters<typeof setAlarm>) => {
      this.armed = Number(args[0]);
      return setAlarm(...args);
    } });
    Object.defineProperty(storage, 'deleteAlarm', { value: (...args: Parameters<typeof deleteAlarm>) => {
      this.armed = null;
      return deleteAlarm(...args);
    } });
    for (const kind of ['test_a', 'test_b']) {
      this.registerTimerKind(kind, {
        run: (ref, now) => this.fire(kind, ref, now),
        rebuild: (timers, now) => {
          if (this.rebuildFault) throw new Error('Fixture rebuild failure');
          this.fixtureSchema();
          this.ctx.storage.sql.exec(`INSERT INTO fixture_rebuilds (kind, state)
            VALUES (?, (SELECT json_extract(value, '$.state') FROM lifecycle WHERE id = 1))`, kind);
          timers.set(kind, 'rebuilt', now + 600_000);
        },
      });
    }
  }

  protected override timerNow(): number { return Date.now() + this.clockOffset; }

  private fixtureSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS fixture_fired (seq INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, kind TEXT NOT NULL,
        ref TEXT NOT NULL, now INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fixture_plan (ref TEXT PRIMARY KEY, action TEXT NOT NULL, at INTEGER);
      CREATE TABLE IF NOT EXISTS fixture_rebuilds (kind TEXT NOT NULL, state TEXT);`);
  }

  private async fire(kind: string, ref: string, now: number) {
    this.fixtureSchema();
    const sql = this.ctx.storage.sql;
    const plan = sql.exec<{ action: Plan; at: number | null }>('SELECT action, at FROM fixture_plan WHERE ref = ?', ref).toArray()[0];
    const action = plan?.action ?? 'delete';
    const timers = new TimerTable(sql);
    this.ctx.storage.transactionSync(() => {
      sql.exec('INSERT INTO fixture_fired (label, kind, ref, now) VALUES (?, ?, ?, ?)', this.label, kind, ref, now);
      if (action === 'delete' || action === 'crash') timers.delete(kind, ref);
      if (action === 'move-and-throw') timers.set(kind, ref, plan!.at!);
    });
    if (action === 'throw' || action === 'move-and-throw') throw new Error('Fixture handler failure');
    if (action === 'crash') {
      // The commit above is durable before the object is reset mid-run.
      await this.ctx.storage.sync();
      this.ctx.abort('Fixture crash after a handler commit');
    }
  }

  private localIndex() {
    const unexpected = async () => { throw new Error('Unexpected timer fixture object I/O'); };
    return new MailboxIndex(this.ctx.storage, {
      get: unexpected, put: unexpected, register: unexpected, hold: async () => {}, release: async () => {},
    }, this.ctx.id.toString());
  }

  async setup(mode: 'ready' | 'missing') {
    const index = this.localIndex();
    const now = Date.now();
    const incarnation = crypto.randomUUID();
    index.setLifecycle({ state: 'init', scope, incarnation });
    if (mode === 'ready') {
      const etag = await new MailboxRecovery(index, this.env.MAIL_STATE, this.ctx.id.toString()).create(incarnation);
      if (!etag) throw new Error('Fixture manifest exists');
      index.setLifecycle(readyLife(scope, incarnation, etag, 1, now));
    } else {
      index.setLifecycle({ state: 'missing', scope, incarnation, since: now, failures: 0 });
    }
    return this.ctx.id.toString();
  }

  // Drive the real handler explicitly so background alarms cannot race test checkpoints.
  override async alarm() {}
  async run(label: string) {
    this.label = label;
    await super.alarm();
  }

  async schedule(kind: string, ref: string, at: number, lowerOnly = false) {
    await this.workLane(() => this.setTimer(kind, ref, at, lowerOnly));
  }
  async cancel(kind: string, ref: string) { await this.workLane(() => this.deleteTimer(kind, ref)); }
  async scheduleError(kind: string, ref: string, at: number) {
    try {
      await this.schedule(kind, ref, at);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  // Seeds `count` due rows directly, alternating kinds and repeating due times so ordering ties are exercised.
  async seed(count: number, base: number) {
    const timers = new TimerTable(this.ctx.storage.sql);
    this.ctx.storage.transactionSync(() => {
      for (let i = 0; i < count; i++) timers.set(i % 2 ? 'test_b' : 'test_a', `r${String(i).padStart(4, '0')}`, base + (i % 10));
    });
  }

  // A stale row with no source state, as a restore target might hold before its reset.
  async seedStale(kind: string, ref: string, at: number) { new TimerTable(this.ctx.storage.sql).set(kind, ref, at); }

  async plan(ref: string, action: Plan, at: number | null = null) {
    this.fixtureSchema();
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO fixture_plan VALUES (?, ?, ?)', ref, action, at);
  }

  async rows() {
    new TimerTable(this.ctx.storage.sql);
    return JSON.stringify(this.ctx.storage.sql.exec('SELECT due_at, kind, ref FROM timers ORDER BY due_at, kind, ref').toArray());
  }

  async fired() {
    this.fixtureSchema();
    return JSON.stringify(this.ctx.storage.sql.exec('SELECT label, kind, ref, now FROM fixture_fired ORDER BY seq').toArray());
  }

  async rebuilds() {
    this.fixtureSchema();
    return JSON.stringify(this.ctx.storage.sql.exec('SELECT kind, state FROM fixture_rebuilds ORDER BY kind').toArray());
  }

  async setClockOffset(ms: number) { this.clockOffset = ms; }
  async setRebuildFault(on: boolean) { this.rebuildFault = on; }
  async alarmAt() { return this.ctx.storage.getAlarm(); }
  async lastArmed() { return this.armed; }
  async lifecycle() { return JSON.stringify(storedLifecycle<Lifecycle>(this.ctx.storage)); }
  async labels() { return JSON.stringify(this.ctx.storage.sql.exec('SELECT id, name FROM labels ORDER BY id').toArray()); }

  async wipe() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export class UnusedSweeper extends DurableObject {}

export default {};
