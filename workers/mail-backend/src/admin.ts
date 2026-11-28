import { WorkerEntrypoint } from 'cloudflare:workers';
import { workspaceMailBucket } from './directory.ts';
import { linkCredentialKeyVersions, rewrapLinkCredentials } from './link-credentials.ts';
import { isDeliveryId, Outbox } from './outbox.ts';
import { enabled, mailboxName, type Env } from './worker.ts';
import { linkRoute, linkRouteById } from './file-links.ts';

// Internal entrypoint for operators. It has no route and is reachable only
// through a service binding that names it.
export class MailAdmin extends WorkerEntrypoint<Env> {
  // Returns a failed delivery to pending with a fresh attempt budget. A delivery
  // in any other state is left unchanged and false is returned.
  async redriveDelivery(id: string): Promise<boolean> {
    if (!enabled(this.env)) throw new Error('Mail backend is disabled');
    if (!isDeliveryId(id)) throw new Error('Invalid delivery id');
    return new Outbox(this.env.DIRECTORY).redrive(id, Date.now());
  }

  // Restores a workspace sweeper's wake-up from its ledger; idempotent.
  async rearmSweeper(workspaceId: string): Promise<void> {
    if (!enabled(this.env)) throw new Error('Mail backend is disabled');
    workspaceMailBucket(workspaceId);
    const sweeper = this.env.SWEEPER.getByName(workspaceId) as unknown as { rearm(): Promise<void> };
    await sweeper.rearm();
  }

  // After a LINK_CRED_KEK rotation: rewraps up to `limit` (at most 100) stored link
  // credentials under the current version. Pass `next` back until it is null.
  async rewrapLinkCredentials(limit: number, cursor: string | null = null): Promise<{ rewrapped: number; failed: number; next: string | null }> {
    if (!enabled(this.env)) throw new Error('Mail backend is disabled');
    return rewrapLinkCredentials(this.env, limit, cursor);
  }

  // Revokes one file link (M3-13) by its id or by its token's SHA-256 (hex), for abuse
  // reports. `revoked` once a publish covers the revocation; `retry` if the sender's
  // mailbox is not ready or the publish failed; `not_found` for an unknown link.
  async revokeFileLink(by: { linkId: string } | { tokenHash: string }): Promise<'revoked' | 'not_found' | 'retry'> {
    if (!enabled(this.env)) throw new Error('Mail backend is disabled');
    return revokeFileLink(this.env, by);
  }

  // The KEK versions stored link credentials still use. Remove an old version only once it is not listed.
  async linkCredentialKeyVersions(): Promise<number[]> {
    if (!enabled(this.env)) throw new Error('Mail backend is disabled');
    return linkCredentialKeyVersions(this.env);
  }
}

// The operator's revoke of one file link (M3-13): the routing row by link id or
// token hash, then the sender's mailbox, which journals the revocation and answers
// once a publish covers it.
export async function revokeFileLink(env: Pick<Env, 'DIRECTORY' | 'MAILBOX'>, by: { linkId: string } | { tokenHash: string }):
  Promise<'revoked' | 'not_found' | 'retry'> {
  const route = by && 'linkId' in by ? await linkRouteById(env.DIRECTORY, by.linkId) : await linkRoute(env.DIRECTORY, by?.tokenHash);
  if (!route) return 'not_found';
  const mailbox = env.MAILBOX.getByName(mailboxName(route.workspaceId, route.mailboxId)) as unknown as {
    operatorRevokeLink(ws: string, mb: string, linkId: string): Promise<'revoked' | 'not_found' | 'retry'>;
  };
  return mailbox.operatorRevokeLink(route.workspaceId, route.mailboxId, route.linkId);
}
