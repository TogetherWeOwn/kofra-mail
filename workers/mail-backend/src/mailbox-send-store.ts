import { hasHeaderControl, isSafeMessageId } from '../../../contracts/mail-api/src/headers.ts';
import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { RecipientStatus, Send, SendState, SendSummaryState } from '../../../contracts/mail-api/src/wire.ts';
import { iso } from './mailbox-api-input.ts';
import type { SendDispatchRow, SendFailure, SendFenceRow, SendMarkRow, SendPart, SendRecipientKind, SendRecord } from './mail-journal.ts';
import type { SendFence } from './mailbox-send-quota.ts';
import { parseObjectKey } from './object-key.ts';
import { isDeliveryId } from './outbox.ts';
import { isSendMimeBoundary } from './send-mime.ts';

// The one timer kind of a send (section 2.2), keyed by send id.
export const SEND_DRIVE = 'send_drive';
// The drive backoff starts here and doubles to at most DRIVE_BACKOFF_MAX_MS.
export const DRIVE_BACKOFF_MS = 5 * 60_000;
export const DRIVE_BACKOFF_MAX_MS = 60 * 60_000;

// Internal states; releasing and queued report as `sending`.
export type SendRowState = 'pending' | 'releasing' | 'queued' | 'sending' | 'delayed' | 'sent' | 'partial' | 'failed' | 'cancelled';
export const TERMINAL: readonly SendRowState[] = ['sent', 'partial', 'failed', 'cancelled'];
export const SEND_FAILURES: readonly SendFailure[] = ['invalid_sender', 'message_too_large', 'delivery_error'];

export type SendRow = {
  id: string; draftId: string; state: SendRowState; createdAt: number; undoUntil: number; holder: string;
  record: SendRecord; createdSeq: number; releaseSeq: number | null; queuedSeq: number | null; terminalSeq: number | null;
  messageId: string | null; reason: SendFailure | null; finishPending: boolean;
};
type StoredSendRow = Omit<SendRow, 'record' | 'finishPending'> & { record: string; finishPending: number };
// `attempting` is the M3-5 consumer's state while it calls the provider; a restore accepts it.
export type LedgerRow = { idx: number; kind: SendRecipientKind; state: 'pending' | 'attempting' | 'sent' | 'failed' | 'suppressed'; reason: string | null };

const columns = `id, draft_id AS draftId, state, created_at AS createdAt, undo_until AS undoUntil, holder, record,
  created_seq AS createdSeq, release_seq AS releaseSeq, queued_seq AS queuedSeq, terminal_seq AS terminalSeq,
  message_id AS messageId, reason, finish_pending AS finishPending`;
const decode = (row: StoredSendRow): SendRow => ({ ...row, record: JSON.parse(row.record) as SendRecord, finishPending: row.finishPending === 1 });

export function sendRow(sql: SqlStorage, id: string): SendRow | undefined {
  const row = sql.exec<StoredSendRow>(`SELECT ${columns} FROM mailbox_sends WHERE id = ?`, id).toArray()[0];
  return row && decode(row);
}

export function sendByMessage(sql: SqlStorage, messageId: string): SendRow | undefined {
  const row = sql.exec<StoredSendRow>(`SELECT ${columns} FROM mailbox_sends WHERE message_id = ?`, messageId).toArray()[0];
  return row && decode(row);
}

// Active means reported as pending, sending or delayed; an unpublished terminal state still reports as active.
// A send is listed only once its sendDraft commit is published.
export function sendPage(sql: SqlStorage, active: boolean, flushed: number, limit: number, position?: [number, string]): SendRow[] {
  const filter = active ? `AND (state IN ('pending', 'releasing', 'queued', 'sending', 'delayed') OR terminal_seq > ?)` : '';
  const where = position ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
  const values: SqlStorageValue[] = [flushed, ...(active ? [flushed] : []), ...(position ? [position[0], position[0], position[1]] : [])];
  return sql.exec<StoredSendRow>(`SELECT ${columns} FROM mailbox_sends WHERE created_seq <= ? ${filter} ${where}
    ORDER BY created_at DESC, id DESC LIMIT ?`, ...values, limit).toArray().map(decode);
}

export function ledger(sql: SqlStorage, id: string): LedgerRow[] {
  return sql.exec<LedgerRow>('SELECT idx, kind, state, reason FROM mailbox_send_recipients WHERE send_id = ? ORDER BY idx', id).toArray();
}

// A send no claim has reached yet has this dispatch state.
export const NEW_DISPATCH: SendDispatchRow = {
  attempt: 0, leaseEpoch: null, leaseAttempt: null, leaseUntil: null, nextAttemptAt: 0, delayedUntil: null, ambiguous: 0,
  providerWait: 0, refusals: 0, unfinished: 0, heldAt: null, graceUntil: null, graceReason: null,
};

export function dispatchRow(sql: SqlStorage, id: string): SendDispatchRow {
  return sql.exec<SendDispatchRow>(`SELECT attempt, lease_epoch AS leaseEpoch, lease_attempt AS leaseAttempt, lease_until AS leaseUntil,
    next_attempt_at AS nextAttemptAt, delayed_until AS delayedUntil, ambiguous, provider_wait AS providerWait, refusals, unfinished,
    held_at AS heldAt, grace_until AS graceUntil, grace_reason AS graceReason FROM mailbox_send_dispatch WHERE send_id = ?`, id)
    .toArray()[0] ?? { ...NEW_DISPATCH };
}

export function fenceRows(sql: SqlStorage, id: string): SendFenceRow[] {
  return sql.exec<Omit<SendFenceRow, 'marked' | 'authorized'> & { marked: number; authorized: number }>(`SELECT epoch, attempt,
    lease_until AS leaseUntil, marked, authorized, outcome FROM mailbox_send_fences WHERE send_id = ? ORDER BY epoch, attempt`, id)
    .toArray().map(row => ({ ...row, marked: row.marked === 1, authorized: row.authorized === 1 }));
}

export function markRows(sql: SqlStorage, id: string): SendMarkRow[] {
  return sql.exec<SendMarkRow>(`SELECT epoch, attempt, idx, outcome, provider_id AS providerId FROM mailbox_send_marks
    WHERE send_id = ? ORDER BY epoch, attempt, idx`, id).toArray();
}

export function releaseList(sql: SqlStorage, id: string): SendFence[] {
  return sql.exec<SendFence>('SELECT epoch, attempt FROM mailbox_send_release_list WHERE send_id = ? ORDER BY epoch, attempt', id).toArray();
}

const nullableMs = (value: unknown) => value === null || epochMs(value);
const nullableCount = (value: unknown) => value === null || count(value);
const FENCE_OUTCOMES: readonly unknown[] = [null, 'accepted', 'rejected', 'try_later', 'outage', 'ambiguous', 'delayed', 'abandoned'];
const MARK_OUTCOMES: readonly unknown[] = [null, 'sent', 'suppressed', 'failed'];
export const LEDGER_STATES: readonly string[] = ['pending', 'attempting', 'sent', 'failed', 'suppressed'];
// Provider message ids are bounded header values; reasons are short provider-neutral codes.
export const validProviderId = (value: unknown): value is string | null =>
  value === null || (bounded(value, LIMITS.headerValueBytes) && !hasHeaderControl(value));
export const validReason = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);

// Refuses malformed consumer state before it can enter the state or a replay.
export function checkDispatch(value: unknown): asserts value is SendDispatchRow {
  const d = (value ?? {}) as Partial<SendDispatchRow>;
  const lease = [d.leaseEpoch, d.leaseAttempt, d.leaseUntil];
  if (!value || typeof value !== 'object' || !count(d.attempt) || !lease.every(nullableCount) ||
      !(lease.every(part => part === null) || (lease.every(part => part !== null) && d.leaseAttempt! >= 1 && d.leaseAttempt! <= d.attempt! &&
        epochMs(d.leaseUntil))) || !epochMs(d.nextAttemptAt) || !nullableMs(d.delayedUntil) || !count(d.ambiguous) ||
      !count(d.providerWait) || !count(d.refusals) || !count(d.unfinished) || !nullableMs(d.heldAt) || !nullableMs(d.graceUntil) ||
      (d.graceReason !== null && !SEND_FAILURES.includes(d.graceReason as SendFailure)) || (d.graceUntil === null) !== (d.graceReason === null)) {
    throw new Error('Invalid send dispatch state');
  }
}

export function checkFence(value: unknown): asserts value is SendFenceRow {
  const f = (value ?? {}) as Partial<SendFenceRow>;
  if (!value || typeof value !== 'object' || !count(f.epoch) || !count(f.attempt) || f.attempt < 1 || !epochMs(f.leaseUntil) ||
      typeof f.marked !== 'boolean' || typeof f.authorized !== 'boolean' || (f.authorized && !f.marked) || !FENCE_OUTCOMES.includes(f.outcome)) {
    throw new Error('Invalid send fence');
  }
}

export function checkMark(value: unknown, recipients: number): asserts value is SendMarkRow {
  const m = (value ?? {}) as Partial<SendMarkRow>;
  if (!value || typeof value !== 'object' || !count(m.epoch) || !count(m.attempt) || m.attempt < 1 || !count(m.idx) || m.idx >= recipients ||
      !MARK_OUTCOMES.includes(m.outcome) || !validProviderId(m.providerId ?? null) || (m.providerId != null && m.outcome !== 'sent')) {
    throw new Error('Invalid send mark');
  }
}

export function checkReleaseEntry(value: unknown): asserts value is SendFence {
  const f = (value ?? {}) as Partial<SendFence>;
  if (!value || typeof value !== 'object' || !count(f.epoch) || !count(f.attempt) || f.attempt < 1) throw new Error('Invalid send release entry');
}

// What a client may see: a state reaches a report only after the publish that
// covers it (section 2.1), so a restore can never take back a reported state.
export function visibleState(row: SendRow, flushed: number): SendRowState {
  if (row.releaseSeq !== null && row.releaseSeq > flushed) return 'pending';
  if (row.terminalSeq !== null && row.terminalSeq > flushed) return row.state === 'cancelled' ? 'pending' : 'releasing';
  return row.state;
}

const wireState = (state: SendRowState): SendState =>
  state === 'releasing' || state === 'queued' ? 'sending' : state;

export function wireSend(row: SendRow, recipients: LedgerRow[], flushed: number, now: number, delayedUntil: number | null = null): Send {
  const state = visibleState(row, flushed);
  const terminal = TERMINAL.includes(state);
  const queued = row.queuedSeq !== null && row.queuedSeq <= flushed;
  const rows = terminal || queued ? new Map(recipients.map(recipient => [recipient.idx, recipient])) : new Map<number, LedgerRow>();
  return {
    id: row.id, draftId: row.draftId, state: wireState(state), createdAt: iso(row.createdAt), undoUntil: iso(row.undoUntil),
    undoRemainingMs: state === 'pending' ? Math.max(0, row.undoUntil - now) : 0,
    ...(queued && row.messageId ? { messageId: row.messageId } : {}),
    ...(state === 'delayed' && delayedUntil !== null ? { delayedUntil: iso(delayedUntil) } : {}),
    recipients: row.record.recipients.map(({ email }, idx): RecipientStatus => {
      const entry = rows.get(idx);
      // The contract has no `attempting`: a provider call in flight is still pending.
      if (!entry || entry.state === 'attempting') return { email, state: 'pending' };
      return { email, state: entry.state, ...(entry.state === 'failed' && entry.reason ? { reason: entry.reason } : {}) };
    }),
  };
}

export function summaryState(row: SendRow, flushed: number): SendSummaryState {
  const state = wireState(visibleState(row, flushed));
  return state === 'pending' || state === 'cancelled' ? 'sending' : state;
}

const bounded = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isSendId = (value: unknown): value is string => typeof value === 'string' && isDeliveryId(value);
// An epoch-ms time that a Date can hold, so every stored time renders with `iso`.
export const epochMs = (value: unknown): value is number => count(value) && value <= 8.64e15;

function validAddress(value: unknown, field?: boolean): boolean {
  if (!value || typeof value !== 'object') return false;
  const address = value as { email?: unknown; name?: unknown; field?: unknown };
  return bounded(address.email, LIMITS.addressBytes) && !hasHeaderControl(address.email) &&
    (address.name === undefined || (typeof address.name === 'string' && address.name.length <= LIMITS.displayNameBytes && !hasHeaderControl(address.name))) &&
    (!field || address.field === 'to' || address.field === 'cc' || address.field === 'bcc');
}

export function validSendId(id: unknown): id is string { return isSendId(id); }

function validPart(value: unknown): boolean {
  const entry = (value ?? {}) as Partial<SendPart>;
  return !!value && typeof value === 'object' && bounded(entry.messageId, 64) && count(entry.part) && entry.part >= 1 &&
    typeof entry.digest === 'string' && /^[0-9a-f]{64}$/.test(entry.digest) && count(entry.size);
}

// Refuses a malformed record before it can enter the state or a replay.
export function checkSendRecord(record: SendRecord): void {
  const r = record as Partial<SendRecord>;
  const keys = r.attachmentKeys, uploads = r.uploadIds, recipients = r.recipients, parts = r.parts;
  if (!isSendId(r.id) || !bounded(r.draftId, 64) || !epochMs(r.createdAt) || !epochMs(r.undoUntil) || !epochMs(r.dateAt) ||
      !bounded(r.messageId, LIMITS.headerValueBytes) || !isSafeMessageId(r.messageId) || hasHeaderControl(r.messageId) ||
      !bounded(r.boundary, 70) || !isSendMimeBoundary(r.boundary) ||
      r.dateAt !== r.undoUntil || !count(r.undoSeconds) || !bounded(r.ownerUserId, 256) || !validAddress(r.from) ||
      typeof r.from?.name !== 'string' || !Array.isArray(r.replyTo) || r.replyTo.length > 1 ||
      !r.replyTo.every(value => validAddress(value)) || !count(r.builderVersion) || r.builderVersion < 1 ||
      !r.draft || parseObjectKey(r.draft.rawKey)?.kind !== 'raw' || !bounded(r.draft.holder, 256) || !bounded(r.draft.revision, 64) ||
      !epochMs(r.draft.updatedAt) || !Array.isArray(keys) || keys.length > LIMITS.attachmentsPerMessage ||
      keys.some(key => typeof key !== 'string' || !parseObjectKey(key)) || !Array.isArray(uploads) ||
      uploads.length > LIMITS.attachmentsPerMessage || uploads.some(id => !bounded(id, 64)) || !Array.isArray(recipients) ||
      !recipients.length || recipients.length > LIMITS.recipientsPerMessage || !recipients.every(value => validAddress(value, true)) ||
      !Array.isArray(parts) || parts.length > LIMITS.attachmentsPerMessage || !parts.every(validPart)) {
    throw new Error('Invalid send record');
  }
}

export function checkKinds(kinds: unknown, record: SendRecord): asserts kinds is SendRecipientKind[] {
  if (!Array.isArray(kinds) || kinds.length !== record.recipients.length || kinds.some(kind => kind !== 'external' && kind !== 'internal')) {
    throw new Error('Invalid send recipients');
  }
}

// The send's raw holder and its sent copy's index holder (section 2.4, step 3).
export const sendRawHolder = (scope: string, id: string) => `send:${scope}:${id}`;
export const sentCopyId = (id: string) => id;
