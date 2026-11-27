import { DurableObject } from 'cloudflare:workers';
import { fenceBefore, type QuotaAnswer, type QuotaPort, type QuotaScope, type SendFence } from '../../src/mailbox-send-quota.ts';

// A recording stand-in for the account quota object (M3-6) behind the
// QuotaPort: balances per fence and quota day, the newest fence per recipient,
// released fences, injected failures and an exhausted gate. Durable, so a
// mailbox restart or a failed call cannot lose what was recorded.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS quota_reservations (ws TEXT NOT NULL, mb TEXT NOT NULL, send_id TEXT NOT NULL, recipient INTEGER NOT NULL,
  day TEXT NOT NULL, epoch INTEGER NOT NULL, attempt INTEGER NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ws, mb, send_id, recipient, day, epoch, attempt));
CREATE TABLE IF NOT EXISTS quota_newest (ws TEXT NOT NULL, mb TEXT NOT NULL, send_id TEXT NOT NULL, recipient INTEGER NOT NULL,
  epoch INTEGER NOT NULL, attempt INTEGER NOT NULL, PRIMARY KEY (ws, mb, send_id, recipient));
CREATE TABLE IF NOT EXISTS quota_released (ws TEXT NOT NULL, mb TEXT NOT NULL, send_id TEXT NOT NULL, epoch INTEGER NOT NULL,
  attempt INTEGER NOT NULL, PRIMARY KEY (ws, mb, send_id, epoch, attempt));
CREATE TABLE IF NOT EXISTS quota_days (day TEXT PRIMARY KEY, ends_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS quota_config (id INTEGER PRIMARY KEY CHECK (id = 1), day TEXT NOT NULL, exhausted INTEGER NOT NULL,
  month_limit INTEGER, month_end INTEGER);
CREATE TABLE IF NOT EXISTS quota_failures (method TEXT PRIMARY KEY, remaining INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS quota_calls (n INTEGER PRIMARY KEY, method TEXT NOT NULL, body TEXT NOT NULL);
`;

export type QuotaCall = { method: string; scope: QuotaScope; fences: SendFence[] };

export class FakeSendQuota extends DurableObject<{ INITIAL_TIME: number }> implements QuotaPort {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: { INITIAL_TIME: number }) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    this.sql.exec("INSERT OR IGNORE INTO quota_config VALUES (1, 'day-0', 0, NULL, NULL)");
    this.sql.exec("INSERT OR IGNORE INTO quota_days VALUES ('day-0', ?)", env.INITIAL_TIME + 24 * 60 * 60_000);
  }

  // `exhausted` closes the daily gate; `month_limit` charges in all are allowed until `month_end`.
  private config() {
    return this.sql.exec<{ day: string; exhausted: number; month_limit: number | null; month_end: number | null }>(
      'SELECT day, exhausted, month_limit, month_end FROM quota_config').one();
  }
  // The reset of the gate that refuses `wanted` more charges, or null when both admit them.
  private refusal(wanted: number): number | null {
    const { day, exhausted, month_limit: limit, month_end: monthEnd } = this.config();
    if (exhausted) return this.endOf(day);
    if (limit === null) return null;
    const used = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM quota_reservations').one().n;
    return used + wanted > limit ? monthEnd : null;
  }
  private log(method: string, scope: QuotaScope, fences: SendFence[]) {
    this.sql.exec('INSERT INTO quota_calls (method, body) VALUES (?, ?)', method, JSON.stringify({ scope, fences }));
  }
  private fail(method: string) {
    const row = this.sql.exec<{ remaining: number }>('SELECT remaining FROM quota_failures WHERE method = ?', method).toArray()[0];
    if (!row?.remaining) return;
    this.sql.exec('UPDATE quota_failures SET remaining = remaining - 1 WHERE method = ?', method);
    throw new Error(`Fixture quota ${method} failure`);
  }
  private released(scope: QuotaScope, fence: SendFence) {
    return this.sql.exec('SELECT 1 FROM quota_released WHERE ws = ? AND mb = ? AND send_id = ? AND epoch = ? AND attempt = ?',
      scope.workspaceId, scope.mailboxId, scope.sendId, fence.epoch, fence.attempt).toArray().length === 1;
  }
  private superseded(scope: QuotaScope, fence: SendFence, recipients: number[]) {
    return recipients.some(recipient => {
      const newest = this.sql.exec<SendFence>('SELECT epoch, attempt FROM quota_newest WHERE ws = ? AND mb = ? AND send_id = ? AND recipient = ?',
        scope.workspaceId, scope.mailboxId, scope.sendId, recipient).toArray()[0];
      return !!newest && fenceBefore(fence, newest);
    });
  }
  private dropFence(scope: QuotaScope, fence: SendFence) {
    this.sql.exec('DELETE FROM quota_reservations WHERE ws = ? AND mb = ? AND send_id = ? AND epoch = ? AND attempt = ?',
      scope.workspaceId, scope.mailboxId, scope.sendId, fence.epoch, fence.attempt);
    this.sql.exec('INSERT OR IGNORE INTO quota_released VALUES (?, ?, ?, ?, ?)', scope.workspaceId, scope.mailboxId, scope.sendId, fence.epoch, fence.attempt);
  }

  async reserve(scope: QuotaScope, fence: SendFence, recipients: number[], release: SendFence[], _expiresAt: number): Promise<QuotaAnswer> {
    this.log('reserve', scope, [fence, ...release]);
    this.fail('reserve');
    return this.ctx.storage.transactionSync((): QuotaAnswer => {
      for (const entry of release) this.dropFence(scope, entry);
      if (this.released(scope, fence) || this.superseded(scope, fence, recipients)) return { status: 'stale' };
      const { day } = this.config();
      const closed = this.refusal(recipients.length);
      if (closed !== null) return { status: 'exhausted', resetAt: closed };
      for (const recipient of recipients) {
        this.sql.exec('INSERT OR REPLACE INTO quota_newest VALUES (?, ?, ?, ?, ?, ?)', scope.workspaceId, scope.mailboxId, scope.sendId, recipient,
          fence.epoch, fence.attempt);
        this.sql.exec('INSERT OR IGNORE INTO quota_reservations (ws, mb, send_id, recipient, day, epoch, attempt) VALUES (?, ?, ?, ?, ?, ?, ?)',
          scope.workspaceId, scope.mailboxId, scope.sendId, recipient, day, fence.epoch, fence.attempt);
      }
      return { status: 'ok', day, dayEnd: this.endOf(day) };
    });
  }

  async confirm(scope: QuotaScope, fence: SendFence, recipients: number[]): Promise<QuotaAnswer> {
    this.log('confirm', scope, [fence]);
    this.fail('confirm');
    return this.ctx.storage.transactionSync((): QuotaAnswer => {
      if (this.released(scope, fence) || this.superseded(scope, fence, recipients)) return { status: 'stale' };
      const { day } = this.config();
      const held = this.sql.exec<{ day: string }>('SELECT day FROM quota_reservations WHERE ws = ? AND mb = ? AND send_id = ? AND epoch = ? AND attempt = ?',
        scope.workspaceId, scope.mailboxId, scope.sendId, fence.epoch, fence.attempt).toArray();
      // A charge that must move to a new day, or be reserved again, needs an open gate.
      const closed = this.refusal(held.length ? 0 : recipients.length);
      if (closed !== null && (!held.length || held.some(row => row.day !== day))) return { status: 'exhausted', resetAt: closed };
      // A charge from an ended day moves to the current one; an expired one is reserved again.
      this.sql.exec('DELETE FROM quota_reservations WHERE ws = ? AND mb = ? AND send_id = ? AND epoch = ? AND attempt = ?',
        scope.workspaceId, scope.mailboxId, scope.sendId, fence.epoch, fence.attempt);
      for (const recipient of recipients) {
        this.sql.exec('INSERT INTO quota_reservations VALUES (?, ?, ?, ?, ?, ?, ?, 1)', scope.workspaceId, scope.mailboxId, scope.sendId, recipient,
          day, fence.epoch, fence.attempt);
      }
      return { status: 'ok', day, dayEnd: this.endOf(day) };
    });
  }

  async release(scope: QuotaScope, fences: SendFence[]): Promise<void> {
    this.log('release', scope, fences);
    this.fail('release');
    this.ctx.storage.transactionSync(() => { for (const fence of fences) this.dropFence(scope, fence); });
  }

  private endOf(day: string): number {
    const row = this.sql.exec<{ ends_at: number }>('SELECT ends_at FROM quota_days WHERE day = ?', day).toArray()[0];
    if (!row) throw new Error('Unknown fixture quota day');
    return row.ends_at;
  }

  async resetAt(): Promise<number> {
    this.fail('resetAt');
    return this.endOf(this.config().day);
  }

  // Test controls.
  setDay(day: string, endsAt: number) {
    this.sql.exec('INSERT OR REPLACE INTO quota_days VALUES (?, ?)', day, endsAt);
    this.sql.exec('UPDATE quota_config SET day = ?', day);
  }
  setExhausted(exhausted: boolean) { this.sql.exec('UPDATE quota_config SET exhausted = ?', exhausted ? 1 : 0); }
  setMonthly(limit: number | null, end: number | null) { this.sql.exec('UPDATE quota_config SET month_limit = ?, month_end = ?', limit, end); }
  failNext(method: string, times = 1) { this.sql.exec('INSERT OR REPLACE INTO quota_failures VALUES (?, ?)', method, times); }
  // Charges per fence and quota day.
  balances() {
    return this.sql.exec<{ ws: string; mb: string; sendId: string; epoch: number; attempt: number; day: string; charges: number }>(`SELECT ws, mb,
      send_id AS sendId, epoch, attempt, day, count(*) AS charges FROM quota_reservations GROUP BY ws, mb, send_id, epoch, attempt, day
      ORDER BY ws, mb, send_id, epoch, attempt, day`).toArray();
  }
  calls(): QuotaCall[] {
    return this.sql.exec<{ method: string; body: string }>('SELECT method, body FROM quota_calls ORDER BY n').toArray()
      .map(({ method, body }) => ({ method, ...JSON.parse(body) as Omit<QuotaCall, 'method'> }));
  }
}
