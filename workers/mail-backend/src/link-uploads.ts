import { LIMITS, MailApiError, problem, type LinkUpload, type MailErrorCode, type Operation } from '../../../contracts/mail-api/src/index.ts';
import { credentialSecret, type S3Credentials } from '../../../packages/link-storage/src/credentials.ts';
import { linkKek } from '../../../packages/link-storage/src/kek.ts';
import { deploymentLocations, locationFields, locationFingerprint, refusedZones, type LinkLocationFields } from '../../../packages/link-storage/src/location.ts';
import { LinkMultipart } from '../../../packages/link-storage/src/multipart.ts';
import { LinkStorageStore, type LinkDatabase } from '../../../packages/link-storage/src/store.ts';
import { isLinkFileName, isLinkHost, isLinkUploadId, type StoredFileLink } from './link-values.ts';

const DAY = 86_400_000, GIB = 2 ** 30, LEASE = 5 * 60_000;
export const LINK_UPLOAD_LIFE = 7 * DAY;
const LIFE = LINK_UPLOAD_LIFE;
const PART = LIMITS.linkPartBytes;
export const LINK_UPLOAD_OPS: ReadonlySet<Operation> = new Set(['createLinkUpload', 'getLinkUpload', 'putLinkPart', 'completeLinkUpload', 'deleteLinkUpload']);
export interface LinkUploadEnv {
  MAIL_FILE_LINKS_ENABLED?: string;
  LINK_HOST?: string;
  LINK_LOCATIONS?: string;
  LINK_CRED_KEK?: string;
  LINK_WRITE_CREDENTIALS?: string;
  LINK_REFUSED_ZONES?: string;
  LINK_FILE_BYTES?: string;
  LINK_DAILY_BYTES?: string;
  LINK_LIVE_BYTES?: string;
  LINK_WORKSPACE_LIMITS?: string;
}
export type LinkObject = {
  workspace_id: string; mailbox_id: string; id: string; location_kind: 'workspace' | 'deployment'; location_id: string;
  fingerprint: string; object_key: string; name: string; size: number; parts: number;
  state: 'opening' | 'uploading' | 'complete' | 'deleting' | 'retiring' | 'deleted'; provider_upload: string | null; version_id: string | null;
  abandoned: number;
  idem_key: string | null; request_fingerprint: string; idem_expires: number; created_at: number; sweep_at: number | null; wake_rev: number;
  confirmed: number; confirm_since: number | null; delete_since: number | null; alert_at: number | null; lease: string | null; lease_until: number | null;
};
const fail = (code: MailErrorCode, extra?: { limit?: number; retryAfterSeconds?: number }): never => { throw new MailApiError(problem(code, extra)); };
const limit = (raw: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
  const n = typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw)) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
};
export function workspaceLinkLimits(env: LinkUploadEnv, ws: string) {
  let entry: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(env.LINK_WORKSPACE_LIMITS ?? '{}');
    if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, ws)) entry = parsed[ws];
  } catch { /* no workspace override */ }
  return {
    file: limit(entry?.fileBytes, limit(env.LINK_FILE_BYTES, LIMITS.linkFileBytes, 5 * GIB), 5 * GIB),
    live: limit(entry?.liveBytes, limit(env.LINK_LIVE_BYTES, 200 * GIB)),
    daily: limit(entry?.dailyBytes, limit(env.LINK_DAILY_BYTES, 20 * GIB)),
  };
}
export const linkUploadGate = (env: LinkUploadEnv) => env.MAIL_FILE_LINKS_ENABLED === 'on' && isLinkHost(env.LINK_HOST);
const unavailable = () => fail('unavailable', { retryAfterSeconds: 1 });

function workspaceZones(env: LinkUploadEnv): string[] | undefined {
  try { const value = JSON.parse(env.LINK_REFUSED_ZONES ?? ''); return Array.isArray(value) && value.length ? refusedZones(value) : undefined; }
  catch { return undefined; }
}
export async function linkUploadsAvailable(db: LinkDatabase, env: LinkUploadEnv, ws: string): Promise<boolean> {
  if (!linkUploadGate(env)) return false;
  const current = await db.prepare('SELECT location_id FROM link_storage_locations WHERE workspace_id = ? AND current = 1').bind(ws).first();
  if (current) return !!workspaceZones(env) && !!(await linkKek(env.LINK_CRED_KEK));
  const locations = deploymentLocations(env.LINK_LOCATIONS);
  return !!locations && !!credentialSecret(env.LINK_WRITE_CREDENTIALS)?.has(locations.current);
}

export async function objectMultipart(db: LinkDatabase, env: LinkUploadEnv, row: LinkObject): Promise<LinkMultipart> {
  const store = new LinkStorageStore(db);
  let fields: LinkLocationFields | undefined, credentials: S3Credentials | null | undefined;
  if (row.location_kind === 'deployment') {
    fields = deploymentLocations(env.LINK_LOCATIONS)?.locations.get(row.location_id);
    credentials = credentialSecret(env.LINK_WRITE_CREDENTIALS)?.get(row.location_id);
  } else {
    const location = await store.get(row.workspace_id, row.location_id);
    const zones = workspaceZones(env);
    const valid = zones && location && locationFields(location, zones);
    const kek = await linkKek(env.LINK_CRED_KEK);
    if (valid && valid.ok && kek) {
      fields = valid.fields;
      credentials = await store.credential(kek, row.workspace_id, row.location_id, 'write');
    }
  }
  if (!fields || !credentials || await locationFingerprint(fields) !== row.fingerprint) return unavailable();
  return new LinkMultipart(fields, credentials, row.object_key);
}

export const storedLink = (row: LinkObject): StoredFileLink => ({ location: { kind: row.location_kind, id: row.location_id }, key: row.object_key, fingerprint: row.fingerprint, uploadId: row.id });
export const linkObject = (db: LinkDatabase, ws: string, mb: string, id: string) => db.prepare('SELECT * FROM link_objects WHERE workspace_id = ? AND mailbox_id = ? AND id = ?').bind(ws, mb, id).first<LinkObject>();
export const linkObjectByKey = (db: LinkDatabase, ws: string, mb: string, key: string) => db.prepare('SELECT * FROM link_objects WHERE workspace_id = ? AND mailbox_id = ? AND object_key = ?').bind(ws, mb, key).first<LinkObject>();

function wire(row: LinkObject, state: LinkUpload['state']): LinkUpload {
  return { id: row.id, name: row.name, size: row.size, partSize: PART, parts: row.parts, state, expiresAt: new Date(row.created_at + LIFE).toISOString() };
}
const partSize = (row: LinkObject, part: number) => part === row.parts ? row.size - (part - 1) * PART : PART;
const anchors = (row: LinkObject) => [row.workspace_id, row.mailbox_id, row.id] as const;

async function claimUploadIo(db: LinkDatabase, row: LinkObject, now: number): Promise<string> {
  const lease = crypto.randomUUID();
  const claimed = await db.prepare(`UPDATE link_objects SET lease = ?, lease_until = ?
    WHERE workspace_id = ? AND mailbox_id = ? AND id = ? AND state = 'uploading' AND abandoned = 0
      AND (lease_until IS NULL OR lease_until <= ?)`).bind(lease, now + LEASE, ...anchors(row), now).run();
  if (claimed.meta.changes !== 1) return unavailable();
  return lease;
}
async function releaseUploadIo(db: LinkDatabase, row: LinkObject, lease: string): Promise<void> {
  await db.prepare('UPDATE link_objects SET lease = NULL, lease_until = NULL WHERE workspace_id = ? AND mailbox_id = ? AND id = ? AND lease = ?')
    .bind(...anchors(row), lease).run();
}

type UploadContext = { db: LinkDatabase; env: LinkUploadEnv; ws: string; mb: string; now: number; input: Record<string, unknown>;
  idempotencyKey?: string; request?: Request; params: Record<string, string>;
  reserve?: (write: () => Promise<unknown>) => Promise<boolean> };

async function create(ctx: UploadContext): Promise<{ body: LinkUpload; replayed?: boolean }> {
  const { db, env, ws, mb, now, input, idempotencyKey } = ctx;
  if (!idempotencyKey) return fail('precondition_required');
  const fingerprint = JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
  const prior = () => db.prepare(`SELECT * FROM link_objects WHERE workspace_id = ? AND mailbox_id = ? AND idem_key = ? AND idem_expires > ?`)
    .bind(ws, mb, idempotencyKey, now).first<LinkObject>();
  let row = await prior();
  let replayed = !!row;
  const lease = crypto.randomUUID();
  if (!row) {
    const { name, size } = input;
    if (Object.keys(input).some(k => k !== 'name' && k !== 'size')) return fail('unknown_field');
    if (!isLinkFileName(name) || typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return fail('invalid_request');
    const caps = workspaceLinkLimits(env, ws), max = caps.file;
    if (size > max) return fail('limit_reached', { limit: max });
    const day = Math.floor(now / DAY);
    const location = await new LinkStorageStore(db).currentLocation(ws, deploymentLocations(env.LINK_LOCATIONS), now);
    if (!location) return fail('feature_unavailable');
    const fields = location.kind === 'workspace' ? location.location : location.fields;
    const loc = location.kind === 'workspace' ? location.location.locationId : location.locationId;
    const locationHash = await locationFingerprint(fields);
    const id = crypto.randomUUID();
    const key = `${fields.prefix}ws/${ws}/${mb}/${id}`;
    const reserve = () => db.batch([
      db.prepare('UPDATE link_objects SET idem_key = NULL WHERE workspace_id = ? AND mailbox_id = ? AND idem_key = ? AND idem_expires <= ?')
        .bind(ws, mb, idempotencyKey, now),
      db.prepare(`INSERT OR IGNORE INTO link_objects
        (workspace_id, mailbox_id, id, location_kind, location_id, fingerprint, object_key, name, size, parts, state,
          idem_key, request_fingerprint, idem_expires, created_at, day, sweep_at, lease, lease_until)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'opening', ?, ?, ?, ?, ?, ?, ?, ?
        WHERE COALESCE((SELECT size FROM link_live_bytes WHERE workspace_id = ?), 0) + ? <= ?
          AND COALESCE((SELECT size FROM link_daily_bytes WHERE workspace_id = ? AND day = ?), 0) + ? <= ?
          AND (CASE WHEN ? = 'workspace' THEN EXISTS (SELECT 1 FROM link_storage_locations
            WHERE workspace_id = ? AND location_id = ? AND current = 1 AND state = 'active' AND fingerprint = ?)
            ELSE NOT EXISTS (SELECT 1 FROM link_storage_locations WHERE workspace_id = ? AND current = 1) END)`)
        .bind(ws, mb, id, location.kind, loc, locationHash, key, name, size, Math.ceil(size / PART), idempotencyKey, fingerprint,
          now + LIMITS.idempotencyRetentionSeconds * 1000, now, day, now + LIFE, lease, now + LEASE,
          ws, size, caps.live, ws, day, size, caps.daily, location.kind, ws, loc, locationHash, ws),
    ]);
    if (!ctx.reserve || !await ctx.reserve(reserve)) return fail('idempotency_in_progress', { retryAfterSeconds: 1 });
    row = await prior();
    if (!row) {
      const balance = await db.prepare(`SELECT COALESCE((SELECT size FROM link_live_bytes WHERE workspace_id = ?), 0) AS live,
        COALESCE((SELECT size FROM link_daily_bytes WHERE workspace_id = ? AND day = ?), 0) AS daily`).bind(ws, ws, day).first<{ live: number; daily: number }>();
      if (balance && balance.live + size > caps.live) return fail('limit_reached', { limit: caps.live });
      if (balance && balance.daily + size > caps.daily) return fail('limit_reached', { limit: caps.daily });
      return unavailable();
    }
    replayed = row.id !== id;
  }
  if (row.request_fingerprint !== fingerprint) return fail('idempotency_key_reused');
  if (row.provider_upload || row.state === 'complete') return { body: wire(row, 'uploading'), replayed: true };
  if (row.state !== 'opening') return fail('idempotency_in_progress', { retryAfterSeconds: 1 });
  const provider = await objectMultipart(db, env, row);
  let remote: string;
  if (row.lease === lease) {
    try { remote = await provider.create(); }
    catch { return fail('idempotency_in_progress', { retryAfterSeconds: 1 }); }
  } else {
    if ((row.lease_until ?? 0) > now) return fail('idempotency_in_progress', { retryAfterSeconds: 1 });
    const claimed = await db.prepare(`UPDATE link_objects SET lease = ?, lease_until = ?
      WHERE workspace_id = ? AND mailbox_id = ? AND id = ? AND state = 'opening' AND lease_until <= ?`)
      .bind(lease, now + LEASE, ...anchors(row), now).run();
    if (claimed.meta.changes !== 1) return fail('idempotency_in_progress', { retryAfterSeconds: 1 });
    try {
      const sessions = await provider.sessions();
      if (sessions.truncated || sessions.ids.length > 1) return unavailable();
      remote = sessions.ids[0] ?? await provider.create();
    } catch { return fail('idempotency_in_progress', { retryAfterSeconds: 1 }); }
  }
  const done = await db.prepare(`UPDATE link_objects SET provider_upload = ?, state = 'uploading', lease = NULL, lease_until = NULL
    WHERE workspace_id = ? AND mailbox_id = ? AND id = ? AND state = 'opening' AND lease = ?`)
    .bind(remote, ...anchors(row), lease).run();
  if (done.meta.changes !== 1) return fail('idempotency_in_progress', { retryAfterSeconds: 1 });
  return { body: wire(row, 'uploading'), ...(replayed && { replayed }) };
}

export async function runLinkUpload(op: Operation, ctx: UploadContext): Promise<{ body?: LinkUpload; replayed?: boolean }> {
  const { db, env, ws, mb, now, request, params } = ctx;
  try {
    if (op === 'createLinkUpload') return await create(ctx);
    const id = params.uploadId;
    const row = isLinkUploadId(id) ? await linkObject(db, ws, mb, id) : null;
    if (!row || row.abandoned || row.state === 'deleted' || row.state === 'retiring' || row.state === 'deleting' || row.state === 'opening') {
      if (op === 'deleteLinkUpload') return {};
      return fail('not_found');
    }
    if (op === 'getLinkUpload') return { body: wire(row, row.state) };
    if (op === 'deleteLinkUpload') {
      // The sweeper checks the mailbox's published ownership before deleting bytes.
      await db.prepare(`UPDATE link_objects SET abandoned = 1, sweep_at = ?, wake_rev = wake_rev + 1
        WHERE workspace_id = ? AND mailbox_id = ? AND id = ? AND state IN ('uploading', 'complete')`)
        .bind(now, ...anchors(row)).run();
      return {};
    }
    if (op === 'putLinkPart') {
      if (row.state !== 'uploading' || !row.provider_upload) return fail('not_found');
      const part = /^[1-9][0-9]{0,2}$/.test(params.partNumber) ? Number(params.partNumber) : 0;
      if (!request || !part || part > row.parts || request.headers.get('content-length') !== String(partSize(row, part)) || !request.body) return fail('invalid_request');
      const lease = await claimUploadIo(db, row, now);
      try {
        await (await objectMultipart(db, env, row)).part(row.provider_upload, part, request.body, partSize(row, part));
        return {};
      } finally { await releaseUploadIo(db, row, lease); }
    }
    if (op !== 'completeLinkUpload') return fail('not_found');
    if (row.state === 'complete') return { body: wire(row, 'complete') };
    if (!row.provider_upload) return fail('not_found');
    const lease = await claimUploadIo(db, row, now);
    try {
      const provider = await objectMultipart(db, env, row);
      const object = await provider.head();
      let version: string | null;
      if (object) {
        if (object.size !== row.size) return fail('invalid_request');
        version = object.version;
      } else {
        const parts = await provider.parts(row.provider_upload);
        if (!parts) return unavailable();
        parts.sort((a, b) => a.number - b.number);
        if (parts.length !== row.parts || parts.some((part, i) => part.number !== i + 1 || part.size !== partSize(row, i + 1))) return fail('invalid_request');
        version = await provider.complete(row.provider_upload, parts);
      }
      const done = await db.prepare(`UPDATE link_objects SET state = 'complete', version_id = ?, lease = NULL, lease_until = NULL
        WHERE workspace_id = ? AND mailbox_id = ? AND id = ? AND state = 'uploading' AND lease = ?`).bind(version, ...anchors(row), lease).run();
      if (done.meta.changes !== 1) return unavailable();
      return { body: wire(row, 'complete') };
    } finally {
      await releaseUploadIo(db, row, lease);
    }
  } catch (error) {
    if (error instanceof MailApiError) throw error;
    return unavailable();
  }
}
