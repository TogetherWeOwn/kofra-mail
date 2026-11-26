import { Mailbox, Sweeper } from '../../src/entry.ts';
import { storedLifecycle } from '../../src/mailbox-index.ts';
import { SETTINGS_FLUSH_MS, type Lifecycle } from '../../src/mailbox-recovery.ts';
import { legacyFixtureObjects, seedLegacyDraft } from './legacy-draft.ts';
import { Outbox } from '../../src/outbox.ts';
import { handleEmail, handleQueue, handleScheduled, type Env } from '../../src/worker.ts';

export { MailAdmin } from '../../src/entry.ts';
export { Sweeper as RecoverySweeper };

export class RecoveryMailbox extends Mailbox {
  async saveDraft(ws: string, mb: string, id: string, bytes: Uint8Array<ArrayBuffer>) {
    return this.mutate(ws, mb, SETTINGS_FLUSH_MS, index => seedLegacyDraft(index, legacyFixtureObjects(this.env, ws), id, bytes));
  }
  protected override restoreSliceMs = 0;
  private readonly manifestPut: { fail: boolean; refused: number; pause: boolean };
  private readonly snapshotPut: { fail: boolean };

  constructor(ctx: DurableObjectState, env: Env) {
    const fault = { fail: false, refused: 0, pause: false };
    const snapshotPut = { fail: false };
    const bucket = env.MAIL_STATE;
    const put = (async (key: string, body: string, options?: R2PutOptions) => {
      if (snapshotPut.fail && key.includes('/snapshots/')) throw new Error('Fixture refused the snapshot PUT');
      if (fault.fail && key.endsWith('/manifest.json')) {
        fault.fail = false;
        fault.refused++;
        throw new Error('Fixture refused the manifest PUT');
      }
      if (fault.pause && key.endsWith('/manifest.json')) {
        fault.pause = false;
        const gate = await (env as FixtureEnv).RECOVERY_GATE.fetch('https://gate.test/manifest-put');
        if (!gate.ok) throw new Error('Manifest PUT gate failed');
      }
      return bucket.put(key, body, options);
    }) as R2Bucket['put'];
    super(ctx, { ...env, MAIL_STATE: { put, get: key => bucket.get(key), list: options => bucket.list(options),
      delete: keys => bucket.delete(keys) } as R2Bucket });
    this.manifestPut = fault;
    this.snapshotPut = snapshotPut;
  }

  async failSnapshotPuts(fail: boolean) { this.snapshotPut.fail = fail; }
  async failNextManifestPut() { this.manifestPut.fail = true; }
  async pauseNextManifestPut() { this.manifestPut.pause = true; }
  async refusedManifestPuts() { return this.manifestPut.refused; }
  async alarmAt() { return this.ctx.storage.getAlarm(); }

  async wipe() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // Suppress timer-driven runs except when a test explicitly requests one.
  private publicationAlarmArmed = false;

  // Advance an existing alarm; do not supply a wake-up the Mailbox dropped.
  async expeditePublicationAlarm() {
    if (await this.ctx.storage.getAlarm() === null) throw new Error('Mailbox has no publication alarm to advance');
    this.publicationAlarmArmed = true;
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm() {
    if (!this.publicationAlarmArmed) return;
    this.publicationAlarmArmed = false;
    const refused = this.manifestPut.refused;
    await super.alarm();
    if (this.manifestPut.refused > refused) {
      // Keep an existing retry from firing while Node inspects the failed commit.
      const retry = await this.ctx.storage.getAlarm();
      if (retry !== null) await this.ctx.storage.setAlarm(Math.max(retry, Date.now() + 60_000));
    }
    await (this.env as FixtureEnv).RECOVERY_GATE.fetch('https://gate.test/alarm-completed');
  }

  async runAlarm() { await super.alarm(); }

  async runAlarmWithPausedFence() {
    const life = storedLifecycle<Lifecycle>(this.ctx.storage);
    if (life?.state !== 'restoring' || life.phase !== 'fence') throw new Error('Restore is not at the fence');
    const original = Outbox.prototype.bumpRecoveryEpoch;
    const env = this.env as FixtureEnv;
    Outbox.prototype.bumpRecoveryEpoch = async function (workspaceId, mailboxId) {
      if (workspaceId === life.scope.workspaceId && mailboxId === life.scope.mailboxId) {
        const gate = await env.RECOVERY_GATE.fetch('https://gate.test/restore-fence');
        if (!gate.ok) throw new Error('Restore fence gate failed');
      }
      return original.call(this, workspaceId, mailboxId);
    };
    try {
      await this.runAlarm();
    } finally {
      Outbox.prototype.bumpRecoveryEpoch = original;
    }
  }

  async expireRestoreSkippedCooldown() {
    this.ctx.storage.sql.exec("UPDATE mailbox_alerts SET sent_at = 0 WHERE code = 'restore_skipped'");
  }

  async lifecycle() { return storedLifecycle<Lifecycle>(this.ctx.storage); }

  // Return the product error across the RPC boundary without Miniflare wrapping it.
  async restoreError(workspaceId: string, mailboxId: string) {
    try {
      await this.restoreFromBackup(workspaceId, mailboxId);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async forceSnapshot() {
    this.ctx.storage.sql.exec("UPDATE lifecycle SET value = json_set(value, '$.nextSnapshotAt', 0) WHERE id = 1");
  }

  async dump() {
    const sql = this.ctx.storage.sql;
    const q = <T extends Record<string, SqlStorageValue>>(statement: string) => sql.exec<T>(statement).toArray();
    return {
      messages: q<{ id: string; raw_key: string; flags: number; subject: string; thread_id: string; auth: string; labels: string }>(`
        SELECT id, raw_key, flags, subject, thread_id, auth,
          (SELECT json_group_array(label_id) FROM
            (SELECT label_id FROM message_labels WHERE message_id = m.id ORDER BY label_id)) AS labels
        FROM messages m ORDER BY id`),
      labels: q<{ id: string; name: string }>('SELECT id, name FROM labels ORDER BY id'),
      drafts: q<{ id: string; raw_key: string }>('SELECT id, raw_key FROM drafts ORDER BY id'),
    };
  }

  async hasReceipt(id: string) {
    return this.ctx.storage.sql.exec('SELECT 1 FROM receipts WHERE id = ?', id).toArray().length === 1;
  }

  async isFlushed() {
    return this.ctx.storage.sql.exec<{ flushed: number }>('SELECT modseq = flushed AS flushed FROM state').one().flushed === 1
      && this.ctx.storage.sql.exec('SELECT 1 FROM messages WHERE indexed = 0 LIMIT 1').toArray().length === 0;
  }

  async search(term: string) {
    return this.ctx.storage.sql.exec<{ id: string }>(
      'SELECT id FROM fts WHERE fts MATCH ? ORDER BY id', `"${term}"`,
    ).toArray().map(row => row.id);
  }
}

type FixtureEnv = Env & {
  RECOVERY_GATE: Fetcher;
  RECOVERY_ADMIN: { redriveDelivery(id: string): Promise<boolean> };
};

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get('id')!;
    switch (url.pathname) {
      case '/email': {
        let rejected = false;
        await handleEmail({
          from: 'sender@example.test', to: request.headers.get('x-to')!, raw: request.body!,
          rawSize: Number(request.headers.get('content-length')), setReject() { rejected = true; },
        }, env);
        return new Response(null, { status: rejected ? 422 : 202 });
      }
      case '/deliver': {
        const atComplete = url.searchParams.has('pause');
        const original = Outbox.prototype.complete;
        let completed: boolean | null = null;
        let disposition: 'ack' | 'retry' | null = null;
        if (atComplete) {
          Outbox.prototype.complete = new Proxy(original, {
            async apply(target, receiver, args) {
              if (args[0] !== id) return Reflect.apply(target, receiver, args);
              const gate = await env.RECOVERY_GATE.fetch('https://gate.test/complete');
              if (!gate.ok) throw new Error('Completion gate failed');
              completed = await Reflect.apply(target, receiver, args);
              return completed;
            },
          });
        }
        try {
          // Exercise the production consumer, but control each queue delivery and its ID.
          await handleQueue({
            queue: env.DELIVERY_QUEUE_NAME, messages: [{
              id: url.searchParams.get('owner')!, body: id,
              ack() { disposition = 'ack'; }, retry() { disposition = 'retry'; },
            }],
          } as unknown as MessageBatch<unknown>, env);
        } finally {
          if (atComplete) Outbox.prototype.complete = original;
        }
        return Response.json({ disposition, completed });
      }
      case '/scheduled':
        await handleScheduled({} as ScheduledController, env);
        return new Response(null, { status: 204 });
      case '/redrive':
        return Response.json(await env.RECOVERY_ADMIN.redriveDelivery(id));
      default:
        return new Response(null, { status: 404 });
    }
  },
};
