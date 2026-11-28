// Admin routes for a workspace's own link storage (contract section 8.7;
// docs/m3-outbound-plan.md, M3-15a). Secrets are write-only: they are checked,
// sealed under LINK_CRED_KEK and stored, and never returned, logged or put in
// an error. This module has no console output at all.
import { MailApiError, problem, LIMITS } from '@kofra/mail-contract';
import type { LinkLocation, MailErrorCode, Operation, Problem } from '@kofra/mail-contract';
import {
  checkLinkLocation, deploymentLocations, keyedFingerprint, linkKek, LinkStorageStore, locationFields, matchesFingerprint, MAX_WORKSPACE_LOCATIONS,
  newLocationId,
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
  /** The clock for write-time decisions; defaults to `now`, else `Date.now`. */
  clock?: () => number;
  fetch?: Fetcher;
}

const fail = (code: MailErrorCode, extra: Omit<Partial<Problem>, 'code' | 'status' | 'type'> = {}): never => {
  throw new MailApiError(problem(code, extra));
};
const invalid = (field: string): never => fail('invalid_request', { errors: [{ field, code: 'invalid' }] });
const iso = (ms: number) => new Date(ms).toISOString();
const locationIdPattern = /^[a-z2-7]{26}$/;
const createFields = ['endpoint', 'region', 'bucket', 'prefix', 'pathStyle', 'read', 'write'];
// The prefix of an idempotency record whose operation is still running (contract section 5).
const IN_PROGRESS = 'in-progress:';
const IN_PROGRESS_MS = 5 * 60_000;

function asLinkLocation(row: StoredLocation): LinkLocation {
  return {
    id: row.locationId, endpoint: row.endpoint, region: row.region, bucket: row.bucket, prefix: row.prefix, pathStyle: row.pathStyle,
    current: row.current, state: row.state, readKeyIdLast4: row.readKeyLast4, writeKeyIdLast4: row.writeKeyLast4,
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

/** A JSON value with every object's keys sorted, so equal bodies have one encoding. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(name => [name, canonicalJson((value as Record<string, unknown>)[name])]));
  }
  return value;
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
      return { body: { deployment: deploymentLocations(ctx.env.LINK_LOCATIONS) !== undefined, items: (await store.list(ws, now)).map(asLinkLocation) } };

    case 'createLinkLocation': {
      const key = ctx.idempotencyKey;
      if (!key) return fail('precondition_required');
      const { kek, zones } = await writeConfig(ctx.env);
      const input = ctx.input;
      // The key's fingerprint covers the whole canonical body, secrets included, as an HMAC under
      // a key derived from the KEK: a change to any field, the secret alone too, is a different body.
      const canonical = JSON.stringify([op, canonicalJson(input)]);
      const fingerprint = (await keyedFingerprint(kek, canonical))!;
      // Each attempt has its own in-progress claim; only that claim can commit or be cleaned up.
      const claim = `${IN_PROGRESS}${crypto.randomUUID()}`;
      const replay = async () => {
        const row = await db.prepare('SELECT fingerprint, result FROM directory_api_keys WHERE workspace_id = ? AND key = ? AND expires_at > ?')
          .bind(ws, key, now).first<{ fingerprint: string; result: string }>();
        if (!row) return undefined;
        if (!await matchesFingerprint(kek, canonical, row.fingerprint)) return fail('idempotency_key_reused');
        if (row.result.startsWith(IN_PROGRESS)) return fail('idempotency_in_progress', { retryAfterSeconds: 1 });
        return { body: JSON.parse(row.result) as LinkLocation, replayed: true };
      };
      const earlier = await replay();
      if (earlier) return earlier;
      if (Object.keys(input).some(field => !createFields.includes(field))) return fail('unknown_field');
      const parsed = locationFields(input, zones);
      if (!parsed.ok) return parsed.reason === 'endpoint' ? fail('storage_check_failed', { reason: 'endpoint' }) : invalid(parsed.field || '/');
      const credentials = credentialPair(input);
      if ((await store.list(ws, now)).length >= MAX_WORKSPACE_LOCATIONS) return fail('limit_reached', { limit: MAX_WORKSPACE_LOCATIONS });
      // Mark the key in progress before the check's first request (contract section 5); a claim
      // left by a crash expires after 5 minutes, longer than the check's own request deadlines.
      try {
        await db.batch([
          db.prepare('DELETE FROM directory_api_keys WHERE workspace_id = ? AND key = ? AND expires_at <= ?').bind(ws, key, now),
          db.prepare('INSERT INTO directory_api_keys (workspace_id, key, fingerprint, result, expires_at) VALUES (?, ?, ?, ?, ?)')
            .bind(ws, key, fingerprint, claim, now + IN_PROGRESS_MS),
          // The KEK version stays in use while a record may hold a fingerprint under it.
          store.fingerprintVersionStatement(kek.current, now + IN_PROGRESS_MS + LIMITS.idempotencyRetentionSeconds * 1000),
        ]);
      } catch {
        return (await replay()) ?? fail('unavailable');
      }
      try {
        const verdict = await check(parsed.fields, credentials, zones);
        if (!verdict.ok) return fail('storage_check_failed', { reason: verdict.reason });
        const locationId = newLocationId();
        const body = asLinkLocation({ ...parsed.fields, workspaceId: ws, locationId, current: true, state: 'active',
          readKeyLast4: credentials.read.keyIdLast4, writeKeyLast4: credentials.write.keyIdLast4, createdAt: now, rotatedAt: null });
        // Every statement requires this attempt's claim to be still in place, so an attempt whose
        // claim expired and was replaced commits nothing.
        const ownClaim = { sql: 'EXISTS (SELECT 1 FROM directory_api_keys WHERE workspace_id = ? AND key = ? AND result = ?)', binds: [ws, key, claim] };
        try {
          await db.batch([
            ...await store.createStatements(kek, ws, locationId, parsed.fields, credentials, now, ownClaim),
            db.prepare(`UPDATE directory_api_keys SET result = ?, expires_at = ? WHERE workspace_id = ? AND key = ? AND result = ?
              AND EXISTS (SELECT 1 FROM link_storage_locations WHERE workspace_id = ? AND location_id = ?)`)
              .bind(JSON.stringify(body), now + LIMITS.idempotencyRetentionSeconds * 1000, ws, key, claim, ws, locationId),
          ]);
        } catch {
          // Never expose the database error.
          return fail('unavailable');
        }
        if (await store.get(ws, locationId)) return { body };
        // Still holding our claim: nothing committed because the workspace was full.
        const ours = await db.prepare('SELECT 1 AS held FROM directory_api_keys WHERE workspace_id = ? AND key = ? AND result = ?')
          .bind(ws, key, claim).first();
        if (ours) return fail('limit_reached', { limit: MAX_WORKSPACE_LOCATIONS });
        // Superseded: answer as any retry would (the replacement's result, or 409 while it runs).
        return (await replay()) ?? fail('unavailable', { retryAfterSeconds: 1 });
      } finally {
        // Release only this attempt's claim (a no-op once it has committed), so a retry runs again.
        await db.prepare('DELETE FROM directory_api_keys WHERE workspace_id = ? AND key = ? AND result = ?').bind(ws, key, claim).run()
          .catch(() => {});
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
      // The write heals a delete claim expired by now (the check may have taken a while) and
      // returns the row it wrote: the rotation is applied with this answer, or not at all.
      const rotated = await store.rotate(kek, ws, locationId, credentials, (ctx.clock ?? (() => ctx.now ?? Date.now()))());
      return rotated ? { body: asLinkLocation(rotated) } : fail('not_found');
    }

    case 'deleteLinkLocation': {
      const locationId = ctx.params.locationId;
      // DELETE answers 204 when the location does not exist (contract section 5), before anything else.
      if (!locationIdPattern.test(locationId) || !await store.get(ws, locationId)) return {};
      // An existing location stays until the usage port (M3-13, M3-15b) can say nothing uses it.
      const usage = ctx.env.LINK_USAGE;
      if (!usage || typeof usage.inUse !== 'function') return fail('feature_unavailable');
      let outcome: Awaited<ReturnType<LinkStorageStore['delete']>>;
      try {
        outcome = await store.delete(ws, locationId, usage, now);
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
