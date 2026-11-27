import { DurableObject } from 'cloudflare:workers';
import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import { fenceBefore, validFence, type QuotaAnswer, type QuotaPort, type QuotaScope, type SendFence } from './mailbox-send-quota.ts';

export type SendQuotaConfig = {
  MAIL_SEND_DAILY_QUOTA?: string;
  MAIL_SEND_MONTHLY_CEILING?: string;
  MAIL_SEND_DAILY_RESET_UTC?: string;
};

const DAY_MS = 24 * 60 * 60_000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS quota_charges (
  ws TEXT NOT NULL, mb TEXT NOT NULL, send_id TEXT NOT NULL,
  epoch INTEGER NOT NULL, attempt INTEGER NOT NULL, recipient INTEGER NOT NULL,
  day TEXT NOT NULL, month TEXT NOT NULL, expires_at INTEGER,
  PRIMARY KEY (ws, mb, send_id, epoch, attempt, recipient)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS quota_charges_by_day ON quota_charges (day, expires_at);
CREATE INDEX IF NOT EXISTS quota_charges_by_month ON quota_charges (month, expires_at);
CREATE TABLE IF NOT EXISTS quota_newest (
  ws TEXT NOT NULL, mb TEXT NOT NULL, send_id TEXT NOT NULL, recipient INTEGER NOT NULL,
  epoch INTEGER NOT NULL, attempt INTEGER NOT NULL,
  PRIMARY KEY (ws, mb, send_id, recipient)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS quota_released (
  ws TEXT NOT NULL, mb TEXT NOT NULL, send_id TEXT NOT NULL, epoch INTEGER NOT NULL, attempt INTEGER NOT NULL,
  PRIMARY KEY (ws, mb, send_id, epoch, attempt)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS quota_gate_alerts (day TEXT PRIMARY KEY) WITHOUT ROWID;
`;

type Charge = { day: string; month: string; expires_at: number | null };
type Window = { day: string; dayEnd: number; month: string; monthEnd: number };
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
  if (!scopeKey(scope).every(v => typeof v === 'string' && v.length > 0) || !fences.every(validFence) ||
      (recipients !== undefined && (!recipients.length || recipients.length > LIMITS.recipientsPerMessage ||
        new Set(recipients).size !== recipients.length || recipients.some(i => !Number.isSafeInteger(i) || i < 0 || i >= LIMITS.recipientsPerMessage)))) {
    throw new Error('Invalid send quota request');
  }
}

// A single SQLite-backed object for the account. Every gate decision and its
// charge writes share one synchronous transaction, including releases on a refusal.
export class SendQuota extends DurableObject<SendQuotaConfig> implements QuotaPort {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: SendQuotaConfig) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  protected now() { return Date.now(); }

  private window(now: number): Window {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(this.env.MAIL_SEND_DAILY_RESET_UTC ?? '');
    if (!match) throw new Error('Invalid send quota configuration');
    const offset = (Number(match[1]) * 60 + Number(match[2])) * 60_000;
    const start = Math.floor((now - offset) / DAY_MS) * DAY_MS;
    const date = new Date(start);
    const day = date.toISOString().slice(0, 10);
    // The calendar month belongs to the quota day's start: both roll at the
    // configured reset on the first, not at UTC midnight unless configured so.
    return { day, dayEnd: start + offset + DAY_MS, month: day.slice(0, 7),
      monthEnd: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) + offset };
  }

  private drop(scope: QuotaScope, fence: SendFence) {
    const key = attemptKey(scope, fence);
    this.sql.exec('DELETE FROM quota_charges WHERE ws = ? AND mb = ? AND send_id = ? AND epoch = ? AND attempt = ?', ...key);
    // Tombstone even a fence that never reserved: a delayed call must not
    // recreate it after finish, regardless of the quota day.
    this.sql.exec('INSERT OR IGNORE INTO quota_released VALUES (?, ?, ?, ?, ?)', ...key);
  }

  private stale(scope: QuotaScope, fence: SendFence, recipients: number[]) {
    if (this.sql.exec('SELECT 1 FROM quota_released WHERE ws = ? AND mb = ? AND send_id = ? AND epoch = ? AND attempt = ?',
      ...attemptKey(scope, fence)).toArray().length) return true;
    return recipients.some(i => {
      const newest = this.sql.exec<SendFence>('SELECT epoch, attempt FROM quota_newest WHERE ws = ? AND mb = ? AND send_id = ? AND recipient = ?',
        ...scopeKey(scope), i).toArray()[0];
      return newest !== undefined && fenceBefore(fence, newest);
    });
  }

  private count(period: 'day' | 'month', key: string, now: number) {
    // Use two indexed ranges so a churn of expired provisional charges does
    // not make current admissions scan that history.
    return this.sql.exec<{ n: number }>(`SELECT
      (SELECT count(*) FROM quota_charges WHERE ${period} = ? AND expires_at IS NULL) +
      (SELECT count(*) FROM quota_charges WHERE ${period} = ? AND expires_at > ?) AS n`, key, key, now).one().n;
  }

  private admit(scope: QuotaScope, fence: SendFence, recipients: number[], release: SendFence[], expiresAt: number | null): QuotaAnswer {
    validate(scope, [fence, ...release], recipients);
    if (expiresAt !== null && !Number.isSafeInteger(expiresAt)) throw new Error('Invalid send quota request');
    const daily = Math.floor(ceiling(this.env.MAIL_SEND_DAILY_QUOTA, 1) * 0.8);
    const monthly = ceiling(this.env.MAIL_SEND_MONTHLY_CEILING, 0);
    const now = this.now();
    const { day, dayEnd, month, monthEnd } = this.window(now);
    const key = attemptKey(scope, fence);
    let alert: { code: 'send_quota_gate_hit'; gate: Gate; resetAt: number } | undefined;
    const answer = this.ctx.storage.transactionSync((): QuotaAnswer => {
      for (const entry of release) this.drop(scope, entry);
      if (this.stale(scope, fence, recipients) || (expiresAt !== null && expiresAt <= now)) return { status: 'stale' };
      const rows = recipients.map(i => this.sql.exec<Charge>(`SELECT day, month, expires_at FROM quota_charges
        WHERE ws = ? AND mb = ? AND send_id = ? AND epoch = ? AND attempt = ? AND recipient = ?`, ...key, i).toArray()[0]);
      // An expired row still proves this fence reserved. A direct confirmation
      // without a successful reserve (including a refused reserve) is stale.
      if (expiresAt === null && rows.some(row => row === undefined)) return { status: 'stale' };
      if (expiresAt !== null) {
        for (const i of recipients) {
          // A refused claim still fences off older calls for these recipients.
          this.sql.exec(`INSERT INTO quota_newest VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (ws, mb, send_id, recipient) DO UPDATE SET epoch = excluded.epoch, attempt = excluded.attempt`,
            ...scopeKey(scope), i, fence.epoch, fence.attempt);
        }
      }
      const addDay = rows.filter(row => !(active(row, now) && row.day === day)).length;
      const addMonth = rows.filter(row => !(active(row, now) && row.month === month)).length;
      const gate = addDay && this.count('day', day, now) + addDay > daily ? 'daily'
        : addMonth && this.count('month', month, now) + addMonth > monthly ? 'monthly' : null;
      if (gate !== null) {
        const resetAt = gate === 'daily' ? dayEnd : monthEnd;
        if (this.sql.exec('INSERT OR IGNORE INTO quota_gate_alerts VALUES (?) RETURNING day', day).toArray().length) {
          alert = { code: 'send_quota_gate_hit', gate, resetAt };
        }
        return { status: 'exhausted', resetAt };
      }
      for (const [index, i] of recipients.entries()) {
        // Once confirmed, a repeated reserve cannot make the charge provisional.
        const expiry = rows[index]?.expires_at === null ? null : expiresAt;
        this.sql.exec(`INSERT INTO quota_charges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (ws, mb, send_id, epoch, attempt, recipient) DO UPDATE SET
            day = excluded.day, month = excluded.month, expires_at = excluded.expires_at`, ...key, i, day, month, expiry);
      }
      return { status: 'ok', day, dayEnd };
    });
    if (alert) console.warn(alert);
    return answer;
  }

  async reserve(scope: QuotaScope, fence: SendFence, recipients: number[], release: SendFence[], expiresAt: number): Promise<QuotaAnswer> {
    return this.admit(scope, fence, recipients, release, expiresAt);
  }

  async confirm(scope: QuotaScope, fence: SendFence, recipients: number[]): Promise<QuotaAnswer> {
    return this.admit(scope, fence, recipients, [], null);
  }

  async release(scope: QuotaScope, fences: SendFence[]): Promise<void> {
    validate(scope, fences);
    this.ctx.storage.transactionSync(() => { for (const fence of fences) this.drop(scope, fence); });
  }

  async resetAt(): Promise<number> { return this.window(this.now()).dayEnd; }
}
