import { DurableObject } from 'cloudflare:workers';
import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import { mailAlert, type AlertBinding } from './alerts.ts';
import { LEASE_MS, RELEASE_BATCH, sendClockSkewMs } from './mailbox-send-dispatch.ts';
import { fenceBefore, sameFence, validFence, type QuotaAnswer, type QuotaPort, type QuotaScope, type SendFence } from './mailbox-send-quota.ts';
import { validSendId } from './mailbox-send-store.ts';
import { MailboxWork } from './mailbox-work.ts';
import { sendAlertEnvironment } from './send-alert-events.ts';
import { RESERVATION_GRACE_MS } from './send-consumer.ts';

export type SendQuotaConfig = {
  MAIL_SEND_DAILY_QUOTA?: string;
  MAIL_SEND_MONTHLY_CEILING?: string;
  MAIL_SEND_DAILY_RESET_UTC?: string;
  MAIL_SEND_CLOCK_SKEW_SECONDS?: string;
  MAIL_ENVIRONMENT?: string;
  ALERTS?: AlertBinding;
};

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const FENCE_RETENTION_MS = 35 * DAY_MS;
const ALERT_RETENTION_MS = 2 * DAY_MS;
const ALERT_RETRY_MS = 60_000;
const ALERT_ATTEMPT_TIMEOUT_MS = 10_000;
const PRUNE_PAGE = 32;
const ALERT_CODE = 'send_quota_gate_hit';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS quota_charges (
  ws TEXT NOT NULL, mb TEXT NOT NULL, send_id TEXT NOT NULL,
  epoch INTEGER NOT NULL, attempt INTEGER NOT NULL, recipient INTEGER NOT NULL,
  day TEXT NOT NULL, month TEXT NOT NULL, expires_at INTEGER,
  PRIMARY KEY (ws, mb, send_id, epoch, attempt, recipient)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS quota_charges_by_day ON quota_charges (day, expires_at);
CREATE INDEX IF NOT EXISTS quota_charges_by_month ON quota_charges (month, expires_at);
CREATE INDEX IF NOT EXISTS quota_charges_by_expiry ON quota_charges (expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS quota_newest (
  ws TEXT NOT NULL, mb TEXT NOT NULL, send_id TEXT NOT NULL, recipient INTEGER NOT NULL,
  epoch INTEGER NOT NULL, attempt INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (ws, mb, send_id, recipient)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS quota_newest_by_seen ON quota_newest (last_seen_at);
CREATE TABLE IF NOT EXISTS quota_released (
  ws TEXT NOT NULL, mb TEXT NOT NULL, send_id TEXT NOT NULL, epoch INTEGER NOT NULL, attempt INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (ws, mb, send_id, epoch, attempt)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS quota_released_by_seen ON quota_released (last_seen_at);
CREATE TABLE IF NOT EXISTS quota_gate_alerts (
  day TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_attempt_at INTEGER, sent_at INTEGER
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS quota_alerts_sent ON quota_gate_alerts (sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS quota_alerts_pending ON quota_gate_alerts (last_attempt_at, created_at) WHERE sent_at IS NULL;
`;

type Charge = { day: string; month: string; expires_at: number | null };
type Window = { day: string; dayEnd: number; month: string; monthEnd: number; previousMonth: string };
type Gate = 'daily' | 'monthly';
const scopeKey = ({ workspaceId, mailboxId, sendId }: QuotaScope) => [workspaceId, mailboxId, sendId] as const;
const attemptKey = (scope: QuotaScope, { epoch, attempt }: SendFence) => [...scopeKey(scope), epoch, attempt] as const;
const active = (charge: Charge | undefined, now: number): charge is Charge =>
  charge !== undefined && (charge.expires_at === null || charge.expires_at > now);

function ceiling(value: string | undefined, min: number) {
  const n = Number(value);
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min) throw new Error('Invalid send quota configuration');
  return n;
}

function validate(scope: QuotaScope, fences: SendFence[], recipients?: number[]) {
  // A workspace ID must fit the mail bucket suffix; allow at most 128 characters for a mailbox ID.
  if (!scope || typeof scope.workspaceId !== 'string' || !scope.workspaceId.length || scope.workspaceId.length > 58 ||
      typeof scope.mailboxId !== 'string' || !scope.mailboxId.length || scope.mailboxId.length > 128 || !validSendId(scope.sendId) ||
      !Array.isArray(fences) || fences.length > RELEASE_BATCH || !fences.every(validFence) ||
      (recipients !== undefined && (!Array.isArray(recipients) || !recipients.length || recipients.length > LIMITS.recipientsPerMessage ||
        new Set(recipients).size !== recipients.length || recipients.some(i => !Number.isSafeInteger(i) || i < 0 || i >= LIMITS.recipientsPerMessage)))) {
    throw new Error('Invalid send quota request');
  }
}

// A single SQLite-backed object for the account. Every gate decision and its
// charge writes share one synchronous transaction, including releases on a refusal.
export class SendQuota extends DurableObject<SendQuotaConfig> implements QuotaPort {
  private readonly sql: SqlStorage;
  private readonly alertWork = new MailboxWork();

  constructor(ctx: DurableObjectState, env: SendQuotaConfig) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  protected now() { return Date.now(); }
  protected async armAlert(at: number) { await this.ctx.storage.setAlarm(at); }

  private window(now: number): Window {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(this.env.MAIL_SEND_DAILY_RESET_UTC ?? '');
    if (!match) throw new Error('Invalid send quota configuration');
    const offset = (Number(match[1]) * 60 + Number(match[2])) * 60_000;
    const start = Math.floor((now - offset) / DAY_MS) * DAY_MS;
    const date = new Date(start);
    const day = date.toISOString().slice(0, 10);
    const year = date.getUTCFullYear(), month = date.getUTCMonth();
    // The calendar month belongs to the quota day's start: both roll at the
    // configured reset on the first, not at UTC midnight unless configured so.
    return { day, dayEnd: start + offset + DAY_MS, month: day.slice(0, 7), monthEnd: Date.UTC(year, month + 1, 1) + offset,
      previousMonth: new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 7) };
  }

  private drop(scope: QuotaScope, fence: SendFence, now: number) {
    const key = attemptKey(scope, fence);
    this.sql.exec('DELETE FROM quota_charges WHERE ws = ? AND mb = ? AND send_id = ? AND epoch = ? AND attempt = ?', ...key);
    // Tombstone even a fence that never reserved, for much longer than an active lease.
    this.sql.exec(`INSERT INTO quota_released VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (ws, mb, send_id, epoch, attempt) DO UPDATE SET last_seen_at = max(last_seen_at, excluded.last_seen_at)`, ...key, now);
  }

  private stale(scope: QuotaScope, fence: SendFence, recipients: number[], confirm: boolean, now: number) {
    const released = this.sql.exec(`UPDATE quota_released SET last_seen_at = max(last_seen_at, ?)
      WHERE ws = ? AND mb = ? AND send_id = ? AND epoch = ? AND attempt = ? RETURNING 1`, now, ...attemptKey(scope, fence)).toArray().length > 0;
    let stale = released;
    for (const i of recipients) {
      const newest = this.sql.exec<SendFence>(`UPDATE quota_newest SET last_seen_at = max(last_seen_at, ?)
        WHERE ws = ? AND mb = ? AND send_id = ? AND recipient = ? RETURNING epoch, attempt`, now, ...scopeKey(scope), i).toArray()[0];
      // Confirm needs the exact newest fence, even after a retained charge's fence metadata has aged out.
      if (confirm ? !sameFence(fence, newest) : newest && fenceBefore(fence, newest)) stale = true;
    }
    return stale;
  }

  private count(period: 'day' | 'month', key: string, now: number) {
    // Two indexed ranges avoid scanning expired provisional charges.
    return this.sql.exec<{ n: number }>(`SELECT
      (SELECT count(*) FROM quota_charges WHERE ${period} = ? AND expires_at IS NULL) +
      (SELECT count(*) FROM quota_charges WHERE ${period} = ? AND expires_at > ?) AS n`, key, key, now).one().n;
  }

  private pruneAlerts(now: number) {
    // Keep the delivery obligation while the binding is absent or failing.
    this.sql.exec(`DELETE FROM quota_gate_alerts WHERE day IN (SELECT day FROM quota_gate_alerts
      WHERE sent_at IS NOT NULL AND sent_at < ? ORDER BY sent_at LIMIT ?)`, now - ALERT_RETENTION_MS, PRUNE_PAGE);
  }

  private prune(now: number, previousMonth?: string) {
    const chargeKey = 'ws, mb, send_id, epoch, attempt, recipient';
    if (previousMonth !== undefined) this.sql.exec(`DELETE FROM quota_charges WHERE (${chargeKey}) IN (SELECT ${chargeKey} FROM quota_charges
      WHERE month < ? ORDER BY month LIMIT ?)`, previousMonth, PRUNE_PAGE);
    this.sql.exec(`DELETE FROM quota_charges WHERE (${chargeKey}) IN (SELECT ${chargeKey} FROM quota_charges
      WHERE expires_at < ? ORDER BY expires_at LIMIT ?)`, now - HOUR_MS, PRUNE_PAGE);
    const cutoff = now - FENCE_RETENTION_MS;
    this.sql.exec(`DELETE FROM quota_newest WHERE (ws, mb, send_id, recipient) IN (SELECT ws, mb, send_id, recipient FROM quota_newest
      WHERE last_seen_at < ? ORDER BY last_seen_at LIMIT ?)`, cutoff, PRUNE_PAGE);
    this.sql.exec(`DELETE FROM quota_released WHERE (ws, mb, send_id, epoch, attempt) IN (SELECT ws, mb, send_id, epoch, attempt FROM quota_released
      WHERE last_seen_at < ? ORDER BY last_seen_at LIMIT ?)`, cutoff, PRUNE_PAGE);
    this.pruneAlerts(now);
  }

  private async queueAlert(day: string, gate: Gate, now: number) {
    await this.alertWork.run(async () => {
      if (this.sql.exec('SELECT 1 FROM quota_gate_alerts WHERE day = ?', day).toArray().length) return;
      // Arm before the insert so a durable alert cannot be stranded without a wake-up.
      // The alarm uses the same work lane for its read, not for the network call.
      await this.armAlert(now + 1000);
      this.sql.exec('INSERT INTO quota_gate_alerts (day, created_at) VALUES (?, ?)', day, now);
      console.error({ code: ALERT_CODE, gate });
    });
  }

  async alarm() {
    const now = this.now();
    const pending = await this.alertWork.run(async () => {
      this.pruneAlerts(now);
      // First attempts and least recently attempted alerts go first so that a
      // rejected page cannot block newer alerts behind it.
      const rows = this.sql.exec<{ day: string; created_at: number }>(`SELECT day, created_at FROM quota_gate_alerts
        WHERE sent_at IS NULL ORDER BY last_attempt_at NULLS FIRST, created_at LIMIT ?`, PRUNE_PAGE).toArray();
      if (rows.length) await this.armAlert(now + ALERT_RETRY_MS);
      return rows;
    });
    if (!pending.length) return;
    let environment: string;
    try { environment = sendAlertEnvironment(this.env.MAIL_ENVIRONMENT); }
    catch { return; } // The retry stays armed; do not post or mark sent without a valid environment.
    const deliver = mailAlert(this.env.ALERTS);
    for (const { day, created_at } of pending) {
      const attempted = this.sql.exec(`UPDATE quota_gate_alerts SET last_attempt_at = max(coalesce(last_attempt_at, 0), ?)
        WHERE day = ? AND sent_at IS NULL RETURNING day`, this.now(), day).toArray();
      if (!attempted.length) continue;
      try {
        await deliver({ code: ALERT_CODE, key: `send_quota_gate:${environment}:${day}`, environment, time: created_at },
          AbortSignal.timeout(ALERT_ATTEMPT_TIMEOUT_MS));
      } catch { continue; } // Missing binding, timeout or non-2xx: keep pending for the next alarm.
      this.sql.exec('UPDATE quota_gate_alerts SET sent_at = ? WHERE day = ? AND sent_at IS NULL', this.now(), day);
    }
  }

  private async admit(scope: QuotaScope, fence: SendFence, recipients: number[], release: SendFence[], expiresAt: number | null): Promise<QuotaAnswer> {
    validate(scope, release, recipients);
    if (!validFence(fence)) throw new Error('Invalid send quota request');
    const now = this.now();
    if (expiresAt !== null && expiresAt > now + LEASE_MS + RESERVATION_GRACE_MS + 2 * sendClockSkewMs(this.env.MAIL_SEND_CLOCK_SKEW_SECONDS)) {
      throw new Error('Invalid send quota request');
    }
    const dailyQuota = ceiling(this.env.MAIL_SEND_DAILY_QUOTA, 1);
    const daily = dailyQuota - Math.ceil(dailyQuota / 5);
    const monthly = ceiling(this.env.MAIL_SEND_MONTHLY_CEILING, 0);
    const { day, dayEnd, month, monthEnd, previousMonth } = this.window(now);
    const key = attemptKey(scope, fence);
    const confirm = expiresAt === null;
    let refusedGate: Gate | undefined;
    const answer = this.ctx.storage.transactionSync((): QuotaAnswer => {
      this.prune(now, previousMonth);
      for (const entry of release) this.drop(scope, entry, now);
      if ((!confirm && expiresAt <= now) || this.stale(scope, fence, recipients, confirm, now)) return { status: 'stale' };
      const rows = recipients.map(i => this.sql.exec<Charge>(`SELECT day, month, expires_at FROM quota_charges
        WHERE ws = ? AND mb = ? AND send_id = ? AND epoch = ? AND attempt = ? AND recipient = ?`, ...key, i).toArray()[0]);
      // Apply both retention cutoffs even when the bounded prune page did not reach this row.
      if (confirm && rows.some(row => row === undefined || row.month < previousMonth ||
        (row.expires_at !== null && row.expires_at < now - HOUR_MS))) return { status: 'stale' };
      if (!confirm) {
        for (const i of recipients) {
          // A refused claim still fences off older calls for these recipients.
          this.sql.exec(`INSERT INTO quota_newest VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (ws, mb, send_id, recipient) DO UPDATE SET epoch = excluded.epoch, attempt = excluded.attempt,
              last_seen_at = max(last_seen_at, excluded.last_seen_at)`, ...scopeKey(scope), i, fence.epoch, fence.attempt, now);
        }
      }
      const addDay = rows.filter(row => !(active(row, now) && row.day === day)).length;
      const addMonth = rows.filter(row => !(active(row, now) && row.month === month)).length;
      if (addMonth && this.count('month', month, now) + addMonth > monthly) refusedGate = 'monthly';
      else if (addDay && this.count('day', day, now) + addDay > daily) refusedGate = 'daily';
      if (refusedGate) return { status: 'exhausted', resetAt: refusedGate === 'monthly' ? monthEnd : dayEnd };
      for (const [index, i] of recipients.entries()) {
        // Once confirmed, a repeated reserve cannot make the charge provisional.
        const expiry = rows[index]?.expires_at === null ? null : expiresAt;
        this.sql.exec(`INSERT INTO quota_charges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (ws, mb, send_id, epoch, attempt, recipient) DO UPDATE SET
            day = excluded.day, month = excluded.month, expires_at = excluded.expires_at`, ...key, i, day, month, expiry);
      }
      return { status: 'ok', day, dayEnd };
    });
    if (refusedGate) await this.queueAlert(day, refusedGate, now);
    return answer;
  }

  async reserve(scope: QuotaScope, fence: SendFence, recipients: number[], release: SendFence[], expiresAt: number): Promise<QuotaAnswer> {
    if (!Number.isSafeInteger(expiresAt)) throw new Error('Invalid send quota request');
    return this.admit(scope, fence, recipients, release, expiresAt);
  }

  async confirm(scope: QuotaScope, fence: SendFence, recipients: number[]): Promise<QuotaAnswer> {
    return this.admit(scope, fence, recipients, [], null);
  }

  async release(scope: QuotaScope, fences: SendFence[]): Promise<void> {
    validate(scope, fences);
    const now = this.now();
    this.ctx.storage.transactionSync(() => {
      // A reset misconfiguration cannot block release or time-based pruning.
      this.prune(now);
      for (const fence of fences) this.drop(scope, fence, now);
    });
  }

  async resetAt(): Promise<number> { return this.window(this.now()).dayEnd; }
}
