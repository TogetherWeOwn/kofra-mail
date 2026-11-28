// Revocable file links (docs/m3-outbound-plan.md, M3-13). A file sent as a
// link is frozen into its send at sendDraft: the link's id, a 128-bit random
// token, the link host, the file's name and size, its expiry and where its
// object lives. Once the release is published (release step 4a), step 4b
// writes one routing row per link to D1: SHA-256(token) to (workspace,
// mailbox, link). The token itself is never stored outside the send's own
// frozen record and never logged. Whether a link is live always comes from
// the mailbox Durable Object (mailbox-links.ts).
import { isLinkExpiry, LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { LinkExpiry } from '../../../contracts/mail-api/src/wire.ts';
import { newLocationId } from '../../../packages/link-storage/src/store.ts';
import { isLocationId } from '../../../packages/link-storage/src/location.ts';
import type { LinkLocationUsage } from '../../../packages/link-storage/src/store.ts';

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
// Every link must have at least this much life left when the send is claimed,
// in authorizeDispatch, and at the internal handoff decision.
export const LINK_FLOOR_MS = HOUR_MS;
// Download budgets per link, in bytes served, as multiples of the file size.
export const LINK_HOURLY_FACTOR = 100;
export const LINK_TOTAL_FACTOR = 1000;
// Reports one link can take; the operator alert carries only the link id.
export const LINK_REPORT_CAP = 10;

/** Where a link's object lives: a deployment location (`LINK_LOCATIONS`) or a workspace's own. */
export type LinkLocationRef = { kind: 'deployment' | 'workspace'; id: string };
/** A draft's file link: the completed upload's object (written by the link upload path, M3-15b). */
export type StoredFileLink = { location: LinkLocationRef; key: string; fingerprint: string };
/** One link frozen in a send's record; every field of the sent bytes and of serving comes from here. */
export type SendLink = {
  id: string; token: string; host: string; name: string; size: number;
  /** `dateAt + N days`, or null for a link that never expires. */
  expiresAt: number | null;
  location: LinkLocationRef; key: string; fingerprint: string;
};

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** A new link token: 128 random bits, 22 base64url characters. */
export function newLinkToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** True only for the canonical encoding of 16 bytes, so one token has one spelling. */
export function isLinkToken(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(value)) return false;
  return true;
}

/** The routing key: SHA-256 of the token, in hex. */
export async function linkTokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
export const isTokenHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** A new link id: 128 random bits as 26 lowercase base32 characters. */
export const newLinkId = (): string => newLocationId();
export const isLinkId = (value: unknown): value is string => typeof value === 'string' && /^[a-z2-7]{26}$/.test(value);

/** A link host: a lowercase DNS name of at least two labels, no port. */
export function isLinkHost(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 253) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) && !/^\d+$/.test(labels.at(-1)!);
}

/** A file name as uploads take it (contract section 8.4): 1 to 255 UTF-8 bytes, no control characters, `/` or `\`. */
export const isLinkFileName = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && byteLength(value) <= 255 && !/[\p{Cc}/\\]/u.test(value);

export function isLocationRef(value: unknown): value is LinkLocationRef {
  const ref = (value ?? {}) as Partial<LinkLocationRef>;
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2) return false;
  return (ref.kind === 'deployment' && isLocationId(ref.id)) || (ref.kind === 'workspace' && typeof ref.id === 'string' && /^[a-z2-7]{26}$/.test(ref.id));
}

/** An object key in a link location: printable, no control characters, at most 1,024 bytes. */
const isObjectKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && byteLength(value) <= 1024 && !/\p{Cc}/u.test(value) && !value.startsWith('/');
const isFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function isStoredFileLink(value: unknown): value is StoredFileLink {
  const link = (value ?? {}) as Partial<StoredFileLink>;
  return !!value && typeof value === 'object' && isLocationRef(link.location) && isObjectKey(link.key) && isFingerprint(link.fingerprint);
}

export function validSendLinks(value: unknown): value is SendLink[] {
  if (!Array.isArray(value) || value.length > LIMITS.fileLinksPerMessage) return false;
  const ids = new Set<string>(), tokens = new Set<string>();
  for (const entry of value) {
    const link = (entry ?? {}) as Partial<SendLink>;
    if (!entry || typeof entry !== 'object' || !isLinkId(link.id) || !isLinkToken(link.token) || !isLinkHost(link.host) ||
        !isLinkFileName(link.name) || !count(link.size) || !(link.expiresAt === null || (count(link.expiresAt) && link.expiresAt <= 8.64e15)) ||
        !isLocationRef(link.location) || !isObjectKey(link.key) || !isFingerprint(link.fingerprint)) return false;
    if (ids.has(link.id) || tokens.has(link.token)) return false;
    ids.add(link.id);
    tokens.add(link.token);
  }
  return true;
}

/** `dateAt + N days` (UTC), or null for `'never'`, so the printed date and the replayed bytes agree. */
export function linkExpiresAt(dateAt: number, expiry: LinkExpiry): number | null {
  if (!isLinkExpiry(expiry)) throw new Error('Invalid link expiry');
  return expiry === 'never' ? null : dateAt + expiry * DAY_MS;
}

/** True if a link of the send has less than `LINK_FLOOR_MS` of life left at `now`. */
export function linkFloorBelow(links: readonly SendLink[] | undefined, now: number): boolean {
  return (links ?? []).some(link => link.expiresAt !== null && link.expiresAt - now < LINK_FLOOR_MS);
}

/** Whether a frozen link is still within its lifetime at `now`. */
export const linkUnexpired = (link: Pick<SendLink, 'expiresAt'>, now: number) => link.expiresAt === null || now < link.expiresAt;

export const linkUrl = (link: Pick<SendLink, 'host' | 'token'>) => `https://${link.host}/f/${link.token}`;

// Bidi controls (and other invisible format characters a name could hide behind) are removed wherever a name is shown.
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
export const withoutBidi = (value: string) => value.replace(BIDI, '');

/** A size for people: bytes, then KB, MB and GB (1,024-based), one decimal below 10. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? (Math.floor(value * 10) / 10).toFixed(1) : Math.floor(value)} ${units[unit]}`;
}

/** `YYYY-MM-DD HH:MM UTC`. */
export const formatExpiry = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * What recipients see below the body: one line per file with its name, size,
 * URL and either `until <date> UTC` or `no expiry date`. Everything comes from
 * the frozen record, so a rerun builds identical bytes.
 */
export function linkTextLines(links: readonly SendLink[] | undefined): string[] {
  if (!links?.length) return [];
  return ['', 'Files shared with download links:', ...links.map(link =>
    `${withoutBidi(link.name)} (${formatSize(link.size)}): ${linkUrl(link)} (${link.expiresAt === null ? 'no expiry date' : `until ${formatExpiry(link.expiresAt)}`})`)];
}

/** A draft's expiry choice: the default when absent; undefined if invalid. */
export function draftLinkExpiry(value: unknown): LinkExpiry | undefined {
  if (value === undefined) return LIMITS.linkExpiryDefaultDays;
  return isLinkExpiry(value) ? value as LinkExpiry : undefined;
}

// ---------------------------------------------------------------- routing rows (D1)

export type LinkRoute = { linkId: string; workspaceId: string; mailboxId: string; locationKind: LinkLocationRef['kind']; locationId: string };

// Release step 4b: one row per link, INSERT OR IGNORE. A workspace location
// must be `active` in the same statement (M3-15a): a location being deleted
// takes no new reference, and the row is written on a later run.
const ROUTE_INSERT = `INSERT OR IGNORE INTO file_links (token_hash, link_id, workspace_id, mailbox_id, location_kind, location_id, created_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
  WHERE ?5 = 'deployment' OR EXISTS (SELECT 1 FROM link_storage_locations
    WHERE workspace_id = ?3 AND location_id = ?6 AND state = 'active')`;

export type RouteOutcome = 'routed' | 'retry' | 'breach';

/**
 * Writes every link's routing row and reads them back: `routed` when each row
 * names this send's link, `retry` when a row is still missing (a location being
 * deleted), `breach` when a row names something else.
 */
export async function routeLinks(db: D1Database, workspaceId: string, mailboxId: string, links: readonly SendLink[], now: number): Promise<RouteOutcome> {
  if (!links.length) return 'routed';
  const hashes = await Promise.all(links.map(link => linkTokenHash(link.token)));
  await db.batch(links.map((link, i) => db.prepare(ROUTE_INSERT)
    .bind(hashes[i], link.id, workspaceId, mailboxId, link.location.kind, link.location.id, now)));
  const { results } = await db.withSession('first-primary').prepare(`SELECT token_hash AS hash, link_id AS linkId, workspace_id AS workspaceId,
      mailbox_id AS mailboxId FROM file_links WHERE token_hash IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(hashes)).all<{ hash: string; linkId: string; workspaceId: string; mailboxId: string }>();
  const rows = new Map(results.map(row => [row.hash, row]));
  let missing = false;
  for (const [i, link] of links.entries()) {
    const row = rows.get(hashes[i]);
    if (!row) { missing = true; continue; }
    if (row.linkId !== link.id || row.workspaceId !== workspaceId || row.mailboxId !== mailboxId) return 'breach';
  }
  return missing ? 'retry' : 'routed';
}

/** The routing row of a token hash, read from the primary so a stale replica never routes. */
export async function linkRoute(db: D1Database, tokenHash: string): Promise<LinkRoute | null> {
  if (!isTokenHash(tokenHash)) return null;
  return db.withSession('first-primary').prepare(`SELECT link_id AS linkId, workspace_id AS workspaceId, mailbox_id AS mailboxId,
      location_kind AS locationKind, location_id AS locationId FROM file_links WHERE token_hash = ?`).bind(tokenHash).first<LinkRoute>();
}

/** The routing row of a link id, for the operator's revoke-by-id. */
export async function linkRouteById(db: D1Database, linkId: string): Promise<LinkRoute | null> {
  if (!isLinkId(linkId)) return null;
  return db.withSession('first-primary').prepare(`SELECT link_id AS linkId, workspace_id AS workspaceId, mailbox_id AS mailboxId,
      location_kind AS locationKind, location_id AS locationId FROM file_links WHERE link_id = ?`).bind(linkId).first<LinkRoute>();
}

/**
 * Counts one abuse report against a link, at most `LINK_REPORT_CAP`, and stores
 * the operator alert obligation (carrying only the link id) in the same batch.
 * False once the cap is reached.
 */
export async function reportLink(db: D1Database, tokenHash: string, linkId: string, now: number): Promise<boolean> {
  const [counted] = await db.batch([
    db.prepare(`UPDATE file_links SET reports = reports + 1 WHERE token_hash = ? AND link_id = ? AND reports < ${LINK_REPORT_CAP} RETURNING reports`)
      .bind(tokenHash, linkId),
    db.prepare(`INSERT OR IGNORE INTO mail_alerts (key, source, created_at)
      SELECT ?, 'mail:link_reported', ? WHERE EXISTS (SELECT 1 FROM file_links WHERE token_hash = ? AND reports BETWEEN 1 AND ${LINK_REPORT_CAP})`)
      .bind(`link_reported:${linkId}`, now, tokenHash),
  ]) as D1Result[];
  return (counted.results?.length ?? 0) === 1;
}

/**
 * M3-15a's usage port, for links: a workspace location is in use while any link
 * routed through it exists. A revoked or expired link still counts, because its
 * object stays until the link lifecycle (M3-15b) deletes it. Draft attachments
 * and unfinished uploads are M3-15b's part of this port: until it ships, no
 * link upload can be created, so none can exist.
 */
export function fileLinkUsage(db: D1Database): LinkLocationUsage {
  return {
    async inUse({ workspaceId, locationId }) {
      const row = await db.withSession('first-primary').prepare(`SELECT 1 AS used FROM file_links
        WHERE workspace_id = ? AND location_kind = 'workspace' AND location_id = ? LIMIT 1`).bind(workspaceId, locationId).first();
      return row !== null;
    },
  };
}
