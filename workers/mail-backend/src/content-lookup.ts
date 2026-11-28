import { WorkerEntrypoint } from 'cloudflare:workers';
import { workspaceMailBucket } from './directory.ts';
import { linkReadCredential, type LinkReadCredential } from './link-credentials.ts';
import { isId } from './mailbox-api-input.ts';
import type { MailboxContentRecord } from './mailbox-api-messages.ts';
import { enabled, mailboxName, type Env } from './worker.ts';
import { isLinkId, isTokenHash, linkRoute, reportLink } from './file-links.ts';
import type { ChargeAnswer, LinkTarget } from './mailbox-links.ts';
import { LinkStorageStore, type LinkDatabase } from '../../../packages/link-storage/src/store.ts';
import type { LinkLocationFields } from '../../../packages/link-storage/src/location.ts';

type LookupEnv = Omit<Env, 'MAILBOX'> & {
  LINK_CRED_KEK?: string;
  MAILBOX: { getByName(name: string): {
    contentRecord(ws: string, mb: string, msg: string): Promise<MailboxContentRecord | null>;
    fileLinkTarget(ws: string, mb: string, linkId: string, tokenHash: string): Promise<LinkTarget | { status: 'gone' | 'unavailable' }>;
    chargeFileLink(ws: string, mb: string, linkId: string, bytes: number): Promise<ChargeAnswer | 'unavailable'>;
  } };
};

/** Which mailbox link a download charges; returned by `fileLink`, passed back to `chargeFileLink`. */
export type FileLinkHandle = { ws: string; mb: string; linkId: string };
/** A live link as mail-content serves it. A workspace location's fields come with it (null if the location is gone). */
export type FileLinkView = Extract<LinkTarget, { status: 'live' }> & { handle: FileLinkHandle; fields: LinkLocationFields | null };
type Gone = { status: 'gone' | 'unavailable' | 'limit' };

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

  /**
   * The read-only key of a workspace's own link location, for serving downloads
   * (M3-13). Only the read column is opened; the write key never leaves the backend.
   */
  async linkReadCredential(ws: unknown, locationId: unknown): Promise<LinkReadCredential | null> {
    if (!enabled(this.env) || this.env.MAIL_CONTENT_ENABLED !== 'on') return null;
    return linkReadCredential(this.env, ws, locationId);
  }

  /**
   * A file link by its token's SHA-256 (M3-13): the routing row, then the sender's
   * mailbox, which alone decides whether the link is live. Unknown, revoked,
   * expired and undone links all answer `gone`; the token itself never crosses here.
   */
  async fileLink(tokenHash: unknown): Promise<FileLinkView | Gone> {
    if (!enabled(this.env) || this.env.MAIL_CONTENT_ENABLED !== 'on' || !isTokenHash(tokenHash)) return { status: 'gone' };
    const route = await linkRoute(this.env.DIRECTORY, tokenHash);
    if (!route) return { status: 'gone' };
    const { workspaceId: ws, mailboxId: mb, linkId } = route;
    const target = await this.env.MAILBOX.getByName(mailboxName(ws, mb)).fileLinkTarget(ws, mb, linkId, tokenHash);
    if (target.status !== 'live') return target;
    // The frozen location and the routing row's always agree; anything else is never served.
    if (target.location.kind !== route.locationKind || target.location.id !== route.locationId) return { status: 'gone' };
    let fields: LinkLocationFields | null = null;
    if (target.location.kind === 'workspace') {
      const stored = await new LinkStorageStore(this.env.DIRECTORY.withSession('first-primary') as unknown as LinkDatabase).get(ws, target.location.id);
      fields = stored && { endpoint: stored.endpoint, region: stored.region, bucket: stored.bucket, prefix: stored.prefix, pathStyle: stored.pathStyle };
    }
    return { ...target, handle: { ws, mb, linkId }, fields };
  }

  /** Charges a download's bytes to the link (M3-13): `ok`, `gone` once it is no longer live, `limit` past its budget. */
  async chargeFileLink(handle: unknown, bytes: unknown): Promise<ChargeAnswer | 'unavailable'> {
    const { ws, mb, linkId } = (handle ?? {}) as Partial<FileLinkHandle>;
    if (!enabled(this.env) || this.env.MAIL_CONTENT_ENABLED !== 'on' || typeof ws !== 'string' || !isId(mb) || !isLinkId(linkId) ||
        typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) return 'gone';
    try { workspaceMailBucket(ws); } catch { return 'gone'; }
    return this.env.MAILBOX.getByName(mailboxName(ws, mb)).chargeFileLink(ws, mb, linkId, bytes);
  }

  /** An abuse report against a live link (M3-13): stored with the link, at most 10, and an operator alert with the link id only. */
  async reportFileLink(tokenHash: unknown): Promise<'reported' | 'gone' | 'limit' | 'unavailable'> {
    const link = await this.fileLink(tokenHash);
    if (link.status === 'gone' || link.status === 'unavailable') return link.status;
    const linkId = 'handle' in link ? link.handle.linkId : (await linkRoute(this.env.DIRECTORY, tokenHash as string))?.linkId;
    if (!linkId) return 'gone';
    return await reportLink(this.env.DIRECTORY, tokenHash as string, linkId, Date.now()) ? 'reported' : 'limit';
  }
}
