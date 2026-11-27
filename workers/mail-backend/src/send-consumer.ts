// The send consumer's dispatch core (docs/m3-outbound-plan.md, section 2.4,
// "Consumer" steps 1 to 6 and the error classes; M3-5b). Plain code behind
// injected ports: the mailbox's RPCs, the account quota port, the send()
// request, the EMAIL binding, the stored-result table, the result-notice
// producer and the clock. The `mail-send` Worker (M3-5c) wires the ports and
// turns the outcome into an acknowledgement or a retry. Nothing here logs
// message content, subjects or addresses.
import type {
  AbandonAnswer, AuthorizeAnswer, ClaimAnswer, DelayAnswer, MarkAnswer, ProviderResult, ReportAnswer, RequestAnswer,
} from './mailbox-send-dispatch.ts';
import type { QuotaAnswer, QuotaPort, SendFence } from './mailbox-send-quota.ts';
import { validErrorCode, validProviderId, validSendId } from './mailbox-send-store.ts';
import type { SendRequest } from './send-mime.ts';
import type { SendDispatch } from './worker.ts';

// A reservation frees itself this long after the claim's lease expiry unless confirmed (step 2).
export const RESERVATION_GRACE_MS = 2 * 60_000;
// abandonClaim's retry for an error before send(); the mailbox clamps it to 1 minute .. 1 hour.
export const ABANDON_RETRY_MS = 60_000;
// abandonClaim's retry after a request the frozen inputs can no longer build (the mailbox's maximum).
export const INVALID_RETRY_MS = 60 * 60_000;
// A stored result's first notify_after: the reconciler's independent retry path (step 6).
export const STORED_NOTIFY_MS = 5 * 60_000;
// The ambiguous code for a rejection without a usable error code: the mailbox alerts on it.
export const UNCODED = 'uncoded';

// A result notice only says a stored provider result is waiting; it never leads to a send() call.
export type ResultNotice = { kind: 'result'; ws: string; mb: string; sendId: string; fence: SendFence };

// The mailbox RPCs of M3-5a, as a Durable Object stub exposes them.
export interface ConsumerMailbox {
  claimSend(workspaceId: string, mailboxId: string, sendId: string): Promise<ClaimAnswer>;
  markSend(workspaceId: string, mailboxId: string, sendId: string, fence: SendFence, recipients: number[], released: SendFence[]): Promise<MarkAnswer>;
  sendRequest(workspaceId: string, mailboxId: string, sendId: string, fence: SendFence): Promise<RequestAnswer>;
  authorizeDispatch(workspaceId: string, mailboxId: string, sendId: string, fence: SendFence, recipients: number[],
    quotaDayEnd: number): Promise<AuthorizeAnswer>;
  recordResult(workspaceId: string, mailboxId: string, sendId: string, fence: SendFence, result: ProviderResult): Promise<ReportAnswer>;
  delaySend(workspaceId: string, mailboxId: string, sendId: string, fence: SendFence, cause: 'gate' | 'provider_daily',
    resetAt?: number): Promise<DelayAnswer>;
  abandonClaim(workspaceId: string, mailboxId: string, sendId: string, fence: SendFence, retryAt: number): Promise<AbandonAnswer>;
}

// The `send_email` binding's structured call.
export type EmailBinding = { send(request: SendRequest): Promise<unknown> };

// A provider result the mailbox could not record, for the D1 table send_results.
export type StoredResult = { workspaceId: string; mailboxId: string; sendId: string; fence: SendFence; result: ProviderResult; createdAt: number };

export type ConsumerPorts = {
  mailbox(workspaceId: string, mailboxId: string): ConsumerMailbox;
  quota(): QuotaPort;
  // Step 3a: the structured request for the fence's Mark set (normally the mailbox's sendRequest).
  request(message: SendDispatch, fence: SendFence): Promise<RequestAnswer>;
  // Undefined when the binding is absent (an environment without permitted senders).
  email(): EmailBinding | undefined;
  storeResult(row: StoredResult): Promise<void>;
  notify(notice: ResultNotice): Promise<void>;
  now(): number;
};

// `ack: false`: the queue retries the message.
export type DispatchOutcome =
  | { ack: true; step: 'invalid' | 'not_now' | 'refused' | 'gone' }
  | { ack: true; step: 'stale' | 'abandoned' | 'delayed' | 'recorded' | 'unrecorded' | 'stored'; fence: SendFence; cause?: string }
  | { ack: false; step: 'claim_failed' }
  | { ack: false; step: 'store_failed'; fence: SendFence };

// Error codes of the Email Service Workers binding (provisional until M3-0's
// receipt replaces the table): every code that is not listed is ambiguous.
const TRY_LATER = new Set(['E_RATE_LIMIT_EXCEEDED']);
// Our own outage: never counted, never failed.
const OUTAGE = new Set(['E_ACCOUNT_SUSPENDED', 'E_SENDER_NOT_VERIFIED', 'E_EMAIL_SENDING_NOT_READY']);
const OUTAGE_PREFIX = 'E_SENDER_DOMAIN_';
// Rejected for good, with a provider-neutral reason for every recipient of the call.
const REJECTED: Readonly<Record<string, string>> = {
  E_VALIDATION_ERROR: 'rejected',
  E_RECIPIENT_SUPPRESSED: 'suppressed',
  E_TOO_MANY_RECIPIENTS: 'too_many_recipients',
  E_TOO_MANY_ATTACHMENTS: 'too_many_attachments',
  E_CONTENT_TOO_LARGE: 'message_too_large',
  E_FIELD_MISSING: 'invalid_header',
  E_HEADER_NOT_ALLOWED: 'invalid_header',
  E_HEADER_USE_API_FIELD: 'invalid_header',
  E_HEADER_VALUE_INVALID: 'invalid_header',
  E_HEADER_VALUE_TOO_LONG: 'invalid_header',
  E_HEADER_NAME_INVALID: 'invalid_header',
  E_HEADERS_TOO_LARGE: 'invalid_header',
  E_HEADERS_TOO_MANY: 'invalid_header',
};
// Known ambiguous codes: the message may have been delivered; no unknown-code alert.
const AMBIGUOUS = new Set(['E_INTERNAL_SERVER_ERROR']);
const DAILY_LIMIT = 'E_DAILY_LIMIT_EXCEEDED';

export type SettledSend = { ok: true; value: unknown } | { ok: false; error: unknown };
// The provider's daily limit is not a recorded result: it goes to delaySend.
export type SendClass = ProviderResult | { kind: 'provider_daily' };

// Classifies the settled send() promise, and only that (section 2.4, step 6).
// A fulfilled promise is accepted, with a null id if it carries no usable one.
// A rejection is classified by its `code`; a rejection without a usable code,
// or with a code not in the table, is ambiguous and raises the unknown-code alert.
export function classifySend(settled: SettledSend): SendClass {
  if (settled.ok) {
    const id = settled.value !== null && typeof settled.value === 'object' ? (settled.value as { messageId?: unknown }).messageId : undefined;
    return { kind: 'accepted', messageId: typeof id === 'string' && validProviderId(id) ? id : null };
  }
  const { error } = settled;
  const raw = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (!validErrorCode(raw)) return { kind: 'ambiguous', code: UNCODED };
  if (raw === DAILY_LIMIT) return { kind: 'provider_daily' };
  if (TRY_LATER.has(raw)) return { kind: 'try_later' };
  if (OUTAGE.has(raw) || raw.startsWith(OUTAGE_PREFIX)) return { kind: 'outage', code: raw };
  if (Object.hasOwn(REJECTED, raw)) return { kind: 'rejected', reason: REJECTED[raw] };
  if (AMBIGUOUS.has(raw)) return { kind: 'ambiguous' };
  return { kind: 'ambiguous', code: raw };
}

const log = (code: string, error?: unknown) =>
  console.error({ code, ...(error !== undefined && { error: error instanceof Error ? error.name : typeof error }) });

function isDispatch(value: unknown): value is SendDispatch {
  const message = value as Partial<SendDispatch> | null;
  return !!message && typeof message === 'object' && message.kind === 'dispatch' && typeof message.ws === 'string' && !!message.ws &&
    typeof message.mb === 'string' && !!message.mb && validSendId(message.sendId);
}

// One dispatch message: claim, reserve, Mark, confirm and build the request,
// authorize, send, then record, delay or abandon (section 2.4, steps 1 to 6).
export async function dispatchSend(message: unknown, ports: ConsumerPorts): Promise<DispatchOutcome> {
  if (!isDispatch(message)) {
    log('send_message_invalid');
    return { ack: true, step: 'invalid' };
  }
  const { ws, mb, sendId } = message;
  const mailbox = ports.mailbox(ws, mb);
  // Step 1. A failed claim is retried by the queue; the drive row re-drives a dead-lettered message.
  let claim: ClaimAnswer;
  try { claim = await mailbox.claimSend(ws, mb, sendId); }
  catch (error) {
    log('send_claim_failed', error);
    return { ack: false, step: 'claim_failed' };
  }
  // "Not now" (including the release paging), refused and gone are acknowledged: the drive row re-drives.
  if (claim.status !== 'claimed') return { ack: true, step: claim.status };
  const { fence } = claim;
  const recipients = claim.recipients.map(({ idx }) => idx);
  const scope = { workspaceId: ws, mailboxId: mb, sendId };
  const stale = (): DispatchOutcome => ({ ack: true, step: 'stale', fence });
  // Errors before send(): the current fence's recipients return to pending and
  // its charge goes. A failed abandon leaves the lease to expire; the drive row re-drives.
  const abandon = async (cause: string, retryAt = ports.now() + ABANDON_RETRY_MS): Promise<DispatchOutcome> => {
    try { await mailbox.abandonClaim(ws, mb, sendId, fence, retryAt); }
    catch (error) { log('send_abandon_failed', error); }
    return { ack: true, step: 'abandoned', fence, cause };
  };
  // A closed gate before send(): delayed until the refusing gate's reset (the mailbox adds clockSkew).
  const delayForGate = async (resetAt: number): Promise<DispatchOutcome> => {
    let delayed: DelayAnswer;
    try { delayed = await mailbox.delaySend(ws, mb, sendId, fence, 'gate', resetAt); }
    catch (error) {
      log('send_delay_failed', error);
      return abandon('delay');
    }
    return delayed.status === 'delayed' ? { ack: true, step: 'delayed', fence } : stale();
  };
  if (!recipients.length) return abandon('recipients');

  // Step 2: one quota call releases the listed fences and reserves under this one.
  const quota = ports.quota();
  let reserved: QuotaAnswer;
  try { reserved = await quota.reserve(scope, fence, recipients, claim.release, claim.leaseUntil + RESERVATION_GRACE_MS); }
  catch (error) {
    log('send_quota_failed', error);
    return abandon('quota');
  }
  if (reserved.status === 'exhausted') return delayForGate(reserved.resetAt);
  if (reserved.status !== 'ok') return abandon('quota_stale');

  // Step 3: Mark, published before any send() under this fence.
  let marked: MarkAnswer;
  try { marked = await mailbox.markSend(ws, mb, sendId, fence, recipients, claim.release); }
  catch (error) {
    log('send_mark_failed', error);
    return abandon('mark');
  }
  if (marked.status !== 'ok') return stale();

  // Step 3a: confirm the reservation, then check the binding and build the
  // request, all before the authorization.
  let confirmed: QuotaAnswer;
  try { confirmed = await quota.confirm(scope, fence, recipients); }
  catch (error) {
    log('send_quota_failed', error);
    return abandon('quota');
  }
  if (confirmed.status === 'exhausted') return delayForGate(confirmed.resetAt);
  if (confirmed.status !== 'ok') return abandon('quota_stale');
  const email = ports.email();
  if (!email) {
    log('send_binding_missing');
    return abandon('binding');
  }
  let built: RequestAnswer;
  try { built = await ports.request(message, fence); }
  catch (error) {
    log('send_request_failed', error);
    return abandon('request');
  }
  if (built.status === 'stale') return stale();
  // Our own invariant breach (the mailbox logs send_request_invalid): never a failure of the send,
  // retried at the longest backoff so it cannot loop every minute.
  if (built.status !== 'ok') return abandon('request_invalid', ports.now() + INVALID_RETRY_MS);

  // Step 4: the clock is read just before the call, so the deadline is never
  // later than the grant plus the window.
  const t0 = ports.now();
  let authorized: AuthorizeAnswer;
  try { authorized = await mailbox.authorizeDispatch(ws, mb, sendId, fence, recipients, confirmed.dayEnd); }
  catch (error) {
    log('send_authorize_failed', error);
    return abandon('authorize');
  }
  // Close to the quota day's end: wait for the reset instead of retrying at once.
  if (authorized.status === 'quota_window') return abandon('quota_window', authorized.retryAfter);
  if (authorized.status !== 'ok') return stale();

  // Step 5: the deadline check and the call, with no await between them. Only
  // the settled promise is classified; a synchronous throw becomes a rejection.
  const deadline = t0 + authorized.remainingMs;
  if (!(ports.now() < deadline)) {
    log('send_deadline_missed');
    return abandon('deadline');
  }
  let call: Promise<unknown>;
  try { call = email.send(built.request); }
  catch (error) { call = Promise.reject(error); }
  const settled = await call.then((value): SettledSend => ({ ok: true, value }), (error: unknown): SettledSend => ({ ok: false, error }));
  const classified = classifySend(settled);

  // Step 6. After the authorization only the missed deadline abandons: the
  // daily limit waits in delaySend, every other class is recorded.
  if (classified.kind === 'provider_daily') {
    try {
      const delayed = await mailbox.delaySend(ws, mb, sendId, fence, 'provider_daily');
      return delayed.status === 'delayed' ? { ack: true, step: 'delayed', fence } : stale();
    } catch (error) {
      // The lease runs out; the next claim treats the call as an ambiguous event of our own.
      log('send_delay_failed', error);
      return stale();
    }
  }
  return record(message, ports, mailbox, fence, classified);
}

// Records the result, or stores it durably and sends a notice when the mailbox
// cannot record it now (restoring, unpublished, or the call failed).
async function record(message: SendDispatch, ports: ConsumerPorts, mailbox: ConsumerMailbox, fence: SendFence,
  result: ProviderResult): Promise<DispatchOutcome> {
  const { ws, mb, sendId } = message;
  let answer: ReportAnswer | undefined;
  try { answer = await mailbox.recordResult(ws, mb, sendId, fence, result); }
  catch (error) { log('send_record_failed', error); }
  if (answer?.status === 'recorded') return { ack: true, step: 'recorded', fence };
  const final = answer?.status === 'stale' || answer?.status === 'gone';
  if (final && (result.kind === 'try_later' || result.kind === 'outage' || result.kind === 'rejected')) {
    // A refused call is not charged: one idempotent release of this fence's
    // reservation, which never touches a newer fence's charge. A failure keeps
    // the charge, as an ambiguous result's is kept.
    try { await ports.quota().release({ workspaceId: ws, mailboxId: mb, sendId }, [fence]); }
    catch (error) { log('send_stale_release_failed', error); }
    return { ack: true, step: 'unrecorded', fence };
  }
  // A stale or gone ambiguous result changes nothing. A stale or gone
  // acceptance is a provider fact: it is stored, so the mailbox flags and
  // alerts it (or counts it as an orphan) instead of it being dropped.
  if (final && result.kind === 'ambiguous') return { ack: true, step: 'unrecorded', fence };
  try { await ports.storeResult({ workspaceId: ws, mailboxId: mb, sendId, fence, result, createdAt: ports.now() }); }
  catch (error) {
    // Not acknowledged: the queue retries the message. A result lost this way is an ambiguous event.
    log('send_result_store_failed', error);
    return { ack: false, step: 'store_failed', fence };
  }
  // The stored row carries the fact; a lost notice is recovered by the reconciler.
  try { await ports.notify({ kind: 'result', ws, mb, sendId, fence }); }
  catch (error) { log('send_notice_failed', error); }
  return { ack: true, step: 'stored', fence };
}

// The step 6 write into send_results, keyed by (workspace, mailbox, send, fence):
// ids, recipient indexes and the provider message id only. A row already stored
// for the fence is kept.
export async function storeSendResult(db: Pick<D1Database, 'prepare'>, row: StoredResult): Promise<void> {
  const { result } = row;
  const messageId = result.kind === 'accepted' ? result.messageId : null;
  const detail = result.kind === 'rejected' ? result.reason : result.kind === 'outage' || result.kind === 'ambiguous' ? result.code ?? null : null;
  const suppressed = result.kind === 'accepted' ? [...new Set(result.suppressed ?? [])].reduce((mask, idx) => mask + 2 ** idx, 0) : 0;
  await db.prepare(`INSERT INTO send_results (workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt, kind, message_id, detail,
      suppressed, created_at, notify_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .bind(row.workspaceId, row.mailboxId, row.sendId, row.fence.epoch, row.fence.attempt, result.kind, messageId, detail, suppressed,
      row.createdAt, row.createdAt + STORED_NOTIFY_MS)
    .run();
}
