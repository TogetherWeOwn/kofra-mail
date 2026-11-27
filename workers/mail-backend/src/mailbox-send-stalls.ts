// Local alert bookkeeping, not send state. It never participates in fencing,
// eligibility, the retry budget or the crash-loop cap.
const STALL_AGE_MS = 24 * 60 * 60_000;
export const PRE_MARK_EXPIRIES = 5;

export class SendStalls {
  constructor(private readonly sql: SqlStorage) {}

  // The drive reaches this only after the queued commit has been published.
  start(id: string, now: number): boolean {
    return this.sql.exec('INSERT OR IGNORE INTO mailbox_send_stalls (send_id, stall_since) VALUES (?, ?) RETURNING 1', id, now)
      .toArray().length > 0;
  }

  claim(id: string, now: number, expiresAt: number): void {
    this.sql.exec(`INSERT INTO mailbox_send_stalls (send_id, stall_since, lease_expires_at) VALUES (?, ?, ?)
      ON CONFLICT (send_id) DO UPDATE SET lease_expires_at = excluded.lease_expires_at`, id, now, expiresAt);
  }

  mark(id: string): void {
    // Mark proves the lease did not expire pre-Mark, not that dispatch reached EMAIL.
    this.sql.exec('UPDATE mailbox_send_stalls SET expiries = 0, lease_expires_at = NULL WHERE send_id = ?', id);
  }

  reached(id: string, now: number): void {
    this.sql.exec(`INSERT INTO mailbox_send_stalls (send_id, stall_since) VALUES (?, ?)
      ON CONFLICT (send_id) DO UPDATE SET stall_since = excluded.stall_since`, id, now);
  }

  // Both the drive and a claim can observe the expired lease. Clearing the
  // watch in the same local transaction counts that lease only once.
  expire(id: string, now: number): boolean {
    const [row] = this.sql.exec<{ expiries: number }>(`UPDATE mailbox_send_stalls SET expiries = expiries + 1, lease_expires_at = NULL
      WHERE send_id = ? AND lease_expires_at <= ? AND expiries < ? RETURNING expiries`, id, now, PRE_MARK_EXPIRIES).toArray();
    return row?.expiries === PRE_MARK_EXPIRIES;
  }

  release(id: string, now: number, beforeMark: boolean, quotaUntil?: number): void {
    // A deliberate quota wait is not stall time. Do not defer a condition that
    // was already active when the quota wait began.
    this.sql.exec(`UPDATE mailbox_send_stalls SET lease_expires_at = NULL,
      expiries = CASE WHEN ? AND expiries < ? THEN 0 ELSE expiries END,
      stall_since = CASE WHEN stall_since + ? > ? THEN stall_since + ? ELSE stall_since END WHERE send_id = ?`,
    beforeMark ? 1 : 0, PRE_MARK_EXPIRIES, STALL_AGE_MS, now, quotaUntil === undefined ? 0 : Math.max(0, quotaUntil - now), id);
  }

  clear(id: string): void { this.sql.exec('DELETE FROM mailbox_send_stalls WHERE send_id = ?', id); }

  next(): number {
    if (this.sql.exec(`SELECT 1 FROM mailbox_send_stalls WHERE expiries >= ${PRE_MARK_EXPIRIES} LIMIT 1`).toArray().length) return 0;
    const first = this.sql.exec<{ stall_since: number }>('SELECT stall_since FROM mailbox_send_stalls ORDER BY stall_since LIMIT 1').toArray()[0];
    return first ? first.stall_since + STALL_AGE_MS : Infinity;
  }
}
