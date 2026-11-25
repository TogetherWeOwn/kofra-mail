import { DurableObject } from 'cloudflare:workers';
import type { Operation } from '../../../contracts/mail-api/src/service.ts';
import { MailboxApi, isIdempotentCreate, mailApiMutation, type MailboxApiOptions, type MailboxApiResult, type MailContentResult } from './mailbox-api.ts';
import { ApiFault, isId } from './mailbox-api-input.ts';
import { ObjectMissingError } from './object-errors.ts';
import { mailAlert, type MailboxAlertCode } from './alerts.ts';
import { kofra } from './kofra.ts';
import { MailboxIndex, PermanentMailError, storedLifecycle } from './mailbox-index.ts';
import {
  BackupConflict, FLAGS_FLUSH_MS, MailboxRecovery, PUBLISH_BUDGET_MS, readyLife, restoringLife, SETTINGS_FLUSH_MS, SNAPSHOT_INTERVAL_MS,
  type CleanupCursor, type Lifecycle, type ReadyLife, type RestoringLife, type Scope,
} from './mailbox-recovery.ts';
import {
  JOURNAL_FLUSH, JOURNAL_FLUSH_REF, TIMER_BATCH, TIMER_RETRY_MS, TimerTable, validTimerKind, type TimerKind, type TimerRow,
} from './mailbox-timers.ts';
import { MailboxWork } from './mailbox-work.ts';
import { isDeliveryId, Outbox, PRUNE_PAGE } from './outbox.ts';
import { RETENTION_MS } from './reconcile.ts';
import { enabled, mailboxName, type Env } from './worker.ts';

// `deferred`: the mailbox is not ready (first initialization or restore) and the
// delivery must be retried later without spending a processing attempt.
// `rejected`: the stored message can never be indexed.
export type MailboxDeliveryResult = 'indexed' | 'deferred' | 'rejected';

const HELD_RECHECK_MS = 15 * 60_000;
const ALERT_COOLDOWN_MS = 24 * 60 * 60_000;
const MAX_FAILURE_BACKOFF_MS = 15 * 60_000;
const RESTORE_RESTART_ALERT = 3;
const backoff = (failures: number) => Math.min(MAX_FAILURE_BACKOFF_MS, 5_000 * 2 ** Math.min(Math.max(failures, 1) - 1, 16));

export class Mailbox extends DurableObject<Env> {
  private readonly work = new MailboxWork();
  private readonly backups = new MailboxWork();
  // Wall-clock budget of one restore run and messages rebuilt per backup run.
  protected restoreSliceMs = 10_000;
  protected reindexBatch = 16;
  // Set when a call asked for an immediate wake-up; consumed by the alarm run.
  private wakeRequested = false;
  // Timer kinds by name. journal_flush is the backup and restore lane; its row
  // survives a restore reset, so it needs no rebuild.
  private readonly timerKinds = new Map<string, TimerKind>([[JOURNAL_FLUSH, { run: () => this.flushLane() }]]);

  // Registers a timer kind. Call from the constructor.
  protected registerTimerKind(kind: string, handler: TimerKind): void {
    if (!validTimerKind(kind) || this.timerKinds.has(kind)) throw new Error('Invalid mailbox timer kind');
    this.timerKinds.set(kind, handler);
  }

  protected timerNow(): number { return Date.now(); }

  private timerTable(): TimerTable { return new TimerTable(this.ctx.storage.sql); }

  private lifecycleState(): Lifecycle['state'] | null {
    const row = this.ctx.storage.sql.exec<{ state: Lifecycle['state'] }>(
      "SELECT json_extract(value, '$.state') AS state FROM lifecycle WHERE id = 1").toArray()[0];
    return row?.state ?? null;
  }

  // Runs an operation in the mailbox work lane, in order with deliveries, API calls and timer handlers.
  protected workLane<T>(operation: () => Promise<T>): Promise<T> { return this.work.run(operation); }

  private registeredKind(kind: string): void {
    // The journal_flush row is moved only by armFor, armSoon and its own lane.
    if (kind === JOURNAL_FLUSH || !this.timerKinds.has(kind)) throw new Error('Unknown mailbox timer kind');
  }

  // Sets a row's due time (or, with lowerOnly, never moves it later) and
  // re-arms. Call in the work lane: from a timer handler or a mailbox operation.
  protected async setTimer(kind: string, ref: string, at: number, lowerOnly = false): Promise<void> {
    this.registeredKind(kind);
    const timers = this.timerTable();
    if (lowerOnly) timers.lower(kind, ref, at);
    else timers.set(kind, ref, at);
    await this.rearm();
  }

  // Deletes a row and re-arms. Call in the work lane.
  protected async deleteTimer(kind: string, ref: string): Promise<void> {
    this.registeredKind(kind);
    this.timerTable().delete(kind, ref);
    await this.rearm();
  }

  // Arms the alarm at the earliest row, or clears it when there is none. The
  // alarm handler forces the write: a wake-up it does not set itself may be
  // cleared when it returns.
  private async rearm(force = false): Promise<void> {
    const at = this.timerTable().earliest();
    const current = force ? undefined : await this.ctx.storage.getAlarm();
    if (at === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
    } else if (current !== at) await this.ctx.storage.setAlarm(at);
  }

  // Moves the journal_flush row to `at` unless it is already earlier, and re-arms. Call in the work lane.
  private async lowerLane(at: number): Promise<void> {
    const timers = this.timerTable();
    if (timers.due(JOURNAL_FLUSH, JOURNAL_FLUSH_REF) === null) {
      // An alarm armed before this lane had a row (by an earlier version) is its deadline.
      const armed = await this.ctx.storage.getAlarm();
      if (armed !== null) at = Math.min(at, armed);
    }
    timers.lower(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, at);
    await this.rearm();
  }

  // Inside the transaction that finishes a restore: each kind recreates its rows from the restored state.
  private rebuildTimers(now: number): void {
    const timers = this.timerTable();
    for (const kind of this.timerKinds.values()) kind.rebuild?.(timers, now);
  }

  private scoped(scope: Scope): boolean {
    return this.ctx.id.equals(this.env.MAILBOX.idFromName(mailboxName(scope.workspaceId, scope.mailboxId)));
  }

  private verifyScope(scope: Scope): void {
    if (!this.scoped(scope)) throw new Error('Delivery mailbox scope mismatch');
  }

  protected mailApiNow(): number { return Date.now(); }

  async mailApi(workspaceId: string, mailboxId: string, operation: Operation, params: Record<string, string>, input: unknown,
    options: MailboxApiOptions): Promise<MailboxApiResult> {
    const scope = { workspaceId, mailboxId };
    if (!this.scoped(scope)) return { error: { code: 'not_found' } };
    if (!enabled(this.env) || this.env.MAIL_LOCAL_API !== 'on') return { error: { code: 'not_implemented' } };
    const now = this.mailApiNow();
    try {
      // The executing operation durably reserves its key before awaiting the
      // object write. A retry can observe this without waiting in the work lane.
      if (isIdempotentCreate(operation) && isId(options.idempotencyKey) && storedLifecycle<Lifecycle>(this.ctx.storage)?.state === 'ready' &&
          this.ctx.storage.sql.exec(`SELECT 1 FROM mailbox_api_in_progress p WHERE p.key = ? AND p.expires_at > ?
            AND NOT EXISTS (SELECT 1 FROM mailbox_api_idempotency r WHERE r.key = p.key AND r.expires_at > ?)`,
          options.idempotencyKey, now, now).toArray().length) {
        return { error: { code: 'idempotency_in_progress', retryAfterSeconds: 1 } };
      }
      return await this.work.run(async () => {
        const index = this.index(workspaceId);
        if (!await this.ready(index, scope)) return { error: { code: 'mailbox_restoring', retryAfterSeconds: 1 } };
        const life = index.lifecycle<Lifecycle>();
        if (life?.state !== 'ready' || index.unindexed('', 1).length) {
          return { error: { code: 'mailbox_restoring', retryAfterSeconds: 1 } };
        }
        if (mailApiMutation(operation)) await this.armFor(operation === 'updateThreads' ? FLAGS_FLUSH_MS : SETTINGS_FLUSH_MS);
        return new MailboxApi(index, this.ctx.storage.sql, workspaceId, mailboxId, life.incarnation, now).call(operation, params, input, options);
      });
    } catch (error) {
      if (error instanceof ApiFault) return { error: error.problem };
      return { error: { code: 'unavailable', retryAfterSeconds: 1 } };
    }
  }

  async mailContent(workspaceId: string, mailboxId: string, messageId: string, part?: number): Promise<MailContentResult> {
    const scope = { workspaceId, mailboxId };
    if (!enabled(this.env) || this.env.MAIL_LOCAL_API !== 'on' || !this.scoped(scope)) return { error: { code: 'not_found' } };
    try {
      return await this.work.run(async () => {
        const index = this.index(workspaceId);
        const life = index.lifecycle<Lifecycle>();
        // A content request never initializes or restores a mailbox.
        if (life?.state !== 'ready') return { error: { code: 'not_found' } };
        return new MailboxApi(index, this.ctx.storage.sql, workspaceId, mailboxId, life.incarnation, this.mailApiNow()).content(messageId, part);
      });
    } catch (error) {
      if (error instanceof ApiFault) return { error: error.problem };
      if (error instanceof ObjectMissingError) return { error: { code: 'not_found' } };
      return { error: { code: 'unavailable', retryAfterSeconds: 1 } };
    }
  }

  private index(workspaceId: string): MailboxIndex {
    const refs = this.env.SWEEPER.getByName(workspaceId);
    return new MailboxIndex(this.ctx.storage, {
      ...kofra(this.env, workspaceId),
      register: (kind, digest, holder) => refs.register(kind, digest, holder),
      hold: (key, holder) => refs.hold(key, holder), release: (key, holder) => refs.release(key, holder),
    }, this.ctx.id.toString(), this.env.MAIL_LOCAL_API === 'on');
  }

  private recovery(index: MailboxIndex): MailboxRecovery {
    if (!this.env.MAIL_STATE) throw new Error('Mailbox journal binding missing');
    return new MailboxRecovery(index, this.env.MAIL_STATE, this.ctx.id.toString());
  }

  private async armSoon(): Promise<void> {
    // An alarm run in progress re-reads this before arming its next wake-up.
    this.wakeRequested = true;
    await this.lowerLane(Date.now());
  }

  // Call in the work lane. A mailbox is ready only after a durable backup
  // baseline exists for its incarnation, so no delivery is acknowledged into a
  // state that a later restore could not reproduce.
  private async ready(index: MailboxIndex, scope: Scope): Promise<boolean> {
    let life = index.lifecycle<Lifecycle>();
    if (life?.state === 'ready') return true;
    if (life && life.state !== 'init') {
      // The alarm lane keeps its own wake-up (and restart or failure backoff)
      // for restoring and missing mailboxes; only replace a lost alarm, so
      // client and delivery traffic cannot cancel that backoff.
      if (await this.ctx.storage.getAlarm() === null) await this.lowerLane(Date.now());
      return false;
    }
    if (!life) {
      life = { state: 'init', scope, incarnation: crypto.randomUUID() };
      index.setLifecycle(life);
    }
    const recovery = this.recovery(index);
    const now = Date.now();
    let current = await recovery.read();
    if (!current) {
      // An absent manifest is a new mailbox only if it never had a baseline and no
      // delivery was ever completed for it; otherwise its backups were lost.
      const outbox = new Outbox(this.env.DIRECTORY);
      const established = await outbox.backupInitialized(scope.workspaceId, scope.mailboxId) ||
        await outbox.deliveryCursor(scope.workspaceId, scope.mailboxId) > 0;
      if (established) {
        // Rows the lost backups covered are again the only replay record.
        await outbox.resetBackupWatermark(scope.workspaceId, scope.mailboxId);
        index.setLifecycle({ state: 'missing', scope: life.scope, incarnation: life.incarnation, since: now, failures: 0 });
        await this.armSoon();
        return false;
      }
      const etag = await recovery.create(life.incarnation);
      if (etag) {
        // Recorded outside this object and the manifest before any write is acknowledged.
        await new Outbox(this.env.DIRECTORY).markBackedUp(scope.workspaceId, scope.mailboxId);
        index.setLifecycle(readyLife(life.scope, life.incarnation, etag, 1, now));
        return true;
      }
      current = await recovery.read();
      if (!current) throw new Error('Mailbox backup manifest unavailable');
    }
    const { manifest } = current;
    if (manifest.incarnation === life.incarnation && manifest.rev === 1 && manifest.last_seq === 0 && index.journal.revision() === 0) {
      // Our own baseline; its reply was lost.
      await new Outbox(this.env.DIRECTORY).markBackedUp(scope.workspaceId, scope.mailboxId);
      index.setLifecycle(readyLife(life.scope, life.incarnation, current.etag, 1, now));
      return true;
    }
    // Backups exist but this object's state is gone: restore, never overwrite them.
    // Pruning stays frozen for the whole restore window; the manifest the restore
    // depends on could still disappear before takeover. Publication re-advances it.
    await new Outbox(this.env.DIRECTORY).resetBackupWatermark(scope.workspaceId, scope.mailboxId);
    index.setLifecycle(restoringLife(life.scope, life.incarnation, now));
    await this.armSoon();
    return false;
  }

  // Arms before committing. Further edits coalesce with the earliest deadline;
  // a stream of edits must not push the first one past its recovery point.
  private async armFor(delay: number): Promise<void> {
    await this.lowerLane(Date.now() + delay - PUBLISH_BUDGET_MS);
  }

  async deliver(id: string): Promise<MailboxDeliveryResult> {
    if (!isDeliveryId(id)) throw new Error('Invalid mailbox delivery id');
    return this.work.run(async () => {
      if (!enabled(this.env)) throw new Error('Mail backend is disabled');
      if (!this.env.MAIL_STATE) throw new Error('Mailbox journal binding missing');
      const row = await new Outbox(this.env.DIRECTORY).get(id);
      if (!row || row.state !== 'pending') return 'indexed';
      const scope = { workspaceId: row.workspaceId, mailboxId: row.mailboxIds[0] };
      this.verifyScope(scope);
      const index = this.index(row.workspaceId);
      if (!await this.ready(index, scope)) return 'deferred';
      await this.armFor(FLAGS_FLUSH_MS);
      try {
        await index.ingest(row.id, row.rawKey, row.createdAt, row.authResults);
      } catch (error) {
        if (error instanceof PermanentMailError) return 'rejected';
        throw error;
      }
      return 'indexed';
    });
  }

  private async mutate<T>(workspaceId: string, mailboxId: string, delay: number, operation: (index: MailboxIndex) => T): Promise<T> {
    const scope = { workspaceId, mailboxId };
    this.verifyScope(scope);
    return this.work.run(async () => {
      if (!enabled(this.env)) throw new Error('Mail backend is disabled');
      if (!this.env.MAIL_STATE) throw new Error('Mailbox journal binding missing');
      const index = this.index(workspaceId);
      if (!await this.ready(index, scope)) throw new Error('Mailbox not ready; retry');
      await this.armFor(delay);
      return operation(index);
    });
  }

  async setLabel(workspaceId: string, mailboxId: string, id: string, name: string) {
    return this.mutate(workspaceId, mailboxId, SETTINGS_FLUSH_MS, index => index.setLabel(id, name));
  }

  async saveDraft(workspaceId: string, mailboxId: string, id: string, bytes: Uint8Array<ArrayBuffer>) {
    return this.mutate(workspaceId, mailboxId, SETTINGS_FLUSH_MS, index => index.saveDraft(id, bytes));
  }

  async setSetting(workspaceId: string, mailboxId: string, kind: 'filter' | 'send-as', id: string, definition: string) {
    return this.mutate(workspaceId, mailboxId, SETTINGS_FLUSH_MS, index => index.setSetting(kind, id, definition));
  }

  async setFlags(workspaceId: string, mailboxId: string, id: string, flags: number, labels: string[]) {
    return this.mutate(workspaceId, mailboxId, FLAGS_FLUSH_MS, index => index.setFlags(id, flags, labels));
  }

  // Starts or resumes a restore; the alarm runs it in bounded slices. `bootstrap`
  // is the explicit operator decision to restart a mailbox whose backups are gone
  // from the completed deliveries that are still retained.
  async restoreFromBackup(workspaceId: string, mailboxId: string, bootstrap = false): Promise<Lifecycle['state']> {
    if (!enabled(this.env) || this.env.MAIL_RECOVERY_ENABLED !== 'on') throw new Error('Mailbox restore is disabled');
    const scope = { workspaceId, mailboxId };
    this.verifyScope(scope);
    return this.work.run(async () => {
      const index = this.index(workspaceId);
      let life = index.lifecycle<Lifecycle>();
      if (!life || life.state === 'init') {
        if (await this.ready(index, scope)) return 'ready';
        life = index.lifecycle<Lifecycle>()!;
      }
      if (life.state === 'ready') throw new Error('Mailbox restore requires an empty target');
      if (life.state === 'missing') {
        if (!bootstrap) return 'missing';
        index.setLifecycle(restoringLife(life.scope, life.incarnation, Date.now(), true));
      } else if (life.state === 'restoring' && bootstrap && !life.bootstrap) {
        // Recorded in any phase: it takes effect only if the manifest this restore
        // depends on is confirmed missing.
        index.setLifecycle({ ...life, bootstrap: true });
      }
      await this.armSoon();
      return 'restoring';
    });
  }

  async alarm(): Promise<void> {
    if (!enabled(this.env)) {
      // A returning handler clears the alarm; keep a wake-up for when the backend
      // is enabled again, without publishing or restoring while it is off.
      if (storedLifecycle<Lifecycle>(this.ctx.storage)) await this.ctx.storage.setAlarm(Date.now() + HELD_RECHECK_MS);
      return;
    }
    await this.backups.run(async () => {
      const life = storedLifecycle<Lifecycle>(this.ctx.storage);
      if (life && life.state !== 'init') this.verifyScope(life.scope);
      // Cloudflare retries a thrown alarm only a few times; keep a durable
      // wake-up before any work. Each row this call runs first moves to its
      // retry time (journal_flush to the settings recovery point, as before),
      // so a crash in a handler or before the final re-arm runs it again on
      // the next alarm, and a row is never run twice by one call.
      const claims = await this.work.run(async () => {
        const timers = this.timerTable();
        const now = this.timerNow();
        const due: Array<Pick<TimerRow, 'kind' | 'ref'>> = timers.dueRows(now, TIMER_BATCH);
        // Nothing due: an early, retried or held wake-up. Run the journal lane,
        // which decides for itself what is due, as every alarm did before timers.
        if (!due.length) due.push({ kind: JOURNAL_FLUSH, ref: JOURNAL_FLUSH_REF });
        const claimed = due.map(({ kind, ref }) => ({ kind, ref,
          until: now + (kind === JOURNAL_FLUSH ? SETTINGS_FLUSH_MS : TIMER_RETRY_MS) }));
        this.ctx.storage.transactionSync(() => { for (const row of claimed) timers.set(row.kind, row.ref, row.until); });
        // More than one batch due re-arms at once.
        await this.rearm(true);
        return claimed;
      });
      for (const claim of claims) await this.runTimer(claim);
      await this.work.run(() => this.rearm(true));
    });
  }

  private async runTimer(claim: { kind: string; ref: string; until: number }): Promise<void> {
    const handler = this.timerKinds.get(claim.kind);
    try {
      if (claim.kind === JOURNAL_FLUSH) {
        // The lane takes the work lane for each step that touches the index and
        // keeps its backup I/O outside it, so deliveries never wait on R2.
        await handler!.run(claim.ref, this.timerNow());
        return;
      }
      await this.work.run(async () => {
        const timers = this.timerTable();
        // Moved or deleted since the claim: its new due time governs.
        if (timers.due(claim.kind, claim.ref) !== claim.until) return;
        // Other kinds act on mailbox state, which is complete only while ready.
        // A kind this version does not know (for example after a rollback) waits too.
        if (!handler || this.lifecycleState() !== 'ready') {
          timers.set(claim.kind, claim.ref, this.timerNow() + HELD_RECHECK_MS);
        } else await handler.run(claim.ref, this.timerNow());
        await this.rearm();
      });
    } catch {
      // A failing handler neither blocks the remaining rows nor spins.
      await this.work.run(async () => {
        const timers = this.timerTable();
        if (timers.due(claim.kind, claim.ref) === claim.until) timers.set(claim.kind, claim.ref, this.timerNow() + TIMER_RETRY_MS);
        await this.rearm();
      });
    }
  }

  // The journal_flush row's handler: the backup and restore lane. Its row
  // carries the deadline this lane computes, which the alarm used to carry.
  private async flushLane(): Promise<void> {
    // Requests made before this run are being served by it.
    this.wakeRequested = false;
    const claimed = this.timerTable().due(JOURNAL_FLUSH, JOURNAL_FLUSH_REF);
    const life = storedLifecycle<Lifecycle>(this.ctx.storage);
    if (!life || life.state === 'init') {
      let held = false;
      try { await this.checkBackupAlerts(null); } catch { held = true; }
      await this.work.run(async () => {
        const timers = this.timerTable();
        // Nothing to publish or restore; keep a deadline a call made during this run.
        if (timers.due(JOURNAL_FLUSH, JOURNAL_FLUSH_REF) === claimed) {
          if (held) timers.set(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, Date.now() + HELD_RECHECK_MS);
          else timers.delete(JOURNAL_FLUSH, JOURNAL_FLUSH_REF);
        }
        await this.rearm(true);
      });
      return;
    }
    this.verifyScope(life.scope);
    const index = this.index(life.scope.workspaceId);
    const now = Date.now();
    let next: number;
    let failed = false;
    try {
      if (life.state === 'restoring') next = await this.restoreSlice(index, life);
      else if (life.state === 'ready') {
        if (this.env.MAIL_LOCAL_API === 'on') await this.work.run(async () => index.pruneApiKeys(this.mailApiNow()));
        next = await this.backupSlice(index, life, now);
      }
      else next = now + HELD_RECHECK_MS;
    } catch {
      failed = true;
      next = now + this.failed(index);
    }
    try { next = Math.min(next, await this.checkBackupAlerts(index)); }
    catch { next = Math.min(next, Date.now() + HELD_RECHECK_MS); }
    await this.work.run(async () => {
      // A change committed during this run must not wait for the next deadline.
      const current = index.lifecycle<Lifecycle>();
      // A failed run retries unpublished changes within the settings recovery point, not the backoff.
      const pending = current?.state === 'ready' && index.journal.flushed() < index.journal.revision();
      const soon = Date.now() + (failed ? SETTINGS_FLUSH_MS - PUBLISH_BUDGET_MS : 1000);
      const requested = this.wakeRequested ? Date.now() : Infinity;
      this.wakeRequested = false;
      this.timerTable().set(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, Math.min(pending ? Math.min(next, soon) : next, requested));
      await this.rearm(true);
    });
  }

  private async checkBackupAlerts(index: MailboxIndex | null): Promise<number> {
    const now = Date.now();
    const life = index?.lifecycle<Lifecycle>();
    const stale = index && life?.state === 'ready' && (now - life.lastSnapshotAt > 2 * SNAPSHOT_INTERVAL_MS ||
      (index.journal.flushed() < index.journal.revision() && now - life.lastPublishedAt > 2 * FLAGS_FLUSH_MS));
    const blocked = life?.state === 'missing' || (life?.state === 'restoring' &&
      (this.env.MAIL_RECOVERY_ENABLED !== 'on' || life.failures >= 5 || (life.restarts ?? 0) >= RESTORE_RESTART_ALERT));
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS mailbox_alerts (code TEXT PRIMARY KEY, since INTEGER NOT NULL, sent_at INTEGER)');
    const skipped = life?.state === 'ready' && (life.restoreSkipped ?? 0) > 0;
    const conflict = life?.state === 'ready' && !!life.conflict;
    const conditions: Array<[MailboxAlertCode, boolean]> = [
      ['backup_stale', !!stale], ['restore_blocked', blocked], ['restore_skipped', skipped], ['backup_conflict', conflict]];
    let next = Infinity;
    for (const [code, active] of conditions) {
      if (!active) {
        sql.exec('DELETE FROM mailbox_alerts WHERE code = ?', code);
        continue;
      }
      sql.exec('INSERT OR IGNORE INTO mailbox_alerts (code, since) VALUES (?, ?)', code, now);
      const { sent_at } = sql.exec<{ sent_at: number | null }>('SELECT sent_at FROM mailbox_alerts WHERE code = ?', code).one();
      if (sent_at !== null && now < sent_at + ALERT_COOLDOWN_MS) {
        next = Math.min(next, sent_at + ALERT_COOLDOWN_MS);
        continue;
      }
      try { await mailAlert(this.env.ALERTS)({ code, key: this.ctx.id.toString() }); }
      catch { next = Math.min(next, Date.now() + HELD_RECHECK_MS); continue; }
      const sentAt = Date.now();
      sql.exec('UPDATE mailbox_alerts SET sent_at = ? WHERE code = ?', sentAt, code);
      // A skipped-delivery report is sent once per restore.
      if (code === 'restore_skipped' && index && life?.state === 'ready') index.setLifecycle({ ...life, restoreSkipped: 0 });
      next = Math.min(next, sentAt + ALERT_COOLDOWN_MS);
    }
    return next;
  }

  private failed(index: MailboxIndex): number {
    return index.transaction(() => {
      const life = index.lifecycle<Lifecycle>();
      if (!life || life.state === 'init') return MAX_FAILURE_BACKOFF_MS;
      const failures = life.failures + 1;
      index.setLifecycle({ ...life, failures });
      return backoff(failures);
    });
  }

  private async restoreSlice(index: MailboxIndex, start: RestoringLife): Promise<number> {
    if (this.env.MAIL_RECOVERY_ENABLED !== 'on') return Date.now() + HELD_RECHECK_MS;
    const recovery = this.recovery(index);
    const outbox = new Outbox(this.env.DIRECTORY);
    const { workspaceId, mailboxId } = start.scope;
    const refs = this.env.SWEEPER.getByName(workspaceId);
    const deadline = Date.now() + this.restoreSliceMs;
    let life: Lifecycle = start;
    // Each step performs I/O, so the clock advances between steps. At least one step runs.
    do {
      const restarts = life.restarts ?? 0;
      life = await recovery.restoreStep(life, {
        now: Date.now,
        // Claims taken before this point can no longer complete (stale index state).
        fence: () => outbox.bumpRecoveryEpoch(workspaceId, mailboxId),
        replayPage: after => outbox.replayPage(workspaceId, mailboxId, after),
        release: (key, holder) => refs.release(key, holder),
        rebuild: now => this.rebuildTimers(now),
      });
      // A restart means the manifest vanished under this restore. Each restart
      // counts against restore_blocked and backs off, so a manifest that keeps
      // disappearing cannot spin fence and baseline writes in a silent loop.
      if (life.state === 'restoring' && (life.restarts ?? 0) > restarts) return Date.now() + backoff(life.restarts ?? 1);
    } while (life.state === 'restoring' && Date.now() < deadline);
    if (life.state === 'ready') await outbox.markBackedUp(workspaceId, mailboxId).catch(() => {});
    return Date.now() + (life.state === 'restoring' ? 0 : 1000);
  }

  private async backupSlice(index: MailboxIndex, life: ReadyLife, now: number): Promise<number> {
    const outbox = new Outbox(this.env.DIRECTORY);
    const { workspaceId, mailboxId } = life.scope;
    const recovery = this.recovery(index);
    // A completion is marked done only after its index commit, so every done row
    // at or below this cursor has its journal event at or below this revision.
    const mark = await this.work.run(async () => {
      const cursor = await outbox.deliveryCursor(workspaceId, mailboxId);
      return { cursor, seq: index.journal.revision() };
    });
    let published: Awaited<ReturnType<MailboxRecovery['publish']>>;
    try {
      published = await recovery.publish(life, now, () => this.work.run(async () => {
        // Every done row at or below the cursor is present in the capture.
        const deliveryCursor = await outbox.deliveryCursor(workspaceId, mailboxId);
        return { deliveryCursor, seq: index.captureSnapshot() };
      }), () => outbox.resetBackupWatermark(workspaceId, mailboxId).catch(() => {}));
    } catch (error) {
      // Never write over a manifest this state cannot have produced; raise an alert.
      if (error instanceof BackupConflict) {
        const stored = index.lifecycle<Lifecycle>();
        if (stored?.state === 'ready') index.setLifecycle({ ...stored, conflict: error.message });
      }
      throw error;
    }
    // The published backup was gone. onMissing above cleared the informational
    // coverage before any re-establishment write; clear it again in case that
    // reset failed, until the re-established manifest commits.
    if (published.reestablishing) await outbox.resetBackupWatermark(workspaceId, mailboxId).catch(() => {});
    // Only now may completed rows up to the cursor be pruned: the published
    // backup is confirmed to cover them. A failure only delays pruning.
    let prunedPage = false;
    if (published.lastSeq >= mark.seq) {
      try {
        await outbox.markBackedUp(workspaceId, mailboxId, mark.cursor);
        prunedPage = await outbox.pruneCovered(workspaceId, mailboxId, Date.now() - RETENTION_MS, mark.cursor) === PRUNE_PAGE;
      } catch { /* retried on a later run */ }
    }
    let current = published.life;
    let cleanupPending = false;
    let cleanupRetry = false;
    try {
      let prior = await this.ctx.storage.get<CleanupCursor>('backupCleanup');
      // Artifacts are superseded only by a snapshot switch (or a recreated
      // manifest), so scan after one and while a scan is unfinished, not every run.
      const switched = current.upload === null && (life.upload !== null || current.lastSnapshotAt !== life.lastSnapshotAt);
      if (switched && !prior) {
        // Record the obligation first, so a failed first scan is retried on the next run.
        prior = { incarnation: current.incarnation, snapshot: null, snapshots: '', deltas: '' };
        await this.ctx.storage.put('backupCleanup', prior);
      }
      const next = prior ? await recovery.cleanup(current, prior) : null;
      if (next) {
        await this.ctx.storage.put('backupCleanup', next);
        cleanupPending = true;
      } else if (prior) await this.ctx.storage.delete('backupCleanup');
    } catch {
      // Publication already succeeded; retry the scan soon rather than at the next switch.
      cleanupRetry = true;
    }
    // Search and message text of restored messages are rebuilt in the background.
    // The cursor keeps one message that cannot be fetched yet from starving the rest.
    // Reindex failures back off on their own clock and never delay publication.
    const reindexDue = (current.reindexRetryAt ?? 0) <= Date.now();
    const pending = reindexDue ? index.unindexed(current.reindexAfter, this.reindexBatch) : [];
    let reindexError: unknown = null;
    for (const message of pending) {
      try { await index.reindex(message.id, message.rawKey); } catch (error) { reindexError ??= error; }
    }
    const reindexFailures = reindexError ? (current.reindexFailures ?? 0) + 1 : reindexDue ? 0 : current.reindexFailures ?? 0;
    const reindexRetryAt = reindexError ? Date.now() + backoff(reindexFailures) : reindexDue ? 0 : current.reindexRetryAt ?? 0;
    const reindexAfter = !reindexDue ? current.reindexAfter : pending.length === this.reindexBatch ? pending[pending.length - 1].id : '';
    const failures = published.snapshotError ? current.failures : 0;
    if (reindexAfter !== current.reindexAfter || failures !== current.failures ||
        reindexFailures !== (current.reindexFailures ?? 0) || reindexRetryAt !== (current.reindexRetryAt ?? 0)) {
      current = { ...current, reindexAfter, failures, reindexFailures, reindexRetryAt };
      index.setLifecycle(current);
    }
    const soon = Date.now() + 1000;
    const reindexAt = reindexRetryAt ? Math.max(reindexRetryAt, soon) : Infinity;
    // Deltas were still published; retry only the snapshot, with backoff.
    if (published.snapshotError) return Math.min(Date.now() + backoff(current.failures), reindexAt);
    const next = Math.min(Math.max(current.nextSnapshotAt, soon), reindexAt, cleanupRetry ? Date.now() + 60_000 : Infinity);
    const more = published.more || cleanupPending || prunedPage || (reindexDue && !reindexError && pending.length > 0);
    return more ? soon : next;
  }
}
