// The backend's side of link storage credentials (docs/m3-outbound-plan.md, M3-15a).
// mail-content never binds the KEK or a write credential: it asks here for one
// workspace location's read-only credential, and only the read column is opened.
import { linkKek } from '../../../packages/link-storage/src/kek.ts';
import { LinkStorageStore, type LinkDatabase } from '../../../packages/link-storage/src/store.ts';
import { workspaceMailBucket } from './directory.ts';

export type LinkCredentialEnv = { LINK_CRED_KEK?: string; DIRECTORY: D1Database };

/** A plain object, so it can cross RPC; it holds the read-only key and nothing else. */
export interface LinkReadCredential { accessKeyId: string; secretAccessKey: string }

const locationId = (value: unknown): value is string => typeof value === 'string' && /^[a-z2-7]{26}$/.test(value);

function store(env: LinkCredentialEnv): LinkStorageStore {
  // A stale replica must not keep serving a rotated or deleted location's old key.
  return new LinkStorageStore(env.DIRECTORY.withSession('first-primary') as unknown as LinkDatabase);
}

/** The read-only credential of a workspace's location, or null. Never throws a detail. */
export async function linkReadCredential(env: LinkCredentialEnv, ws: unknown, loc: unknown): Promise<LinkReadCredential | null> {
  if (typeof ws !== 'string' || !locationId(loc)) return null;
  try { workspaceMailBucket(ws); } catch { return null; }
  const kek = await linkKek(env.LINK_CRED_KEK);
  if (!kek) return null;
  try {
    // A lookup only reads: no rewrap here (the operator job and write paths rewrap).
    const credentials = await store(env).credential(kek, ws, loc, 'read', { rewrap: false });
    return credentials && credentials.reveal();
  } catch {
    return null;
  }
}

/** The bounded operator rewrap job after a KEK rotation (at most 100 credentials per call); pass `next` back until null. */
export async function rewrapLinkCredentials(env: LinkCredentialEnv, limit: number, cursor: string | null = null) {
  const kek = await linkKek(env.LINK_CRED_KEK);
  if (!kek) throw new Error('Link credential KEK unavailable');
  return store(env).rewrapStale(kek, limit, cursor);
}

/** The KEK versions still in use; a version can be removed from the secret once it is not listed. */
export async function linkCredentialKeyVersions(env: LinkCredentialEnv): Promise<number[]> {
  return store(env).keyVersionsInUse(Date.now());
}
