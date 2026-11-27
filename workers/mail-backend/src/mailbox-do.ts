import { DurableObject } from 'cloudflare:workers';
import type { Operation } from '../../../contracts/mail-api/src/service.ts';
import { MailboxApi, isIdempotentCreate, mailApiMutation, type MailboxApiOptions, type MailboxApiResult, type MailContentResult, type PreparedApiKey } from './mailbox-api.ts';
import { checkReplayInput, createQuery, readMailboxJson, type HttpMailboxWrite } from './mailbox-http-write.ts';
import { ApiFault, fail, isId } from './mailbox-api-input.ts';
import { apiKey, clearApiKey, fingerprintOf, ownsApiKey, replayApiKey, reserveApiKey, resultEvent, scheduleResult } from './mailbox-api-idempotency.ts';
import { idemExpiry, uploadExpiry } from './mailbox-expiry.ts';
import { IDEM_EXPIRY, IN_PROGRESS_TTL_MS, UPLOAD_EXPIRY, UPLOAD_TTL_MS, readUpload, uploadMediaType, uploadName, wireUpload, type UploadBody } from './mailbox-upload.ts';
import { contentRecord, type MailboxContentRecord } from './mailbox-api-messages.ts';
import { ObjectMissingError } from './object-errors.ts';
import { mailAlert, type MailboxAlertCode } from './alerts.ts';
import { kofra } from './kofra.ts';
import { MailboxIndex, PermanentMailError, storedLifecycle } from './mailbox-index.ts';
import {
  BackupConflict, FLAGS_FLUSH_MS, MailboxRecovery, PUBLISH_BUDGET_MS, readyLife, restoringLife, SETTINGS_FLUSH_MS, SNAPSHOT_INTERVAL_MS,
  type CleanupCursor, type Lifecycle, type ReadyLife, type RestoringLife, type Scope,
} from './mailbox-recovery.ts';
import {
  JOURNAL_FLUSH, JOURNAL_FLUSH_REF, TIMER_BATCH, TIMER_HANDLER_BUDGET_MS, TIMER_LEASE_MS, TIMER_RETRY_MS, TIMER_RUN_BUDGET_MS, TimerTable,
  validTimerKind, type TimerKind, type TimerRow, type TimerRun,
} from './mailbox-timers.ts';
import { MailboxWork } from './mailbox-work.ts';
import { defaultMimeBuilders, type SendMimeBuilders } from './mailbox-send-mime.ts';
import { markSendHeld, SendApi, sendDrive, type SendCommit, type SendPorts, type SendStep } from './mailbox-send.ts';
import { SEND_DRIVE, UnpublishedSend } from './mailbox-send-store.ts';
import {
  CLOCK_SKEW_MS, SendDispatcher, type AbandonAnswer, type AuthorizeAnswer, type ClaimAnswer, type DelayAnswer, type MarkAnswer, type ProviderResult,
  type ReportAnswer, type StoredAnswer,
} from './mailbox-send-dispatch.ts';
import type { QuotaPort, SendFence } from './mailbox-send-quota.ts';
import { isDeliveryId, Outbox, PRUNE_PAGE } from './outbox.ts';
import { RETENTION_MS } from './reconcile.ts';
import { enabled, mailboxName, type Env } from './worker.ts';

// `deferred`: the mailbox is not ready (first initialization or restore) and the
// delivery must be retried later without spending a processing attempt.
// `rejected`: the stored message can never be indexed.
export type MailboxDeliveryResult = 'indexed' | 'deferred' | 'rejected';

const HELD_RECHECK_MS = 15 * 60_000;
type TimerClaim = TimerRow & { token: string; until: number; retained?: boolean };
const thenable = (value: unknown): value is PromiseLike<unknown> => typeof (value as { then?: unknown } | null)?.then === 'function';
const ALERT_COOLDOWN_MS = 24 * 60 * 60_000;
const MAX_FAILURE_BACKOFF_MS = 15 * 60_000;
const RESTORE_RESTART_ALERT = 3;
const backoff = (failures: number) => Math.min(MAX_FAILURE_BACKOFF_MS, 5_000 * 2 ** Math.min(Math.max(failures, 1) - 1, 16));

export class Mailbox extends DurableObject<Env> {
  private readonly work = new MailboxWork();
  private readonly backups = new MailboxWork();
  // Stage one bounded upload at a time without gating delivery or publication.
  private readonly uploads = new MailboxWork();
  private readonly jsonWrites = new MailboxWork();
  // Wall-clock budget of one restore run and messages rebuilt per backup run.
  protected restoreSliceMs = 10_000;
  protected reindexBatch = 16;
  // Set when a call asked for an immediate wake-up; consumed by the alarm run.
  private wakeRequested = false;
  // Timer kinds by name. journal_flush is the backup and restore lane; its row
  // survives a restore reset, so it needs no rebuild.
  private readonly timerKinds = new Map<string, TimerKind>([[JOURNAL_FLUSH, { run: async () => { await this.runLaneIfDue(); } }]]);
  // Handler calls still running in this isolate, by kind and ref, including
  // ones that lost their race; an evicted isolate takes its calls with it.
  // An entry blocks a new start for TIMER_LEASE_MS at most.
  private readonly inFlight = new Map<string, { started: number; id: string; token: string }>();
  // Resolved when a write moves the journal_flush deadline earlier, so a
  // running dispatcher re-evaluates the race it is waiting on.
  private laneMoved: PromiseWithResolvers<void> | null = null;
  // One publish at a time per mailbox: the backup lane's and every barrier's
  // (docs/m3-outbound-plan.md, section 2.1), so two never race the manifest ETag.
  protected readonly publishes = new MailboxWork();
  // The send path's MIME builders (M3-3's port; M3-4 supplies the real one).
  protected sendMime: SendMimeBuilders = defaultMimeBuilders();
  protected timerHandlerBudgetMs = TIMER_HANDLER_BUDGET_MS;
  protected timerRunBudgetMs = TIMER_RUN_BUDGET_MS;
  protected timerRetryMs = TIMER_RETRY_MS;
  protected holderIoBudgetMs = PUBLISH_BUDGET_MS;
  protected barrierBudgetMs = PUBLISH_BUDGET_MS;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const outbound = env.MAIL_DRAFT_UPLOADS_ENABLED === 'on';
    const ports = {
      sql: ctx.storage.sql,
      ready: () => {
        const life = storedLifecycle<Lifecycle>(ctx.storage);
        if (life?.state === 'ready') return { incarnation: life.incarnation, index: this.index(life.scope.workspaceId) };
      },
      journalDue: (timers: TimerTable) => {
        if (this.lowerJournal(timers, this.timerNow() + SETTINGS_FLUSH_MS - PUBLISH_BUDGET_MS)) this.laneMoved?.resolve();
      },
    };
    // A disabled feature still restores schedules for existing outbound state.
    // Hold its due jobs without changing that state until the feature is on again.
    const register = (kind: string, handler: TimerKind) => this.registerTimerKind(kind, {
      ...handler,
      run: outbound ? handler.run : timer => timer.local(timers => {
        const due = timers.due(kind, timer.ref);
        if (this.lifecycleState() === 'ready' && due !== null && due <= timer.now + this.timerRetryMs) {
          timers.set(kind, timer.ref, timer.now + HELD_RECHECK_MS);
        }
      }),
    });
    register(UPLOAD_EXPIRY, uploadExpiry(ports));
    this.registerTimerKind(IDEM_EXPIRY, idemExpiry(ports, outbound, HELD_RECHECK_MS));
    // The send path holds its due drive rows, like other outbound kinds, while it is off,
    // and marks a held pending send for a fresh undo window when the path is on again.
    const sending = env.MAIL_SEND_ENABLED === 'on';
    const drive = sendDrive(this.sendPorts());
    this.registerTimerKind(SEND_DRIVE, {
      ...drive,
      run: sending ? drive.run : timer => timer.local(timers => {
        const due = timers.due(SEND_DRIVE, timer.ref);
        if (this.lifecycleState() === 'ready' && due !== null && due <= timer.now + this.timerRetryMs) {
          timers.set(SEND_DRIVE, timer.ref, timer.now + HELD_RECHECK_MS);
          markSendHeld(ctx.storage.sql, timer.ref);
        }
      }),
    });
    void ctx.blockConcurrencyWhile(() => this.adoptArmedAlarm());
  }

  // On every start, before the object serves any call, restore alarm =
  // MIN(due_at) after another version may have armed it:
  // - a stored alarm earlier than every row (or, with no rows, for a mailbox
  //   past init) is the journal lane's deadline, so lower the lane to it. This
  //   version never arms earlier than its earliest row except the
  //   disabled-backend fallback, where lowering only runs the lane early;
  // - with the backend enabled, a missing alarm or one later than the
  //   earliest row is re-armed at that row. A disabled backend keeps its held
  //   recheck.
  private async adoptArmedAlarm(): Promise<void> {
    const state = storedLifecycle<Lifecycle>(this.ctx.storage)?.state;
    const armed = await this.ctx.storage.getAlarm();
    const timers = this.timerTable();
    const earliest = timers.earliest();
    if (armed !== null && (earliest === null ? !!state && state !== 'init' : armed < earliest)) {
      timers.lower(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, armed);
    }
    if (!enabled(this.env)) return;
    const due = timers.earliest();
    if (due !== null && (armed === null || armed > due)) await this.ctx.storage.setAlarm(due);
  }

  protected sendPorts(): SendPorts {
    const self = this;
    return {
      sql: this.ctx.storage.sql,
      ready: () => {
        const life = storedLifecycle<Lifecycle>(this.ctx.storage);
        if (life?.state !== 'ready') return;
        return { incarnation: life.incarnation, index: this.index(life.scope.workspaceId),
          scope: { ...life.scope, holderScope: this.ctx.id.toString() }, epoch: life.epoch ?? 0, restoredAt: life.restoredAt ?? 0 };
      },
      local: this.local,
      publishThrough: seq => this.publishThrough(seq),
      journalDue: timers => this.journalDue(timers),
      sweeper: workspaceId => this.env.SWEEPER.getByName(workspaceId),
      get directory() { return self.env.DIRECTORY; },
      get queue() { return self.env.SEND; },
      get mime() { return self.sendMime; },
      put: (workspaceId, key, bytes) => kofra(this.env, workspaceId).put(key, bytes),
      get dispatcher() { return self.sendDispatcher(); },
      quota: () => this.sendQuota(),
      checkpoint: step => this.sendCheckpoint(step),
    };
  }

  // The account quota gate (M3-6 supplies the quota object). Without it, a
  // step that must release or read the quota fails and is retried.
  protected sendQuota(): QuotaPort | undefined { return undefined; }

  // clockSkew (section 2.4, step 5) is configuration, used only on the mailbox side.
  private clockSkewMs(): number {
    const configured = this.env.MAIL_SEND_CLOCK_SKEW_SECONDS;
    if (configured === undefined || configured === '') return CLOCK_SKEW_MS;
    const seconds = Number(configured);
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 600) throw new Error('Invalid send clock skew');
    return seconds * 1000;
  }

  private sendDispatcher(): SendDispatcher {
    return new SendDispatcher({
      sql: this.ctx.storage.sql,
      ready: scope => this.work.run(async () => {
        if (!enabled(this.env)) throw new Error('Mail backend is disabled');
        this.verifyScope(scope);
        return this.ready(this.index(scope.workspaceId), scope);
      }),
      current: () => {
        const life = storedLifecycle<Lifecycle>(this.ctx.storage);
        if (life?.state !== 'ready') return;
        return { index: this.index(life.scope.workspaceId), epoch: life.epoch ?? 0, restoredAt: life.restoredAt ?? 0 };
      },
      local: this.local,
      exclusive: (io, step) => this.exclusiveStep(io, step),
      senderCheckpoint: phase => this.sendSenderCheckpoint(phase),
      beforeRecord: fence => this.sendRecordCheckpoint(fence),
      afterClaimRelease: () => this.sendReleaseCheckpoint(),
      publishThrough: seq => this.publishThrough(seq),
      journalDue: timers => this.journalDue(timers),
      directory: this.env.DIRECTORY,
      quota: () => this.sendQuota(),
      clockSkewMs: this.clockSkewMs(),
      now: () => this.mailApiNow(),
      sending: this.env.MAIL_SEND_ENABLED === 'on',
    });
  }

  // A test seam inside the work lane, before and after authorizeDispatch's directory statement.
  protected async sendSenderCheckpoint(_phase: 'before' | 'after'): Promise<void> {}
  // A test seam before recordResult acts.
  protected async sendRecordCheckpoint(_fence: SendFence): Promise<void> {}
  // A test seam between a claim's release-only quota call and the removal of those fences.
  protected async sendReleaseCheckpoint(): Promise<void> {}

  // Holds the work lane across `io`, then runs `step` in a transaction and
  // re-arms without reading the alarm first, so `io` is the last await before
  // the step's commit.
  private exclusiveStep<A, T>(io: () => Promise<A>, step: (timers: TimerTable, value: A) => T): Promise<T> {
    return this.work.run(async () => {
      const value = await io();
      let result!: T;
      const timers = this.timerTable();
      await this.rearm(() => {
        result = this.ctx.storage.transactionSync(() => {
          try { return step(timers, value); } finally { timers.revoke(); }
        });
      }, true);
      return result;
    });
  }

  // The send consumer's RPCs (docs/m3-outbound-plan.md, section 2.4; M3-5a).
  async claimSend(workspaceId: string, mailboxId: string, sendId: string): Promise<ClaimAnswer> {
    return this.sendDispatcher().claim({ workspaceId, mailboxId }, sendId);
  }

  async markSend(workspaceId: string, mailboxId: string, sendId: string, fence: SendFence, recipients: number[],
    released: SendFence[]): Promise<MarkAnswer> {
    return this.sendDispatcher().mark({ workspaceId, mailboxId }, sendId, fence, recipients, released);
  }

  async authorizeDispatch(workspaceId: string, mailboxId: string, sendId: string, fence: SendFence, recipients: number[],
    quotaDayEnd: number): Promise<AuthorizeAnswer> {
    return this.sendDispatcher().authorize({ workspaceId, mailboxId }, sendId, fence, recipients, quotaDayEnd);
  }

  async recordResult(workspaceId: string, mailboxId: string, sendId: string, fence: SendFence, result: ProviderResult): Promise<ReportAnswer> {
    return this.sendDispatcher().record({ workspaceId, mailboxId }, sendId, fence, result);
  }

  // `gate`: our own gate refused the reservation, with the refusing gate's `resetAt`;
  // `provider_daily`: the provider's daily-limit error.
  async delaySend(workspaceId: string, mailboxId: string, sendId: string, fence: SendFence, cause: 'gate' | 'provider_daily',
    resetAt?: number): Promise<DelayAnswer> {
    return this.sendDispatcher().delay({ workspaceId, mailboxId }, sendId, fence, cause, resetAt);
  }


  async abandonClaim(workspaceId: string, mailboxId: string, sendId: string, fence: SendFence, retryAt: number): Promise<AbandonAnswer> {
    return this.sendDispatcher().abandon({ workspaceId, mailboxId }, sendId, fence, retryAt);
  }

  // Shared by the drive handler and result notices; a notice passes its fence,
  // and that row is recorded whatever its notify_after.
  async recordStoredResults(workspaceId: string, mailboxId: string, sendId: string, fence?: SendFence): Promise<StoredAnswer> {
    return this.sendDispatcher().recordStored({ workspaceId, mailboxId }, sendId, fence);
  }

  // A test seam after each release step; does nothing here.
  protected async sendCheckpoint(_step: SendStep): Promise<void> {}

  private journalDue(timers: TimerTable): void {
    if (this.lowerJournal(timers, this.timerNow() + SETTINGS_FLUSH_MS - PUBLISH_BUDGET_MS)) this.laneMoved?.resolve();
  }

  // The publish barrier (section 2.1): resolves true once a publish covers
  // `seq`. Joins the publish in flight or waits for it, then publishes the
  // remainder. Never call it inside the work lane: the publish reads the
  // journal outside the lane, and deliveries must not wait on R2.
  // `wake` false leaves the covered-work wake-up to the caller (scheduleCoveredWake),
  // so it can queue its own lane work first.
  protected async publishThrough(seq: number, wake = true): Promise<boolean> {
    const journal = () => this.ctx.storage.sql.exec<{ flushed: number }>('SELECT flushed FROM state WHERE id = 1').one().flushed;
    // An answer never waits past this: a stalled publish ahead of the barrier
    // ends the wait (409 for the API, a later drive run for the handler), and
    // the publish it joined finishes on its own.
    const deadline = Date.now() + this.barrierBudgetMs;
    for (let round = 0; round < 64 && journal() < seq; round++) {
      let progressed = false;
      try {
        const done = await this.beforeDeadline(deadline, () => this.publishes.run(async () => {
          // The publish this barrier queued behind may already cover it.
          if (journal() >= seq) { progressed = true; return true; }
          const life = storedLifecycle<Lifecycle>(this.ctx.storage);
          if (life?.state !== 'ready') return false;
          const index = this.index(life.scope.workspaceId);
          const before = journal();
          await this.recovery(index).publish(life, Date.now(), async () => { throw new Error('Barrier publishes deltas only'); }, undefined,
            { deltasOnly: true });
          progressed = journal() > before;
          return true;
        }));
        // Out of time or not ready: the coverage check below decides, since
        // the publish ahead may have published this commit before its other work.
        if (!done) break;
      } catch { return false; }
      if (!progressed) break;
    }
    if (journal() < seq) return false;
    if (wake) this.scheduleCoveredWake();
    return true;
  }

  // A covered caller never waits for this wake-up or fails on it: a lost one
  // leaves the work to the backup lane's own run.
  private scheduleCoveredWake(): void {
    this.ctx.waitUntil(this.work.run(() => this.wakeCoveredWork()).catch(error =>
      console.error({ code: 'barrier_lane_wakeup', error: error instanceof Error ? error.message : String(error) })));
  }

  // In the work lane: confirmations and releases a publish covered are the lane's work; bring it forward.
  protected async wakeCoveredWork(): Promise<void> {
    const through = this.ctx.storage.sql.exec<{ flushed: number }>('SELECT flushed FROM state WHERE id = 1').one().flushed;
    if (this.ctx.storage.sql.exec(`SELECT EXISTS (SELECT 1 FROM mailbox_pending_releases WHERE seq <= ?)
      OR EXISTS (SELECT 1 FROM mailbox_pending_confirmations WHERE seq <= ?) AS pending`, through, through).one().pending) {
      await this.lowerLane(this.timerNow() + 60_000);
    }
  }

  // `published`: a read already waited once for the publish of its sends' consumer changes.
  private async sendApi(scope: Scope, operation: 'sendDraft' | 'undoSend' | 'getSend' | 'listSends', params: Record<string, string>,
    options: MailboxApiOptions, published = false): Promise<MailboxApiResult> {
    const index = this.index(scope.workspaceId);
    const outcome = await this.work.run(async (): Promise<{ result: MailboxApiResult } | { commit: SendCommit } | { reread: number }> => {
      if (!await this.ready(index, scope)) return fail('mailbox_restoring', { retryAfterSeconds: 1 });
      const life = index.lifecycle<Lifecycle>();
      // Undo and send reads use only send rows, never the message index, so they
      // serve as soon as a restore is ready: the restored send's fresh undo
      // window must not run out while restored messages are still reindexed.
      if (life?.state !== 'ready' || (operation === 'sendDraft' && index.unindexed('', 1).length)) {
        return fail('mailbox_restoring', { retryAfterSeconds: 1 });
      }
      const write = operation === 'sendDraft' || operation === 'undoSend';
      if (write) await this.armFor(SETTINGS_FLUSH_MS);
      const timers = this.timerTable();
      try {
        const api = new SendApi(index, this.ctx.storage.sql, { ...scope, holderScope: this.ctx.id.toString() }, life.incarnation, timers,
          this.sendMime, this.env.DIRECTORY, () => this.mailApiNow(), table => this.journalDue(table));
        if (operation === 'getSend' || operation === 'listSends') {
          const body = operation === 'getSend' ? api.getSend(params) : await api.listSends(params, options.cursorScope);
          // A send's consumer state is reported only once published (section 2.1), like its terminal state.
          const unpublished = api.unpublishedProgress('items' in body ? body.items.map(({ id }) => id) : [body.id]);
          if (!unpublished) return { result: { body } };
          return published ? fail('mailbox_restoring', { retryAfterSeconds: 1 }) : { reread: unpublished };
        }
        return { commit: operation === 'sendDraft' ? await api.sendDraft(params, options) : await api.undoSend(params, options) };
      } finally {
        timers.revoke();
        await this.rearm();
      }
    });
    if ('result' in outcome) return outcome.result;
    if ('reread' in outcome) {
      if (!await this.publishThrough(outcome.reread)) return { error: { code: 'mailbox_restoring', retryAfterSeconds: 1 } };
      return this.sendApi(scope, operation, params, options, true);
    }
    // The action has taken effect; until a publish covers it, the client retries the same key.
    if (!await this.publishThrough(outcome.commit.seq, false)) return { error: { code: 'idempotency_in_progress', retryAfterSeconds: 1 } };
    // The answer is queued in the work lane ahead of the covered-work wake-up, so it never waits for it.
    const answered = this.work.run(async () => {
      const { body, status, replayed } = await outcome.commit.answer();
      return { body, status, ...(replayed && { replayed: true }) };
    });
    this.scheduleCoveredWake();
    return answered;
  }

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
    await this.rearm(() => {
      if (lowerOnly) timers.lower(kind, ref, at);
      else timers.set(kind, ref, at);
    });
  }

  // Deletes a row and re-arms. Call in the work lane.
  protected async deleteTimer(kind: string, ref: string): Promise<void> {
    this.registeredKind(kind);
    const timers = this.timerTable();
    await this.rearm(() => timers.delete(kind, ref));
  }

  // Applies `write`, then arms the alarm at the earliest row (or clears it
  // when there is none). The armed alarm is read before the write, so no
  // other call can interleave between the row write and the alarm write. The
  // alarm handler forces the alarm write: a wake-up it does not set itself
  // may be cleared when it returns.
  private async rearm(write: () => void = () => {}, force = false): Promise<void> {
    const current = force ? undefined : await this.ctx.storage.getAlarm();
    write();
    const at = this.timerTable().earliest();
    if (at === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
    } else if (current !== at) await this.ctx.storage.setAlarm(at);
  }

  // Moves the journal_flush row to `at` unless it is already earlier, and re-arms. Call in the work lane.
  private async lowerLane(at: number): Promise<void> {
    const timers = this.timerTable();
    let moved = false;
    await this.rearm(() => { moved = this.lowerJournal(timers, at); });
    if (moved) this.laneMoved?.resolve();
  }

  private lowerJournal(timers: TimerTable, at: number): boolean {
    const before = timers.due(JOURNAL_FLUSH, JOURNAL_FLUSH_REF);
    timers.lower(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, at);
    return before === null || at < before;
  }

  // Inside the transaction that finishes a restore: each kind recreates its rows from the restored state.
  private rebuildTimers(now: number): void {
    const timers = this.timerTable();
    try {
      for (const kind of this.timerKinds.values()) {
        const result: unknown = kind.rebuild?.(timers, now);
        // Its deferred writes would miss the transaction that sets the mailbox ready.
        if (thenable(result)) {
          result.then(undefined, () => {});
          throw new Error('Timer rebuilds must be synchronous');
        }
      }
    } finally {
      timers.revoke();
    }
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
    const outbound = this.env.MAIL_DRAFT_UPLOADS_ENABLED === 'on';
    if (!outbound && (operation === 'createUpload' || operation === 'deleteUpload')) return { error: { code: 'not_implemented' } };
    try {
      // The executing operation durably reserves its key before awaiting the
      // object write. A retry can observe this without waiting in the work lane.
      if (isIdempotentCreate(operation) && isId(options.idempotencyKey) && storedLifecycle<Lifecycle>(this.ctx.storage)?.state === 'ready' &&
          this.ctx.storage.sql.exec(`SELECT 1 FROM mailbox_api_in_progress p WHERE p.key = ? AND p.expires_at > ?
            AND NOT EXISTS (SELECT 1 FROM mailbox_api_idempotency r WHERE r.key = p.key AND r.expires_at > ?)`,
          options.idempotencyKey, now, now).toArray().length) {
        return { error: { code: 'idempotency_in_progress', retryAfterSeconds: 1 } };
      }
      if (operation === 'sendDraft' || operation === 'undoSend' || operation === 'getSend' || operation === 'listSends') {
        if (this.env.MAIL_SEND_ENABLED !== 'on') return { error: { code: 'not_implemented' } };
        return await this.sendApi(scope, operation, params, options);
      }
      const http = options.httpWrite;
      if (operation === 'createUpload') return await this.createUpload(scope, params, http ?? input as UploadBody, options.idempotencyKey, now, http);
      if (http && (operation === 'createDraft' || operation === 'createLabel')) {
        return await this.createJsonWrite(scope, operation, http, options, now);
      }
      try { return await this.executeMailApi(scope, operation, params, input, options); }
      catch (error) {
        // A thread whose sent copy reports an unpublished send state: publish, then read once more.
        if (!(error instanceof UnpublishedSend)) throw error;
        if (!await this.publishThrough(error.seq)) return { error: { code: 'mailbox_restoring', retryAfterSeconds: 1 } };
        try { return await this.executeMailApi(scope, operation, params, input, options); }
        catch (retry) {
          if (retry instanceof UnpublishedSend) return { error: { code: 'mailbox_restoring', retryAfterSeconds: 1 } };
          throw retry;
        }
      }
    } catch (error) {
      if (error instanceof ApiFault) return { error: error.problem };
      return { error: { code: 'unavailable', retryAfterSeconds: 1 } };
    } finally {
      const stream = options.httpWrite?.stream;
      if (stream && !stream.locked) void stream.cancel().catch(() => {});
    }
  }

  private async executeMailApi(scope: Scope, operation: Operation, params: Record<string, string>, input: unknown,
    options: MailboxApiOptions, preparedKey?: PreparedApiKey): Promise<MailboxApiResult> {
    return this.work.run(async () => {
      const index = this.index(scope.workspaceId);
      if (!await this.ready(index, scope)) return fail('mailbox_restoring', { retryAfterSeconds: 1 });
      const life = index.lifecycle<Lifecycle>();
      if (life?.state !== 'ready' || index.unindexed('', 1).length) return fail('mailbox_restoring', { retryAfterSeconds: 1 });
      const mutation = mailApiMutation(operation);
      if (mutation) await this.armFor(operation === 'updateThreads' ? FLAGS_FLUSH_MS : SETTINGS_FLUSH_MS);
      const timers = mutation ? this.timerTable() : undefined;
      try {
        return await new MailboxApi(index, this.ctx.storage.sql, scope.workspaceId, scope.mailboxId, life.incarnation, this.mailApiNow(),
          timers, preparedKey, () => this.mailApiNow(), this.env.MAIL_DRAFT_UPLOADS_ENABLED === 'on').call(operation, params, input, options);
      } finally {
        if (timers) { timers.revoke(); await this.rearm(); }
      }
    });
  }

  private async createJsonWrite(scope: Scope, operation: 'createDraft' | 'createLabel', http: HttpMailboxWrite, options: MailboxApiOptions,
    arrived: number): Promise<MailboxApiResult> {
    const key = apiKey(options.idempotencyKey);
    const sql = this.ctx.storage.sql;
    const index = this.index(scope.workspaceId);
    const reservation = await this.work.run(async () => {
      if (!await this.ready(index, scope) || index.unindexed('', 1).length) return fail('mailbox_restoring', { retryAfterSeconds: 1 });
      return reserveApiKey(sql, key, this.mailApiNow());
    });
    const committed = 'row' in reservation;
    try {
      const params = createQuery(http, false);
      const deadline = committed ? arrived + IN_PROGRESS_TTL_MS : reservation.expiresAt;
      return await this.jsonWrites.run(async () => {
        const input = await readMailboxJson(http, deadline - this.mailApiNow());
        const fingerprint = await fingerprintOf(operation, params, input);
        if (committed) return replayApiKey(index, reservation.row, fingerprint);
        return this.executeMailApi(scope, operation, params, input, options, { token: reservation.token, fingerprint });
      });
    } catch (error) {
      return checkReplayInput(error, committed);
    } finally {
      if ('token' in reservation) await this.work.run(async () => clearApiKey(sql, key, reservation.token));
    }
  }

  private async createUpload(scope: Scope, params: Record<string, string>, input: UploadBody, rawKey: string | undefined,
    now: number, http?: HttpMailboxWrite): Promise<MailboxApiResult> {
    const key = apiKey(rawKey);
    const sql = this.ctx.storage.sql;
    const index = this.index(scope.workspaceId);
    const reservation = await this.work.run(async () => {
      if (!await this.ready(index, scope) || index.unindexed('', 1).length) return fail('mailbox_restoring', { retryAfterSeconds: 1 });
      return reserveApiKey(sql, key, this.mailApiNow());
    });
    try {
      const query = http ? createQuery(http, true) : params;
      // Only a replay must read the body before validating its filename.
      const reserved = 'row' in reservation ? reservation : { ...reservation, name: uploadName(query.name) };
      const deadline = 'row' in reserved ? now + IN_PROGRESS_TTL_MS : reserved.expiresAt;
      return await this.uploads.run(async () => {
        const mediaType = uploadMediaType(input.mediaType);
        const { digest, size, bytes } = await readUpload(input, 'row' in reserved, deadline - this.mailApiNow());
        const fingerprint = await fingerprintOf('createUpload', query, { digest, mediaType });
        if ('row' in reserved) return replayApiKey(index, reserved.row, fingerprint);
        const { name } = reserved;
        const live = () => storedLifecycle<Lifecycle>(this.ctx.storage)?.state === 'ready' &&
          ownsApiKey(sql, key, reserved.token, this.mailApiNow());
        const remaining = () => live() ? deadline - this.mailApiNow() : 0;
        const id = crypto.randomUUID();
        const prepared = await this.beforeDeadline(Date.now() + remaining(), () => index.prepareUpload(id, digest, size, bytes, remaining));
        if (!prepared) {
          if (!bytes.locked) void bytes.cancel().catch(() => {});
          return fail('idempotency_in_progress', { retryAfterSeconds: 1 });
        }
        const { objectKey, holder } = prepared;
        let committed = false;
        try {
          return await this.localStep(timers => {
            if (!live()) return fail('idempotency_in_progress', { retryAfterSeconds: 1 });
            const createdAt = this.mailApiNow();
            const row = { id, objectKey, holder, name, mediaType, size, expiresAt: createdAt + UPLOAD_TTL_MS };
            const upload = wireUpload(row);
            const stored = resultEvent('createUpload', key, fingerprint, { upload }, createdAt);
            index.commitEvents([{ type: 'api_upload', ...row }, stored]);
            timers.set(UPLOAD_EXPIRY, id, row.expiresAt);
            scheduleResult(timers, stored);
            if (this.lowerJournal(timers, this.timerNow() + SETTINGS_FLUSH_MS - PUBLISH_BUDGET_MS)) this.laneMoved?.resolve();
            clearApiKey(sql, key, reserved.token);
            committed = true;
            return { body: upload };
          });
        } catch (error) {
          if (committed) return fail('idempotency_in_progress', { retryAfterSeconds: 1 });
          this.ctx.waitUntil(index.releaseUpload(holder, objectKey));
          throw error;
        }
      });
    } catch (error) {
      if (!input.stream?.locked) void input.stream?.cancel().catch(() => {});
      return checkReplayInput(error, 'row' in reservation);
    } finally {
      if ('token' in reservation) await this.work.run(async () => clearApiKey(sql, key, reservation.token));
    }
  }

  async contentRecord(workspaceId: string, mailboxId: string, messageId: string): Promise<MailboxContentRecord | null> {
    if (!enabled(this.env) || this.env.MAIL_CONTENT_ENABLED !== 'on' || !isId(messageId) ||
        !this.scoped({ workspaceId, mailboxId }) || this.lifecycleState() !== 'ready') return null;
    // A cold DO still runs its existing constructor schema/alarm self-repair.
    // This RPC itself never initializes, restores, indexes or arms a mailbox.
    return contentRecord(this.ctx.storage.sql, messageId, this.mailApiNow());
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
      holdProvisional: (target, holder) => refs.holdProvisional(target, holder),
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
    const now = Date.now();
    // A journal wake-up already due within a second, with the platform alarm
    // armed that soon, is soon enough. A held fallback alarm (for example
    // after a disabled period) is not: re-arm from the rows.
    const due = this.timerTable().due(JOURNAL_FLUSH, JOURNAL_FLUSH_REF);
    if (due !== null && due <= now + 1000) {
      const armed = await this.ctx.storage.getAlarm();
      if (armed !== null && armed <= now + 1000) return;
    }
    await this.lowerLane(now);
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
      // The journal row is checked on its own: another kind's row may hold the alarm.
      if (this.timerTable().due(JOURNAL_FLUSH, JOURNAL_FLUSH_REF) === null || await this.ctx.storage.getAlarm() === null) {
        await this.lowerLane(Date.now());
      }
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

  protected async mutate<T>(workspaceId: string, mailboxId: string, delay: number, operation: (index: MailboxIndex) => T): Promise<T> {
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
      // wake-up before any work. Each row this call runs is first claimed: it
      // moves to its retry time (journal_flush to the settings recovery point,
      // as before) under this call's token, so a crash in a handler or before
      // the final re-arm runs it again on the next alarm, a row is never run
      // twice by one call, and any later write to the row ends the claim.
      const started = this.timerNow();
      const claims = await this.work.run(async () => {
        const timers = this.timerTable();
        const now = this.timerNow();
        const lane = timers.due(JOURNAL_FLUSH, JOURNAL_FLUSH_REF);
        const laneDue = lane !== null && lane <= now;
        // A due journal_flush always runs first and takes one of the batch's places.
        const due: TimerRow[] = timers.dueRows(now, TIMER_BATCH - (laneDue ? 1 : 0), JOURNAL_FLUSH);
        // With nothing due (an early, retried or held wake-up) the journal lane
        // runs anyway and decides for itself what is due, as every alarm did before timers.
        if (laneDue || !due.length) due.unshift({ due_at: lane ?? now, kind: JOURNAL_FLUSH, ref: JOURNAL_FLUSH_REF });
        // A row still claimed by a call that is running within its lease stays
        // that call's: its late failure keeps its retry. A replaced row has no
        // claim and gets a new token, so a stale call can never move it.
        const running = new Set([...this.inFlight.values()].filter(entry => now - entry.started < TIMER_LEASE_MS).map(entry => entry.token));
        const claimed: TimerClaim[] = due.map(({ due_at, kind, ref, claim }) => {
          const retained = !!claim && running.has(claim);
          return { due_at, kind, ref, retained, token: retained ? claim! : crypto.randomUUID(),
            until: now + (kind === JOURNAL_FLUSH ? SETTINGS_FLUSH_MS : this.timerRetryMs) };
        });
        // More than one batch due re-arms at once.
        await this.rearm(() => this.ctx.storage.transactionSync(() => {
          for (const row of claimed) timers.claim(row.kind, row.ref, row.until, row.token);
        }), true);
        return claimed;
      });
      // Rows dispatched by this call, journal_flush runs included; at most TIMER_BATCH.
      let dispatched = 0;
      // Whether another kind ran since the lane last ran in this call.
      let handlerRan = false;
      for (let i = 0; i < claims.length; i++) {
        const claim = claims[i];
        if (claim.kind === JOURNAL_FLUSH) {
          dispatched++;
          await this.runLane(claim.token);
          continue;
        }
        // A journal_flush deadline that fell due since the claim (or during
        // another handler) never waits behind the next handler.
        if (dispatched < TIMER_BATCH && await this.runLaneIfDue()) {
          dispatched++;
          handlerRan = false;
        }
        if (dispatched >= TIMER_BATCH || this.timerNow() - started >= this.timerRunBudgetMs) {
          await this.releaseClaims(claims.slice(i));
          break;
        }
        const result = await this.runTimer(claim, started + this.timerRunBudgetMs);
        if (result === 'budget') {
          await this.releaseClaims(claims.slice(i));
          break;
        }
        // journal_flush fell due while this claim waited for the work lane: run it, then reconsider the claim.
        if (result === 'lane') {
          i--;
          continue;
        }
        if (result === 'ran') {
          dispatched++;
          handlerRan = true;
        }
      }
      if (handlerRan && dispatched < TIMER_BATCH) await this.runLaneIfDue();
      await this.work.run(() => this.rearm(undefined, true));
    });
  }

  // Unstarted rows go back to their due time, so the final re-arm wakes the next call at once.
  private async releaseClaims(claims: TimerClaim[]): Promise<void> {
    await this.work.run(async () => {
      const timers = this.timerTable();
      await this.rearm(() => this.ctx.storage.transactionSync(() => {
        // A claim kept for a still-running call stays that call's: its deferred retry is already set.
        for (const claim of claims) if (!claim.retained) timers.setIfOwned(claim.kind, claim.ref, claim.token, claim.due_at);
      }));
    });
  }

  private laneDue(): boolean {
    const due = this.timerTable().due(JOURNAL_FLUSH, JOURNAL_FLUSH_REF);
    return due !== null && due <= this.timerNow();
  }

  // Runs journal_flush now if its row is due, claiming it first like any due row.
  private async runLaneIfDue(): Promise<boolean> {
    if (!this.laneDue()) return false;
    const token = crypto.randomUUID();
    await this.work.run(async () => {
      const timers = this.timerTable();
      await this.rearm(() => timers.claim(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, this.timerNow() + SETTINGS_FLUSH_MS, token));
    });
    await this.runLane(token);
    return true;
  }

  // The lane takes the work lane for each step that touches the index and
  // keeps its backup I/O outside it, so deliveries never wait on R2.
  private async runLane(token: string): Promise<void> {
    try {
      await this.flushLane(token);
    } catch {
      await this.work.run(async () => {
        const timers = this.timerTable();
        await this.rearm(() => timers.setIfOwned(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, token, this.timerNow() + TIMER_RETRY_MS));
      });
    }
  }

  // One synchronous storage step of a timer handler, in the work lane. The
  // table it gets is revoked when the step returns, so a write the step
  // defers past an await cannot land outside the transaction.
  private localStep<T>(step: (timers: TimerTable) => T): Promise<T> {
    return this.work.run(async () => {
      let value!: T;
      const timers = this.timerTable();
      await this.rearm(() => {
        value = this.ctx.storage.transactionSync(() => {
          let result: T;
          try {
            result = step(timers);
          } finally {
            // Before anything the step deferred can run.
            timers.revoke();
          }
          // A promise here would hold the step open across I/O; refuse it and roll back.
          if (thenable(result)) {
            // Its own later failure (for example a write to the revoked table) is expected; do not leave it unhandled.
            result.then(undefined, () => {});
            throw new Error('Timer steps must be synchronous');
          }
          return result;
        });
      });
      return value;
    });
  }

  private readonly local = ((step: (timers: TimerTable) => unknown) => this.localStep(step)) as TimerRun['local'];

  // Starts one claimed row of another kind. Returns 'lane' when journal_flush
  // fell due before the handler could start, so the caller runs it first.
  private async runTimer(claim: TimerClaim, runDeadline: number): Promise<'ran' | 'skipped' | 'lane' | 'budget'> {
    const handler = this.timerKinds.get(claim.kind);
    const key = JSON.stringify([claim.kind, claim.ref]);
    const id = crypto.randomUUID();
    const start = await this.work.run(async () => {
      const timers = this.timerTable();
      const now = this.timerNow();
      // Replaced or deleted since the claim: its new schedule governs.
      if (!timers.owned(claim.kind, claim.ref, claim.token)) return 'skipped';
      // A call still running in this isolate is not started twice within its lease; the row waits for its claim.
      const running = this.inFlight.get(key);
      if (running && now - running.started < TIMER_LEASE_MS) return 'skipped';
      // Checked again here, just before the handler starts: this step may have waited behind other work.
      if (this.laneDue()) return 'lane';
      if (now >= runDeadline) return 'budget';
      // Other kinds act on mailbox state, which is complete only while ready.
      // A kind this version does not know (for example after a rollback) waits too.
      if (!handler || this.lifecycleState() !== 'ready') {
        await this.rearm(() => timers.setIfOwned(claim.kind, claim.ref, claim.token, now + HELD_RECHECK_MS));
        return 'skipped';
      }
      // This claim kept an earlier call's token, and that call has since settled
      // or its lease ran out: the new call gets its own token, so the earlier
      // call's queued retry cannot touch it. Only now, when a call really starts.
      if (claim.retained) {
        claim.token = crypto.randomUUID();
        claim.retained = false;
        timers.claim(claim.kind, claim.ref, claim.until, claim.token);
      }
      this.inFlight.set(key, { started: now, id, token: claim.token });
      return 'start';
    });
    if (start !== 'start' || !handler) return start === 'start' ? 'skipped' : start;
    const now = this.timerNow();
    const call = (async () => handler.run({ ref: claim.ref, now, local: this.local }))();
    const outcome = call.then(() => ({ failed: false }), () => ({ failed: true }));
    void outcome.then(() => {
      // A later call may hold the entry after this one's lease ran out.
      if (this.inFlight.get(key)?.id === id) this.inFlight.delete(key);
    });
    const result = await this.race(outcome, now + this.timerHandlerBudgetMs);
    if (result === 'failed') await this.retryFailed(claim);
    // A call that lost its race and fails later still gets its retry, unless its row was rescheduled since.
    else if (result === 'lost') void outcome.then(({ failed }) => failed ? this.retryFailed(claim) : undefined).catch(() => {});
    return 'ran';
  }

  // A failing handler neither blocks the remaining rows nor spins: a row still
  // claimed for its call waits TIMER_RETRY_MS from the failure.
  private async retryFailed(claim: TimerClaim): Promise<void> {
    await this.work.run(async () => {
      const timers = this.timerTable();
      await this.rearm(() => timers.setIfOwned(claim.kind, claim.ref, claim.token, this.timerNow() + this.timerRetryMs));
    });
  }

  // Waits for a handler until the earlier of its budget and the journal_flush
  // deadline, re-reading that deadline whenever a write moves it earlier.
  private async race(outcome: Promise<{ failed: boolean }>, budget: number): Promise<'settled' | 'failed' | 'lost'> {
    for (;;) {
      const lane = this.timerTable().due(JOURNAL_FLUSH, JOURNAL_FLUSH_REF);
      const until = Math.min(budget, lane ?? Infinity);
      const wait = until - this.timerNow();
      if (wait <= 0) return 'lost';
      const moved = this.laneMoved = Promise.withResolvers<void>();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), wait); });
      try {
        const result = await Promise.race([outcome, tick, moved.promise.then(() => null)]);
        if (result) return result.failed ? 'failed' : 'settled';
      } finally {
        clearTimeout(timeout);
        if (this.laneMoved === moved) this.laneMoved = null;
      }
    }
  }

  // The journal_flush row's handler: the backup and restore lane. Its row
  // carries the deadline this lane computes, which the alarm used to carry.
  private async flushLane(token: string): Promise<void> {
    // Requests made before this run are being served by it.
    this.wakeRequested = false;
    const life = storedLifecycle<Lifecycle>(this.ctx.storage);
    if (!life || life.state === 'init') {
      let held = false;
      try { await this.checkBackupAlerts(null); } catch { held = true; }
      await this.work.run(async () => {
        const timers = this.timerTable();
        const state = this.lifecycleState();
        await this.rearm(() => {
          // A call during this run made the mailbox ready (or started a
          // restore). Keep the deadline it armed; if it armed none past the
          // claim, the lane has work now.
          if (state && state !== 'init') timers.settleIfOwned(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, token, Date.now());
          // Nothing to publish or restore; keep a deadline a call set during this run.
          else if (held) timers.setIfOwned(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, token, Date.now() + HELD_RECHECK_MS);
          else timers.deleteIfOwned(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, token);
        }, true);
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
      const timers = this.timerTable();
      await this.rearm(() => {
        timers.set(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, Math.min(pending ? Math.min(next, soon) : next, requested));
        if (current?.state === 'ready') {
          const through = index.journal.flushed();
          if (this.ctx.storage.sql.exec(`SELECT EXISTS (SELECT 1 FROM mailbox_pending_releases WHERE seq <= ?)
            OR EXISTS (SELECT 1 FROM mailbox_pending_confirmations WHERE seq <= ?) AS pending`, through, through)
            .one().pending) timers.lower(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, this.timerNow() + 60_000);
        }
      }, true);
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
    const skipped = life?.state === 'ready' && (life.restoreSkipped ?? 0) > 0;
    const conflict = life?.state === 'ready' && !!life.conflict;
    const oldestConfirmation = index ? sql.exec<{ published_at: number }>(`SELECT published_at FROM mailbox_pending_confirmations
      WHERE published_at IS NOT NULL ORDER BY published_at LIMIT 1`).toArray()[0]?.published_at : undefined;
    const confirmStaleAt = oldestConfirmation === undefined ? Infinity : oldestConfirmation + FLAGS_FLUSH_MS;
    const holderLost = life?.state === 'ready' && sql.exec(`SELECT EXISTS (SELECT 1 FROM mailbox_unusable_sources)
      OR EXISTS (SELECT 1 FROM mailbox_alerts WHERE code = 'holder_source_lost' AND sent_at IS NULL) AS active`).one().active !== 0;
    const breach = life?.state === 'ready' && sql.exec('SELECT EXISTS (SELECT 1 FROM mailbox_send_breaches) AS active').one().active !== 0;
    // A send held after repeated crashes of our own waits for an operator.
    const held = life?.state === 'ready' && sql.exec(`SELECT EXISTS (SELECT 1 FROM mailbox_send_dispatch d JOIN mailbox_sends s ON s.id = d.send_id
      WHERE d.held_at IS NOT NULL AND s.state NOT IN ('sent', 'partial', 'failed', 'cancelled')) AS active`).one().active !== 0;
    // A stored acceptance that cannot be recorded: an invariant breach.
    const unapplied = life?.state === 'ready' && sql.exec('SELECT EXISTS (SELECT 1 FROM mailbox_send_unapplied) AS active').one().active !== 0;
    const conditions: Array<[MailboxAlertCode, boolean]> = [
      ['backup_stale', !!stale], ['restore_blocked', blocked], ['restore_skipped', skipped], ['backup_conflict', conflict],
      ['holder_confirm_stale', confirmStaleAt <= now], ['holder_source_lost', holderLost], ['send_invariant', breach], ['send_held', held],
      ['send_result_unapplied', unapplied]];
    let next = confirmStaleAt > now ? confirmStaleAt : Infinity;
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
        confirm: async entries => {
          const answers = await this.beforeDeadline(deadline, () => refs.confirm(entries));
          if (!answers) throw new Error('Holder confirmation exceeded restore slice');
          return answers;
        },
        rebuild: now => this.rebuildTimers(now),
      });
      // A restart means the manifest vanished under this restore. Each restart
      // counts against restore_blocked and backs off, so a manifest that keeps
      // disappearing cannot spin fence and baseline writes in a silent loop.
      if (life.state === 'restoring' && (life.restarts ?? 0) > restarts) return Date.now() + backoff(life.restarts ?? 1);
    } while (life.state === 'restoring' && Date.now() < deadline);
    if (life.state === 'ready') {
      // Rows rebuilt by the finishing transaction are armed before anything else runs.
      await this.work.run(() => this.rearm());
      await outbox.markBackedUp(workspaceId, mailboxId).catch(() => {});
    }
    return Date.now() + (life.state === 'restoring' ? 0 : 1000);
  }

  private async beforeDeadline<T>(deadline: number, io: () => Promise<T>): Promise<T | null> {
    const timeLeft = deadline - Date.now();
    if (timeLeft <= 0) return null;
    let handle: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([io(), new Promise<null>(resolve => { handle = setTimeout(() => resolve(null), timeLeft); })]);
    } finally { clearTimeout(handle); }
  }

  private async confirmPublishedHolders(index: MailboxIndex, workspaceId: string, lastSeq: number, deadline: number): Promise<void> {
    const rows = index.pendingConfirmations(lastSeq);
    if (!rows.length) return;
    const refs = this.env.SWEEPER.getByName(workspaceId);
    const answers = await this.beforeDeadline(deadline, () => refs.confirm(rows.map(({ key, holder }) => ({ key, holder })))).catch(() => null);
    if (!answers) return;
    await this.work.run(async () => {
      if (this.lifecycleState() === 'ready') index.finishConfirmations(rows, answers, false);
    });
  }

  private async releasePublishedHolders(workspaceId: string, lastSeq: number, journalDeadline: number): Promise<void> {
    type Pending = { seq: number; key: string; holder: string; retry_at: number };
    const sql = this.ctx.storage.sql;
    const rows = sql.exec<Pending>(`SELECT seq, object_key AS key, holder, retry_at FROM mailbox_pending_releases
      WHERE retry_at <= ? AND seq <= ? ORDER BY retry_at, seq, object_key, holder LIMIT 64`, Date.now(), lastSeq).toArray();
    if (!rows.length) return;
    const sweeper = this.env.SWEEPER.getByName(workspaceId);
    // An unhealthy sweeper cannot hold this tail past the next journal deadline.
    const timeLeft = Math.min(PUBLISH_BUDGET_MS, journalDeadline - Date.now());
    if (timeLeft <= 0) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), timeLeft); });
    try {
      for (let offset = 0; offset < rows.length && Date.now() < journalDeadline; offset += 6) {
        const batch = await this.work.run(async () => this.ctx.storage.transactionSync(() => {
          const retryAt = Date.now() + TIMER_RETRY_MS;
          // Attempted rows sort behind older attempts and rows that have not
          // yet run, even if a suspended or failed release never acknowledges.
          return rows.slice(offset, offset + 6).filter(row => sql.exec(`UPDATE mailbox_pending_releases SET retry_at = ?
            WHERE seq = ? AND object_key = ? AND holder = ? AND retry_at = ?`, retryAt, row.seq, row.key, row.holder, row.retry_at).rowsWritten);
        }));
        if (Date.now() >= journalDeadline) break;
        const acks = Promise.allSettled(batch.map(async ({ seq, key, holder }) => {
          await sweeper.release(key, holder);
          // Preserve each independent acknowledgement even if its sibling is
          // still running when the tail runs out of time.
          await this.work.run(async () => {
            sql.exec('DELETE FROM mailbox_pending_releases WHERE seq = ? AND object_key = ? AND holder = ?', seq, key, holder);
          });
        }));
        if (!await Promise.race([budget, acks])) break;
      }
    } finally { clearTimeout(timeout); }
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
      published = await this.publishes.run(async () => {
        // A barrier may have published since this run read the lifecycle.
        const stored = index.lifecycle<Lifecycle>();
        if (stored?.state !== 'ready' || stored.incarnation !== life.incarnation) throw new Error('Mailbox lifecycle changed');
        life = stored;
        return recovery.publish(life, now, () => this.work.run(async () => {
          // Every done row at or below the cursor is present in the capture.
          const deliveryCursor = await outbox.deliveryCursor(workspaceId, mailboxId);
          return { deliveryCursor, seq: index.captureSnapshot() };
        }), () => outbox.resetBackupWatermark(workspaceId, mailboxId).catch(() => {}));
      });
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
      // Start from the stored lifecycle: a barrier may have published (and moved its ETag) since.
      const stored = index.lifecycle<Lifecycle>();
      current = { ...(stored?.state === 'ready' ? stored : current), reindexAfter, failures, reindexFailures, reindexRetryAt };
      index.setLifecycle(current);
    }
    const soon = Date.now() + 1000;
    const reindexAt = reindexRetryAt ? Math.max(reindexRetryAt, soon) : Infinity;
    const next = Math.min(Math.max(current.nextSnapshotAt, soon), reindexAt, cleanupRetry ? Date.now() + 60_000 : Infinity);
    const more = published.more || cleanupPending || prunedPage || (reindexDue && !reindexError && pending.length > 0);
    // Deltas were still published; retry only the snapshot, with backoff.
    const deadline = published.snapshotError ? Math.min(Date.now() + backoff(current.failures), reindexAt) : more ? soon : next;
    const armed = this.timerTable().due(JOURNAL_FLUSH, JOURNAL_FLUSH_REF);
    const holderNow = Date.now();
    const holderDeadline = Math.min(deadline, armed ?? Infinity, holderNow + this.holderIoBudgetMs);
    const releasable = this.ctx.storage.sql.exec(`SELECT 1 FROM mailbox_pending_releases
      WHERE retry_at <= ? AND seq <= ? LIMIT 1`, holderNow, published.lastSeq).toArray().length !== 0;
    // Confirm first, but a stuck confirmation must leave time for releases.
    const confirmDeadline = releasable ? holderNow + Math.floor((holderDeadline - holderNow) / 2) : holderDeadline;
    await this.confirmPublishedHolders(index, workspaceId, published.lastSeq, confirmDeadline);
    await this.releasePublishedHolders(workspaceId, published.lastSeq, holderDeadline);
    return deadline;
  }
}
