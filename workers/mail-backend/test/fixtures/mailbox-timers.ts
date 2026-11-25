import { DurableObject } from 'cloudflare:workers';
import { Mailbox } from '../../src/mailbox-do.ts';
import { MailboxIndex, storedLifecycle } from '../../src/mailbox-index.ts';
import { MailboxRecovery, readyLife, SNAPSHOT_INTERVAL_MS, type Lifecycle } from '../../src/mailbox-recovery.ts';
import { JOURNAL_FLUSH, JOURNAL_FLUSH_REF, TimerTable, type TimerRun } from '../../src/mailbox-timers.ts';
import type { Env } from '../../src/worker.ts';

const scope = { workspaceId: 'workspace', mailboxId: 'mailbox' };
// What the test-only handler does with the row it runs:
// - `hang` moves the row to `at` (if given) in its first step, then awaits until released;
// - `hang-throw` hangs without moving the row, then throws when released;
// - `due-lane` makes journal_flush due and deletes its own row;
// - `crash` commits directly (no handler-side alarm write), then resets the object;
// - `async-step` and `async-write` hand `local` a step that returns a promise.
type Plan = 'delete' | 'keep' | 'throw' | 'move-and-throw' | 'crash' | 'hang' | 'hang-throw' | 'due-lane' | 'async-step' | 'async-write';
// Work a test injects right after an alarm call claims its rows (its first alarm write).
// `hold` keeps the work lane for `ms`, then moves the timer clock forward by `advance`.
// `edit` is a first write on a mailbox without state: a flag edit on `message`, or a label edit.
type OnClaim = { kind: 'edit'; message?: string } | { kind: 'hold'; ms: number; advance?: number } | { kind: 'replace'; ref: string };

// A mailbox with two test-only timer kinds. Fixture tables live in the same
// SQLite database, so a handler's record commits atomically with its row change.
export class TimerMailbox extends Mailbox {
  private clockOffset = 0;
  private label = '';
  private armed: number | null = null;
  private rebuildFault: false | 'throw' | 'async' = false;
  private alarmWriteCount = 0;
  private hangsReleased = false;
  private readonly hangs: Array<PromiseWithResolvers<void>> = [];
  private readonly active = new Map<string, number>();
  private overlaps = 0;
  private errors: string[] = [];
  private onClaim: OnClaim | null = null;
  private injected: Promise<unknown> = Promise.resolve();
  // When the injected edit ran: its deadline was armed between these times.
  private editWindow: { before: number; after: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, SWEEPER: { getByName: () => ({
      register: async () => { throw new Error('Unexpected timer fixture registration'); },
      hold: async () => {}, release: async () => {},
    }) } });
    this.fixtureSchema();
    // A shortened retry survives an object reset, so the platform delivers the successor alarm in a test.
    const retry = ctx.storage.sql.exec<{ value: number }>("SELECT value FROM fixture_settings WHERE name = 'retry'").toArray()[0];
    if (retry) this.timerRetryMs = retry.value;
    const storage = ctx.storage;
    const setAlarm = storage.setAlarm.bind(storage);
    const deleteAlarm = storage.deleteAlarm.bind(storage);
    // Record what the mailbox armed: an immediate alarm fires (and is cleared) before a test can read it.
    Object.defineProperty(storage, 'setAlarm', { value: (...args: Parameters<typeof setAlarm>) => {
      this.armed = Number(args[0]);
      this.alarmWriteCount++;
      const inject = this.onClaim;
      this.onClaim = null;
      if (inject) this.inject(inject);
      return setAlarm(...args);
    } });
    Object.defineProperty(storage, 'deleteAlarm', { value: (...args: Parameters<typeof deleteAlarm>) => {
      this.armed = null;
      return deleteAlarm(...args);
    } });
    for (const kind of ['test_a', 'test_b']) {
      this.registerTimerKind(kind, {
        run: timer => this.fire(kind, timer),
        rebuild: (timers, now) => {
          if (this.rebuildFault === 'throw') throw new Error('Fixture rebuild failure');
          if (this.rebuildFault === 'async') {
            // Defers its write past an await: refused, and the write must not land.
            const late = async () => {
              await Promise.resolve();
              timers.set(kind, 'late-rebuild', now + 600_000);
            };
            return late() as unknown as undefined;
          }
          this.ctx.storage.sql.exec(`INSERT INTO fixture_rebuilds (kind, state)
            VALUES (?, (SELECT json_extract(value, '$.state') FROM lifecycle WHERE id = 1))`, kind);
          timers.set(kind, 'rebuilt', now + 600_000);
        },
      });
    }
  }

  protected override timerNow(): number { return Date.now() + this.clockOffset; }

  // Queued in the work lane behind the claim, as a concurrent RPC would be.
  private inject(work: OnClaim) {
    if (work.kind === 'edit') {
      // ready() creates the mailbox's baseline, then the edit arms its deadline (hourly for flags, a minute for a label).
      const before = Date.now();
      const edit = work.message
        ? this.setFlags(scope.workspaceId, scope.mailboxId, work.message, 1, [])
        : this.setLabel(scope.workspaceId, scope.mailboxId, 'first', 'First');
      this.injected = edit.then(() => { this.editWindow = { before, after: Date.now() }; });
    } else if (work.kind === 'hold') {
      this.injected = this.workLane(async () => {
        await new Promise(resolve => setTimeout(resolve, work.ms));
        this.clockOffset += work.advance ?? 0;
      });
    } else {
      const due = new TimerTable(this.ctx.storage.sql).due('test_a', work.ref)!;
      // Replace the claimed row with the same due time.
      this.injected = this.workLane(() => this.setTimer('test_a', work.ref, due));
    }
  }

  private fixtureSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS fixture_fired (seq INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, kind TEXT NOT NULL,
        ref TEXT NOT NULL, now INTEGER NOT NULL, flushed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fixture_plan (ref TEXT PRIMARY KEY, action TEXT NOT NULL, at INTEGER);
      CREATE TABLE IF NOT EXISTS fixture_rebuilds (kind TEXT NOT NULL, state TEXT);
      CREATE TABLE IF NOT EXISTS fixture_dispatch (seq INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fixture_settings (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fixture_alarm_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fixture_crash (armed INTEGER, rows TEXT NOT NULL);`);
  }

  private async fire(kind: string, { ref, now, local }: TimerRun) {
    const key = `${kind}/${ref}`;
    if (this.active.get(key)) this.overlaps++;
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      await this.act(kind, ref, now, local);
    } catch (error) {
      this.errors.push(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      const left = this.active.get(key)! - 1;
      if (left) this.active.set(key, left);
      else this.active.delete(key);
    }
  }

  private record(kind: string, ref: string, now: number) {
    const sql = this.ctx.storage.sql;
    this.fixtureSchema();
    // Whether the mailbox journal was fully published when this handler first ran.
    const { flushed } = sql.exec<{ flushed: number }>('SELECT modseq = flushed AS flushed FROM state').one();
    sql.exec('INSERT INTO fixture_fired (label, kind, ref, now, flushed) VALUES (?, ?, ?, ?, ?)', this.label, kind, ref, now, flushed);
  }

  private hang(): Promise<void> {
    const gate = Promise.withResolvers<void>();
    this.hangs.push(gate);
    // A release of every call also covers one that registers its gate later.
    if (this.hangsReleased) gate.resolve();
    return gate.promise;
  }

  private async act(kind: string, ref: string, now: number, local: TimerRun['local']) {
    this.fixtureSchema();
    const sql = this.ctx.storage.sql;
    const plan = sql.exec<{ action: Plan; at: number | null }>('SELECT action, at FROM fixture_plan WHERE ref = ?', ref).toArray()[0];
    const action = plan?.action ?? 'delete';
    if (action === 'async-step') {
      await local((async () => {}) as unknown as () => void);
      return;
    }
    if (action === 'async-write') {
      // The step awaits, then writes: the write must not land after the step has ended.
      const step = async (timers: TimerTable) => {
        await Promise.resolve();
        try { timers.set(kind, 'late', 1); } catch (error) { this.errors.push(`late write: ${(error as Error).message}`); }
      };
      await local(step as unknown as (timers: TimerTable) => void);
      return;
    }
    if (action === 'crash') {
      // What survives the crash: the alarm armed when it happens, and the other rows' due times.
      const armed = await this.ctx.storage.getAlarm();
      this.ctx.storage.transactionSync(() => {
        this.record(kind, ref, now);
        new TimerTable(sql).delete(kind, ref);
        const others = sql.exec("SELECT due_at, ref FROM timers WHERE kind <> 'journal_flush' ORDER BY ref").toArray();
        sql.exec('INSERT INTO fixture_crash VALUES (?, ?)', armed, JSON.stringify(others));
      });
      // The commit is durable before the object is reset mid-run; nothing re-armed after it.
      await this.ctx.storage.sync();
      this.ctx.abort('Fixture crash after a handler commit');
    }
    await local(timers => {
      this.record(kind, ref, now);
      if (action === 'delete') timers.delete(kind, ref);
      if (action === 'due-lane') {
        timers.delete(kind, ref);
        timers.set(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, now - 1);
      }
      if ((action === 'move-and-throw' || action === 'hang') && plan!.at !== null) timers.set(kind, ref, plan!.at);
    });
    if (action === 'throw' || action === 'move-and-throw') throw new Error('Fixture handler failure');
    if (action === 'hang') await this.hang();
    if (action === 'hang-throw') {
      await this.hang();
      throw new Error('Fixture late handler failure');
    }
  }

  private localIndex() {
    const unexpected = async () => { throw new Error('Unexpected timer fixture object I/O'); };
    return new MailboxIndex(this.ctx.storage, {
      get: unexpected, put: unexpected, register: unexpected, hold: async () => {}, release: async () => {},
    }, this.ctx.id.toString());
  }

  // `stale` backdates the last snapshot, so the journal lane raises backup_stale.
  async setup(mode: 'ready' | 'missing', stale = false) {
    const index = this.localIndex();
    const now = Date.now();
    const incarnation = crypto.randomUUID();
    index.setLifecycle({ state: 'init', scope, incarnation });
    if (mode === 'ready') {
      const etag = await new MailboxRecovery(index, this.env.MAIL_STATE, this.ctx.id.toString()).create(incarnation);
      if (!etag) throw new Error('Fixture manifest exists');
      const life = readyLife(scope, incarnation, etag, 1, now);
      index.setLifecycle(stale ? { ...life, lastSnapshotAt: now - 2 * SNAPSHOT_INTERVAL_MS - 1000 } : life);
    } else {
      index.setLifecycle({ state: 'missing', scope, incarnation, since: now, failures: 0 });
    }
    return this.ctx.id.toString();
  }

  // Background alarms are ignored so they cannot race test checkpoints, except
  // platform-fired alarms a test queued. Requests are stored, so each is
  // consumed once even if the object is reset during its alarm.
  override async alarm() {
    this.fixtureSchema();
    const sql = this.ctx.storage.sql;
    // Every platform-fired alarm call is recorded, consumed request or not.
    const next = sql.exec<{ label: string }>('SELECT label FROM fixture_dispatch ORDER BY seq LIMIT 1').toArray()[0];
    sql.exec('INSERT INTO fixture_alarm_runs (label, at) VALUES (?, ?)', next?.label ?? null, Date.now());
    const request = sql.exec<{ seq: number; label: string }>('SELECT seq, label FROM fixture_dispatch ORDER BY seq LIMIT 1').toArray()[0];
    if (!request) return;
    sql.exec('DELETE FROM fixture_dispatch WHERE seq = ?', request.seq);
    this.label = request.label;
    await super.alarm();
  }
  async dispatchAlarms(...labels: string[]) {
    this.fixtureSchema();
    for (const label of labels) this.ctx.storage.sql.exec('INSERT INTO fixture_dispatch (label) VALUES (?)', label);
  }
  async setRetry(ms: number) {
    this.fixtureSchema();
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO fixture_settings VALUES ('retry', ?)", ms);
    this.timerRetryMs = ms;
  }
  async run(label: string, onClaim: OnClaim | null = null) {
    this.label = label;
    this.onClaim = onClaim;
    try {
      await super.alarm();
    } finally {
      this.onClaim = null;
    }
    await this.injected;
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

  // State an earlier version left: its alarm armed, and no journal_flush row. The object restarts.
  async seedLegacyAlarm(at: number) {
    new TimerTable(this.ctx.storage.sql).delete(JOURNAL_FLUSH, JOURNAL_FLUSH_REF);
    // An earlier version had no timers table, so it never recorded the one-time migration.
    this.ctx.storage.sql.exec('DELETE FROM timers_migrated');
    await this.ctx.storage.setAlarm(at);
    await this.ctx.storage.sync();
    this.ctx.abort('Fixture restart after seeding a legacy alarm');
  }

  // Restarts the object, as an eviction would.
  async evict() {
    await this.ctx.storage.sync();
    this.ctx.abort('Fixture eviction');
  }
  async editTimes() { return this.editWindow; }
  // Resolves after every work-lane step queued before it.
  async barrier() { await this.workLane(async () => {}); }
  // A stored message, before the mailbox has a lifecycle.
  async seedMessage(id: string, rawKey: string) {
    this.localIndex().restoreSnapshotRow({ row_no: 1, kind: 'message', value: JSON.stringify({
      id, rawKey, threadId: id, createdAt: 1, dedupeKey: 'fixture', flags: 0, gmailId: null, labels: [], auth: 'none', attKeys: [],
    }) });
  }
  async messageFlags(id: string) {
    return this.ctx.storage.sql.exec<{ flags: number }>('SELECT flags FROM messages WHERE id = ?', id).one().flags;
  }

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
    return JSON.stringify(this.ctx.storage.sql.exec('SELECT label, kind, ref, now, flushed FROM fixture_fired ORDER BY seq').toArray());
  }

  async rebuilds() {
    this.fixtureSchema();
    return JSON.stringify(this.ctx.storage.sql.exec('SELECT kind, state FROM fixture_rebuilds ORDER BY kind').toArray());
  }

  async setClockOffset(ms: number) { this.clockOffset = ms; }
  async setBackendEnabled(on: boolean) { this.env.MAIL_BACKEND_ENABLED = on ? 'on' : 'off'; }
  async crashState() {
    this.fixtureSchema();
    const row = this.ctx.storage.sql.exec<{ armed: number | null; rows: string }>('SELECT armed, rows FROM fixture_crash').toArray()[0];
    return row ? { armed: row.armed, rows: JSON.parse(row.rows) as Array<{ due_at: number; ref: string }> } : null;
  }
  async alarmRuns() {
    this.fixtureSchema();
    return JSON.stringify(this.ctx.storage.sql.exec('SELECT label, at FROM fixture_alarm_runs ORDER BY seq').toArray());
  }
  async setBudgets(handlerMs: number, runMs: number) {
    this.timerHandlerBudgetMs = handlerMs;
    this.timerRunBudgetMs = runMs;
  }
  // Sets the journal_flush row directly, as the lane's own deadline would.
  async setLaneDue(at: number, arm = false) {
    new TimerTable(this.ctx.storage.sql).set(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, at);
    if (arm) await this.ctx.storage.setAlarm(at);
  }
  // Releases one hung call (by start order), or all of them.
  async releaseHang(index?: number) {
    if (index === undefined) this.hangsReleased = true;
    else if (!this.hangs[index]) throw new Error('Fixture hang not registered');
    for (const [i, gate] of this.hangs.entries()) if (index === undefined || i === index) gate.resolve();
  }
  async hangCount() { return this.hangs.length; }
  async handlerState() {
    return { active: [...this.active.keys()].sort(), running: Object.fromEntries(this.active), overlaps: this.overlaps, errors: this.errors };
  }
  async setRebuildFault(fault: false | 'throw' | 'async') { this.rebuildFault = fault; }
  async alarmWrites() { return { count: this.alarmWriteCount, last: this.armed }; }
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
