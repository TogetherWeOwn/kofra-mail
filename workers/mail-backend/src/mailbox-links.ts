// File links in the mailbox (docs/m3-outbound-plan.md, M3-13). Whether a link
// is live always comes from here: its send's release is published, the link is
// not revoked or deleted, the send was not undone, and `now < expiresAt` (or
// the link never expires). Revocations and deletions are journalled; the
// per-link byte counters are local state, checked and incremented in one
// synchronous step so concurrent downloads cannot pass the budget.
import type { FileLink } from '../../../contracts/mail-api/src/wire.ts';
import {
  HOUR_MS, isLinkId, LINK_HOURLY_FACTOR, LINK_TOTAL_FACTOR, linkUnexpired, linkUrl, type LinkLocationRef, type SendLink,
} from './file-links.ts';
import { iso } from './mailbox-api-input.ts';
import { sendRow, type SendRow } from './mailbox-send-store.ts';

type LinkRow = { linkId: string; sendId: string; idx: number; createdAt: number; revokedAt: number | null; deletedAt: number | null; expiredAt: number | null };
const columns = `link_id AS linkId, send_id AS sendId, idx, created_at AS createdAt, revoked_at AS revokedAt, deleted_at AS deletedAt, expired_at AS expiredAt`;

const flushed = (sql: SqlStorage) => sql.exec<{ flushed: number }>('SELECT flushed FROM state WHERE id = 1').one().flushed;

export function linkRow(sql: SqlStorage, linkId: string): LinkRow | undefined {
  if (!isLinkId(linkId)) return undefined;
  return sql.exec<LinkRow>(`SELECT ${columns} FROM mailbox_send_links WHERE link_id = ?`, linkId).toArray()[0];
}

// A send whose release failed before it was queued, or that was undone, never makes its links live.
const neverReleased = (send: SendRow) => send.state === 'cancelled' || (send.queuedSeq === null && send.state === 'failed');

/** The frozen link and its send, for a link the sender can see (not deleted, its send listed). */
function visible(sql: SqlStorage, linkId: string): { row: LinkRow; send: SendRow; link: SendLink } | undefined {
  const row = linkRow(sql, linkId);
  if (!row || row.deletedAt !== null) return undefined;
  const send = sendRow(sql, row.sendId);
  const link = send?.record.links?.[row.idx];
  if (!send || !link || link.id !== linkId || neverReleased(send) || send.createdSeq > flushed(sql)) return undefined;
  return { row, send, link };
}

export type LiveLink = { send: SendRow; link: SendLink };

/** The link if it is live at `now`: release published, not revoked, deleted or undone, unexpired. */
export function liveLink(sql: SqlStorage, linkId: string, now: number): LiveLink | undefined {
  const row = linkRow(sql, linkId);
  if (!row || row.revokedAt !== null || row.deletedAt !== null || row.expiredAt !== null) return undefined;
  const send = sendRow(sql, row.sendId);
  const link = send?.record.links?.[row.idx];
  if (!send || !link || link.id !== linkId || send.state === 'cancelled' || send.queuedSeq === null || send.queuedSeq > flushed(sql)) return undefined;
  return linkUnexpired(link, now) ? { send, link } : undefined;
}

export type LinkBudget = { hourly: number; total: number };
function factor(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1_000_000 ? parsed : fallback;
}
/** Bytes served per hour and in total, as multiples of the file size. */
export const linkBudget = (env: { LINK_HOURLY_FACTOR?: string; LINK_TOTAL_FACTOR?: string }): LinkBudget =>
  ({ hourly: factor(env.LINK_HOURLY_FACTOR, LINK_HOURLY_FACTOR), total: factor(env.LINK_TOTAL_FACTOR, LINK_TOTAL_FACTOR) });

type Counter = { hour: number; hourBytes: number; totalBytes: number };
function counter(sql: SqlStorage, linkId: string, now: number): Counter {
  const row = sql.exec<{ hour: number; hourBytes: number; totalBytes: number }>(
    'SELECT hour, hour_bytes AS hourBytes, total_bytes AS totalBytes FROM mailbox_link_counters WHERE link_id = ?', linkId).toArray()[0];
  const hour = Math.floor(now / HOUR_MS);
  return { hour, hourBytes: row && row.hour === hour ? row.hourBytes : 0, totalBytes: row?.totalBytes ?? 0 };
}

/** True when nothing more can be served now: the hour's or the total budget is used up. */
export function budgetSpent(sql: SqlStorage, link: SendLink, now: number, budget: LinkBudget): boolean {
  if (link.size === 0) return false;
  const used = counter(sql, link.id, now);
  return used.hourBytes >= budget.hourly * link.size || used.totalBytes >= budget.total * link.size;
}

export type ChargeAnswer = 'ok' | 'gone' | 'limit';

/**
 * Charges `bytes` (a response's Content-Length) to a live link, or refuses:
 * the liveness check, the budget check and the increment are one synchronous
 * step with no await, so two downloads can never both pass on the same bytes.
 */
export function chargeLink(sql: SqlStorage, linkId: string, bytes: number, now: number, budget: LinkBudget): ChargeAnswer {
  const live = liveLink(sql, linkId, now);
  if (!live) return 'gone';
  const used = counter(sql, linkId, now);
  const { size } = live.link;
  if (used.hourBytes + bytes > budget.hourly * size || used.totalBytes + bytes > budget.total * size) return 'limit';
  sql.exec(`INSERT INTO mailbox_link_counters (link_id, hour, hour_bytes, total_bytes) VALUES (?, ?, ?, ?)
    ON CONFLICT (link_id) DO UPDATE SET hour = excluded.hour, hour_bytes = excluded.hour_bytes, total_bytes = excluded.total_bytes`,
  linkId, used.hour, used.hourBytes + bytes, used.totalBytes + bytes);
  return 'ok';
}

/** What mail-content needs to show and serve a live link; never the token. */
export type LinkTarget =
  | { status: 'live'; name: string; size: number; sender: { name: string; email: string }; expiresAt: number | null;
      location: LinkLocationRef; key: string; fingerprint: string }
  | { status: 'limit' };

export function linkTarget(live: LiveLink, sql: SqlStorage, now: number, budget: LinkBudget): LinkTarget {
  if (budgetSpent(sql, live.link, now, budget)) return { status: 'limit' };
  const { link, send } = live;
  return { status: 'live', name: link.name, size: link.size, sender: { name: send.record.from.name, email: send.record.from.email },
    expiresAt: link.expiresAt, location: link.location, key: link.key, fingerprint: link.fingerprint };
}

export function wireFileLink(sql: SqlStorage, row: LinkRow, send: SendRow, link: SendLink, now: number): FileLink {
  const published = send.queuedSeq !== null && send.queuedSeq <= flushed(sql);
  const state = row.revokedAt !== null ? 'revoked' : !published ? 'pending' : row.expiredAt === null && linkUnexpired(link, now) ? 'live' : 'expired';
  return { id: link.id, sendId: send.id, name: link.name, size: link.size, url: linkUrl(link), createdAt: iso(row.createdAt),
    ...(link.expiresAt !== null && { expiresAt: iso(link.expiresAt) }), state };
}

/** The sender's view of one link; undefined if it is deleted or not visible. */
export function fileLink(sql: SqlStorage, linkId: string, now: number): FileLink | undefined {
  const found = visible(sql, linkId);
  return found && wireFileLink(sql, found.row, found.send, found.link, now);
}

/** A page of the sender's links, newest first; deleted links and links of undone or unreleased-and-failed sends are left out. */
export function linkPage(sql: SqlStorage, limit: number, now: number, position?: [number, string]): FileLink[] {
  const where = position ? 'AND (l.created_at < ? OR (l.created_at = ? AND l.link_id < ?))' : '';
  const rows = sql.exec<LinkRow>(`SELECT l.link_id AS linkId, l.send_id AS sendId, l.idx, l.created_at AS createdAt, l.revoked_at AS revokedAt,
      l.deleted_at AS deletedAt, l.expired_at AS expiredAt FROM mailbox_send_links l JOIN mailbox_sends s ON s.id = l.send_id
    WHERE l.deleted_at IS NULL AND s.state <> 'cancelled' AND NOT (s.state = 'failed' AND s.queued_seq IS NULL) AND s.created_seq <= ? ${where}
    ORDER BY l.created_at DESC, l.link_id DESC LIMIT ?`, flushed(sql), ...(position ? [position[0], position[0], position[1]] : []), limit).toArray();
  return rows.flatMap(row => {
    const send = sendRow(sql, row.sendId);
    const link = send?.record.links?.[row.idx];
    return send && link && link.id === row.linkId ? [wireFileLink(sql, row, send, link, now)] : [];
  });
}

/**
 * The journal event that revokes a link (and, when `deleting`, deletes it), or
 * null when it already is (the caller still waits for its publish). Undefined
 * when the link is not the sender's to change: unknown, deleted (for a revoke),
 * or of a send that never released.
 */
export function linkStateEvent(sql: SqlStorage, linkId: string, now: number, deleting: boolean):
  { type: 'link_state'; sendId: string; linkId: string; revokedAt: number; deletedAt?: number } | null | undefined {
  // A deleted link is already gone for its sender; a repeated delete still waits for that deletion to be published.
  if (deleting && linkRow(sql, linkId)?.deletedAt != null) return null;
  const found = visible(sql, linkId);
  if (!found) return undefined;
  const { row } = found;
  if (row.revokedAt !== null && (!deleting || row.deletedAt !== null)) return null;
  return { type: 'link_state', sendId: row.sendId, linkId, revokedAt: row.revokedAt ?? now, ...(deleting && { deletedAt: now }) };
}
