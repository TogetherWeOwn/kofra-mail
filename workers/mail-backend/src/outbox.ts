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

  async complete(id: string, now: number): Promise<boolean> {
    const result = await this.db.prepare("UPDATE deliveries SET state = 'done', done_at = ? WHERE id = ? AND state = 'pending'")
      .bind(now, id).run();
    return result.meta.changes === 1;
  }
}

export function isDeliveryId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}
