// Link storage rows in the directory database (migration 0010). Every query is
// a primary-key lookup, a per-workspace page of at most `MAX_WORKSPACE_LOCATIONS`
// rows, or an indexed key-version lookup with a limit.

import type { CredentialRole, S3Credentials } from './credentials.ts';
import { openCredential, sealCredential, type LinkKek } from './kek.ts';
import { locationFingerprint, type DeploymentLocations, type LinkLocationFields } from './location.ts';

export interface LinkStatement {
  bind(...values: (string | number | null)[]): LinkStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface LinkDatabase {
  prepare(query: string): LinkStatement;
  batch(statements: LinkStatement[]): Promise<unknown[]>;
}

/** How long a delete's claim holds before another delete may take it over. */
export const DELETE_CLAIM_MS = 60_000;
/** The longest a delete waits for its usage check. */
export const USAGE_TIMEOUT_MS = 20_000;

/** A workspace may keep a few locations at once: the current one, and older ones its links still use. */
export const MAX_WORKSPACE_LOCATIONS = 8;

/**
 * Whether anything still references a location: a live link, a pending delete, a
 * draft attachment or an unfinished upload. M3-13 and M3-15b provide it; until
 * then no deployment binds one, and deleting a location fails closed.
 */
export interface LinkLocationUsage {
  inUse(location: { workspaceId: string; locationId: string }): Promise<boolean>;
}

export interface StoredLocation extends LinkLocationFields {
  workspaceId: string;
  locationId: string;
  current: boolean;
  /** `deleting` while a delete checks whether anything still uses the location. */
  state: 'active' | 'deleting';
  readKeyLast4: string;
  writeKeyLast4: string;
  createdAt: number;
  rotatedAt: number | null;
}

interface LocationRow {
  workspace_id: string; location_id: string; endpoint: string; region: string; bucket: string; prefix: string;
  path_style: number; current: number; state: 'active' | 'deleting'; read_key_last4: string; write_key_last4: string; created_at: number; rotated_at: number | null;
}
interface SealedRow { key_version: number; sealed: string }

/** The workspace's current location is being deleted: retry; never fall back to another location. */
export class LocationPendingDeleteError extends Error {
  constructor() { super('Link location delete pending'); this.name = 'LocationPendingDeleteError'; }
}

export class LocationRepointedError extends Error {
  constructor() { super('Link location id is already recorded with other fields'); this.name = 'LocationRepointedError'; }
}

const columns = `workspace_id, location_id, endpoint, region, bucket, prefix, path_style, current, state,
  read_key_last4, write_key_last4, created_at, rotated_at`;
const asLocation = (row: LocationRow): StoredLocation => ({
  workspaceId: row.workspace_id, locationId: row.location_id, endpoint: row.endpoint, region: row.region, bucket: row.bucket,
  prefix: row.prefix, pathStyle: row.path_style === 1, current: row.current === 1, state: row.state, readKeyLast4: row.read_key_last4,
  writeKeyLast4: row.write_key_last4, createdAt: row.created_at, rotatedAt: row.rotated_at,
});
// Fixed column names per role: never interpolated from input.
const sealedColumns = {
  read: { version: 'read_key_version', sealed: 'read_sealed' },
  write: { version: 'write_key_version', sealed: 'write_sealed' },
} as const;

/**
 * SQL condition, binding one workspace id: the workspace is below its location
 * limit. Every statement of a create batch uses it, so they all apply or none do.
 */
export const HAS_ROOM = `(SELECT count(*) FROM link_storage_locations WHERE workspace_id = ?) < ${MAX_WORKSPACE_LOCATIONS}`;

function rewrapCursor(cursor: string | null): [number, number, string, string] {
  if (cursor === null) return [0, 0, '', ''];
  let value: unknown;
  try { value = typeof cursor === 'string' && cursor.length <= 256 ? JSON.parse(cursor) : undefined; } catch { value = undefined; }
  if (!Array.isArray(value) || value.length !== 4) throw new Error('Invalid rewrap cursor');
  const [role, version, ws, loc] = value;
  if ((role !== 0 && role !== 1) || !Number.isSafeInteger(version) || version < 0 || version > 255
    || typeof ws !== 'string' || ws.length > 58 || typeof loc !== 'string' || loc.length > 26) throw new Error('Invalid rewrap cursor');
  return [role, version, ws, loc];
}

/** A new location id: 128 random bits as 26 lowercase base32 characters. */
export function newLocationId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = crypto.getRandomValues(new Uint8Array(17));
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export class LinkStorageStore {
  readonly #db: LinkDatabase;
  constructor(db: LinkDatabase) { this.#db = db; }

  /**
   * Returns a workspace's `deleting` rows whose claim is older than `DELETE_CLAIM_MS`
   * to `active`: their delete failed or was abandoned (at most `MAX_WORKSPACE_LOCATIONS` rows).
   */
  async healStaleDeletes(workspaceId: string, now = Date.now()): Promise<void> {
    await this.#db.prepare(`UPDATE link_storage_locations SET state = 'active', delete_claim = NULL, delete_claimed_at = NULL
      WHERE workspace_id = ? AND state = 'deleting' AND delete_claimed_at <= ?`).bind(workspaceId, now - DELETE_CLAIM_MS).run();
  }

  /** Every location of a workspace, `deleting` ones included (stale claims healed first). */
  async list(workspaceId: string, now = Date.now()): Promise<StoredLocation[]> {
    await this.healStaleDeletes(workspaceId, now);
    const { results } = await this.#db.prepare(`SELECT ${columns} FROM link_storage_locations
      WHERE workspace_id = ? ORDER BY created_at, location_id LIMIT ?`).bind(workspaceId, MAX_WORKSPACE_LOCATIONS).all<LocationRow>();
    return results.map(asLocation);
  }

  /** One location, `deleting` included: links already made with it keep resolving. Read-only. */
  async get(workspaceId: string, locationId: string): Promise<StoredLocation | null> {
    const row = await this.#db.prepare(`SELECT ${columns} FROM link_storage_locations
      WHERE workspace_id = ? AND location_id = ?`).bind(workspaceId, locationId).first<LocationRow>();
    return row && asLocation(row);
  }

  /**
   * Statements that insert a new location as the workspace's current one, sealed
   * under the current KEK version. Run them in one batch, after any idempotency
   * record (which should use `HAS_ROOM` too); they change nothing when the
   * workspace is at its limit.
   */
  async createStatements(kek: LinkKek, workspaceId: string, locationId: string, fields: LinkLocationFields,
    credentials: { read: S3Credentials; write: S3Credentials }, now: number,
    guard: { sql: string; binds: (string | number)[] } = { sql: '1', binds: [] }): Promise<LinkStatement[]> {
    const read = await sealCredential(kek, workspaceId, locationId, 'read', credentials.read);
    const write = await sealCredential(kek, workspaceId, locationId, 'write', credentials.write);
    const fingerprint = await locationFingerprint(fields);
    // `guard` is an extra condition (with its binds) every statement requires, such as the caller's idempotency claim.
    const room = `${HAS_ROOM} AND (${guard.sql})`;
    return [
      this.#db.prepare(`UPDATE link_storage_locations SET current = 0 WHERE workspace_id = ? AND current = 1 AND ${room}`)
        .bind(workspaceId, workspaceId, ...guard.binds),
      this.#db.prepare(`INSERT INTO link_storage_locations (workspace_id, location_id, endpoint, region, bucket, prefix, path_style,
          fingerprint, state, current, read_key_last4, read_key_version, read_sealed, write_key_last4, write_key_version, write_sealed,
          created_at, rotated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, NULL WHERE ${room}`).bind(
        workspaceId, locationId, fields.endpoint, fields.region, fields.bucket, fields.prefix, fields.pathStyle ? 1 : 0, fingerprint,
        credentials.read.keyIdLast4, read.version, read.sealed, credentials.write.keyIdLast4, write.version, write.sealed, now, workspaceId,
        ...guard.binds),
    ];
  }

  /** Replaces both credentials of a location in place (a pending delete does not block it). False if there is no such location. */
  async rotate(kek: LinkKek, workspaceId: string, locationId: string, credentials: { read: S3Credentials; write: S3Credentials },
    now: number): Promise<boolean> {
    const read = await sealCredential(kek, workspaceId, locationId, 'read', credentials.read);
    const write = await sealCredential(kek, workspaceId, locationId, 'write', credentials.write);
    const { meta } = await this.#db.prepare(`UPDATE link_storage_locations SET read_key_last4 = ?, read_key_version = ?, read_sealed = ?,
        write_key_last4 = ?, write_key_version = ?, write_sealed = ?, rotated_at = ?
      WHERE workspace_id = ? AND location_id = ?`).bind(
      credentials.read.keyIdLast4, read.version, read.sealed, credentials.write.keyIdLast4, write.version, write.sealed, now,
      workspaceId, locationId).run();
    return (meta.changes ?? 0) > 0;
  }

  /**
   * Deletes a location unless something still uses it. It first marks the row
   * `deleting`, so no new reference can be written (writers require `active`),
   * then asks `usage`; a location in use is set back to `active`. While another
   * delete is checking, the answer is `pending`; a claim left by a failed delete
   * expires after `DELETE_CLAIM_MS`, and the next delete takes it over.
   */
  async delete(workspaceId: string, locationId: string, usage: LinkLocationUsage, now = Date.now()):
    Promise<'deleted' | 'in_use' | 'pending' | 'not_found'> {
    // A claim stamps the row; only its holder may restore or delete it. A claim older
    // than DELETE_CLAIM_MS (its holder failed or gave up) can be taken over, so a
    // location is never left hidden for good.
    const claim = crypto.randomUUID();
    const marked = await this.#db.prepare(`UPDATE link_storage_locations SET state = 'deleting', delete_claim = ?, delete_claimed_at = ?
      WHERE workspace_id = ? AND location_id = ? AND (state = 'active' OR (state = 'deleting' AND delete_claimed_at <= ?))`)
      .bind(claim, now, workspaceId, locationId, now - DELETE_CLAIM_MS).run();
    if (!marked.meta.changes) {
      // Another delete of this location is checking its usage right now.
      const pending = await this.#db.prepare(`SELECT 1 AS pending FROM link_storage_locations
        WHERE workspace_id = ? AND location_id = ? AND state = 'deleting'`).bind(workspaceId, locationId).first();
      return pending ? 'pending' : 'not_found';
    }
    const restore = () => this.#db.prepare(`UPDATE link_storage_locations SET state = 'active', delete_claim = NULL, delete_claimed_at = NULL
      WHERE workspace_id = ? AND location_id = ? AND state = 'deleting' AND delete_claim = ?`).bind(workspaceId, locationId, claim).run();
    let used = true;
    try {
      // A usage check that takes too long keeps the location and fails, well before the claim can be taken over.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((_, reject) => { timer = setTimeout(() => reject(new Error('Link location usage check timed out')), USAGE_TIMEOUT_MS); });
      try {
        used = await Promise.race([usage.inUse({ workspaceId, locationId }), timeout]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      if (used !== false) await restore();
    }
    if (used !== false) return 'in_use';
    let deleted;
    try {
      deleted = await this.#db.prepare(`DELETE FROM link_storage_locations
        WHERE workspace_id = ? AND location_id = ? AND state = 'deleting' AND delete_claim = ?`).bind(workspaceId, locationId, claim).run();
    } catch (error) {
      // If this restore fails too, the claim expires and a retried delete takes it over.
      await restore().catch(() => {});
      throw error;
    }
    return deleted.meta.changes ? 'deleted' : 'pending';
  }

  /**
   * Opens one credential of a location (`active` or `deleting`). Unless `rewrap` is false (read-only
   * callers such as the content lookup), a value sealed under an older KEK version is
   * rewrapped under the current one (a conditional update, so a concurrent rotation
   * always wins). Null if there is no such location.
   */
  async credential(kek: LinkKek, workspaceId: string, locationId: string, role: CredentialRole,
    { rewrap = true }: { rewrap?: boolean } = {}): Promise<S3Credentials | null> {
    const column = sealedColumns[role];
    // No state filter: links made with a location keep their key while a delete checks its usage.
    const row = await this.#db.prepare(`SELECT ${column.version} AS key_version, ${column.sealed} AS sealed FROM link_storage_locations
      WHERE workspace_id = ? AND location_id = ?`).bind(workspaceId, locationId).first<SealedRow>();
    if (!row) return null;
    const credentials = await openCredential(kek, workspaceId, locationId, role, row.key_version, row.sealed);
    if (rewrap && row.key_version !== kek.current) await this.#rewrap(kek, workspaceId, locationId, role, row, credentials);
    return credentials;
  }

  async #rewrap(kek: LinkKek, workspaceId: string, locationId: string, role: CredentialRole, row: SealedRow,
    credentials: S3Credentials): Promise<boolean> {
    const column = sealedColumns[role];
    const next = await sealCredential(kek, workspaceId, locationId, role, credentials);
    const { meta } = await this.#db.prepare(`UPDATE link_storage_locations SET ${column.version} = ?, ${column.sealed} = ?
      WHERE workspace_id = ? AND location_id = ? AND ${column.version} = ? AND ${column.sealed} = ?`)
      .bind(next.version, next.sealed, workspaceId, locationId, row.key_version, row.sealed).run();
    return (meta.changes ?? 0) > 0;
  }

  /**
   * The bounded operator rewrap job: rewraps up to `limit` (at most 100) credentials
   * sealed under a version other than the current one, walking each role's stale
   * versions in index order. Values it cannot open are counted and left as they are,
   * and the walk moves past them. Pass `next` back until it is null.
   */
  async rewrapStale(kek: LinkKek, limit: number, cursor: string | null = null):
    Promise<{ rewrapped: number; failed: number; next: string | null }> {
    const bound = Math.max(1, Math.min(100, Math.floor(limit) || 1));
    let [role, version, ws, loc] = rewrapCursor(cursor);
    let rewrapped = 0;
    let failed = 0;
    let budget = bound;
    const roles = ['read', 'write'] as const;
    // The next stale version of a column after `after`, by index seeks; 0 if none.
    const nextVersion = async (column: string, after: number): Promise<number> => {
      for (;;) {
        const row = await this.#db.prepare(`SELECT ${column} AS version FROM link_storage_locations WHERE ${column} > ? ORDER BY ${column} LIMIT 1`)
          .bind(after).first<{ version: number }>();
        if (!row) return 0;
        if (row.version !== kek.current) return row.version;
        after = row.version;
      }
    };
    while (role < roles.length && budget > 0) {
      const column = sealedColumns[roles[role]];
      if (version === 0) {
        version = await nextVersion(column.version, 0);
        if (version === 0) { role++; continue; }
      }
      const { results } = await this.#db.prepare(`SELECT workspace_id, location_id, ${column.version} AS key_version, ${column.sealed} AS sealed
        FROM link_storage_locations WHERE ${column.version} = ? AND (workspace_id, location_id) > (?, ?)
        ORDER BY workspace_id, location_id LIMIT ?`).bind(version, ws, loc, budget).all<SealedRow & { workspace_id: string; location_id: string }>();
      for (const row of results) {
        try {
          const credentials = await openCredential(kek, row.workspace_id, row.location_id, roles[role], row.key_version, row.sealed);
          if (await this.#rewrap(kek, row.workspace_id, row.location_id, roles[role], row, credentials)) rewrapped++;
        } catch {
          failed++;
        }
        ws = row.workspace_id;
        loc = row.location_id;
      }
      const asked = budget;
      budget -= results.length;
      if (results.length < asked) {
        version = await nextVersion(column.version, version);
        ws = '';
        loc = '';
        if (version === 0) role++;
      }
    }
    return { rewrapped, failed, next: role < roles.length ? JSON.stringify([role, version, ws, loc]) : null };
  }

  /** Every KEK version a stored credential uses. An old version can be removed once it is not listed. */
  async keyVersionsInUse(): Promise<number[]> {
    const versions = new Set<number>();
    for (const column of ['read_key_version', 'write_key_version'] as const) {
      // Each step is one index seek past the previous version: at most 255 seeks per column.
      let after = 0;
      for (;;) {
        const row = await this.#db.prepare(`SELECT ${column} AS version FROM link_storage_locations WHERE ${column} > ? ORDER BY ${column} LIMIT 1`)
          .bind(after).first<{ version: number }>();
        if (!row) break;
        versions.add(row.version);
        after = row.version;
      }
    }
    return [...versions].sort((a, b) => a - b);
  }

  /**
   * Records a deployment location's fingerprint on its first use and refuses an id
   * whose recorded fingerprint differs. Call it before any use of a deployment id.
   */
  async ensureDeploymentFingerprint(locationId: string, fields: LinkLocationFields, now: number): Promise<void> {
    const fingerprint = await locationFingerprint(fields);
    await this.#db.prepare('INSERT OR IGNORE INTO link_location_fingerprints (location_id, fingerprint, recorded_at) VALUES (?, ?, ?)')
      .bind(locationId, fingerprint, now).run();
    const row = await this.#db.prepare('SELECT fingerprint FROM link_location_fingerprints WHERE location_id = ?').bind(locationId)
      .first<{ fingerprint: string }>();
    if (row?.fingerprint !== fingerprint) throw new LocationRepointedError();
  }

  /**
   * The location new links of a workspace use: its current override, else the
   * deployment's current location (fingerprint-checked). Null if neither exists.
   * While the current override is being deleted it throws `LocationPendingDeleteError`
   * (retryable): new links never fall back to the deployment's storage then.
   */
  async currentLocation(workspaceId: string, deployment: DeploymentLocations | undefined, now: number):
    Promise<{ kind: 'workspace'; location: StoredLocation } | { kind: 'deployment'; locationId: string; fields: LinkLocationFields } | null> {
    await this.healStaleDeletes(workspaceId, now);
    const row = await this.#db.prepare(`SELECT ${columns} FROM link_storage_locations
      WHERE workspace_id = ? AND current = 1`).bind(workspaceId).first<LocationRow>();
    if (row?.state === 'deleting') throw new LocationPendingDeleteError();
    if (row) return { kind: 'workspace', location: asLocation(row) };
    if (!deployment) return null;
    const fields = deployment.locations.get(deployment.current)!;
    await this.ensureDeploymentFingerprint(deployment.current, fields, now);
    return { kind: 'deployment', locationId: deployment.current, fields };
  }
}

