import { WorkerEntrypoint } from 'cloudflare:workers';
import { workspaceMailBucket } from './directory.ts';
import { isId } from './mailbox-api-input.ts';
import type { MailboxContentRecord } from './mailbox-api-messages.ts';
import { enabled, mailboxName, type Env } from './worker.ts';

type LookupEnv = Omit<Env, 'MAILBOX'> & {
  MAILBOX: { getByName(name: string): { contentRecord(ws: string, mb: string, msg: string): Promise<MailboxContentRecord | null> } };
};

// Account IDs are opaque token subjects, not mail API resource IDs.
const accountId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);

async function owner(env: LookupEnv, ws: unknown, mb: unknown): Promise<string | null> {
  if (!enabled(env) || env.MAIL_CONTENT_ENABLED !== 'on' || typeof ws !== 'string' || !isId(mb)) return null;
  try { workspaceMailBucket(ws); } catch { return null; }
  // Keep the lookup on the primary even if directory read replication is enabled:
  // a stale replica must not extend access after a mailbox reassignment.
  const id = await env.DIRECTORY.withSession('first-primary')
    .prepare('SELECT user_id FROM mailboxes WHERE workspace_id = ? AND id = ?').bind(ws, mb).first<string>('user_id');
  return accountId(id) ? id : null;
}

/** The content Worker's whole mailbox capability: no stubs or write methods cross RPC. */
export class ContentLookup extends WorkerEntrypoint<LookupEnv> {
  mailboxOwner(ws: unknown, mb: unknown): Promise<string | null> {
    return owner(this.env, ws, mb);
  }

  async messageRecord(ws: unknown, mb: unknown, sub: unknown, msg: unknown): Promise<MailboxContentRecord | null> {
    if (typeof ws !== 'string' || !isId(mb) || !accountId(sub) || !isId(msg) || await owner(this.env, ws, mb) !== sub) return null;
    const row = await this.env.MAILBOX.getByName(mailboxName(ws, mb)).contentRecord(ws, mb, msg);
    return row && { rawKey: row.rawKey, attachments: row.attachments.map(({ part, objectKey }) => ({ part, objectKey })), verdict: row.verdict };
  }
}
