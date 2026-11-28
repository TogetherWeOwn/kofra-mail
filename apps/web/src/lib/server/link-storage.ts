// Admin routes for a workspace's own link storage (contract section 8.7;
// docs/m3-outbound-plan.md, M3-15a). Secrets are write-only: they are checked,
// sealed under LINK_CRED_KEK and stored, and never returned, logged or put in
// an error. This module has no console output at all.
import { MailApiError, problem, LIMITS } from '@kofra/mail-contract';
import type { LinkLocation, MailErrorCode, Operation, Problem } from '@kofra/mail-contract';
import {
  checkLinkLocation, deploymentLocations, HAS_ROOM, linkKek, LinkStorageStore, locationFields, MAX_WORKSPACE_LOCATIONS, newLocationId,
  refusedZones, S3Credentials, type Fetcher, type LinkDatabase, type LinkLocationFields, type LinkLocationUsage, type StoredLocation,
} from '@kofra/link-storage';
import type { DirectoryDatabase } from './mail-directory.ts';
import type { OperationResult } from './mail-api.ts';

export const LINK_STORAGE_OPS: ReadonlySet<Operation> = new Set<Operation>([
  'listLinkLocations', 'createLinkLocation', 'rotateLinkLocationCredentials', 'deleteLinkLocation',
]);

export interface LinkStorageEnvironment {
  /** Secret: the versioned key encryption key (`@kofra/link-storage` kek.ts). */
  LINK_CRED_KEK?: string;
  /** The deployment's link storage, `{ current, locations }`; reported only as configured or not. */
  LINK_LOCATIONS?: string;
  /** JSON array of the deployment's own zones (suite, content, link, storage and account domains), refused as endpoints. */
  LINK_REFUSED_ZONES?: string;
  /** What still references a location (M3-13, M3-15b). Without it, deletes fail closed. */
  LINK_USAGE?: LinkLocationUsage;
}

export interface LinkStorageContext {
  db: DirectoryDatabase;
  workspaceId: string;
  principal: { role: 'member' | 'admin'; authTime: number };
  env: LinkStorageEnvironment;
  params: Record<string, string>;
  input: Record<string, unknown>;
  idempotencyKey?: string;
  now?: number;
  fetch?: Fetcher;
}

const fail = (code: MailErrorCode, extra: Omit<Partial<Problem>, 'code' | 'status' | 'type'> = {}): never => {
  throw new MailApiError(problem(code, extra));
};
const invalid = (field: string): never => fail('invalid_request', { errors: [{ field, code: 'invalid' }] });
const iso = (ms: number) => new Date(ms).toISOString();
const locationIdPattern = /^[a-z2-7]{26}$/;
const createFields = ['endpoint', 'region', 'bucket', 'prefix', 'pathStyle', 'read', 'write'];
// An idempotency record whose operation is still running (contract section 5).
const IN_PROGRESS = '';
const IN_PROGRESS_MS = 5 * 60_000;

function asLinkLocation(row: StoredLocation): LinkLocation {
  return {
    id: row.locationId, endpoint: row.endpoint, region: row.region, bucket: row.bucket, prefix: row.prefix, pathStyle: row.pathStyle,
    current: row.current, readKeyIdLast4: row.readKeyLast4, writeKeyIdLast4: row.writeKeyLast4,
    createdAt: iso(row.createdAt), rotatedAt: row.rotatedAt === null ? null : iso(row.rotatedAt),
  };
}

function credentialPair(input: Record<string, unknown>): { read: S3Credentials; write: S3Credentials } {
  const read = S3Credentials.from(input.read);
  if (!read) return invalid('/read');
  const write = S3Credentials.from(input.write);
  if (!write) return invalid('/write');
  return { read, write };
}

/** The KEK and the refused zones; a deployment without either cannot store an override. */
async function writeConfig(env: LinkStorageEnvironment) {
  const kek = await linkKek(env.LINK_CRED_KEK);
  let configured: unknown;
  try { configured = JSON.parse(env.LINK_REFUSED_ZONES ?? ''); } catch { configured = undefined; }
  const zones = Array.isArray(configured) && configured.length > 0 ? refusedZones(configured) : undefined;
  if (!kek || !zones) return fail('feature_unavailable');
  return { kek, zones };
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function runLinkStorage(op: Operation, ctx: LinkStorageContext): Promise<OperationResult> {
  // The router already enforces both; this module refuses on its own too.
  if (ctx.principal.role !== 'admin') return fail('forbidden');
  if (op !== 'listLinkLocations' && (ctx.now ?? Date.now()) - ctx.principal.authTime > 600_000) return fail('reauth_required', { maxAgeSeconds: 600 });
  const session = ctx.db.withSession?.('first-primary') ?? ctx.db;
  // D1 statements always have run(); the directory's narrower type omits it.
  const db = session as unknown as LinkDatabase;
  const store = new LinkStorageStore(db);
  const ws = ctx.workspaceId;
  const now = ctx.now ?? Date.now();
  const check = (fields: LinkLocationFields, credentials: { read: S3Credentials; write: S3Credentials }, zones: string[]) =>
    checkLinkLocation(fields, credentials, zones, { fetch: ctx.fetch });

  switch (op) {
    case 'listLinkLocations':
      return { body: { deployment: deploymentLocations(ctx.env.LINK_LOCATIONS) !== undefined, items: (await store.list(ws)).map(asLinkLocation) } };

    case 'createLinkLocation': {
      const key = ctx.idempotencyKey;
      if (!key) return fail('precondition_required');
      const { kek, zones } = await writeConfig(ctx.env);
      const input = ctx.input;
      // The key's fingerprint covers the whole body except the secret values (each
      // credential counts by its key id and field names), so nothing derived from a secret is stored.
      const shape = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
        ? { accessKeyId: (value as Record<string, unknown>).accessKeyId, fields: Object.keys(value).sort() } : value;
      const fingerprint = await sha256(JSON.stringify([op, Object.keys(input).sort().map(name =>
        [name, name === 'read' || name === 'write' ? shape(input[name]) : input[name]])]));
      const replay = async () => {
        const row = await db.prepare('SELECT fingerprint, result FROM directory_api_keys WHERE workspace_id = ? AND key = ? AND expires_at > ?')
          .bind(ws, key, now).first<{ fingerprint: string; result: string }>();
        if (!row) return undefined;
        if (row.fingerprint !== fingerprint) return fail('idempotency_key_reused');
        if (row.result === IN_PROGRESS) return fail('idempotency_in_progress', { retryAfterSeconds: 1 });
        return { body: JSON.parse(row.result) as LinkLocation, replayed: true };
      };
      const earlier = await replay();
      if (earlier) return earlier;
      if (Object.keys(input).some(field => !createFields.includes(field))) return fail('unknown_field');
      const parsed = locationFields(input, zones);
      if (!parsed.ok) return parsed.reason === 'endpoint' ? fail('storage_check_failed', { reason: 'endpoint' }) : invalid(parsed.field || '/');
      const credentials = credentialPair(input);
      if ((await store.list(ws)).length >= MAX_WORKSPACE_LOCATIONS) return fail('limit_reached', { limit: MAX_WORKSPACE_LOCATIONS });
      // Mark the key in progress before the check's first request (contract section 5); a marker
      // left by a crash expires after 5 minutes, longer than the check's own request deadlines.
      try {
        await db.batch([
          db.prepare('DELETE FROM directory_api_keys WHERE workspace_id = ? AND key = ? AND expires_at <= ?').bind(ws, key, now),
          db.prepare('INSERT INTO directory_api_keys (workspace_id, key, fingerprint, result, expires_at) VALUES (?, ?, ?, ?, ?)')
            .bind(ws, key, fingerprint, IN_PROGRESS, now + IN_PROGRESS_MS),
        ]);
      } catch {
        return (await replay()) ?? fail('unavailable');
      }
      let committed = false;
      try {
        const verdict = await check(parsed.fields, credentials, zones);
        if (!verdict.ok) return fail('storage_check_failed', { reason: verdict.reason });
        const locationId = newLocationId();
        const body = asLinkLocation({ ...parsed.fields, workspaceId: ws, locationId, current: true, readKeyLast4: credentials.read.keyIdLast4,
          writeKeyLast4: credentials.write.keyIdLast4, createdAt: now, rotatedAt: null });
        try {
          await db.batch([
            db.prepare('DELETE FROM directory_api_keys WHERE workspace_id = ? AND key = ? AND result = ?').bind(ws, key, IN_PROGRESS),
            db.prepare(`INSERT INTO directory_api_keys (workspace_id, key, fingerprint, result, expires_at) SELECT ?, ?, ?, ?, ? WHERE ${HAS_ROOM}`)
              .bind(ws, key, fingerprint, JSON.stringify(body), now + LIMITS.idempotencyRetentionSeconds * 1000, ws),
            ...await store.createStatements(kek, ws, locationId, parsed.fields, credentials, now),
          ]);
        } catch {
          // Never expose the database error.
          return fail('unavailable');
        }
        committed = true;
        if (await store.get(ws, locationId)) return { body };
        return fail('limit_reached', { limit: MAX_WORKSPACE_LOCATIONS });
      } finally {
        // A failed operation releases its key, so a retry runs again.
        if (!committed) {
          await db.prepare('DELETE FROM directory_api_keys WHERE workspace_id = ? AND key = ? AND result = ?').bind(ws, key, IN_PROGRESS).run()
            .catch(() => {});
        }
      }
    }

    case 'rotateLinkLocationCredentials': {
      const { kek, zones } = await writeConfig(ctx.env);
      const locationId = ctx.params.locationId;
      if (Object.keys(ctx.input).some(field => field !== 'read' && field !== 'write')) return fail('unknown_field');
      const location = locationIdPattern.test(locationId) ? await store.get(ws, locationId) : null;
      if (!location) return fail('not_found');
      const credentials = credentialPair(ctx.input);
      const verdict = await check(location, credentials, zones);
      if (!verdict.ok) return fail('storage_check_failed', { reason: verdict.reason });
      if (!await store.rotate(kek, ws, locationId, credentials, now)) return fail('not_found');
      const rotated = await store.get(ws, locationId);
      return rotated ? { body: asLinkLocation(rotated) } : fail('not_found');
    }

    case 'deleteLinkLocation': {
      const usage = ctx.env.LINK_USAGE;
      if (!usage || typeof usage.inUse !== 'function') return fail('feature_unavailable');
      const locationId = ctx.params.locationId;
      // DELETE answers 204 whether or not the location exists (contract section 5).
      if (!locationIdPattern.test(locationId)) return {};
      let outcome: Awaited<ReturnType<LinkStorageStore['delete']>>;
      try {
        outcome = await store.delete(ws, locationId, usage);
      } catch {
        return fail('unavailable');
      }
      if (outcome === 'in_use') return fail('location_in_use');
      // Another delete is still checking its usage: its answer is not known yet.
      if (outcome === 'pending') return fail('unavailable', { retryAfterSeconds: 1 });
      return {};
    }

    default:
      return fail('not_found');
  }
}
