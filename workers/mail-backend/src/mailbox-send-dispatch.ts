// The mailbox side of the send consumer (docs/m3-outbound-plan.md, section
// 2.4, consumer steps 1 to 7, the finish rule and the deadline; M3-5a):
// claimSend, markSend, authorizeDispatch, recordResult, delaySend,
// abandonClaim and recordStoredResults, and the drive handler's decisions
// after release. Every change is one `send_progress` journal event committed
// in the work lane; remote calls (the directory, the quota port, publishes)
// happen between steps, and each commit re-checks the state it acts on.
import type { MailboxIndex } from './mailbox-index.ts';
import { fenceBefore, fenceKey, sameFence, validFence, type QuotaPort, type QuotaScope, type SendFence } from './mailbox-send-quota.ts';
import { senderActive } from './mailbox-send-sender.ts';
import {
  dispatchRow, fenceRows, ledger, markRows, releaseList, SEND_DRIVE, sendRow, sentCopyId, TERMINAL, validErrorCode, validProviderId, validReason,
  validSendId,
  type LedgerRow, type SendRow,
} from './mailbox-send-store.ts';
import type { TimerRun, TimerTable } from './mailbox-timers.ts';
import type { SendRequest } from './send-mime.ts';
import type {
  JournalEvent, SendDispatchRow, SendFailure, SendFenceOutcome, SendFenceRow, SendLedgerChange, SendMarkRow, SendRecipient, SendRecord,
} from './mail-journal.ts';

// A claim's lease, and the hold of a protected recipient after its lease or a restore.
export const LEASE_MS = 5 * 60_000;
// The default bound on clock differences between the objects of the send path (configuration).
export const CLOCK_SKEW_MS = 30_000;
// What one authorization grants: a `send()` call must start within it.
export const DISPATCH_WINDOW_MS = 10_000;
// Provider-reported ambiguous errors that end a send's remaining external recipients.
export const AMBIGUOUS_CAP = 3;
export const AMBIGUOUS_BACKOFF_MS = 30 * 60_000;
// Provider wait (rate limits and ambiguous errors) that ends a send's remaining external recipients.
export const DEADLINE_MS = 72 * 60 * 60_000;
// Try-later and our-outage results back off from 1 minute, doubling to at most 1 hour.
export const REFUSAL_BACKOFF_MS = 60_000;
export const REFUSAL_BACKOFF_MAX_MS = 60 * 60_000;
// abandonClaim's retry time is clamped to this range.
export const ABANDON_MIN_MS = 60_000;
export const ABANDON_MAX_MS = 60 * 60_000;
// Unfinished attempts in a row that hold a send, and how often a held send's drive row fires.
export const CRASH_CAP = 5;
export const HOLD_RECHECK_MS = 24 * 60 * 60_000;
// A stored result found while the mailbox restores waits at least this long.
export const RESTORING_NOTICE_MS = 5 * 60_000;
export const NOTICE_BACKOFF_MS = 60_000;
export const NOTICE_BACKOFF_MAX_MS = 60 * 60_000;
const STORED_PAGE = 16;
// Failed attempts (about 4 hours of backoff) after which an applicable stored row raises an alert.
export const STUCK_FAILURES = 8;
// How long a poll that took a flagged row's recheck keeps it from other polls.
export const RECHECK_LEASE_MS = 5 * 60_000;
// A gate's reset is at most this far ahead (a monthly gate resets within a month).
export const GATE_RESET_MAX_MS = 32 * 24 * 60 * 60_000;
// Release-list fences a claim hands out, a Mark removes and a quota call releases at once.
export const RELEASE_BATCH = 64;

export type ProviderResult =
  // `send()` was accepted: every recipient of the call is sent, except those
  // the provider reports suppressed. A null message id is still accepted.
  | { kind: 'accepted'; messageId: string | null; suppressed?: number[] }
  | { kind: 'rejected'; reason: string }
  | { kind: 'try_later' }
  // Our own outage (for example sending not verified): never counted.
  | { kind: 'outage'; code: string }
  | { kind: 'ambiguous'; code?: string };

export type ClaimedRecipient = SendRecipient & { idx: number };
export type ClaimAnswer =
  | { status: 'claimed'; fence: SendFence; leaseUntil: number; recipients: ClaimedRecipient[]; release: SendFence[];
      from: SendRecord['from']; replyTo: SendRecord['replyTo']; sentCopyKey: string | null }
  // `results`: a stored provider result for this send could not be read or recorded yet.
  // `release`: listed fences beyond one page could not be released yet.
  | { status: 'not_now'; reason: 'restoring' | 'disabled' | 'unpublished' | 'leased' | 'delayed' | 'backoff' | 'held' | 'grace' | 'results' | 'release' }
  // Nothing to send for this send now or ever: the consumer acknowledges.
  | { status: 'refused' }
  // A ready mailbox has no such send.
  | { status: 'gone' };
export type MarkAnswer = { status: 'ok' | 'stale' };
// `invalid`: the frozen inputs can no longer build the request (an invariant breach).
export type RequestAnswer = { status: 'ok'; request: SendRequest } | { status: 'stale' | 'invalid' };
export type AuthorizeAnswer = { status: 'ok'; remainingMs: number } | { status: 'stale' } | { status: 'quota_window'; retryAfter: number };
// `unpublished`: recorded, but no publish covers it yet; the caller keeps the result and retries.
export type ReportAnswer = { status: 'recorded' | 'stale' | 'restoring' | 'unpublished' | 'gone' };
export type DelayAnswer = { status: 'delayed'; until: number } | { status: 'stale' | 'restoring' | 'gone' };
export type AbandonAnswer = { status: 'ok' | 'stale' | 'restoring' | 'gone' };
// `retry`: rows remain, the earliest due at `next`.
export type StoredAnswer = { status: 'none' | 'recorded' | 'restoring' | 'retry'; recorded: number; next?: number };

type DirectoryDatabase = { withSession(constraint: 'first-primary'): Pick<D1DatabaseSession, 'prepare'> };
export type DispatchScope = { workspaceId: string; mailboxId: string };
type Ready = { index: MailboxIndex; epoch: number; restoredAt: number };

export type DispatchPorts = {
  sql: SqlStorage;
  // In the work lane: whether the mailbox is ready for this scope (it may start a restore).
  ready(scope: DispatchScope): Promise<boolean>;
  // Synchronous, inside a step: the ready mailbox's index and recovery fences.
  current(): Ready | undefined;
  local: TimerRun['local'];
  // Holds the work lane across `io` and then runs `step` synchronously in a
  // transaction, so `io` is the last await before the step's commit.
  exclusive<A, T>(io: () => Promise<A>, step: (timers: TimerTable, value: A) => T): Promise<T>;
  // A test seam inside the lane, before and after authorizeDispatch's directory statement.
  senderCheckpoint?(phase: 'before' | 'after'): Promise<void>;
  // A test seam before recordResult acts, for fault injection.
  beforeRecord?(fence: SendFence): Promise<void>;
  // A test seam between a claim's release-only quota call and the removal of those fences.
  afterClaimRelease?(): Promise<void>;
  // A test seam right after a stored result's row is deleted.
  afterResultDelete?(): Promise<void>;
  // A test seam right after a poll selected its stored rows.
  afterStoredSelect?(): Promise<void>;
  // A test seam right after a poll took a flagged row's recheck.
  afterRecheckTake?(): Promise<void>;
  publishThrough(seq: number): Promise<boolean>;
  // Moves the journal lane to the settings recovery point, so every commit is published soon.
  journalDue(timers: TimerTable): void;
  directory: DirectoryDatabase;
  quota(): QuotaPort | undefined;
  // The structured send() request for these recipients from the send's frozen
  // inputs; null when they can no longer build it.
  buildRequest(record: SendRecord, recipients: number[]): Promise<SendRequest | null>;
  clockSkewMs: number;
  now(): number;
  sending: boolean;
};

type Ctx = { now: number; epoch: number; restoredAt: number; skew: number };
const rank = (state: string) => state === 'sent' ? 3 : state === 'suppressed' ? 2 : state === 'failed' ? 1 : 0;
const isTerminalRecipient = (state: LedgerRow['state']) => state === 'sent' || state === 'failed' || state === 'suppressed';
const metric = (name: string) => console.log({ metric: name });

// A send's state after release, loaded for one step and changed in memory;
// `event()` turns the changes into one journal event of absolute values.
class SendModel {
  readonly d: SendDispatchRow;
  state: 'queued' | 'sending' | 'delayed' | 'sent' | 'partial' | 'failed';
  terminal = false;
  private readonly rows: Map<number, LedgerRow>;
  private readonly fences: Map<string, SendFenceRow>;
  private readonly marks: Map<string, SendMarkRow>;
  private readonly releases: Map<string, SendFence>;
  private readonly changedRows = new Set<number>();
  private readonly changedFences = new Set<string>();
  private readonly changedMarks = new Set<string>();
  private readonly added = new Map<string, SendFence>();
  private readonly removed = new Map<string, SendFence>();
  private readonly loaded: string;

  constructor(sql: SqlStorage, readonly row: SendRow) {
    this.state = row.state as SendModel['state'];
    this.d = dispatchRow(sql, row.id);
    this.loaded = JSON.stringify(this.d);
    this.rows = new Map(ledger(sql, row.id).map(entry => [entry.idx, entry]));
    this.fences = new Map(fenceRows(sql, row.id).map(fence => [fenceKey(fence), fence]));
    this.marks = new Map(markRows(sql, row.id).map(mark => [`${fenceKey(mark)}:${mark.idx}`, mark]));
    this.releases = new Map(releaseList(sql, row.id).map(fence => [fenceKey(fence), fence]));
  }

  get finished(): boolean { return TERMINAL.includes(this.row.state) || this.row.finishPending; }
  recipient(idx: number): LedgerRow | undefined { return this.rows.get(idx); }
  externals(): LedgerRow[] { return [...this.rows.values()].filter(entry => entry.kind === 'external'); }
  openExternals(): LedgerRow[] { return this.externals().filter(entry => !isTerminalRecipient(entry.state)); }
  allTerminal(): boolean { return this.rows.size > 0 && [...this.rows.values()].every(entry => isTerminalRecipient(entry.state)); }
  fence(fence: SendFence): SendFenceRow | undefined { return this.fences.get(fenceKey(fence)); }
  markSet(fence: SendFence): SendMarkRow[] { return [...this.marks.values()].filter(mark => sameFence(mark, fence)); }
  releaseList(): SendFence[] { return [...this.releases.values()].sort((a, b) => fenceBefore(a, b) ? -1 : 1); }

  lease(): SendFence | null {
    const { leaseEpoch, leaseAttempt } = this.d;
    return leaseEpoch === null || leaseAttempt === null ? null : { epoch: leaseEpoch, attempt: leaseAttempt };
  }

  // The fence a recipient is attempting under: the newest marked fence whose Mark set holds it.
  attemptingFence(idx: number): SendFenceRow | undefined {
    let newest: SendFenceRow | undefined;
    for (const mark of this.marks.values()) {
      if (mark.idx !== idx) continue;
      const fence = this.fence(mark);
      if (fence?.marked && (!newest || fenceBefore(newest, fence))) newest = fence;
    }
    return newest;
  }

  setRecipient(idx: number, state: LedgerRow['state'], reason: string | null = null): void {
    const entry = this.rows.get(idx);
    if (!entry) throw new Error('Missing send ledger row');
    if (entry.state === state && entry.reason === reason) return;
    this.rows.set(idx, { ...entry, state, reason });
    this.changedRows.add(idx);
  }

  putFence(fence: SendFenceRow): void {
    this.fences.set(fenceKey(fence), fence);
    this.changedFences.add(fenceKey(fence));
  }

  putMark(mark: SendMarkRow): void {
    const key = `${fenceKey(mark)}:${mark.idx}`;
    this.marks.set(key, mark);
    this.changedMarks.add(key);
  }

  addRelease(fence: SendFence): void {
    const key = fenceKey(fence);
    if (this.releases.has(key)) return;
    const entry = { epoch: fence.epoch, attempt: fence.attempt };
    this.releases.set(key, entry);
    if (this.removed.delete(key)) return;
    this.added.set(key, entry);
  }

  removeRelease(fence: SendFence): void {
    const key = fenceKey(fence);
    const entry = this.releases.get(key);
    if (!entry) return;
    this.releases.delete(key);
    if (this.added.delete(key)) return;
    this.removed.set(key, entry);
  }

  endLease(): void { this.d.leaseEpoch = null; this.d.leaseAttempt = null; this.d.leaseUntil = null; }

  // `sent` if every recipient was sent, `failed` if none was, `partial` otherwise: a
  // suppressed recipient was accepted but not delivered (M3-9: the send is partial).
  finalState(): 'sent' | 'partial' | 'failed' {
    const sent = [...this.rows.values()].filter(entry => entry.state === 'sent').length;
    return sent === this.rows.size ? 'sent' : sent === 0 ? 'failed' : 'partial';
  }

  event(): Extract<JournalEvent, { type: 'send_progress' }> | null {
    if (JSON.stringify(this.d) === this.loaded && !this.terminal && this.state === this.row.state && !this.changedRows.size && !this.changedFences.size &&
        !this.changedMarks.size && !this.added.size && !this.removed.size) return null;
    const changes: SendLedgerChange[] = [...this.changedRows].sort((a, b) => a - b)
      .map(idx => { const { state, reason } = this.rows.get(idx)!; return { idx, state, reason }; });
    return {
      type: 'send_progress', id: this.row.id, state: this.state, ...(this.terminal && { terminal: true as const }), dispatch: { ...this.d },
      ...(changes.length && { recipients: changes }),
      ...(this.changedFences.size && { fences: [...this.changedFences].map(key => this.fences.get(key)!) }),
      ...(this.changedMarks.size && { marks: [...this.changedMarks].map(key => this.marks.get(key)!) }),
      ...(this.added.size && { releaseAdd: [...this.added.values()] }),
      ...(this.removed.size && { releaseRemove: [...this.removed.values()] }),
    };
  }
}

// A recipient that may have been sent: attempting under an authorized fence or one from an older recovery epoch.
function protectedFence(m: SendModel, idx: number, ctx: Ctx): SendFenceRow | undefined {
  if (m.recipient(idx)?.state !== 'attempting') return undefined;
  const fence = m.attemptingFence(idx);
  return fence && (fence.authorized || fence.epoch < ctx.epoch) ? fence : undefined;
}

// A lease counts as expired only clockSkew after its lease_until.
const leaseLive = (leaseUntil: number | null, ctx: Ctx) => leaseUntil !== null && ctx.now < leaseUntil + ctx.skew;

// Finish rule step 1: the terminal state with finish_pending, no lease, the drive row now.
function finish(m: SendModel, ctx: Ctx): number {
  endLease(m, ctx);
  m.state = m.finalState();
  m.terminal = true;
  return ctx.now;
}

// Ends the live lease; a never-authorized fence of this epoch goes on the release list.
function endLease(m: SendModel, ctx: Ctx): void {
  const lease = m.lease();
  if (!lease) return;
  const fence = m.fence(lease);
  if (fence && !fence.authorized && lease.epoch === ctx.epoch) m.addRelease(lease);
  m.endLease();
}

// The end of a protected recipient's hold: one lease period from the later of
// its lease expiry and the end of the latest restore.
const holdEnd = (fence: SendFenceRow, ctx: Ctx) => Math.max(fence.leaseUntil + ctx.skew, ctx.restoredAt) + LEASE_MS;

// The grace transition (section 2.4): unprotected open external recipients end
// failed now; protected ones are held one lease period from the later of their
// lease expiry and the end of the latest restore. Returns the drive time: the
// end of the hold, now to finish, or null to leave the drive row where it is.
function grace(m: SendModel, reason: SendFailure, ctx: Ctx): number | null {
  let holdUntil = 0;
  for (const entry of m.openExternals()) {
    const fence = protectedFence(m, entry.idx, ctx);
    if (fence) {
      holdUntil = Math.max(holdUntil, holdEnd(fence, ctx));
      continue;
    }
    const attempting = entry.state === 'attempting' ? m.attemptingFence(entry.idx) : undefined;
    if (attempting && !attempting.authorized && attempting.epoch === ctx.epoch) m.addRelease(attempting);
    m.setRecipient(entry.idx, 'failed', reason);
  }
  endLease(m, ctx);
  if (holdUntil) {
    m.d.graceUntil = holdUntil;
    m.d.graceReason = reason;
    return holdUntil;
  }
  return m.allTerminal() ? finish(m, ctx) : null;
}

// Applies a confirmed provider fact for one recipient: the best confirmed fact
// across its fences wins (sent over suppressed over any failure).
function confirm(m: SendModel, idx: number, outcome: 'sent' | 'suppressed'): boolean {
  const entry = m.recipient(idx);
  if (!entry || entry.kind !== 'external' || rank(outcome) <= rank(entry.state)) return false;
  m.setRecipient(idx, outcome, null);
  return true;
}

function refusalBackoff(refusals: number): number {
  return Math.min(REFUSAL_BACKOFF_MAX_MS, REFUSAL_BACKOFF_MS * 2 ** Math.min(refusals, 16));
}

export function checkResult(value: unknown): asserts value is ProviderResult {
  const result = (value ?? {}) as Record<string, unknown>;
  const code = validErrorCode;
  const valid = !!value && typeof value === 'object' && (
    (result.kind === 'accepted' && validProviderId(result.messageId ?? null) && (result.messageId === null || typeof result.messageId === 'string') &&
      (result.suppressed === undefined || (Array.isArray(result.suppressed) && result.suppressed.length <= 50 &&
        result.suppressed.every(idx => Number.isSafeInteger(idx) && idx >= 0 && idx < 50)))) ||
    (result.kind === 'rejected' && validReason(result.reason)) ||
    result.kind === 'try_later' ||
    (result.kind === 'outage' && code(result.code)) ||
    (result.kind === 'ambiguous' && (result.code === undefined || code(result.code))));
  if (!valid) throw new Error('Invalid provider result');
}

function checkRecipients(value: unknown): asserts value is number[] {
  if (!Array.isArray(value) || !value.length || value.length > 50 || new Set(value).size !== value.length ||
      !value.every(idx => Number.isSafeInteger(idx) && idx >= 0 && idx < 50)) throw new Error('Invalid send recipients');
}

export class SendDispatcher {
  constructor(private readonly ports: DispatchPorts) {}

  private ctx(ready: Ready): Ctx {
    return { now: this.ports.now(), epoch: ready.epoch, restoredAt: ready.restoredAt, skew: this.ports.clockSkewMs };
  }

  private load(id: string): SendModel | undefined {
    const row = validSendId(id) ? sendRow(this.ports.sql, id) : undefined;
    // Before release step 4 there is no ledger and nothing to dispatch.
    return row && row.queuedSeq !== null && row.state !== 'cancelled' ? new SendModel(this.ports.sql, row) : undefined;
  }

  // Commits the model's changes as one event and moves the drive row; returns the event's seq or 0.
  private commit(m: SendModel, ready: Ready, timers: TimerTable, driveAt: number | null, report = false): number {
    const event = m.event();
    if (event) {
      ready.index.commitEvents([event]);
      this.ports.journalDue(timers);
    }
    if (driveAt !== null) timers.set(SEND_DRIVE, m.row.id, Math.max(1, driveAt));
    // A report or a state change resets the drive backoff; a claim does not.
    if (report) this.ports.sql.exec('UPDATE mailbox_send_drivers SET backoff = 0 WHERE send_id = ?', m.row.id);
    return event ? ready.index.journal.revision() : 0;
  }

  private async readyFor(scope: DispatchScope): Promise<boolean> {
    return this.ports.ready(scope);
  }

  // The claim's gate, before and after its directory statement. Returns an answer, or null to go on.
  private gate(m: SendModel, ctx: Ctx, flushed: number): { answer: ClaimAnswer; driveAt?: number } | null {
    if (m.finished) return { answer: { status: 'refused' } };
    if (m.row.queuedSeq! > flushed) return { answer: { status: 'not_now', reason: 'unpublished' } };
    if (m.d.heldAt !== null) return { answer: { status: 'not_now', reason: 'held' } };
    if (m.d.graceUntil !== null) return { answer: { status: 'not_now', reason: 'grace' }, driveAt: m.d.graceUntil };
    if (m.lease() && leaseLive(m.d.leaseUntil, ctx)) return { answer: { status: 'not_now', reason: 'leased' }, driveAt: m.d.leaseUntil! + ctx.skew };
    let live = 0;
    for (const entry of m.externals()) {
      if (entry.state !== 'attempting') continue;
      const fence = m.attemptingFence(entry.idx);
      if (fence && leaseLive(fence.leaseUntil, ctx)) live = Math.max(live, fence.leaseUntil + ctx.skew);
    }
    if (live) return { answer: { status: 'not_now', reason: 'leased' }, driveAt: live };
    if (!m.externals().some(entry => entry.state === 'pending' || entry.state === 'attempting')) return { answer: { status: 'refused' } };
    if (m.state === 'delayed' && m.d.delayedUntil !== null && ctx.now < m.d.delayedUntil) {
      return { answer: { status: 'not_now', reason: 'delayed' }, driveAt: m.d.delayedUntil };
    }
    if (ctx.now < m.d.nextAttemptAt) return { answer: { status: 'not_now', reason: 'backoff' }, driveAt: m.d.nextAttemptAt };
    return null;
  }

  // Consumer step 1.
  async claim(scope: DispatchScope, id: string): Promise<ClaimAnswer> {
    const { ports } = this;
    if (!ports.sending) return { status: 'not_now', reason: 'disabled' };
    if (!await this.readyFor(scope)) return { status: 'not_now', reason: 'restoring' };
    const step = (timers: TimerTable, sender?: boolean): ClaimAnswer | { check: SendRow; mayHaveRun: boolean } | { drain: SendFence[] } => {
      const ready = ports.current();
      if (!ready) return { status: 'not_now', reason: 'restoring' };
      const row = validSendId(id) ? sendRow(ports.sql, id) : undefined;
      if (!row) return { status: 'gone' };
      if (TERMINAL.includes(row.state) || row.finishPending) return { status: 'refused' };
      const m = this.load(id);
      // Before release step 4 commits there is nothing to claim yet; the drive row enqueues after it.
      if (!m) return { status: 'not_now', reason: 'unpublished' };
      const ctx = this.ctx(ready);
      const gated = this.gate(m, ctx, ready.index.journal.flushed());
      if (gated) {
        if (gated.driveAt !== undefined) timers.set(SEND_DRIVE, id, Math.max(1, gated.driveAt));
        return gated.answer;
      }
      if (sender === undefined) {
        // A stored acceptance for a recipient whose call may have run is recorded before it is reclaimed.
        const mayHaveRun = m.externals().some(entry => entry.state === 'attempting' && !!protectedFence(m, entry.idx, ctx));
        return { check: m.row, mayHaveRun };
      }
      // The caps and the deadline, normally applied when the result is recorded.
      if (m.d.ambiguous >= AMBIGUOUS_CAP || m.d.providerWait >= DEADLINE_MS) {
        this.commit(m, ready, timers, grace(m, 'delivery_error', ctx), true);
        return { status: 'refused' };
      }
      if (!sender) {
        this.commit(m, ready, timers, grace(m, 'invalid_sender', ctx), true);
        return { status: 'refused' };
      }
      const expired = m.externals().filter(entry => entry.state === 'attempting');
      // Crash-loop cap: a fence whose lease expired with recipients attempting and no report.
      const unfinished = new Set(expired.map(entry => m.attemptingFence(entry.idx)).filter(fence => fence && fence.outcome === null)
        .map(fence => fenceKey(fence!)));
      m.d.unfinished += unfinished.size;
      if (m.d.unfinished >= CRASH_CAP) {
        // Held, not resumed: charges of never-authorized fences of this epoch still go (the drive row releases them).
        for (const entry of expired) {
          const fence = m.attemptingFence(entry.idx);
          if (fence && !fence.authorized && fence.epoch === ctx.epoch) m.addRelease(fence);
        }
        endLease(m, ctx);
        m.d.heldAt = ctx.now;
        console.error({ code: 'send_held' });
        this.commit(m, ready, timers, ctx.now + HOLD_RECHECK_MS);
        return { status: 'not_now', reason: 'held' };
      }
      for (const entry of expired) {
        const fence = m.attemptingFence(entry.idx);
        // A call may have run: an ambiguous event of our own, never counted toward the cap.
        if (fence && (fence.authorized || fence.epoch < ctx.epoch)) metric('send_ambiguous_retry');
        // send() cannot have run: its reservations go.
        else if (fence) m.addRelease(fence);
        m.setRecipient(entry.idx, 'pending');
      }
      endLease(m, ctx);
      // No reservation under a new fence while a never-authorized charge remains
      // (section 2.4, step 2): a list longer than one page is drained first.
      if (m.releaseList().length > RELEASE_BATCH) {
        this.commit(m, ready, timers, null);
        return { drain: m.releaseList().slice(0, RELEASE_BATCH) };
      }
      const fence = { epoch: ctx.epoch, attempt: m.d.attempt + 1 };
      if (m.fence(fence)) throw new Error('Send fence reused');
      const leaseUntil = ctx.now + LEASE_MS;
      m.putFence({ ...fence, leaseUntil, marked: false, authorized: false, outcome: null });
      Object.assign(m.d, { attempt: fence.attempt, leaseEpoch: fence.epoch, leaseAttempt: fence.attempt, leaseUntil, delayedUntil: null });
      m.state = 'sending';
      this.commit(m, ready, timers, leaseUntil + ctx.skew);
      const record = m.row.record;
      const sentCopy = ports.sql.exec<{ key: string }>('SELECT raw_key AS key FROM messages WHERE id = ?', sentCopyId(id)).toArray()[0];
      return {
        status: 'claimed', fence, leaseUntil, release: m.releaseList(),
        recipients: m.externals().filter(entry => entry.state === 'pending').map(({ idx }) => ({ idx, ...record.recipients[idx] })),
        from: record.from, replyTo: record.replyTo, sentCopyKey: sentCopy?.key ?? null,
      };
    };
    const first = await ports.local(timers => step(timers));
    if ('drain' in first) throw new Error('Unexpected send release page');
    if (!('check' in first)) return first;
    if (first.mayHaveRun && !(await this.storedSettled(scope, id)).settled) return { status: 'not_now', reason: 'results' };
    const { record } = first.check;
    // The one directory statement of section 1, on every claim.
    const sender = await senderActive(ports.directory, { ...scope, ownerUserId: record.ownerUserId, from: record.from.email });
    // The mailbox drains a release list longer than one page itself: each page
    // leaves the list only after the quota object released it.
    for (let page = 0; page < 4; page++) {
      const answer = await ports.local(timers => step(timers, sender));
      if ('check' in answer) return { status: 'not_now', reason: 'restoring' };
      if (!('drain' in answer)) return answer;
      if (!await this.releaseAndUnlist(scope, id, answer.drain)) return { status: 'not_now', reason: 'release' };
    }
    return { status: 'not_now', reason: 'release' };
  }

  // Releases these listed fences in one quota call, then takes them off the list. False if the call failed.
  private async releaseAndUnlist(scope: DispatchScope, id: string, fences: SendFence[]): Promise<boolean> {
    try {
      const quota = this.ports.quota();
      if (!quota) throw new Error('Send quota binding missing');
      await quota.release({ ...scope, sendId: id }, fences);
    } catch (error) {
      console.error({ code: 'send_quota_release', error: error instanceof Error ? error.message : String(error) });
      return false;
    }
    await this.ports.afterClaimRelease?.();
    await this.ports.local(timers => {
      const ready = this.ports.current();
      const row = validSendId(id) ? sendRow(this.ports.sql, id) : undefined;
      if (!ready || !row || row.queuedSeq === null || row.state === 'cancelled') return;
      const m = new SendModel(this.ports.sql, row);
      for (const fence of fences) m.removeRelease(fence);
      this.commit(m, ready, timers, null);
    });
    return true;
  }

  // Consumer step 3: Mark, then the barrier, then the re-check.
  async mark(scope: DispatchScope, id: string, fence: SendFence, recipients: number[], released: SendFence[]): Promise<MarkAnswer> {
    const { ports } = this;
    if (!validFence(fence) || !Array.isArray(released) || released.length > RELEASE_BATCH || !released.every(validFence)) throw new Error('Invalid send mark');
    checkRecipients(recipients);
    if (!await this.readyFor(scope)) return { status: 'stale' };
    const seq = await ports.local(timers => {
      const ready = ports.current();
      const m = ready && this.load(id);
      if (!ready || !m) return 0;
      const ctx = this.ctx(ready);
      const current = m.fence(fence);
      if (m.finished || fence.epoch !== ctx.epoch || !sameFence(m.lease(), fence) || ctx.now >= m.d.leaseUntil! || !current ||
          current.marked || !recipients.every(idx => m.recipient(idx)?.kind === 'external' && m.recipient(idx)?.state === 'pending')) return 0;
      const leaseUntil = ctx.now + LEASE_MS;
      for (const idx of recipients) {
        m.setRecipient(idx, 'attempting');
        m.putMark({ ...fence, idx, outcome: null, providerId: null });
      }
      m.putFence({ ...current, marked: true, leaseUntil });
      m.d.leaseUntil = leaseUntil;
      // Only the fences the consumer's quota call released leave the list.
      for (const entry of released) m.removeRelease(entry);
      return this.commit(m, ready, timers, leaseUntil + ctx.skew);
    });
    if (!seq) return { status: 'stale' };
    const published = await ports.publishThrough(seq);
    return ports.local(timers => {
      const ready = ports.current();
      const m = ready && this.load(id);
      if (!ready || !m) return { status: 'stale' };
      const ctx = this.ctx(ready);
      const current = !m.finished && fence.epoch === ctx.epoch && sameFence(m.lease(), fence);
      if (published && current && ctx.now < m.d.leaseUntil!) return { status: 'ok' };
      // send() was never called under this fence: its recipients return to pending.
      if (current && !m.fence(fence)?.authorized) {
        for (const { idx } of m.markSet(fence)) if (m.recipient(idx)?.state === 'attempting' && sameFence(m.attemptingFence(idx), fence)) m.setRecipient(idx, 'pending');
        this.commit(m, ready, timers, null);
      }
      return { status: 'stale' };
    });
  }

  // Consumer step 3a's request: the structured send() request for the fence's
  // Mark set, built from the send's frozen inputs (never from the sent copy).
  // The fence rules are Mark's: only the current, live, marked lease of a send
  // that is not finished gets a request. It records nothing; authorizeDispatch
  // checks everything again.
  async request(scope: DispatchScope, id: string, fence: SendFence): Promise<RequestAnswer> {
    const { ports } = this;
    if (!validFence(fence)) throw new Error('Invalid send request');
    if (!ports.sending || !await this.readyFor(scope)) return { status: 'stale' };
    const claimed = await ports.local(() => {
      const ready = ports.current();
      const m = ready && this.load(id);
      if (!ready || !m) return null;
      const ctx = this.ctx(ready);
      const row = m.fence(fence);
      if (m.finished || fence.epoch !== ctx.epoch || !sameFence(m.lease(), fence) || ctx.now >= m.d.leaseUntil! || !row?.marked) return null;
      const recipients = m.markSet(fence).map(mark => mark.idx)
        .filter(idx => m.recipient(idx)?.state === 'attempting' && sameFence(m.attemptingFence(idx), fence));
      return recipients.length ? { record: m.row.record, recipients } : null;
    });
    if (!claimed) return { status: 'stale' };
    const request = await ports.buildRequest(claimed.record, claimed.recipients);
    if (request) return { status: 'ok', request };
    console.error({ code: 'send_request_invalid' });
    return { status: 'invalid' };
  }

  // Consumer step 4: at most one authorization per fence. `quotaDayEnd` is the
  // end of the quota day the consumer's charge is confirmed in, as `confirm` returned it.
  async authorize(scope: DispatchScope, id: string, fence: SendFence, recipients: number[], quotaDayEnd: number): Promise<AuthorizeAnswer> {
    const { ports } = this;
    if (!validFence(fence) || !Number.isSafeInteger(quotaDayEnd) || quotaDayEnd < 0) throw new Error('Invalid send authorization');
    checkRecipients(recipients);
    if (!ports.sending || !await this.readyFor(scope)) return { status: 'stale' };
    // The directory statement runs inside the work lane and is the last await
    // before the synchronous grant, so no state it checked can change in between.
    return ports.exclusive(async () => {
      const record = this.load(id)?.row.record;
      if (!record) return null;
      await ports.senderCheckpoint?.('before');
      const active = await senderActive(ports.directory, { ...scope, ownerUserId: record.ownerUserId, from: record.from.email });
      await ports.senderCheckpoint?.('after');
      return active;
    }, (timers, sender): AuthorizeAnswer => {
      const ready = ports.current();
      const m = ready && this.load(id);
      if (!ready || !m || sender === null) return { status: 'stale' };
      const ctx = this.ctx(ready);
      const row = m.fence(fence);
      if (!row) return { status: 'stale' };
      const current = !m.finished && fence.epoch === ctx.epoch && sameFence(m.lease(), fence);
      const stale = (): AuthorizeAnswer => {
        // With the current fence and no authorization, send() cannot have run.
        if (current && !row.authorized) {
          for (const { idx } of m.markSet(fence)) if (m.recipient(idx)?.state === 'attempting' && sameFence(m.attemptingFence(idx), fence)) m.setRecipient(idx, 'pending');
          this.commit(m, ready, timers, null);
        }
        return { status: 'stale' };
      };
      if (!current || !row.marked || row.authorized || ctx.now >= m.d.leaseUntil!) return stale();
      const marked = new Set(m.markSet(fence).map(mark => mark.idx));
      if (recipients.length !== marked.size || !recipients.every(idx => marked.has(idx) && m.recipient(idx)?.state === 'attempting')) return stale();
      if (!sender) {
        this.commit(m, ready, timers, grace(m, 'invalid_sender', ctx), true);
        return { status: 'stale' };
      }
      if (m.d.leaseUntil! - ctx.now < DISPATCH_WINDOW_MS + ctx.skew) return stale();
      // The quota object's clock and the consumer's backward step can each differ by clockSkew.
      if (quotaDayEnd - ctx.now < DISPATCH_WINDOW_MS + 2 * ctx.skew) return { status: 'quota_window', retryAfter: quotaDayEnd + ctx.skew };
      m.putFence({ ...row, authorized: true });
      this.commit(m, ready, timers, null);
      return { status: 'ok', remainingMs: DISPATCH_WINDOW_MS };
    });
  }

  // Consumer step 6. Idempotent per fence; answers once a publish covers the outcome.
  async record(scope: DispatchScope, id: string, fence: SendFence, result: ProviderResult): Promise<ReportAnswer> {
    const { ports } = this;
    if (!validFence(fence)) throw new Error('Invalid send fence');
    checkResult(result);
    if (!await this.readyFor(scope)) return { status: 'restoring' };
    await ports.beforeRecord?.(fence);
    const outcome = await ports.local((timers): ReportAnswer | { seq: number; refused?: true } => {
      const ready = ports.current();
      if (!ready) return { status: 'restoring' };
      const m = this.load(id);
      if (!m) return validSendId(id) && sendRow(ports.sql, id) ? { status: 'stale' } : { status: 'gone' };
      const ctx = this.ctx(ready);
      const row = m.fence(fence);
      // An unknown fence never had a published Mark set here.
      if (!row) return { status: 'stale' };
      // Idempotent per fact: a repeat changes nothing and waits for the publish
      // that covers it, but a confirmed acceptance always upgrades an earlier
      // non-accepted outcome of the same fence (a late confirmation).
      if (row.outcome !== null && (result.kind !== 'accepted' || row.outcome === 'accepted')) return { seq: ready.index.journal.revision() };
      const current = row.outcome === null && !m.finished && fence.epoch === ctx.epoch && sameFence(m.lease(), fence);
      if (!current) return this.recordStale(m, ready, timers, row, result, ctx);
      // A provider result needs a call, and a call needs the fence's authorization.
      if (!row.authorized) return { status: 'stale' };
      const attempting = m.markSet(fence).map(mark => mark.idx)
        .filter(idx => m.recipient(idx)?.state === 'attempting' && sameFence(m.attemptingFence(idx), fence));
      let next: number | null = null;
      let refused = false;
      switch (result.kind) {
        case 'accepted': {
          const suppressed = new Set(result.suppressed ?? []);
          for (const mark of m.markSet(fence)) {
            const outcome = suppressed.has(mark.idx) ? 'suppressed' : 'sent';
            m.putMark({ ...mark, outcome, providerId: outcome === 'sent' ? result.messageId : null });
            confirm(m, mark.idx, outcome);
          }
          m.d.refusals = m.d.outages = 0;
          break;
        }
        case 'rejected':
          for (const idx of attempting) {
            m.setRecipient(idx, 'failed', result.reason);
            m.putMark({ ...fence, idx, outcome: 'failed', providerId: null });
          }
          // The provider refused the call: its charge goes.
          m.addRelease(fence);
          m.d.refusals = m.d.outages = 0;
          break;
        case 'try_later':
        case 'outage': {
          for (const idx of attempting) m.setRecipient(idx, 'pending');
          // Each kind backs off on its own counter, from 1 minute doubling to 1 hour.
          const wait = refusalBackoff(result.kind === 'try_later' ? m.d.refusals++ : m.d.outages++);
          next = m.d.nextAttemptAt = ctx.now + wait;
          // Only time the provider caused counts toward the deadline; our outages never do.
          if (result.kind === 'try_later') m.d.providerWait += wait;
          else console.error({ code: 'send_outage', provider: result.code });
          // Refused by the provider, in the same commit: the release survives a failed quota call.
          m.addRelease(fence);
          refused = true;
          break;
        }
        case 'ambiguous':
          for (const idx of attempting) m.setRecipient(idx, 'pending');
          m.d.ambiguous++;
          next = m.d.nextAttemptAt = ctx.now + AMBIGUOUS_BACKOFF_MS;
          m.d.providerWait += AMBIGUOUS_BACKOFF_MS;
          m.d.refusals = m.d.outages = 0;
          metric('send_ambiguous_retry');
          if (result.code !== undefined && result.code !== 'timeout') console.error({ code: 'send_unknown_error', provider: result.code });
          break;
      }
      m.putFence({ ...row, outcome: result.kind });
      m.endLease();
      m.d.unfinished = 0;
      let driveAt = next ?? ctx.now;
      if (m.d.ambiguous >= AMBIGUOUS_CAP || m.d.providerWait >= DEADLINE_MS) {
        console.error({ code: m.d.ambiguous >= AMBIGUOUS_CAP ? 'send_ambiguous_cap' : 'send_deadline' });
        driveAt = grace(m, 'delivery_error', ctx) ?? ctx.now;
      } else if (m.allTerminal()) driveAt = finish(m, ctx);
      return { seq: this.commit(m, ready, timers, driveAt, true) || ready.index.journal.revision(), ...(refused && { refused: true as const }) };
    });
    if ('status' in outcome) return outcome;
    if (outcome.refused) await this.releaseNow(scope, id, fence);
    return await ports.publishThrough(outcome.seq) ? { status: 'recorded' } : { status: 'unpublished' };
  }

  // A stale fence records only confirmed provider facts, for recipients its
  // published Mark set held, and only if a call can have run under it.
  private recordStale(m: SendModel, ready: Ready, timers: TimerTable, row: SendFenceRow, result: ProviderResult, ctx: Ctx): ReportAnswer | { seq: number } {
    if (result.kind !== 'accepted' || !(row.authorized || row.epoch < ctx.epoch)) return { status: 'stale' };
    const suppressed = new Set(result.suppressed ?? []);
    let late = false;
    for (const mark of m.markSet(row)) {
      const outcome = suppressed.has(mark.idx) ? 'suppressed' : 'sent';
      m.putMark({ ...mark, outcome, providerId: outcome === 'sent' ? result.messageId : null });
      const before = m.recipient(mark.idx)?.state;
      if (confirm(m, mark.idx, outcome) && before === 'failed') late = true;
    }
    m.putFence({ ...row, outcome: 'accepted' });
    let driveAt: number | null = null;
    if (m.finished) {
      // A late confirmation: only the recipient's row and the reported state change.
      if (TERMINAL.includes(m.row.state)) m.state = m.finalState();
    } else if (m.allTerminal()) driveAt = finish(m, ctx);
    if (late) metric('send_late_confirmation');
    return { seq: this.commit(m, ready, timers, driveAt) || ready.index.journal.revision() };
  }

  // A quota wait. `gate`: our own gate refused the reservation, and `resetAt`
  // is the reset of the gate that refused it (daily or monthly), as the quota
  // port answered. `provider_daily`: the provider's daily-limit error, which
  // waits for the quota day's end. The mailbox adds clockSkew; the consumer
  // never computes a reset.
  async delay(scope: DispatchScope, id: string, fence: SendFence, cause: 'gate' | 'provider_daily', resetAt?: number): Promise<DelayAnswer> {
    const { ports } = this;
    if (!validFence(fence) || (cause !== 'gate' && cause !== 'provider_daily') || (cause === 'gate') !== (resetAt !== undefined) ||
        (resetAt !== undefined && !Number.isSafeInteger(resetAt))) throw new Error('Invalid send delay');
    if (cause === 'gate') {
      const now = ports.now();
      if (resetAt! <= now || resetAt! > now + GATE_RESET_MAX_MS) throw new Error('Invalid quota reset');
    }
    if (!await this.readyFor(scope)) return { status: 'restoring' };
    let reset = resetAt;
    if (reset === undefined) {
      const quota = ports.quota();
      if (!quota) throw new Error('Send quota binding missing');
      reset = await quota.resetAt();
    }
    const until = reset + ports.clockSkewMs;
    const answer = await ports.local(timers => this.report(id, fence, timers, (m, ctx) => {
      m.state = 'delayed';
      m.d.delayedUntil = Math.max(until, ctx.now);
      return { outcome: 'delayed', driveAt: m.d.delayedUntil };
    }));
    if (answer.status !== 'done') return answer.status === 'ok' ? { status: 'stale' } : { status: answer.status };
    await this.releaseNow(scope, id, fence);
    return { status: 'delayed', until: answer.at };
  }

  // Errors before send(): never counted.
  async abandon(scope: DispatchScope, id: string, fence: SendFence, retryAt: number): Promise<AbandonAnswer> {
    const { ports } = this;
    if (!validFence(fence) || !Number.isSafeInteger(retryAt)) throw new Error('Invalid send abandon');
    if (!await this.readyFor(scope)) return { status: 'restoring' };
    const answer = await ports.local(timers => this.report(id, fence, timers, (m, ctx) => {
      const next = Math.min(ctx.now + ABANDON_MAX_MS, Math.max(ctx.now + ABANDON_MIN_MS, retryAt));
      m.d.nextAttemptAt = next;
      return { outcome: 'abandoned', driveAt: next };
    }));
    if (answer.status !== 'done') return answer;
    await this.releaseNow(scope, id, fence);
    return { status: 'ok' };
  }

  // delaySend and abandonClaim: only the current fence changes anything. Its
  // recipients return to pending, the lease ends, and its charge is released.
  private report(id: string, fence: SendFence, timers: TimerTable,
    change: (m: SendModel, ctx: Ctx) => { outcome: SendFenceOutcome; driveAt: number }): { status: 'done'; at: number } | AbandonAnswer {
    const ready = this.ports.current();
    if (!ready) return { status: 'restoring' };
    const m = this.load(id);
    if (!m) return validSendId(id) && sendRow(this.ports.sql, id) ? { status: 'stale' } : { status: 'gone' };
    const ctx = this.ctx(ready);
    const row = m.fence(fence);
    if (m.finished || fence.epoch !== ctx.epoch || !sameFence(m.lease(), fence) || !row || row.outcome !== null) return { status: 'stale' };
    for (const { idx } of m.markSet(fence)) if (m.recipient(idx)?.state === 'attempting' && sameFence(m.attemptingFence(idx), fence)) m.setRecipient(idx, 'pending');
    const { outcome, driveAt } = change(m, ctx);
    m.putFence({ ...row, outcome });
    m.addRelease(fence);
    m.endLease();
    m.d.unfinished = 0;
    this.commit(m, ready, timers, driveAt, true);
    return { status: 'done', at: driveAt };
  }

  // The immediate release of a refused charge. Once the quota object has
  // released the fence it leaves the release list; a failure leaves it there,
  // for the next consumer's quota call or finish to drain.
  private async releaseNow(scope: DispatchScope, id: string, fence: SendFence): Promise<void> {
    await this.releaseAndUnlist(scope, id, [fence]);
  }

  // Settled once no stored result of this send is left unrecorded; a failed
  // lookup is not settled. `next`: when the earliest remaining row is due.
  async storedSettled(scope: DispatchScope, id: string): Promise<{ settled: boolean; next: number | null }> {
    try {
      const { status, next } = await this.recordStored(scope, id);
      return { settled: status === 'none' || status === 'recorded', next: next ?? null };
    } catch (error) {
      console.error({ code: 'send_result_lookup', error: error instanceof Error ? error.message : String(error) });
      return { settled: false, next: null };
    }
  }

  // Records the stored results of one send (section 2.4, step 6): a point
  // lookup in send_results, each row recorded under its fence and deleted only
  // after the publish covering it. The scope is checked before any statement.
  // With `fence` (a result notice): that row only, whatever its notify_after.
  // Without (the drive row, a claim, the reconciler): the due rows first, so a
  // backed-off prefix never starves later rows. Rows marked unapplied (an
  // acceptance that cannot be recorded) are left to notices and the reconciler
  // and never hold up dispatch.
  async recordStored(scope: DispatchScope, id: string, fence?: SendFence): Promise<StoredAnswer> {
    const { ports } = this;
    if (!validSendId(id) || (fence !== undefined && !validFence(fence))) throw new Error('Invalid send result lookup');
    const ready = await this.readyFor(scope);
    const epoch = ready ? ports.current()?.epoch ?? null : null;
    const db = ports.directory.withSession('first-primary');
    const columns = `fence_epoch AS epoch, fence_attempt AS attempt, kind, message_id AS messageId, detail, suppressed,
      notify_failures AS failures, unapplied, rechecked_epoch AS rechecked`;
    const sendKey = 'workspace_id = ? AND mailbox_id = ? AND send_id = ?';
    let results: StoredRow[];
    if (fence) {
      results = (await db.prepare(`SELECT ${columns} FROM send_results WHERE ${sendKey} AND fence_epoch = ? AND fence_attempt = ?`)
        .bind(scope.workspaceId, scope.mailboxId, id, fence.epoch, fence.attempt).all<StoredRow>()).results;
    } else {
      // Flagged acceptances from an older recovery epoch first: a restore may have made them apply.
      // Each is rechecked at once once per epoch; after that it honors notify_after like any row.
      // The page holds only rows this poll can take (the take's own condition): rows another attempt
      // holds a live lease on are left out, so they cannot fill the page ahead of a runnable row.
      const flagged = epoch === null ? [] : (await db.prepare(`SELECT ${columns} FROM send_results WHERE ${sendKey} AND unapplied = 1
        AND unapplied_epoch < ? AND (rechecked_epoch IS NULL OR rechecked_epoch < ?
          OR (notify_after <= ? AND (recheck_lease_until IS NULL OR recheck_lease_until <= ?)))
        ORDER BY notify_after, unapplied_epoch, rechecked_epoch, fence_epoch, fence_attempt LIMIT ?`)
        .bind(scope.workspaceId, scope.mailboxId, id, epoch, epoch, ports.now(), ports.now(), STORED_PAGE).all<StoredRow>()).results;
      const due = (await db.prepare(`SELECT ${columns} FROM send_results WHERE ${sendKey} AND unapplied = 0 AND notify_after <= ?
        ORDER BY notify_after, fence_epoch, fence_attempt LIMIT ?`).bind(scope.workspaceId, scope.mailboxId, id, ports.now(), STORED_PAGE)
        .all<StoredRow>()).results;
      results = [...flagged, ...due];
      await ports.afterStoredSelect?.();
    }
    // Whether a row that can apply is left, and when the earliest is due: one page is never taken for all of them.
    // A flagged row from an older epoch counts until it is evaluated in this epoch: due at once before its
    // first recheck, then at its backoff. Each lookup is an indexed seek (send_results_send, send_results_flagged).
    const remaining = async (): Promise<number | null> => {
      const next = (await db.prepare(`SELECT min(notify_after) AS next FROM send_results WHERE ${sendKey} AND unapplied = 0`)
        .bind(scope.workspaceId, scope.mailboxId, id).first<{ next: number | null }>())?.next ?? null;
      if (epoch === null) return next;
      const unchecked = (await db.prepare(`SELECT EXISTS (SELECT 1 FROM send_results WHERE ${sendKey} AND unapplied = 1 AND unapplied_epoch < ?
        AND (rechecked_epoch IS NULL OR rechecked_epoch < ?)) AS found`).bind(scope.workspaceId, scope.mailboxId, id, epoch, epoch)
        .first<{ found: number }>())?.found;
      // The earliest effective time over the send's flagged rows: each is due at its notify_after, but
      // not before an attempt's lease on it ends. One aggregate over that send's flagged rows only.
      const flagged = unchecked ? ports.now() : (await db.prepare(`SELECT min(max(notify_after, coalesce(recheck_lease_until, 0))) AS at
        FROM send_results WHERE ${sendKey} AND unapplied = 1 AND unapplied_epoch < ?`).bind(scope.workspaceId, scope.mailboxId, id, epoch)
        .first<{ at: number | null }>())?.at ?? null;
      const times = [next, flagged].filter((at): at is number => typeof at === 'number');
      return times.length ? Math.min(...times) : null;
    };
    // A notice's answer is about its own row only; a row already gone also clears its alerts.
    if (fence && !results.length && ready) {
      await this.resultAlerts(id, { epoch: fence.epoch, attempt: fence.attempt } as StoredRow, [], ['unapplied', 'stuck']);
    }
    if (!results.length) {
      const next = fence ? null : await remaining();
      return next === null ? { status: 'none', recorded: 0 } : { status: 'retry', recorded: 0, next };
    }
    const where = `${sendKey} AND fence_epoch = ? AND fence_attempt = ?`;
    const keys = (row: StoredRow) => [scope.workspaceId, scope.mailboxId, id, row.epoch, row.attempt];
    // A restoring mailbox defers every selected row past the restore's next slice; nothing is re-enqueued here.
    const defer = async (rows: StoredRow[]) => {
      const at = ports.now() + RESTORING_NOTICE_MS;
      for (const row of rows) await db.prepare(`UPDATE send_results SET notify_after = max(notify_after, ?) WHERE ${where}`).bind(at, ...keys(row)).run();
    };
    if (!ready) {
      await defer(results);
      return { status: 'restoring', recorded: 0 };
    }
    let recorded = 0;
    let backoff: number | null = null;
    for (const [at, row] of results.entries()) {
      // A flagged row's recheck is taken by one attempt at a time: the conditional update marks this
      // epoch's immediate recheck as used and holds an in-flight lease (recheck_lease_until), so a
      // concurrent attempt skips the row, and a crash leaves it retryable once the lease runs out.
      // The lease is separate from notify_after, which stays the reconciler's schedule: a keyed
      // notice is refused only while another attempt holds a live lease. A poll also needs the row
      // still due, so a poll whose read went stale (another attempt ended and backed it off) skips it.
      // The lease this attempt holds (null when it took none): its outcome is fenced by it.
      let lease: number | null = null;
      if (row.unapplied && epoch !== null) {
        const now = ports.now();
        const due = fence ? '' : 'AND notify_after <= ?';
        const taken = await db.prepare(`UPDATE send_results SET rechecked_epoch = ?, recheck_lease_until = ? WHERE ${where} AND unapplied = 1
          AND (rechecked_epoch IS NULL OR rechecked_epoch < ? OR ((recheck_lease_until IS NULL OR recheck_lease_until <= ?) ${due})) RETURNING 1`)
          .bind(epoch, now + RECHECK_LEASE_MS, ...keys(row), epoch, now, ...(fence ? [] : [now])).first();
        if (!taken) {
          // Another attempt holds this row's recheck and may still fail: retry once its lease ends.
          const held = await db.prepare(`SELECT recheck_lease_until AS at FROM send_results WHERE ${where}`).bind(...keys(row)).first<{ at: number | null }>();
          if (held?.at != null) backoff = backoff === null ? held.at : Math.min(backoff, held.at);
          continue;
        }
        lease = now + RECHECK_LEASE_MS;
        await ports.afterRecheckTake?.();
      }
      let answer: ReportAnswer['status'] | 'error';
      try { answer = (await this.record(scope, id, { epoch: row.epoch, attempt: row.attempt }, storedResult(row))).status; }
      catch (error) {
        console.error({ code: 'send_result_record', error: error instanceof Error ? error.message : String(error) });
        answer = 'error';
      }
      if (answer === 'restoring') {
        await defer(results.slice(at));
        return { status: 'restoring', recorded };
      }
      const wait = Math.min(NOTICE_BACKOFF_MAX_MS, NOTICE_BACKOFF_MS * 2 ** Math.min(row.failures, 16));
      if (answer === 'stale' && row.kind === 'accepted') {
        // Definitive: an acceptance that cannot be recorded in this epoch. It is kept, flagged with the
        // epoch, and alerted; it no longer holds up dispatch until the epoch advances.
        console.error({ code: 'send_result_unapplied' });
        // A fact, so it is written also by an attempt whose lease expired; it clears only its own lease.
        await db.prepare(`UPDATE send_results SET notify_after = ?, notify_failures = notify_failures + 1, unapplied = 1, unapplied_epoch = ?,
          recheck_lease_until = CASE WHEN recheck_lease_until IS ? THEN NULL ELSE recheck_lease_until END
          WHERE ${where}`).bind(ports.now() + wait, epoch, lease, ...keys(row)).run();
        backoff = ports.now() + wait;
        await this.resultAlerts(id, row, ['unapplied'], ['stuck']);
      } else if (answer === 'recorded' || answer === 'stale' || answer === 'gone') {
        // Definitive: recorded and published, a result that can never apply, or no such send.
        if (answer === 'gone') metric('send_result_orphan');
        // The alert goes first: a crash after the delete cannot leave it active.
        await this.resultAlerts(id, row, [], ['unapplied', 'stuck']);
        await db.prepare(`DELETE FROM send_results WHERE ${where}`).bind(...keys(row)).run();
        await ports.afterResultDelete?.();
        recorded++;
      } else {
        // Transient (an error, or not yet published): the row backs off, doubling from 1 minute
        // to 1 hour, and keeps its flag; the rest of the page goes on. A row that keeps failing
        // raises an alert: an applicable one, or a flagged one a restore made eligible (a row
        // flagged in this epoch answers stale, never a transient failure).
        // Schedule, not fact: fenced by this attempt's lease, so an attempt whose lease expired and
        // was taken over writes nothing, and its successor's lease and retry state stand.
        const written = await db.prepare(`UPDATE send_results SET notify_after = ?, notify_failures = notify_failures + 1,
          recheck_lease_until = NULL WHERE ${where} AND recheck_lease_until IS ? RETURNING notify_after AS at`)
          .bind(ports.now() + wait, ...keys(row), lease).first<{ at: number }>();
        if (!written) {
          // A successor holds the row now: the answer points at its lease or backoff.
          const held = await db.prepare(`SELECT max(notify_after, coalesce(recheck_lease_until, 0)) AS at FROM send_results WHERE ${where}`)
            .bind(...keys(row)).first<{ at: number }>();
          if (held) backoff = backoff === null ? held.at : Math.min(backoff, held.at);
          continue;
        }
        backoff = written.at;
        if (row.failures + 1 >= STUCK_FAILURES) await this.resultAlerts(id, row, ['stuck'], []);
      }
    }
    if (fence) return backoff === null ? { status: 'recorded', recorded } : { status: 'retry', recorded, next: backoff };
    const next = await remaining();
    return next === null ? { status: 'recorded', recorded } : { status: 'retry', recorded, next };
  }

  // Mailbox alerts for stored results, as local state: `unapplied`, an
  // acceptance that cannot be recorded (an invariant breach); `stuck`, an
  // applicable row that keeps failing. Changed only on definitive answers
  // (and `stuck` at its threshold).
  private async resultAlerts(id: string, row: StoredRow, set: ('unapplied' | 'stuck')[], clear: ('unapplied' | 'stuck')[]): Promise<void> {
    await this.ports.local(timers => {
      let changed = false;
      for (const code of clear) {
        changed = this.ports.sql.exec('DELETE FROM mailbox_send_result_alerts WHERE send_id = ? AND epoch = ? AND attempt = ? AND code = ? RETURNING 1',
          id, row.epoch, row.attempt, code).toArray().length > 0 || changed;
      }
      for (const code of set) {
        changed = this.ports.sql.exec('INSERT OR IGNORE INTO mailbox_send_result_alerts VALUES (?, ?, ?, ?, ?) RETURNING 1', id, row.epoch, row.attempt,
          code, this.ports.now()).toArray().length > 0 || changed;
      }
      // The backup lane evaluates the alerts: bring it forward when one changed.
      if (changed) this.ports.journalDue(timers);
    });
  }

  // The drive handler's decision for a released send (section 2.2's table,
  // from `queued` on), inside its own conditional commit.
  drive(index: MailboxIndex, row: SendRow, timers: TimerTable, ready: Omit<Ready, 'index'>, now: number): 'enqueue' | 'finish' | 'release' | null {
    const m = new SendModel(this.ports.sql, row);
    const r: Ready = { ...ready, index };
    const ctx: Ctx = { now, epoch: ready.epoch, restoredAt: ready.restoredAt, skew: this.ports.clockSkewMs };
    if (m.d.heldAt !== null) {
      // Held after repeated crashes of our own: never failed, never claimed; an operator resumes it.
      timers.set(SEND_DRIVE, row.id, now + HOLD_RECHECK_MS);
      return releaseList(this.ports.sql, row.id).length ? 'release' : null;
    }
    if (m.d.graceUntil !== null) {
      // A restore that ended since the hold began extends it, as the hold counts from the latest restore.
      let until = m.d.graceUntil;
      for (const entry of m.openExternals()) {
        const fence = protectedFence(m, entry.idx, ctx);
        if (fence) until = Math.max(until, holdEnd(fence, ctx));
      }
      if (until !== m.d.graceUntil) {
        m.d.graceUntil = until;
        this.commit(m, r, timers, null);
      }
      if (now < until) {
        timers.set(SEND_DRIVE, row.id, until);
        return null;
      }
      // The hold ended without a result: the protected recipients fail too.
      for (const entry of m.openExternals()) m.setRecipient(entry.idx, 'failed', m.d.graceReason);
      m.d.graceUntil = null;
      m.d.graceReason = null;
      this.commit(m, r, timers, m.allTerminal() ? finish(m, ctx) : null, true);
      return m.terminal ? 'finish' : null;
    }
    if (m.d.ambiguous >= AMBIGUOUS_CAP || m.d.providerWait >= DEADLINE_MS) {
      this.commit(m, r, timers, grace(m, 'delivery_error', ctx), true);
      return m.terminal ? 'finish' : null;
    }
    if (m.allTerminal()) {
      this.commit(m, r, timers, finish(m, ctx), true);
      return 'finish';
    }
    if (m.state === 'delayed') {
      if (m.d.delayedUntil !== null && now < m.d.delayedUntil) {
        timers.set(SEND_DRIVE, row.id, m.d.delayedUntil);
        return null;
      }
      m.state = 'queued';
      m.d.delayedUntil = null;
      this.commit(m, r, timers, null, true);
    }
    // Only internal recipients are open: their handoff (M3-8) ends them. Until it runs, the
    // drive row keeps the backoff its handler set before acting (5 minutes doubling to 1 hour).
    if (!m.openExternals().length) return null;
    if (m.lease() && leaseLive(m.d.leaseUntil, ctx)) {
      timers.set(SEND_DRIVE, row.id, m.d.leaseUntil! + ctx.skew);
      return null;
    }
    for (const entry of m.openExternals()) {
      const fence = entry.state === 'attempting' ? m.attemptingFence(entry.idx) : undefined;
      if (fence && leaseLive(fence.leaseUntil, ctx)) {
        timers.set(SEND_DRIVE, row.id, fence.leaseUntil + ctx.skew);
        return null;
      }
    }
    if (now < m.d.nextAttemptAt) {
      timers.set(SEND_DRIVE, row.id, m.d.nextAttemptAt);
      return null;
    }
    return 'enqueue';
  }
}

// Finish rule step 3's quota part: every fence on the release list.
export function finishReleases(sql: SqlStorage, id: string): SendFence[] { return releaseList(sql, id); }

// The delayed send's wait, for the restore epilogue.
export function delayedUntil(sql: SqlStorage, id: string): number | null { return dispatchRow(sql, id).delayedUntil; }

type StoredRow = { epoch: number; attempt: number; kind: string; messageId: string | null; detail: string | null; suppressed: number; failures: number;
  unapplied: number; rechecked: number | null };

function storedResult(row: StoredRow): ProviderResult {
  switch (row.kind) {
    // `suppressed` is a bit mask of recipient indexes 0 to 49.
    case 'accepted': return { kind: 'accepted', messageId: row.messageId,
      suppressed: Array.from({ length: 50 }, (_, idx) => idx).filter(idx => Math.floor(row.suppressed / 2 ** idx) % 2 === 1) };
    case 'rejected': return { kind: 'rejected', reason: row.detail ?? 'rejected' };
    case 'try_later': return { kind: 'try_later' };
    case 'outage': return { kind: 'outage', code: row.detail ?? 'unknown' };
    case 'ambiguous': return row.detail === null ? { kind: 'ambiguous' } : { kind: 'ambiguous', code: row.detail };
    default: throw new Error('Invalid stored send result');
  }
}

export type { QuotaScope };
