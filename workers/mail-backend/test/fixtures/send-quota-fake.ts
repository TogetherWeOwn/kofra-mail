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
CREATE TABLE IF NOT EXISTS quota_config (id INTEGER PRIMARY KEY CHECK (id = 1), day TEXT NOT NULL, exhausted INTEGER NOT NULL);
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
    this.sql.exec("INSERT OR IGNORE INTO quota_config VALUES (1, 'day-0', 0)");
    this.sql.exec("INSERT OR IGNORE INTO quota_days VALUES ('day-0', ?)", env.INITIAL_TIME + 24 * 60 * 60_000);
  }

  private config() { return this.sql.exec<{ day: string; exhausted: number }>('SELECT day, exhausted FROM quota_config').one(); }
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
      const { day, exhausted } = this.config();
      if (exhausted) return { status: 'exhausted', resetAt: this.endOf(day) };
      for (const recipient of recipients) {
        this.sql.exec('INSERT OR REPLACE INTO quota_newest VALUES (?, ?, ?, ?, ?, ?)', scope.workspaceId, scope.mailboxId, scope.sendId, recipient,
          fence.epoch, fence.attempt);
        this.sql.exec('INSERT OR IGNORE INTO quota_reservations (ws, mb, send_id, recipient, day, epoch, attempt) VALUES (?, ?, ?, ?, ?, ?, ?)',
          scope.workspaceId, scope.mailboxId, scope.sendId, recipient, day, fence.epoch, fence.attempt);
      }
      return { status: 'ok', day };
    });
  }

  async confirm(scope: QuotaScope, fence: SendFence, recipients: number[]): Promise<QuotaAnswer> {
    this.log('confirm', scope, [fence]);
    this.fail('confirm');
    return this.ctx.storage.transactionSync((): QuotaAnswer => {
      if (this.released(scope, fence) || this.superseded(scope, fence, recipients)) return { status: 'stale' };
      const { day } = this.config();
      // A charge from an ended day moves to the current one; an expired one is reserved again.
      this.sql.exec('DELETE FROM quota_reservations WHERE ws = ? AND mb = ? AND send_id = ? AND epoch = ? AND attempt = ?',
        scope.workspaceId, scope.mailboxId, scope.sendId, fence.epoch, fence.attempt);
      for (const recipient of recipients) {
        this.sql.exec('INSERT INTO quota_reservations VALUES (?, ?, ?, ?, ?, ?, ?, 1)', scope.workspaceId, scope.mailboxId, scope.sendId, recipient,
          day, fence.epoch, fence.attempt);
      }
      return { status: 'ok', day };
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

  async resetAt(day?: string): Promise<number> {
    this.fail('resetAt');
    return this.endOf(day ?? this.config().day);
  }

  // Test controls.
  setDay(day: string, endsAt: number) {
    this.sql.exec('INSERT OR REPLACE INTO quota_days VALUES (?, ?)', day, endsAt);
    this.sql.exec('UPDATE quota_config SET day = ?', day);
  }
  setExhausted(exhausted: boolean) { this.sql.exec('UPDATE quota_config SET exhausted = ?', exhausted ? 1 : 0); }
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
