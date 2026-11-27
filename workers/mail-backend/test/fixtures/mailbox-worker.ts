import { DurableObject } from 'cloudflare:workers';
import { MailboxIndex } from '../../src/mailbox-index.ts';
import { journalPrefix, replayJournal, writeDelta } from '../../src/journal-backup.ts';
import { sha256 } from '../../src/bytes.ts';
import { parseObjectKey, type ObjectKind } from '../../src/object-key.ts';
import { SweepLedger } from '../../src/sweep-ledger.ts';
import { MailboxRecovery, readyLife, restoringLife, SETTINGS_FLUSH_MS, type Lifecycle, type ReadyLife } from '../../src/mailbox-recovery.ts';
import { legacyFixtureObjects, seedLegacyDraft } from './legacy-draft.ts';
import { MailboxWork } from '../../src/mailbox-work.ts';
import { Mailbox } from '../../src/mailbox-do.ts';
import type { Env as MailboxEnv } from '../../src/worker.ts';

interface Env { RAW: R2Bucket; STATE: R2Bucket; SWEEP: DurableObjectNamespace<FixtureSweeper>; }
const FIXTURE_INCARNATION = '00000000-0000-4000-8000-000000000000';
type Delivery = [id: string, rawKey: string, createdAt: number, doneAt: number];

// Exercise the real alarm and storage scheduler, without an external holder service.
export class AlarmMailbox extends Mailbox {
  constructor(ctx: DurableObjectState, env: MailboxEnv) {
    super(ctx, { ...env, SWEEPER: { getByName: () => ({
      register: async () => { throw new Error('Unexpected alarm fixture registration'); },
      hold: async () => {}, release: async () => {},
      holdProvisional: async () => { throw new Error('Unexpected fixture holder'); }, confirm: async () => { throw new Error('Unexpected fixture confirmation'); },
      registerSend: async () => { throw new Error('Unexpected fixture send registration'); },
      releaseSend: async () => { throw new Error('Unexpected fixture send release'); },
    }) } });
  }
  async saveDraft(ws: string, mb: string, id: string, bytes: Uint8Array<ArrayBuffer>) {
    return this.mutate(ws, mb, SETTINGS_FLUSH_MS, index => seedLegacyDraft(index, legacyFixtureObjects(this.env, ws), id, bytes));
  }
  async scheduledAt() { return this.ctx.storage.getAlarm(); }
  // Step the real handler at explicit checkpoints instead of racing wall-clock alarms.
  override async alarm() {}
  async publishNow() { await super.alarm(); }
  async wipe() { await this.ctx.storage.deleteAll(); }
  async restoreState() {
    return JSON.stringify({
      labels: this.ctx.storage.sql.exec('SELECT id, name FROM labels ORDER BY id').toArray(),
      messages: this.ctx.storage.sql.exec('SELECT id FROM messages ORDER BY id').toArray(),
    });
  }
}

export class FixtureSweeper extends DurableObject {
  async register(kind: ObjectKind, digest: string, holder: string, now = 100) {
    return new SweepLedger(this.ctx.storage).register(kind, digest, holder, now);
  }
  async deleteDue(now: number, target: string, status: number) {
    const attempted: string[] = [];
    try {
      await new SweepLedger(this.ctx.storage).sweep(now, async key => {
        if (key === target) attempted.push(key);
        if (key !== target || ![204, 404].includes(status)) throw new Error('DELETE outcome not confirmed');
      });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return JSON.stringify(attempted);
  }
  async hold(key: string, holder: string, now = 100) { new SweepLedger(this.ctx.storage).hold(key, holder, now); }
  async release(key: string, holder: string, now = 100) { new SweepLedger(this.ctx.storage).release(key, holder, now); }
  async candidates(now: number) { return new SweepLedger(this.ctx.storage).candidates(now); }
}

// The streamed attachment PUT, checked as the object store checks it.
export function fixturePutUpload(bucket: R2Bucket) {
  return async (key: string, content: ReadableStream<Uint8Array>, size: number, digest: string) => {
    const bytes = new Uint8Array(await new Response(content).arrayBuffer());
    if (bytes.byteLength !== size || await sha256(bytes) !== digest) throw new Error('Fixture attachment PUT mismatch');
    await bucket.put(key, bytes);
  };
}

export class FixtureMailbox extends DurableObject<Env> {
  private rawReads = 0;
  private snapshotFault?: { method: 'GET' | 'PUT'; page: number };

  private index() {
    const refs = this.env.SWEEP.getByName('workspace');
    return new MailboxIndex(this.ctx.storage, {
      get: async key => {
        this.rawReads++;
        const object = await this.env.RAW.get(key);
        if (!object) throw new Error('Missing fixture object');
        return new Uint8Array(await object.arrayBuffer());
      },
      put: async (key, bytes) => { await this.env.RAW.put(key, bytes); },
      putUpload: fixturePutUpload(this.env.RAW),
      register: (kind, digest, holder) => refs.register(kind, digest, holder),
      hold: (key, holder) => refs.hold(key, holder),
      release: (key, holder) => refs.release(key, holder),
    }, this.ctx.id.toString());
  }
  private readonly work = new MailboxWork();
  private readonly ready = Promise.withResolvers<void>();
  private readonly resume = Promise.withResolvers<void>();

  async ingest(id: string, key: string, createdAt = 100) {
    await this.work.run(() => this.index().ingest(id, key, createdAt));
  }

  async failNextSnapshotPage(method: 'GET' | 'PUT', page: number) { this.snapshotFault = { method, page }; }
  async rawGetCount() { return this.rawReads; }

  private checkSnapshotFault(method: 'GET' | 'PUT', key: string) {
    if (this.snapshotFault?.method === method && key.includes('/snapshots/') && key.endsWith(`/${this.snapshotFault.page}.json`)) {
      this.snapshotFault = undefined;
      throw new Error(`Injected snapshot page ${method} failure`);
    }
  }

  private recovery(index: MailboxIndex, scope: string, pause = false) {
    const put = (async (key: string, value: string, options: R2PutOptions) => {
      this.checkSnapshotFault('PUT', key);
      if (pause && key.endsWith('/manifest.json')) {
        this.ready.resolve();
        await this.resume.promise;
      }
      return this.env.STATE.put(key, value, options);
    }) as R2Bucket['put'];
    return new MailboxRecovery(index, { get: key => {
      this.checkSnapshotFault('GET', key);
      return this.env.STATE.get(key);
    }, put }, scope);
  }

  async createBaseline(scope: string) {
    const index = this.index();
    const incarnation = crypto.randomUUID();
    const target = { workspaceId: 'fixture', mailboxId: scope };
    const etag = await this.recovery(index, scope).create(incarnation);
    if (!etag) return false;
    index.setLifecycle({ state: 'init', scope: target, incarnation });
    index.setLifecycle(readyLife(target, incarnation, etag, 1, Date.now()));
    return true;
  }

  private publish(index: MailboxIndex, life: ReadyLife, cursor: number, pause: boolean) {
    return this.recovery(index, life.scope.mailboxId, pause).publish(life, Date.now(),
      () => this.work.run(async () => ({ deliveryCursor: cursor, seq: index.captureSnapshot() })));
  }

  async publishOnce(cursor: number, full = false, pause = false) {
    const index = this.index();
    const life = index.lifecycle<Lifecycle>();
    if (life?.state !== 'ready') throw new Error('Fixture is not ready to publish');
    const result = await this.publish(index, full ? { ...life, nextSnapshotAt: 0 } : life, cursor, pause);
    return JSON.stringify({ more: result.more, snapshotError: result.snapshotError instanceof Error ? result.snapshotError.message : result.snapshotError });
  }

  // Miniflare's Node proxy obscures rejected workerd RPCs; return the original error text.
  async publishError(cursor: number, pause = false) {
    try { await this.publishOnce(cursor, false, pause); return ''; } catch (error) { return String(error); }
  }

  async publishBackup(scope: string, cursor: number, pause = false, full = false) {
    const index = this.index();
    let life = index.lifecycle<Lifecycle>();
    if (life?.state !== 'ready') {
      if (!await this.createBaseline(scope)) throw new Error('Fixture manifest exists');
      life = index.lifecycle<ReadyLife>()!;
      full = true;
    }
    if (full) life = { ...life, nextSnapshotAt: 0 };
    let snapshot = false;
    for (;;) {
      const result = await this.publish(index, life, cursor, pause);
      if (result.snapshotError) throw result.snapshotError;
      if (result.life.nextSnapshotAt !== life.nextSnapshotAt) snapshot = true;
      life = result.life;
      if (!result.more) break;
    }
    return snapshot;
  }

  async waitForManifest() { await this.ready.promise; }
  async releaseManifest() { this.resume.resolve(); }

  async beginRestore(scope: string) {
    const index = this.index();
    const target = { workspaceId: 'fixture', mailboxId: scope };
    const incarnation = crypto.randomUUID();
    index.setLifecycle({ state: 'init', scope: target, incarnation });
    index.setLifecycle(restoringLife(target, incarnation, Date.now()));
  }

  async restoreCursor() {
    const life = this.index().lifecycle<Lifecycle>();
    if (life?.state !== 'restoring') return JSON.stringify({ phase: life?.state });
    const { phase, page, rowNo, delta, after } = life;
    return JSON.stringify({ phase, page, rowNo, delta, after });
  }

  async advanceRestore(deliveries: Delivery[] = []) {
    const index = this.index();
    const life = index.lifecycle<Lifecycle>();
    if (life?.state !== 'restoring') throw new Error('Fixture is not restoring');
    const result = await this.recovery(index, life.scope.mailboxId).restoreStep(life, {
      now: Date.now, fence: async () => null, release: async () => {},
      replayPage: async after => deliveries.filter(row => row[3] > after)
        .map(([id, rawKey, createdAt, doneAt]) => ({ id, rawKey, createdAt, doneAt, authResults: null })),
    });
    return result.state;
  }

  async restoreStepError() {
    try { await this.advanceRestore(); return ''; } catch (error) { return String(error); }
  }

  async restoreBackup(scope: string, deliveries: Delivery[]) {
    await this.beginRestore(scope);
    while (await this.advanceRestore(deliveries) === 'restoring') { /* one cursor step */ }
    await this.rebuildSearch();
  }

  async rebuildSearch() {
    const index = this.index();
    for (const message of index.unindexed('', 1000)) await index.reindex(message.id, message.rawKey);
  }
  async search(query: string) { return this.index().search(query); }
  async ingestError(id: string, key: string) {
    try { await this.ingest(id, key); return ''; } catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  async labels() { return JSON.stringify(this.ctx.storage.sql.exec('SELECT id, name FROM labels ORDER BY id').toArray()); }
  async label(id: string, name: string) { this.index().setLabel(id, name); }
  async flags(id: string, flags: number, labels: string[]) { this.index().setFlags(id, flags, labels); }
  async draft(id: string, text: string) {
    const refs = this.env.SWEEP.getByName('workspace');
    await seedLegacyDraft(this.index(), {
      put: async (key, bytes) => { await this.env.RAW.put(key, bytes); },
      hold: (key, holder) => refs.hold(key, holder),
    }, id, new Uint8Array(new TextEncoder().encode(text)));
  }
  async bayes(token: string, ham: number, spam: number) { this.index().setBayes(token, ham, spam); }
  async seedBayes(count: number, offset = 0) {
    const index = this.index();
    for (let i = offset; i < offset + count; i++) index.setBayes(`token-${i}`, 2, 5);
  }
  async setting(kind: 'filter' | 'send-as', id: string, definition: string) { this.index().setSetting(kind, id, definition); }
  async flush(scope: string) {
    const { journal } = this.index();
    const page = await writeDelta(journal, this.env.STATE, journalPrefix(scope), FIXTURE_INCARNATION, journal.flushed());
    if (!page) return null;
    journal.checkpoint(page.last);
    return page.key;
  }
  async replay(key: string) {
    const index = this.index();
    await replayJournal(index, this.env.STATE, key.slice(0, key.indexOf('/deltas/') + 1), key);
    for (const message of index.unindexed('', 1000)) await index.reindex(message.id, message.rawKey);
  }
  async replayError(key: string) {
    try { await this.replay(key); return ''; } catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  async state() {
    const index = this.index();
    // Return a scalar rather than a test-harness RPC proxy for deep comparison in Node.
    return JSON.stringify({
      modseq: index.journal.revision(),
      messages: index.nonDerivedPage('messages', ''), labels: index.nonDerivedPage('labels', ''),
      drafts: index.nonDerivedPage('drafts', ''), bayes: index.nonDerivedPage('bayes', ''), settings: index.nonDerivedPage('settings', ''),
    });
  }
  async wipe() { await this.ctx.storage.deleteAll(); }
  async emptyTrash() { return this.index().emptyTrash(); }
  async readIndexed(id: string) {
    const lengths: number[] = [];
    for (const key of this.index().messageObjectKeys(id)) {
      const object = await this.env.RAW.get(key);
      if (!object) throw new Error('Indexed object missing');
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (parseObjectKey(key)?.digest !== await sha256(bytes)) throw new Error('Indexed object was changed');
      lengths.push(bytes.byteLength);
    }
    return lengths;
  }
}

export default {};
