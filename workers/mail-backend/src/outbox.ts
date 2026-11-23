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
  nextAttemptAt: number;
  doneAt: number | null;
  mailboxIds: [string];
};

type Row = Omit<Delivery, 'mailboxIds'> & { encodedMailboxIds: string };
const FIELDS = `id, workspace_id AS workspaceId, envelope_from AS envelopeFrom,
  envelope_to AS envelopeTo, resolved_mailbox_ids AS encodedMailboxIds, raw_key AS rawKey,
  auth_results AS authResults, state, attempts, next_attempt_at AS nextAttemptAt,
  created_at AS createdAt, done_at AS doneAt`;

const MAILBOX_DONE = `workspace_id = ?1 AND json_extract(resolved_mailbox_ids, '$[0]') = ?2 AND state = 'done'`;

// The watermark is per mailbox, so a completion after a snapshot reads the
// watermark can never reuse it, even within the same millisecond.
export const NEXT_DONE_AT = `max(?, coalesce((SELECT previous.done_at + 1 FROM deliveries AS previous
  WHERE previous.workspace_id = deliveries.workspace_id
    AND json_extract(previous.resolved_mailbox_ids, '$[0]') = json_extract(deliveries.resolved_mailbox_ids, '$[0]')
    AND previous.state = 'done' ORDER BY previous.done_at DESC LIMIT 1), 1))`;

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
    if (!row) return null;
    const { encodedMailboxIds, ...delivery } = row;
    const mailboxIds: unknown = JSON.parse(encodedMailboxIds);
    if (!Array.isArray(mailboxIds) || mailboxIds.length !== 1 || typeof mailboxIds[0] !== 'string' || !mailboxIds[0]) {
      throw new Error('Invalid delivery recipients');
    }
    return { ...delivery, mailboxIds: [mailboxIds[0]] };
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

  async complete(id: string, now: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE deliveries SET state = 'done', done_at = ${NEXT_DONE_AT} WHERE id = ? AND state = 'pending'`)
      .bind(now, id).run();
    return result.meta.changes === 1;
  }
}

export function isDeliveryId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}
