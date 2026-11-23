import { Mailbox } from '../../src/mailbox-do.ts';
import { MailboxIndex, storedLifecycle } from '../../src/mailbox-index.ts';
import { BackupConflict, MailboxRecovery, readyLife, type Lifecycle, type ReadyLife } from '../../src/mailbox-recovery.ts';
import type { Env } from '../../src/worker.ts';

const scope = { workspaceId: 'workspace', mailboxId: 'mailbox' };
type PauseAt = 'first snapshot page PUT' | 'failed manifest GET' | 'manifest GET' | 'restore fence';

function pauseAt(point: PauseAt, skip = 0) {
  return { point, skip, entered: Promise.withResolvers<string>(), release: Promise.withResolvers<void>() };
}

export class RegressionMailbox extends Mailbox {
  private readonly io: { gate?: ReturnType<typeof pauseAt>; failList?: boolean; failedLists?: number; failSwitch?: boolean };
  private schedulerRun?: ReturnType<typeof Promise.withResolvers<void>>;
  private ignoredAlarm?: ReturnType<typeof Promise.withResolvers<void>>;
  private useScheduler = false;
  private scheduledDelay: number | null = null;
  private bookmark?: ReadyLife;

  constructor(ctx: DurableObjectState, env: Env) {
    const io: RegressionMailbox['io'] = {};
    const bucket = env.MAIL_STATE;
    const put = (async (key: string, body: string, options?: R2PutOptions) => {
      const gate = io.gate;
      if (gate?.point === 'first snapshot page PUT' && key.includes('/snapshots/') && key.endsWith('/1.json')) {
        gate.entered.resolve(key);
        await gate.release.promise;
      }
      if (io.failSwitch && key.endsWith('/manifest.json') && JSON.parse(body).snapshot_key !== null) {
        io.failSwitch = false;
        throw new Error('Injected snapshot switch PUT failure');
      }
      return bucket.put(key, body, options);
    }) as R2Bucket['put'];
    const get = (async (key: string) => {
      const gate = io.gate;
      if ((gate?.point === 'manifest GET' || gate?.point === 'failed manifest GET') &&
          key.endsWith('/manifest.json') && gate.skip-- === 0) {
        gate.entered.resolve(key);
        await gate.release.promise;
        if (gate.point === 'failed manifest GET') throw new Error('Injected manifest GET failure');
      }
      return bucket.get(key);
    }) as R2Bucket['get'];
    const list: R2Bucket['list'] = async options => {
      if (io.failList) {
        io.failList = false;
        io.failedLists = (io.failedLists ?? 0) + 1;
        throw new Error('Injected backup cleanup list failure');
      }
      return bucket.list(options);
    };
    super(ctx, { ...env, MAIL_STATE: { get, put, list, delete: keys => bucket.delete(keys) } as R2Bucket,
      SWEEPER: { getByName: () => ({
        register: async () => { throw new Error('Unexpected fixture registration'); }, hold: async () => {}, release: async () => {},
      }) },
    });
    this.io = io;
    // Capture the first deadline before the real callback can replace its alarm.
    const storage = ctx.storage;
    const setAlarm = storage.setAlarm.bind(storage);
    Object.defineProperty(storage, 'setAlarm', { value: (...args: Parameters<typeof setAlarm>) => {
      if (this.useScheduler && this.scheduledDelay === null) this.scheduledDelay = Number(args[0]) - Date.now();
      return setAlarm(...args);
    } });
  }

  private localIndex() {
    const unexpected = async () => { throw new Error('Unexpected fixture object I/O'); };
    return new MailboxIndex(this.ctx.storage, {
      get: unexpected, put: unexpected, register: unexpected, hold: unexpected, release: unexpected,
    }, this.ctx.id.toString());
  }

  async prepare(options: { snapshotDue?: boolean; idleForMs?: number; failures?: number } = {}) {
    const index = this.localIndex();
    const incarnation = crypto.randomUUID();
    index.setLifecycle({ state: 'init', scope, incarnation });
    const etag = await new MailboxRecovery(index, this.env.MAIL_STATE, this.ctx.id.toString()).create(incarnation);
    if (!etag) throw new Error('Fixture manifest already exists');
    const now = Date.now();
    const life = readyLife(scope, incarnation, etag, 1, now);
    index.setLifecycle({ ...life, nextSnapshotAt: options.snapshotDue ? 0 : life.nextSnapshotAt,
      lastPublishedAt: now - (options.idleForMs ?? 0), failures: options.failures ?? 0 });
    this.bookmark = life;
  }

  async seedPublishedEdits(count: number) {
    const index = this.localIndex();
    const sql = this.ctx.storage.sql;
    // The same label edit repeated produces a compact snapshot but a long contiguous journal.
    index.transaction(() => {
      index.setLabel('seed', 'Seed');
      sql.exec(`INSERT INTO journal(seq, event)
        SELECT n, event FROM (WITH RECURSIVE seq(n) AS (SELECT 2 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
          SELECT n FROM seq) JOIN journal ON seq = 1`, count);
      sql.exec('UPDATE state SET modseq = ?, flushed = ? WHERE id = 1', count, count);
    });
    // The published history chain through `count`, as the manifest records it.
    let chain = '';
    const { event } = sql.exec<{ event: string }>('SELECT event FROM journal WHERE seq = 1').one();
    const encoder = new TextEncoder();
    const hash = async (input: string) => {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input)));
      return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    };
    for (let at = 1; at <= count; at++) chain = await hash(`${chain}\n${at}\n${event}`);
    // Make the synthetic history verifiable by both the original tip check and the chain check.
    return { last_chain: chain, last_event: await hash(event) };
  }

  async failNextCleanupList() { this.io.failList = true; }
  async failedCleanupLists() { return this.io.failedLists ?? 0; }
  async failNextSnapshotSwitch() { this.io.failSwitch = true; }

  async deliveredIds() {
    return this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM messages ORDER BY id').toArray().map(row => row.id);
  }

  async seedUnindexed(id: string, rawKey: string) {
    this.localIndex().restoreSnapshotRow({ row_no: 1, kind: 'message', value: JSON.stringify({
      id, rawKey, threadId: id, createdAt: 1, dedupeKey: 'fixture', flags: 0, gmailId: null, labels: [], auth: 'none', attKeys: [],
    }) });
  }

  async wipe() { await this.ctx.storage.deleteAll(); }

  // Model a SQLite rewind to the baseline bookmark, without rewinding R2.
  async rewindToBaseline() {
    const life = this.bookmark;
    if (!life) throw new Error('Fixture bookmark is missing');
    const index = this.localIndex();
    index.transaction(() => { index.resetForRestore(); index.setLifecycle(life); });
  }

  async publishConflicts() {
    const index = this.localIndex();
    const life = index.lifecycle<Lifecycle>();
    if (life?.state !== 'ready') throw new Error('Fixture is not ready');
    try {
      await new MailboxRecovery(index, this.env.MAIL_STATE, this.ctx.id.toString()).publish(life, Date.now(), async () => {
        throw new Error('Unexpected snapshot capture');
      });
      return false;
    } catch (error) {
      if (!(error instanceof BackupConflict)) throw error;
      return true;
    }
  }

  // Return the error as data: Miniflare's direct DO stub does not preserve the thrown error.
  async setLabelError(...args: Parameters<Mailbox['setLabel']>): Promise<string | null> {
    try {
      await this.setLabel(...args);
      return null;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return error.message;
    }
  }

  async lifecycle() { return JSON.stringify(storedLifecycle<Lifecycle>(this.ctx.storage)); }

  async labels() {
    return JSON.stringify(this.ctx.storage.sql.exec('SELECT id, name FROM labels ORDER BY id').toArray());
  }

  async journal() {
    const { journal } = this.localIndex();
    return JSON.stringify({ modseq: journal.revision(), flushed: journal.flushed() });
  }

  // This branch's fence port is a no-op. Drive the real reset and fence steps
  // with a D1 round-trip in the fence port to reproduce the reconciliation race.
  async runThroughFence() {
    const index = this.localIndex();
    const life = index.lifecycle<Lifecycle>();
    const gate = this.io.gate;
    if (life?.state !== 'restoring' || life.phase !== 'reset' || gate?.point !== 'restore fence') {
      throw new Error('Fixture is not at restore reset with a fence gate');
    }
    const recovery = new MailboxRecovery(index, this.env.MAIL_STATE, this.ctx.id.toString());
    const unexpected = async () => { throw new Error('Unexpected restore step'); };
    const ports = { now: Date.now, replayPage: unexpected, release: unexpected, fence: async () => {
      const row = await this.env.DIRECTORY.prepare('SELECT 1 AS epoch').first<{ epoch: number }>();
      if (!row) throw new Error('Fixture D1 fence did not return a row');
      gate.entered.resolve('restore fence');
      await gate.release.promise;
      return row.epoch;
    } };
    const reset = await recovery.restoreStep(life, ports);
    if (reset.state !== 'restoring' || reset.phase !== 'fence') throw new Error('Fixture did not reach the fence');
    await recovery.restoreStep(reset, ports);
  }

  async pauseNextIo(point: PauseAt, skip = 0) { this.io.gate = pauseAt(point, skip); }
  async waitForIo() {
    if (!this.io.gate) throw new Error('Fixture I/O gate is missing');
    return this.io.gate.entered.promise;
  }
  async resumeIo() {
    const gate = this.io.gate;
    this.io.gate = undefined;
    gate?.release.resolve();
  }

  async setBackendEnabled(on: boolean) { this.env.MAIL_BACKEND_ENABLED = on ? 'on' : 'off'; }
  async alarmAt() { return this.ctx.storage.getAlarm(); }
  async dropAlarm() { await this.ctx.storage.deleteAlarm(); }

  async expectIgnoredAlarm() { this.ignoredAlarm = Promise.withResolvers<void>(); }
  async waitForIgnoredAlarm() {
    if (!this.ignoredAlarm) throw new Error('Fixture is not waiting for an ignored alarm');
    await this.ignoredAlarm.promise;
  }

  async allowNextScheduledRun() {
    this.schedulerRun = Promise.withResolvers<void>();
    this.scheduledDelay = null;
    this.useScheduler = true;
  }

  async scheduledAlarmDelay() { return this.scheduledDelay; }

  // Shorten an existing alarm's wait without manufacturing a wake-up if it was lost.
  async expediteScheduledAlarm() {
    if (await this.alarmAt() === null) throw new Error('Fixture has no scheduled alarm');
    await this.allowNextScheduledRun();
    await this.ctx.storage.setAlarm(Date.now() + 50);
  }

  async waitForScheduledRun() {
    if (!this.schedulerRun) throw new Error('Fixture is not waiting for an alarm');
    await this.schedulerRun.promise;
  }

  // Other tests drive the handler explicitly for deterministic I/O checkpoints.
  override async alarm() {
    if (!this.useScheduler) {
      this.ignoredAlarm?.resolve();
      return;
    }
    this.useScheduler = false;
    try {
      await super.alarm();
      this.schedulerRun?.resolve();
    } catch (error) {
      this.schedulerRun?.reject(error);
      throw error;
    }
  }
  async run() { await super.alarm(); }
}

export default {};
