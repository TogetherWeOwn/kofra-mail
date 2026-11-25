import { deltaRange, INCARNATION, journalPrefix, readDelta, writeDelta } from './journal-backup.ts';
import { sha256 } from './bytes.ts';
import { MissingMailError, type MailboxIndex, type SnapshotRow } from './mailbox-index.ts';
import type { ReplayDelivery } from './outbox.ts';

export const SETTINGS_FLUSH_MS = 60_000;
export const FLAGS_FLUSH_MS = 60 * 60_000;
export const SNAPSHOT_INTERVAL_MS = 7 * 24 * FLAGS_FLUSH_MS;
// Alarms fire this much before a recovery-point deadline, leaving time to publish.
export const PUBLISH_BUDGET_MS = 15_000;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_PAGES = 1_000_000;
const MAX_DELTA_PAGES_PER_RUN = 128;
const MAX_UPLOAD_PAGES_PER_RUN = 128;
// A manifest naming this many deltas forces a snapshot, which drops the covered ones.
const MAX_DELTA_KEYS = 20_000;
const EVENT_HASH = /^[a-f0-9]{64}$/;
const MAX_CLEANUP_DELETES = 100;

type Bucket = Pick<R2Bucket, 'get' | 'put'> & Partial<Pick<R2Bucket, 'list' | 'delete'>>;
export type CleanupCursor = { incarnation: string; snapshot: string | null; snapshots: string | null; deltas: string | null };
export type Scope = { workspaceId: string; mailboxId: string };

// Version 2. Only the incarnation named in the manifest may replace it, and only
// conditionally on the ETag it last wrote. A baseline has no snapshot.
export type MailboxManifest = {
  version: 2; incarnation: string; rev: number; snapshot_key: string | null;
  delta_keys: string[]; last_seq: number; delivery_cursor: number;
  // Hash chain over every journal event through last_seq ('' for none), so a
  // writer whose local history diverged anywhere (for example after a
  // point-in-time rewind) is detected rather than trusted.
  last_chain?: string | null;
};
type SnapshotHead = { version: 2; seq: number; pages: number };
// `recovery` marks an upload begun after the manifest was found missing.
type Upload = { key: string; seq: number; deliveryCursor: number; after: number; pages: number; done: boolean; recovery?: true };

export type InitLife = { state: 'init'; scope: Scope; incarnation: string };
export type ReadyLife = {
  state: 'ready'; scope: Scope; incarnation: string; etag: string; rev: number;
  nextSnapshotAt: number; lastPublishedAt: number; lastSnapshotAt: number; failures: number; upload: Upload | null;
  reindexAfter: string;
  // Completed deliveries the last restore skipped because their raw object was gone.
  restoreSkipped?: number;
  // Background reindex backoff, separate from publication failures.
  reindexFailures?: number; reindexRetryAt?: number;
  // The manifest position a restore rebuilt from; its event is not in the local journal.
  baseSeq?: number; baseChain?: string | null;
  // Set when publication found a manifest this state cannot have written.
  conflict?: string;
};
export type RestoringLife = {
  state: 'restoring'; scope: Scope; incarnation: string; startedAt: number; failures: number; bootstrap: boolean;
  phase: 'reset' | 'fence' | 'takeover' | 'snapshot' | 'deltas' | 'deliveries';
  epoch: number | null; etag: string | null; rev: number; page: number; rowNo: number; delta: number; after: number;
  // Completed deliveries whose raw object was verifiably gone during replay.
  skipped: number;
  baseSeq?: number; baseChain?: string | null;
  // Times this restore restarted because its manifest was confirmed missing.
  restarts?: number;
};
// Backups are gone but completed deliveries show this mailbox existed. Only an
// explicit bootstrap may start it again from the retained deliveries.
export type MissingLife = { state: 'missing'; scope: Scope; incarnation: string; since: number; failures: number };
export type Lifecycle = InitLife | ReadyLife | RestoringLife | MissingLife;

export class BackupConflict extends Error {}
// A read confirmed that the manifest a restore depends on no longer exists.
class ManifestMissing extends Error {}
// Thrown before any write when an artifact exceeds the size cap.
export class OversizedArtifact extends Error {}

export function readyLife(scope: Scope, incarnation: string, etag: string, rev: number, now: number): ReadyLife {
  return { state: 'ready', scope, incarnation, etag, rev, nextSnapshotAt: now + SNAPSHOT_INTERVAL_MS,
    lastPublishedAt: now, lastSnapshotAt: now, failures: 0, upload: null, reindexAfter: '' };
}

export function restoringLife(scope: Scope, incarnation: string, now: number, bootstrap = false): RestoringLife {
  return { state: 'restoring', scope, incarnation, startedAt: now, failures: 0, bootstrap, phase: 'reset',
    epoch: null, etag: null, rev: 0, page: 0, rowNo: 0, delta: 0, after: 0, skipped: 0 };
}

const uint = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

async function getJson<T>(bucket: Bucket, key: string): Promise<{ value: T; etag: string } | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > MAX_ARTIFACT_BYTES) throw new Error('Oversized mailbox backup artifact');
  return { value: await object.json<T>(), etag: object.etag };
}

function encode(value: unknown): string {
  const data = JSON.stringify(value);
  if (new TextEncoder().encode(data).byteLength > MAX_ARTIFACT_BYTES) throw new OversizedArtifact('Oversized mailbox backup artifact');
  return data;
}

export type RestorePorts = {
  now(): number;
  // Invalidates every delivery claim taken before restore began; returns the new epoch.
  fence(): Promise<number | null>;
  replayPage(after: number): Promise<ReplayDelivery[]>;
  release(key: string, holder: string): Promise<void>;
  // Recreates local state derived from the restored rows (timer rows), inside
  // the transaction that finishes the restore.
  rebuild?(now: number): void;
};

export class MailboxRecovery {
  private readonly prefix: string;
  private readonly manifestKey: string;

  constructor(private readonly index: MailboxIndex, private readonly bucket: Bucket, scope: string) {
    this.prefix = journalPrefix(scope);
    this.manifestKey = `${this.prefix}manifest.json`;
  }

  private snapshotKey(gen: string) { return `${this.prefix}snapshots/${gen}/head.json`; }
  private pageKey(head: string, page: number) { return `${head.slice(0, -'head.json'.length)}${page}.json`; }

  private validSnapshotKey(key: unknown): key is string {
    if (typeof key !== 'string' || !key.startsWith(`${this.prefix}snapshots/`) || !key.endsWith('/head.json')) return false;
    const gen = key.slice(`${this.prefix}snapshots/`.length, -'/head.json'.length);
    return INCARNATION.test(gen);
  }

  async read(): Promise<{ manifest: MailboxManifest; etag: string } | null> {
    const found = await getJson<MailboxManifest>(this.bucket, this.manifestKey);
    if (!found) return null;
    const m = found.value;
    let next = 0;
    const deltasValid = Array.isArray(m.delta_keys) && m.delta_keys.every((key, i) => {
      const range = deltaRange(this.prefix, key);
      if (!range || (i > 0 && range.from !== next)) return false;
      next = range.last + 1;
      return true;
    });
    if (m.version !== 2 || typeof m.incarnation !== 'string' || !INCARNATION.test(m.incarnation) || !uint(m.rev) || m.rev < 1 ||
        !uint(m.last_seq) || !uint(m.delivery_cursor) || (m.snapshot_key !== null && !this.validSnapshotKey(m.snapshot_key)) ||
        !deltasValid || (m.delta_keys.length > 0 && next - 1 !== m.last_seq) ||
        (m.last_chain !== undefined && m.last_chain !== null && m.last_chain !== '' && !EVENT_HASH.test(m.last_chain))) {
      throw new Error('Invalid mailbox backup manifest');
    }
    return { manifest: m, etag: found.etag };
  }

  // Only the ready alarm writer may call this, after publishing. Re-read before
  // listing or deleting: a local checkpoint alone does not prove ownership.
  async cleanup(life: ReadyLife, prior?: CleanupCursor): Promise<CleanupCursor | null> {
    if (!this.bucket.list || !this.bucket.delete) return null;
    const current = await this.read();
    if (!current || current.etag !== life.etag || current.manifest.incarnation !== life.incarnation) return null;
    const manifest = current.manifest;
    if (prior?.incarnation !== life.incarnation || prior.snapshot !== manifest.snapshot_key) prior = undefined;
    const next: CleanupCursor = { incarnation: life.incarnation, snapshot: manifest.snapshot_key, snapshots: null, deltas: null };
    const live = new Set(manifest.delta_keys);
    const generation = (key: string | null | undefined) => key?.slice(0, -'head.json'.length);
    const protectedSnapshots = [generation(manifest.snapshot_key), generation(life.upload?.key)];
    const remove: string[] = [];
    for (const kind of ['snapshots', 'deltas'] as const) {
      if (prior?.[kind] === null) continue;
      const prefix = `${this.prefix}${kind}/`;
      const limit = MAX_CLEANUP_DELETES - remove.length;
      if (!limit) { next[kind] = prior?.[kind] ?? prefix; continue; }
      const page = await this.bucket.list({ prefix, limit, startAfter: prior?.[kind] });
      for (const { key } of page.objects) {
        if (kind === 'snapshots') {
          const gen = key.slice(prefix.length).split('/', 1)[0];
          if (INCARNATION.test(gen) && !protectedSnapshots.includes(`${prefix}${gen}/`)) remove.push(key);
        } else {
          const range = deltaRange(this.prefix, key);
          if (range && !live.has(key) && (range.incarnation !== life.incarnation || range.last <= manifest.last_seq)) {
            remove.push(key);
          }
        }
      }
      if (page.truncated && page.objects.length) next[kind] = page.objects[page.objects.length - 1].key;
    }
    if (remove.length) await this.bucket.delete(remove);
    return next.snapshots || next.deltas ? next : null;
  }

  // Conditional create; null means a manifest already exists.
  async create(incarnation: string): Promise<string | null> {
    const baseline: MailboxManifest = { version: 2, incarnation, rev: 1, snapshot_key: null, delta_keys: [], last_seq: 0, delivery_cursor: 0,
      last_chain: '' };
    const written = await this.bucket.put(this.manifestKey, encode(baseline), {
      onlyIf: new Headers({ 'if-none-match': '*' }), httpMetadata: { contentType: 'application/json' } });
    return written?.etag ?? null;
  }

  // Conditional replace; null means the manifest changed since `etag`.
  private async replace(manifest: MailboxManifest, etag: string): Promise<string | null> {
    const written = await this.bucket.put(this.manifestKey, encode(manifest), {
      onlyIf: { etagMatches: etag }, httpMetadata: { contentType: 'application/json' } });
    return written?.etag ?? null;
  }

  // One bounded publication run, serialized by the caller's backup lane. Deltas are
  // drained through the current revision before any snapshot work, and a failing
  // snapshot never stops them. Returns the persisted lifecycle.
  // onMissing runs once the manifest is confirmed absent, before any
  // re-establishment I/O, so the caller can drop published coverage even if
  // the replacement write then fails.
  async publish(life: ReadyLife, now: number, capture: () => Promise<{ seq: number; deliveryCursor: number }>,
    onMissing?: () => Promise<void>):
    Promise<{ life: ReadyLife; more: boolean; snapshotError: unknown; lastSeq: number; reestablishing?: true }> {
    const current = await this.read();
    // Tells the caller the published coverage is gone until the new manifest commits.
    if (!current) {
      await onMissing?.();
      return { ...await this.reestablish(life, now, capture), reestablishing: true };
    }
    if (current.manifest.incarnation !== life.incarnation) throw new BackupConflict('Mailbox backup owned by another incarnation');
    // A journal behind its own manifest (for example after a point-in-time rewind)
    // would renumber events the manifest already covers; refuse to publish.
    if (current.manifest.last_seq > this.index.journal.revision()) throw new BackupConflict('Mailbox journal is behind its backup manifest');
    await this.verifyHistory(life, current.manifest, current.etag === life.etag);
    // Remember the verified position so the next chain starts from here.
    if (current.manifest.last_chain) this.index.journal.setChain(current.manifest.last_seq, current.manifest.last_chain);
    let manifest = current.manifest;
    if (current.etag !== life.etag) {
      // Only this incarnation writes manifests carrying its id, and its history
      // was just verified: this is our own write whose reply was lost (or a state
      // rewound to an identical history). Adopt it and apply what it committed.
      life = this.committed(life, manifest, current.etag, now);
      // An unfinished upload from before may have had pages removed by a cleanup
      // since; restart it under a new generation from the first staged row.
      if (life.upload && manifest.snapshot_key !== life.upload.key) {
        life = { ...life, upload: { ...life.upload, key: this.snapshotKey(crypto.randomUUID()), after: 0, pages: 0, done: false } };
        this.index.setLifecycle(life);
      }
    }
    const commit = async (next: MailboxManifest) => {
      const chain = await this.chainAt(next.last_seq, life);
      const written = { ...next, rev: next.rev + 1, last_chain: chain };
      const etag = await this.replace(written, life.etag);
      if (!etag) {
        this.index.setLifecycle(life);
        throw new BackupConflict('Mailbox backup manifest changed during publication');
      }
      if (chain) this.index.journal.setChain(next.last_seq, chain);
      life = this.committed(life, written, etag, now);
      return written;
    };
    let changed = false;
    for (let pages = 0; pages < MAX_DELTA_PAGES_PER_RUN; pages++) {
      const cut = life.upload && manifest.last_seq < life.upload.seq ? life.upload.seq : undefined;
      const page = await writeDelta(this.index.journal, this.bucket, this.prefix, life.incarnation, manifest.last_seq, cut);
      if (!page) break;
      manifest = { ...manifest, delta_keys: [...manifest.delta_keys, page.key], last_seq: page.last };
      changed = true;
    }
    // Commit due deltas before any snapshot I/O, so a slow or stalled snapshot
    // upload can never hold back a draft or settings recovery point.
    // A crowded manifest is compacted by a snapshot soon.
    const crowded = manifest.delta_keys.length >= MAX_DELTA_KEYS;
    if (crowded && !life.upload && life.nextSnapshotAt > now) life = { ...life, nextSnapshotAt: now };
    const snapshotIo = life.upload ? !life.upload.done : now >= life.nextSnapshotAt;
    if (changed && snapshotIo) {
      // Still commit before snapshot I/O; only a manifest too large to write at
      // all waits for the snapshot switch that compacts it.
      try {
        manifest = await commit(manifest);
        changed = false;
      } catch (error) {
        if (!(error instanceof OversizedArtifact)) throw error;
      }
    }
    let snapshotError: unknown = null;
    try {
      life = await this.uploadSnapshot(life, now, capture);
    } catch (error) {
      snapshotError = error;
      life = { ...life, failures: life.failures + 1 };
    }
    const upload = life.upload;
    const switching = upload?.done === true && manifest.last_seq >= upload.seq;
    if (switching) {
      manifest = { ...manifest, snapshot_key: upload.key, delivery_cursor: upload.deliveryCursor,
        delta_keys: manifest.delta_keys.filter(key => deltaRange(this.prefix, key)!.from > upload.seq) };
      changed = true;
    }
    if (changed) manifest = await commit(manifest);
    // Nothing left to publish: the confirmed manifest is current as of now.
    else this.index.setLifecycle(life = snapshotError ? life : { ...life, lastPublishedAt: now });
    const more = this.index.journal.revision() > manifest.last_seq || life.upload !== null;
    return { life, more, snapshotError, lastSeq: manifest.last_seq };
  }


  // Applies the effects of a manifest this incarnation wrote, atomically with
  // the journal checkpoint and the lifecycle.
  // The hash chain through `seq`: from the latest stored position (or the
  // restore base) forward over local events. Null if an event is missing locally.
  private async chainAt(seq: number, life: ReadyLife): Promise<string | null> {
    if (seq === 0) return '';
    let from = 0;
    let chain: string | null = '';
    const stored = this.index.journal.chainedAtOrBefore(seq);
    if (stored) ({ seq: from, chain } = stored);
    if (life.baseSeq !== undefined && life.baseSeq <= seq && life.baseSeq > from) {
      from = life.baseSeq;
      chain = life.baseChain ?? null;
    }
    if (chain === null) return null;
    for (let at = from + 1; at <= seq; at++) {
      const event = this.index.journal.event(at);
      if (event === null) return null;
      chain = await sha256(new Uint8Array(new TextEncoder().encode(`${chain}\n${at}\n${event}`)));
    }
    return chain;
  }

  // Refuses to extend or adopt a manifest unless this state's whole history
  // through its last_seq hashes to the manifest's chain.
  private async verifyHistory(life: ReadyLife, manifest: MailboxManifest, ownEtag: boolean): Promise<void> {
    if (manifest.last_seq === 0) return;
    const local = await this.chainAt(manifest.last_seq, life);
    const recorded = manifest.last_chain ?? null;
    const consistent = local !== null && recorded !== null ? local === recorded : ownEtag;
    if (!consistent) throw new BackupConflict('Mailbox journal diverged from its backup manifest');
  }

  private committed(life: ReadyLife, manifest: MailboxManifest, etag: string, now: number): ReadyLife {
    let next: ReadyLife = { ...life, etag, rev: manifest.rev, lastPublishedAt: now, conflict: undefined };
    const switched = life.upload?.done === true && manifest.snapshot_key === life.upload.key;
    if (switched) next = { ...next, upload: null, nextSnapshotAt: now + SNAPSHOT_INTERVAL_MS, lastSnapshotAt: now, failures: 0 };
    this.index.transaction(() => {
      this.index.journal.checkpoint(manifest.last_seq);
      if (switched) this.index.clearSnapshot();
      this.index.setLifecycle(next);
    });
    return next;
  }

  // The manifest vanished while this incarnation still holds the full state (for
  // example, the backup store lost it). Publish a fresh snapshot and recreate the
  // manifest with a create-only put, so nothing that appeared meanwhile is replaced.
  private async reestablish(life: ReadyLife, now: number, capture: () => Promise<{ seq: number; deliveryCursor: number }>):
    Promise<{ life: ReadyLife; more: boolean; snapshotError: unknown; lastSeq: number }> {
    let snapshotError: unknown = null;
    // Pages of an upload begun before the loss may have gone with the manifest:
    // restart it under a new generation from the first staged row.
    if (life.upload && !life.upload.recovery) {
      life = { ...life, upload: { ...life.upload, key: this.snapshotKey(crypto.randomUUID()), after: 0, pages: 0, done: false,
        recovery: true } };
      this.index.setLifecycle(life);
    }
    try {
      life = await this.uploadSnapshot(life, now, capture, true);
    } catch (error) {
      snapshotError = error;
      life = { ...life, failures: life.failures + 1 };
      this.index.setLifecycle(life);
    }
    const upload = life.upload;
    if (snapshotError || !upload?.done) return { life, more: true, snapshotError, lastSeq: 0 };
    const manifest: MailboxManifest = { version: 2, incarnation: life.incarnation, rev: life.rev + 1,
      snapshot_key: upload.key, delta_keys: [], last_seq: upload.seq, delivery_cursor: upload.deliveryCursor,
      last_chain: await this.chainAt(upload.seq, life) };
    const written = await this.bucket.put(this.manifestKey, encode(manifest), {
      onlyIf: new Headers({ 'if-none-match': '*' }), httpMetadata: { contentType: 'application/json' } });
    if (!written) throw new BackupConflict('Mailbox backup manifest reappeared during re-establishment');
    if (manifest.last_chain) this.index.journal.setChain(manifest.last_seq, manifest.last_chain);
    life = this.committed(life, manifest, written.etag, now);
    return { life, more: this.index.journal.revision() > manifest.last_seq || life.upload !== null, snapshotError,
      lastSeq: manifest.last_seq };
  }

  private async uploadSnapshot(life: ReadyLife, now: number, capture: () => Promise<{ seq: number; deliveryCursor: number }>,
    force = false) {
    let upload = life.upload;
    if (!upload) {
      if (!force && now < life.nextSnapshotAt) return life;
      const captured = await capture();
      upload = { key: this.snapshotKey(crypto.randomUUID()), seq: captured.seq, deliveryCursor: captured.deliveryCursor,
        after: 0, pages: 0, done: false, ...(force ? { recovery: true as const } : {}) };
      life = { ...life, upload };
      this.index.setLifecycle(life);
    }
    // Staged rows are immutable until the next capture, so re-uploading a page
    // after a restart writes the same bytes to the same key.
    for (let uploaded = 0; !upload.done && uploaded < MAX_UPLOAD_PAGES_PER_RUN; uploaded++) {
      const rows = this.index.snapshotPage(upload.after);
      if (!rows.length) {
        await this.bucket.put(upload.key, encode({ version: 2, seq: upload.seq, pages: upload.pages } satisfies SnapshotHead),
          { httpMetadata: { contentType: 'application/json' } });
        upload = { ...upload, done: true };
        break;
      }
      if (upload.pages + 1 > MAX_SNAPSHOT_PAGES) throw new Error('Mailbox snapshot page limit exceeded');
      await this.bucket.put(this.pageKey(upload.key, upload.pages + 1), encode(rows), { httpMetadata: { contentType: 'application/json' } });
      upload = { ...upload, pages: upload.pages + 1, after: rows[rows.length - 1].row_no };
    }
    life = { ...life, upload };
    this.index.setLifecycle(life);
    return life;
  }

  private async owned(life: RestoringLife): Promise<MailboxManifest> {
    const current = await this.read();
    if (!current) throw new ManifestMissing('Mailbox backup manifest missing');
    if (current.etag !== life.etag || current.manifest.incarnation !== life.incarnation) {
      throw new BackupConflict('Mailbox backup manifest changed during restore');
    }
    return current.manifest;
  }

  // One bounded, resumable restore step. Every cursor advance commits with the
  // rows it covers, so a retry continues where the previous step stopped.
  async restoreStep(life: RestoringLife, ports: RestorePorts): Promise<Lifecycle> {
    try {
      return await this.restoreStepOnce(life, ports);
    } catch (error) {
      if (!(error instanceof ManifestMissing)) throw error;
      // The backups this restore relied on are gone (a confirmed absent read, not
      // a transient error or a conflict). Without an approved bootstrap, hold the
      // mailbox in `missing`. An approved bootstrap is never dropped: whatever the
      // phase, the restore restarts from a reset state as a bootstrap, except when
      // the bootstrap's own baseline vanished at takeover, which retries with
      // backoff and keeps the approval.
      return this.index.transaction(() => {
        const stored = this.index.lifecycle<Lifecycle>();
        const approved = life.bootstrap || (stored?.state === 'restoring' && stored.bootstrap);
        if (approved) {
          if (life.bootstrap && life.phase === 'takeover') throw new Error('Mailbox backup manifest missing during bootstrap');
          const next: RestoringLife = { ...restoringLife(life.scope, life.incarnation, ports.now(), true),
            startedAt: life.startedAt, restarts: (life.restarts ?? 0) + 1 };
          this.index.setLifecycle(next);
          return next;
        }
        const missing: MissingLife = { state: 'missing', scope: life.scope, incarnation: life.incarnation,
          since: ports.now(), failures: 0 };
        this.index.setLifecycle(missing);
        return missing;
      });
    }
  }

  private async restoreStepOnce(life: RestoringLife, ports: RestorePorts): Promise<Lifecycle> {
    // Every successful step is progress: consecutive failures restart from zero,
    // so a restore that keeps advancing never raises restore_blocked.
    const save = (step: RestoringLife, apply?: () => void) => this.index.transaction(() => {
      // An operator's bootstrap request may have been stored while this step ran.
      const stored = this.index.lifecycle<Lifecycle>();
      const bootstrap = step.bootstrap || (stored?.state === 'restoring' && stored.bootstrap);
      const next = { ...step, failures: 0, bootstrap };
      apply?.();
      this.index.setLifecycle(next);
      return next;
    });
    switch (life.phase) {
      case 'reset':
        return save({ ...life, phase: 'fence' }, () => this.index.resetForRestore());
      case 'fence':
        return save({ ...life, phase: 'takeover', epoch: await ports.fence() });
      case 'takeover': {
        let current = await this.read();
        // Use a bootstrap request stored while the read was in flight.
        const stored = this.index.lifecycle<Lifecycle>();
        if (stored?.state === 'restoring' && stored.bootstrap) life = { ...life, bootstrap: true };
        if (!current && life.bootstrap) {
          await this.create(life.incarnation);
          current = await this.read();
        }
        if (!current) throw new ManifestMissing('Mailbox backup manifest missing');
        let { etag } = current;
        if (current.manifest.incarnation !== life.incarnation) {
          // Fence older incarnations out of the manifest before reading it.
          const written = await this.replace({ ...current.manifest, incarnation: life.incarnation, rev: current.manifest.rev + 1 }, etag);
          if (!written) throw new BackupConflict('Mailbox backup manifest changed during takeover');
          etag = written;
        }
        const taken = await this.read();
        if (!taken) throw new ManifestMissing('Mailbox backup manifest missing after takeover');
        if (taken.etag !== etag) throw new BackupConflict('Mailbox backup manifest changed during takeover');
        return save({ ...life, phase: 'snapshot', etag, rev: taken.manifest.rev, page: 0, rowNo: 0 });
      }
      case 'snapshot': {
        const manifest = await this.owned(life);
        if (manifest.snapshot_key === null) return save({ ...life, phase: 'deltas', delta: 0 });
        const head = await getJson<SnapshotHead>(this.bucket, manifest.snapshot_key);
        const snapshot = head?.value;
        if (!snapshot || snapshot.version !== 2 || !uint(snapshot.pages) || snapshot.pages > MAX_SNAPSHOT_PAGES ||
            !uint(snapshot.seq) || snapshot.seq > manifest.last_seq) throw new Error('Invalid mailbox snapshot');
        if (life.page >= snapshot.pages) {
          return save({ ...life, phase: 'deltas', delta: 0 }, () => this.index.finishSnapshot(snapshot.seq));
        }
        const page = life.page + 1;
        const found = await getJson<SnapshotRow[]>(this.bucket, this.pageKey(manifest.snapshot_key, page));
        const rows = found?.value;
        if (!Array.isArray(rows) || !rows.length || rows.length > 64) throw new Error('Invalid mailbox snapshot page');
        return save({ ...life, page, rowNo: life.rowNo + rows.length }, () => {
          let rowNo = life.rowNo;
          for (const row of rows) {
            if (!row || row.row_no !== ++rowNo || typeof row.kind !== 'string' || typeof row.value !== 'string') {
              throw new Error('Invalid mailbox snapshot row');
            }
            this.index.restoreSnapshotRow(row);
          }
        });
      }
      case 'deltas': {
        const manifest = await this.owned(life);
        if (life.delta >= manifest.delta_keys.length) {
          if (this.index.journal.revision() !== manifest.last_seq) throw new Error('Mailbox backup journal gap');
          return save({ ...life, phase: 'deliveries', after: manifest.delivery_cursor,
            baseSeq: manifest.last_seq, baseChain: manifest.last_chain ?? null },
            () => this.index.journal.checkpoint(manifest.last_seq));
        }
        const key = manifest.delta_keys[life.delta];
        const rows = await readDelta(this.bucket, key, deltaRange(this.prefix, key)!);
        let releases: Array<{ key: string; holder: string }> = [];
        const next = save({ ...life, delta: life.delta + 1 }, () => { releases = rows.flatMap(row => this.index.replayRow(row)); });
        // A crash before these releases only retains an object longer.
        for (const release of releases) await ports.release(release.key, release.holder);
        return next;
      }
      case 'deliveries': {
        const rows = await ports.replayPage(life.after);
        if (!rows.length) {
          const now = ports.now();
          const ready: ReadyLife = { ...readyLife(life.scope, life.incarnation, life.etag!, life.rev, now),
            nextSnapshotAt: now, lastSnapshotAt: life.startedAt, restoreSkipped: life.skipped,
            baseSeq: life.baseSeq, baseChain: life.baseChain };
          this.index.transaction(() => {
            this.index.setLifecycle(ready);
            ports.rebuild?.(now);
          });
          return ready;
        }
        let after = life.after;
        for (const row of rows) {
          if (!uint(row.doneAt) || row.doneAt <= after) throw new Error('Non-monotonic mailbox delivery cursor');
          // Deduplicated by receipt and by Message-ID plus body hash.
          let skipped = life.skipped;
          try {
            await this.index.ingest(row.id, row.rawKey, row.createdAt, row.authResults);
          } catch (error) {
            if (!(error instanceof MissingMailError)) throw error;
            this.index.skipMissing(row.id);
            skipped++;
          }
          after = row.doneAt;
          life = save({ ...life, after, skipped });
        }
        return life;
      }
    }
  }
}
