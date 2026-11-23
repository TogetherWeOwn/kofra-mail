export type NewDelivery = {
  id: string;
  workspaceId: string;
  envelopeFrom: string;
  envelopeTo: string;
  mailboxId: string;
  rawKey: string;
  authResults: string | null;
  createdAt: number;
};

export type Delivery = Omit<NewDelivery, 'mailboxId'> & {
  state: 'pending' | 'done' | 'failed';
  attempts: number;
  lease: number;
  retries: number;
  nextAttemptAt: number;
  doneAt: number | null;
  mailboxIds: [string];
};

type Row = Omit<Delivery, 'mailboxIds'> & { encodedMailboxIds: string };
// Only processing failures of the stored message (parse, digest, size cap) spend
// one of these. Mailbox not ready, timeouts, lost replies and storage, D1 or queue
// errors retry with capped backoff and never fail a delivery.
export const MAX_ATTEMPTS = 8;
export const RECONCILE_PAGE = 12;
export const PRUNE_PAGE = 100;
// Match the one-minute recovery cron; each retry doubles the interval up to the cap.
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const MAX_SHIFT = 6;
// About 3.5 hours of retries (1, 2, 4, 8, 16, then 30 minutes): raise a stuck-delivery
// alert without failing the row.
export const STUCK_RETRIES = 12;
// A claim's processing window before the reconciler may re-drive the delivery.
export const LEASE_MS = 5 * 60_000;
const BACKOFF = (count: string) => `min(${MAX_BACKOFF_MS}, ${BASE_BACKOFF_MS} << min(${count}, ${MAX_SHIFT}))`;
const EPOCH = `(SELECT recovery_epoch FROM mailboxes AS m
  WHERE m.workspace_id = deliveries.workspace_id AND m.id = json_extract(deliveries.resolved_mailbox_ids, '$[0]'))`;

function decode(row: Row | null): Delivery | null {
  if (!row) return null;
  const { encodedMailboxIds, ...delivery } = row;
  const mailboxIds: unknown = JSON.parse(encodedMailboxIds);
  if (!Array.isArray(mailboxIds) || mailboxIds.length !== 1 || typeof mailboxIds[0] !== 'string' || !mailboxIds[0]) {
    throw new Error('Invalid delivery recipients');
  }
  return { ...delivery, mailboxIds: [mailboxIds[0]] };
}
const FIELDS = `id, workspace_id AS workspaceId, envelope_from AS envelopeFrom,
  envelope_to AS envelopeTo, resolved_mailbox_ids AS encodedMailboxIds, raw_key AS rawKey,
  auth_results AS authResults, state, attempts, lease, retries, next_attempt_at AS nextAttemptAt,
  created_at AS createdAt, done_at AS doneAt`;

const MAILBOX_DONE = `workspace_id = ?1 AND json_extract(resolved_mailbox_ids, '$[0]') = ?2 AND state = 'done'`;

// The watermark is per mailbox, so a completion after a snapshot reads the
// watermark can never reuse it, even within the same millisecond.
export const NEXT_DONE_AT = `max(?1, coalesce((SELECT previous.done_at + 1 FROM deliveries AS previous
  WHERE previous.workspace_id = deliveries.workspace_id
    AND json_extract(previous.resolved_mailbox_ids, '$[0]') = json_extract(deliveries.resolved_mailbox_ids, '$[0]')
    AND previous.state = 'done' ORDER BY previous.done_at DESC LIMIT 1), 1))`;

// One mailbox's oldest completed rows at or below ?3, at most ?4 of them.
// Matches the alert queue's occurrence key: the first generation keeps the plain
// key, later re-drives append `:<generation>`.
const FAILED_ALERT_KEY = `'delivery_failed:' || id || CASE WHEN redrives > 0 THEN ':' || redrives ELSE '' END`;

export const PRUNE_COVERED = `DELETE FROM deliveries WHERE id IN (SELECT id FROM deliveries
  WHERE ${MAILBOX_DONE} AND done_at <= ?3 ORDER BY done_at LIMIT ?4)`;

export type ReplayDelivery = { id: string; rawKey: string; createdAt: number; doneAt: number; authResults: string | null };

export class Outbox {
  private readonly db: D1Database;

  constructor(db: D1Database) { this.db = db; }

  async insert(row: NewDelivery): Promise<void> {
    await this.db.prepare(`INSERT INTO deliveries
      (id, workspace_id, envelope_from, envelope_to, resolved_mailbox_ids, group_post_ids,
       raw_key, auth_results, state, attempts, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, '[]', ?, ?, 'pending', 0, ?, ?)`)
      .bind(row.id, row.workspaceId, row.envelopeFrom, row.envelopeTo, JSON.stringify([row.mailboxId]),
        row.rawKey, row.authResults, row.createdAt, row.createdAt).run();
  }

  async get(id: string): Promise<Delivery | null> {
    const row = await this.db.withSession('first-primary').prepare(`SELECT ${FIELDS} FROM deliveries WHERE id = ?`)
      .bind(id).first<Row>();
    return decode(row);
  }

  // A due delivery gets a new lease and a full processing window, and records the
  // mailbox recovery epoch it saw. Only the same queue message can resume an
  // active lease after an ambiguous acknowledgement; resuming neither extends the
  // lease nor re-reads the epoch, because that message may already have indexed
  // into the mailbox state that a restore is replacing.
  async claim(id: string, now: number, owner: string): Promise<Delivery | null> {
    const row = await this.db.prepare(`UPDATE deliveries SET
      lease = CASE WHEN next_attempt_at <= ?2 THEN lease + 1 ELSE lease END,
      retries = CASE WHEN next_attempt_at <= ?2 AND claimed = 1 AND claim_owner IS NOT NULL
        THEN min(retries + 1, 30) ELSE retries END,
      claim_epoch = CASE WHEN next_attempt_at <= ?2 OR claimed = 0 THEN ${EPOCH} ELSE claim_epoch END,
      next_attempt_at = CASE WHEN next_attempt_at <= ?2 OR claimed = 0 THEN ?2 + ?3 ELSE next_attempt_at END,
      claimed = 1, claim_owner = ?4
      WHERE id = ?1 AND state = 'pending' AND (
        next_attempt_at <= ?2 OR (lease > 0 AND (claimed = 0 OR claim_owner = ?4))
      ) RETURNING ${FIELDS}`).bind(id, now, LEASE_MS, owner).first<Row>();
    return decode(row);
  }

  async deliveryCursor(workspaceId: string, mailboxId: string): Promise<number> {
    const row = await this.db.withSession('first-primary')
      .prepare(`SELECT done_at AS doneAt FROM deliveries WHERE ${MAILBOX_DONE} ORDER BY done_at DESC LIMIT 1`)
      .bind(workspaceId, mailboxId).first<{ doneAt: number }>();
    return row?.doneAt ?? 0;
  }

  async replayPage(workspaceId: string, mailboxId: string, after: number): Promise<ReplayDelivery[]> {
    const page = await this.db.withSession('first-primary').prepare(`SELECT id, raw_key AS rawKey,
      created_at AS createdAt, done_at AS doneAt, auth_results AS authResults FROM deliveries WHERE ${MAILBOX_DONE} AND done_at > ?3
      ORDER BY done_at, id LIMIT 64`).bind(workspaceId, mailboxId, after).all<ReplayDelivery>();
    return page.results;
  }

  // Rejected unless the lease, the owner and the mailbox recovery epoch are all
  // unchanged since the claim. A rejected completion leaves the row pending for
  // the reconciler; mailbox deduplication makes the repeat harmless.
  async complete(id: string, lease: number, now: number, owner: string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE deliveries SET state = 'done', done_at = ${NEXT_DONE_AT}, claim_owner = NULL
      WHERE id = ?2 AND state = 'pending' AND lease = ?3 AND claimed = 1 AND claim_owner = ?4 AND claim_epoch IS ${EPOCH}`)
      .bind(now, id, lease, owner).run();
    return result.meta.changes === 1;
  }

  // Retry later without spending a processing attempt.
  async defer(id: string, lease: number, owner: string, now: number): Promise<void> {
    await this.db.prepare(`UPDATE deliveries SET claimed = 1, claim_owner = NULL, retries = min(retries + 1, 30),
      next_attempt_at = ?1 + ${BACKOFF('retries')}
      WHERE id = ?2 AND state = 'pending' AND lease = ?3 AND claim_owner = ?4`).bind(now, id, lease, owner).run();
  }

  // The stored message cannot be processed; the eighth such failure is terminal.
  // The transition to failed and its alert obligation commit in one D1 batch, so a
  // re-drive that follows at once can never lose that generation's alert.
  async reject(id: string, lease: number, owner: string, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE deliveries SET claimed = 1, claim_owner = NULL, attempts = min(attempts + 1, ?5),
        state = CASE WHEN attempts + 1 >= ?5 THEN 'failed' ELSE 'pending' END,
        next_attempt_at = ?1 + ${BACKOFF('attempts')}
        WHERE id = ?2 AND state = 'pending' AND lease = ?3 AND claim_owner = ?4`).bind(now, id, lease, owner, MAX_ATTEMPTS),
      this.db.prepare(`INSERT OR IGNORE INTO mail_alerts (key, source, created_at)
        SELECT ${FAILED_ALERT_KEY}, 'mail:delivery_failed', ?1 FROM deliveries
        WHERE id = ?2 AND state = 'failed' AND alerted_at IS NULL`).bind(now, id),
      this.db.prepare(`UPDATE deliveries SET alerted_at = ?1 WHERE id = ?2 AND state = 'failed' AND alerted_at IS NULL`).bind(now, id),
    ]);
  }

  async due(now: number): Promise<Array<{ id: string; lease: number; retries: number; redrives: number }>> {
    const result = await this.db.withSession('first-primary').prepare(`SELECT id, lease, retries, redrives FROM deliveries
      WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?`)
      .bind(now, RECONCILE_PAGE).all<{ id: string; lease: number; retries: number; redrives: number }>();
    return result.results;
  }

  // A reservation fences out every earlier lease. A lease that ended without a
  // report (crash, timeout, lost queue send) counts as a retry; a deferral
  // already did.
  async reserve(id: string, lease: number, now: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE deliveries SET lease = lease + 1, claimed = 0, claim_owner = NULL,
      retries = CASE WHEN claimed = 1 AND claim_owner IS NULL THEN retries ELSE min(retries + 1, 30) END,
      next_attempt_at = ?1 + ${BACKOFF('retries')}
      WHERE id = ?2 AND state = 'pending' AND next_attempt_at <= ?1 AND lease = ?3`).bind(now, id, lease).run();
    return result.meta.changes === 1;
  }

  // Fenced admin re-drive of a terminal delivery; returns whether it was failed.
  async redrive(id: string, now: number): Promise<boolean> {
    // A new re-drive generation gives any later failed or stuck alert its own
    // identity; earlier obligations, sent or queued, are kept as they are.
    const result = await this.db.prepare(`UPDATE deliveries SET state = 'pending', attempts = 0, retries = 0,
      lease = lease + 1, claimed = 1, claim_owner = NULL, next_attempt_at = ?1, alerted_at = NULL, redrives = redrives + 1
      WHERE id = ?2 AND state = 'failed'`).bind(now, id).run();
    return result.meta.changes === 1;
  }


  // Invalidates every delivery claimed for this mailbox before the call.
  async bumpRecoveryEpoch(workspaceId: string, mailboxId: string): Promise<number> {
    const row = await this.db.withSession('first-primary')
      .prepare('SELECT recovery_epoch AS epoch FROM mailboxes WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, mailboxId).first<{ epoch: number }>();
    if (!row) throw new Error('Mailbox directory entry missing');
    const next = row.epoch + 1;
    const result = await this.db.prepare(`UPDATE mailboxes SET recovery_epoch = ?3
      WHERE workspace_id = ?1 AND id = ?2 AND recovery_epoch = ?4`).bind(workspaceId, mailboxId, next, row.epoch).run();
    if (result.meta.changes !== 1) throw new Error('Mailbox recovery epoch changed concurrently');
    return next;
  }

  async alertDue(): Promise<Array<{ id: string; redrives: number }>> {
    const result = await this.db.withSession('first-primary').prepare(`SELECT id, redrives FROM deliveries
      WHERE state = 'failed' AND alerted_at IS NULL ORDER BY id LIMIT ?`).bind(RECONCILE_PAGE).all<{ id: string; redrives: number }>();
    return result.results;
  }

  // Fenced by re-drive generation: a cron that read an older generation cannot
  // stamp a later failed generation as alerted.
  async alerted(id: string, redrives: number, now: number): Promise<void> {
    await this.db.prepare(`UPDATE deliveries SET alerted_at = ?1 WHERE id = ?2 AND state = 'failed' AND alerted_at IS NULL
      AND redrives = ?3`).bind(now, id, redrives).run();
  }

  // Prunes one mailbox's completed rows that are past retention and at or below
  // `covered`, a delivery cursor its own published backup is confirmed to
  // include. One indexed range read on deliveries_mailbox_done, bounded by LIMIT.
  // Returns the number of rows removed.
  async pruneCovered(workspaceId: string, mailboxId: string, cutoff: number, covered: number): Promise<number> {
    const result = await this.db.prepare(PRUNE_COVERED).bind(workspaceId, mailboxId, Math.min(cutoff, covered), PRUNE_PAGE).run();
    return result.meta.changes;
  }

  // Clears the informational coverage cursor while backups are lost or restoring.
  async resetBackupWatermark(workspaceId: string, mailboxId: string): Promise<void> {
    await this.db.prepare('UPDATE mailboxes SET backup_done_at = 0 WHERE workspace_id = ? AND id = ?').bind(workspaceId, mailboxId).run();
  }

  async backupInitialized(workspaceId: string, mailboxId: string): Promise<boolean> {
    const row = await this.db.withSession('first-primary')
      .prepare('SELECT backup_initialized AS initialized FROM mailboxes WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, mailboxId).first<{ initialized: number }>();
    return row?.initialized === 1;
  }

  // Records that the mailbox has a backup baseline and, optionally, the delivery
  // cursor its latest published backup is confirmed to cover (informational).
  async markBackedUp(workspaceId: string, mailboxId: string, doneAt = 0): Promise<void> {
    const result = await this.db.prepare(`UPDATE mailboxes SET backup_initialized = 1, backup_done_at = max(backup_done_at, ?3)
      WHERE workspace_id = ?1 AND id = ?2`).bind(workspaceId, mailboxId, doneAt).run();
    if (result.meta.changes !== 1) throw new Error('Mailbox directory entry missing');
  }
}

export function isDeliveryId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}
