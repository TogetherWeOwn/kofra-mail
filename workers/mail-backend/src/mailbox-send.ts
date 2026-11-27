// The send state machine (docs/m3-outbound-plan.md, section 2), from
// `pending` to the published release and its enqueue (M3-3): sendDraft,
// undoSend, getSend and listSends, and the one `send_drive` timer per send
// that releases, enqueues and finishes it. The consumer (M3-5) and the
// internal handoff (M3-8) build on the state this writes.
import { hasHeaderControl } from '../../../contracts/mail-api/src/headers.ts';
import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { Draft, Send } from '../../../contracts/mail-api/src/wire.ts';
import { sha256 } from './bytes.ts';
import { normalizeAddress } from './directory.ts';
import {
  draftObjectKeys, draftRef, draftUploadIds, eachForwardedPart, encodeDraftObject, fingerprintParts, inlinePart, readDraft, readDraftObject, sendableDraftObject,
  type DraftObject, type DraftObjectRef,
} from './mailbox-api-drafts.ts';
import { apiKey, committedKey, fingerprintOf, RESULT_TTL_MS, scheduleResult } from './mailbox-api-idempotency.ts';
import { canonical, cursorPosition, fail, invalid, isId, makeCursor, need, pageLimit, utf8 } from './mailbox-api-input.ts';
import { SENT_COPY_FLAGS } from './mailbox-api-messages.ts';
import { mailboxState } from './mailbox-api.ts';
import type { MailboxIndex } from './mailbox-index.ts';
import type { SendMimeBuilders, SendMimeMessage, SendMimeParts } from './mailbox-send-mime.ts';
import { senderActive, senderState } from './mailbox-send-sender.ts';
import { SendMimeError, SendMimeInvariantError, sendMimeBoundary, sendMimeMessageId } from './send-mime.ts';
import {
  dispatchRow, unpublishedProgress, DRIVE_BACKOFF_MAX_MS, DRIVE_BACKOFF_MS, ledger, SEND_DRIVE, sendPage, sendRawHolder, sendRow, sentCopyId,
  TERMINAL, validSendId, wireSend, type SendRow, type SendRowState,
} from './mailbox-send-store.ts';
import type { TimerKind, TimerRun, TimerTable } from './mailbox-timers.ts';
import { delayedUntil, finishReleases, RELEASE_BATCH, type SendDispatcher } from './mailbox-send-dispatch.ts';
import type { QuotaPort, SendFence } from './mailbox-send-quota.ts';
import { UPLOAD_EXPIRY, unusableSource, uploadReferenced, uploadRow } from './mailbox-upload.ts';
import type { JournalEvent, JournalResult, SendFailure, SendPart, SendRecipient, SendRecipientKind, SendRecord } from './mail-journal.ts';
import { ObjectInvalidError } from './object-errors.ts';
import { parseObjectKey } from './object-key.ts';
import { parseMail, RawDigestMismatch } from './parse-mail.ts';
import type { SendDispatch, SweeperReferences } from './worker.ts';
import { ulid } from 'ulid';

export type SendScope = { workspaceId: string; mailboxId: string; holderScope: string };
// `epoch` and `restoredAt`: the recovery fence of the send path (section 2.5).
type Ready = { incarnation: string; index: MailboxIndex; scope: SendScope; epoch: number; restoredAt: number };
type DirectoryDatabase = { withSession(constraint: 'first-primary'): Pick<D1DatabaseSession, 'prepare'> };

// What the send path needs from its mailbox object. Every storage step runs
// in the work lane through `local`; remote calls happen between steps.
export type SendPorts = {
  sql: SqlStorage;
  ready(): Ready | undefined;
  local: TimerRun['local'];
  // The publish barrier (section 2.1): true once a publish covers `seq`.
  publishThrough(seq: number): Promise<boolean>;
  // Moves the journal lane's deadline to the settings recovery point, so a
  // commit whose barrier failed is still published by the lane.
  journalDue(timers: TimerTable): void;
  sweeper(workspaceId: string): Pick<SweeperReferences, 'registerSend' | 'releaseSend'>;
  directory: DirectoryDatabase;
  queue?: { send(message: SendDispatch): Promise<unknown> };
  mime: SendMimeBuilders;
  put(workspaceId: string, key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  // The consumer's side after release (M3-5a): stored results and the drive decisions.
  dispatcher: Pick<SendDispatcher, 'drive' | 'storedSettled'>;
  quota(): QuotaPort | undefined;
  // Called after each completed release step; tests inject crashes here.
  checkpoint?(step: SendStep): Promise<void>;
};
export type SendStep = 'released' | 'stored' | 'queued' | 'enqueued';

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).byteLength;
const flushed = (sql: SqlStorage) => sql.exec<{ flushed: number }>('SELECT flushed FROM state WHERE id = 1').one().flushed;
const revision = (sql: SqlStorage) => sql.exec<{ modseq: number }>('SELECT modseq FROM state WHERE id = 1').one().modseq;

function validDomain(name: string): boolean {
  const labels = name.split('.');
  return name.length <= 253 && labels.length >= 2 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}
export function validEmail(email: string): boolean {
  const [local, domain, extra] = email.split('@');
  // An RFC 2047 encoded word is not allowed inside an addr-spec (contract section 8.3).
  return extra === undefined && !local.includes('=?') && local.length <= 64 && email.length <= LIMITS.addressBytes && !!domain && validDomain(domain)
    && /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local);
}

const files = (draft: DraftObject) => (draft.attachments ?? []).flatMap(attachment =>
  attachment.wire.kind === 'link' || !('key' in attachment) ? [] : [{ wire: attachment.wire, key: attachment.key }]);

// The MIME inputs, all from the frozen record and the immutable draft revision.
export function mimeMessage(record: SendRecord, draft: DraftObject): SendMimeMessage {
  const field = (name: SendRecipient['field']) => record.recipients.filter(r => r.field === name).map(({ email, name: display }) =>
    ({ email, ...(display ? { name: display } : {}) }));
  const links = (draft.attachments ?? []).flatMap(({ wire }) => wire.kind === 'link' ? [`${wire.name}: ${wire.url}`] : []);
  return {
    messageId: record.messageId, boundary: record.boundary, date: record.dateAt,
    from: { email: record.from.email, ...(record.from.name ? { name: record.from.name } : {}) }, replyTo: record.replyTo,
    to: field('to'), cc: field('cc'), bcc: field('bcc'), subject: draft.fields.subject, text: [draft.fields.body, ...links].join('\r\n'),
    attachments: files(draft).map(({ wire }) => ({ name: wire.name, type: wire.type, size: wire.size })),
    ...(draft.replyHeaders?.inReplyTo ? { inReplyTo: draft.replyHeaders.inReplyTo } : {}),
    ...(draft.replyHeaders?.references ? { references: draft.replyHeaders.references } : {}),
  };
}

// Contract section 8.3's sendDraft checks, shared with release step 2's limits.
function checkSendable(draft: DraftObject): SendRecipient[] {
  const { fields } = draft;
  const all = [...fields.to.map(a => ({ ...a, field: 'to' as const })), ...fields.cc.map(a => ({ ...a, field: 'cc' as const })),
    ...fields.bcc.map(a => ({ ...a, field: 'bcc' as const }))];
  if (all.length > LIMITS.recipientsPerMessage) fail('too_many_recipients', { limit: LIMITS.recipientsPerMessage });
  if (files(draft).length > LIMITS.attachmentsPerMessage) fail('too_many_attachments', { limit: LIMITS.attachmentsPerMessage });
  if (hasHeaderControl(fields.subject)) fail('invalid_header', { errors: [{ field: '/subject', code: 'invalid' }] });
  for (const name of ['to', 'cc', 'bcc'] as const) {
    for (const [i, { email, name: display }] of fields[name].entries()) {
      if (hasHeaderControl(email)) fail('invalid_header', { errors: [{ field: `/${name}/${i}/email`, code: 'invalid' }] });
      if (display !== undefined && hasHeaderControl(display)) fail('invalid_header', { errors: [{ field: `/${name}/${i}/name`, code: 'invalid' }] });
    }
  }
  if (byteLength(fields.subject) > LIMITS.subjectBytes) invalid('/subject', 'too_long');
  if (!all.length || all.some(({ email }) => !validEmail(email))) fail('invalid_recipients');
  return all.map(({ email, name, field }) => ({ field, email, ...(name ? { name } : {}) }));
}

// Email Service accepts one Reply-To address, so settings freeze only the first.
function replyToFromSettings(sql: SqlStorage): SendRecord['replyTo'] {
  const row = sql.exec<{ definition: string }>('SELECT definition FROM mailbox_api_settings WHERE id = 1').toArray()[0];
  const value = row ? (JSON.parse(row.definition) as { replyTo?: unknown }).replyTo : undefined;
  const invalidReplyTo = () => fail('invalid_header', { errors: [{ field: '/replyTo', code: 'invalid' }] });
  if (value === undefined) return [];
  if (!Array.isArray(value)) return invalidReplyTo();
  if (!value.length) return [];
  const { email, name } = (value[0] ?? {}) as { email?: unknown; name?: unknown };
  if (typeof email !== 'string' || hasHeaderControl(email) || !validEmail(email) || (name !== undefined &&
      (typeof name !== 'string' || hasHeaderControl(name) || byteLength(name) > LIMITS.displayNameBytes))) {
    return invalidReplyTo();
  }
  return [{ email, ...(name && { name }) }];
}

function settingsUndoSeconds(sql: SqlStorage): number {
  const row = sql.exec<{ definition: string }>('SELECT definition FROM mailbox_api_settings WHERE id = 1').toArray()[0];
  const seconds = row ? (JSON.parse(row.definition) as { undoSeconds?: unknown }).undoSeconds : undefined;
  return LIMITS.undoSecondsOptions.includes(seconds as never) ? seconds as number : 10;
}

const resultOf = (operation: 'sendDraft' | 'undoSend', key: string, fingerprint: string, status: number, body: unknown, now: number): JournalResult =>
  ({ key, fingerprint, expiresAt: now + RESULT_TTL_MS, result: JSON.stringify({ operation, status, body, createdAt: now }) });

export type SendOptions = { idempotencyKey?: string; ifMatch?: string; canSendAs: string[]; userId?: string; cursorScope?: string };
// A committed (or replayed) API write, answered only after `seq` is published.
export type SendCommit = { seq: number; answer: () => Promise<{ body: unknown; status: number; replayed?: boolean }> };

// The API half: each call runs inside the mailbox work lane.
export class SendApi {
  constructor(private readonly index: MailboxIndex, private readonly sql: SqlStorage, private readonly scope: SendScope,
    private readonly incarnation: string, private readonly timers: TimerTable, private readonly mime: SendMimeBuilders,
    private readonly directory: DirectoryDatabase, private readonly clock: () => number, private readonly journalDue: (timers: TimerTable) => void) {}

  private replayed(operation: 'sendDraft' | 'undoSend', key: string, fingerprint: string, now: number) {
    const row = committedKey(this.sql, key);
    if (!row || row.expiresAt <= now) return;
    if (row.fingerprint !== fingerprint) return fail('idempotency_key_reused');
    const stored = JSON.parse(row.result) as { operation?: string; body?: { send?: string; draft?: DraftObjectRef } };
    if (stored.operation !== operation) return fail('idempotency_key_reused');
    return stored.body ?? {};
  }

  // `published`: an API read sees a send only once its sendDraft commit is
  // published; a replay waits for that publish before it answers.
  private getSendBody(id: string, published = true): Send {
    const row = need(sendRow(this.sql, id));
    const through = flushed(this.sql);
    if (published && row.createdSeq > through) return fail('not_found');
    return wireSend(row, ledger(this.sql, id), through, this.clock(), dispatchRow(this.sql, id).delayedUntil);
  }

  async sendDraft(params: Record<string, string>, options: SendOptions): Promise<SendCommit> {
    const key = apiKey(options.idempotencyKey);
    const now = this.clock();
    const fingerprint = await fingerprintOf('sendDraft', { draftId: params.draftId ?? '' }, null);
    // A committed key replays before the draft's existence or revision is checked.
    const replay = this.replayed('sendDraft', key, fingerprint, now);
    if (replay) {
      const id = replay.send;
      if (!validSendId(id)) throw new Error('Invalid stored send result');
      // Wait for the publish of the original commit only, not of later unrelated changes.
      const original = sendRow(this.sql, id)?.createdSeq ?? revision(this.sql);
      return { seq: original, answer: async () => ({ body: this.getSendBody(id), status: 202, replayed: true }) };
    }
    if (!options.ifMatch) return fail('precondition_required');
    const ref = need(draftRef(this.sql, params.draftId));
    if (ref.revision !== options.ifMatch) return fail('revision_mismatch');
    if (unusableSource(this.sql, 'draft', ref.id)) return fail('unavailable');
    const draft = await readDraftObject(this.index, ref);
    const recipients = checkSendable(draft);
    if (!options.userId) throw new Error('Send submitter missing');
    // The mailbox's own check, the one directory statement of section 1: never
    // the caller's earlier, separate reads of the session's mailbox and identities.
    // A user who lost the mailbox meanwhile gets the API layer's answer for that.
    const from = draft.fields.from;
    const sender = await senderState(this.directory, { ...this.scope, ownerUserId: options.userId, from });
    if (sender === 'not_owner') return fail('forbidden');
    if (sender !== 'ok') return fail('invalid_sender');
    const uploadIds = draftUploadIds(draft);
    for (const id of uploadIds) if (!uploadRow(this.sql, id) || unusableSource(this.sql, 'upload', id)) return fail('not_found');
    const profile = await this.directory.withSession('first-primary').prepare(
      'SELECT display_name FROM mailbox_profiles WHERE workspace_id = ? AND mailbox_id = ?')
      .bind(this.scope.workspaceId, this.scope.mailboxId).first<{ display_name: string }>();
    const name = profile?.display_name && !hasHeaderControl(profile.display_name) ? profile.display_name : '';
    // A draft saved before parts were fingerprinted gets its fingerprints now.
    const parts = (await fingerprintParts(this.index, draft.attachments ?? [])).flatMap(attachment =>
      attachment.wire.kind === 'message' && 'part' in attachment && attachment.part
        ? [{ messageId: attachment.wire.messageId, part: attachment.wire.part, ...attachment.part }] : []);
    const undoSeconds = settingsUndoSeconds(this.sql), replyTo = replyToFromSettings(this.sql), attachmentKeys = draftObjectKeys(draft);
    const builder = this.mime.get(this.mime.current)!;
    const frozen = (at: number, source: Pick<DraftObjectRef, 'rawKey' | 'revision' | 'updatedAt'> & { holder: string }): SendRecord => {
      const id = ulid(at);
      const mimeId = id.toLowerCase();
      return {
        id, draftId: ref.id, createdAt: at, undoUntil: at + undoSeconds * 1000, dateAt: at + undoSeconds * 1000, undoSeconds,
        messageId: sendMimeMessageId(mimeId, { email: from }), boundary: sendMimeBoundary(mimeId),
        ownerUserId: options.userId!, from: { email: from, name }, replyTo, builderVersion: builder.version,
        draft: { rawKey: source.rawKey, holder: source.holder, revision: source.revision, updatedAt: source.updatedAt },
        attachmentKeys, uploadIds, recipients, parts,
      };
    };
    const tooLarge = (record: SendRecord) => {
      try { return builder.encodedSize(mimeMessage(record, draft)) > LIMITS.outboundMessageBytes; }
      catch (error) {
        if (!(error instanceof SendMimeError)) throw error;
        const { code, ...extra } = error.problem;
        return fail(code, extra);
      }
    };
    if (tooLarge(frozen(this.clock(), ref))) return fail('message_too_large', { limit: LIMITS.outboundMessageBytes });
    // A legacy prefix-less `drafts/` revision is first stored as a raw/ generation,
    // as replaceDraft writes one (section 2.7), and committed with the send.
    const staged = parseObjectKey(ref.rawKey)?.kind === 'raw' ? undefined
      : await this.index.prepareApiDraft(ref.id, encodeDraftObject(draft), this.clock(), attachmentKeys);
    // The undo window starts at the commit, after any storage above.
    const committedAt = this.clock();
    const record = frozen(committedAt, staged ?? ref);
    const result = resultOf('sendDraft', key, fingerprint, 202, { send: record.id }, committedAt);
    let seq = 0;
    try {
      if (tooLarge(record)) return fail('message_too_large', { limit: LIMITS.outboundMessageBytes });
      // The pending send, the draft's removal and the idempotency result are one event.
      this.index.changeMany([...(staged ? [{ type: 'draft' as const, ...staged, attachmentKeys, uploadIds }] : []),
        { type: 'send_create', send: record, result }], () => {
        seq = revision(this.sql);
        this.timers.set(SEND_DRIVE, record.id, record.undoUntil);
        scheduleResult(this.timers, { type: 'api_result', ...result });
        this.journalDue(this.timers);
      });
    } catch (error) {
      if (staged) await this.index.releaseDraft(staged, attachmentKeys);
      throw error;
    }
    return { seq, answer: async () => ({ body: this.getSendBody(record.id), status: 202 }) };
  }

  async undoSend(params: Record<string, string>, options: SendOptions): Promise<SendCommit> {
    const key = apiKey(options.idempotencyKey);
    const now = this.clock();
    const fingerprint = await fingerprintOf('undoSend', { sendId: params.sendId ?? '' }, null);
    const replay = this.replayed('undoSend', key, fingerprint, now);
    if (replay) {
      const ref = replay.draft;
      if (!ref || !isId(ref.id)) throw new Error('Invalid stored undo result');
      // The undo's own event set the send's terminal seq.
      const undone = validSendId(params.sendId) ? sendRow(this.sql, params.sendId) : undefined;
      const original = undone?.state === 'cancelled' && undone.terminalSeq !== null ? undone.terminalSeq : revision(this.sql);
      return { seq: original, answer: async () => ({ body: await readDraft(this.index, ref), status: 200, replayed: true }) };
    }
    const row = need(validSendId(params.sendId) ? sendRow(this.sql, params.sendId) : undefined);
    if (row.state !== 'pending') return fail('send_not_pending');
    // A source the sweeper confirmed lost cannot be restored as a draft; release fails the send instead.
    if (sendSourceLost(this.sql, row.record)) return fail('send_not_pending');
    const updatedAt = this.clock();
    const ref: DraftObjectRef = { id: row.draftId, rawKey: row.record.draft.rawKey, revision: crypto.randomUUID(), updatedAt };
    const result = resultOf('undoSend', key, fingerprint, 200, { draft: ref }, updatedAt);
    let seq = 0;
    this.index.changeMany([{ type: 'send_undo', id: row.id, revision: ref.revision, updatedAt, result }], () => {
      seq = revision(this.sql);
      // The drive row finishes the cancelled send now, at the normal retry; the draft takes over its uploads.
      this.timers.set(SEND_DRIVE, row.id, updatedAt);
      this.sql.exec('UPDATE mailbox_send_drivers SET backoff = 0 WHERE send_id = ?', row.id);
      for (const id of row.record.uploadIds) this.timers.delete(UPLOAD_EXPIRY, id);
      scheduleResult(this.timers, { type: 'api_result', ...result });
      this.journalDue(this.timers);
    });
    return { seq, answer: async () => ({ body: await readDraft(this.index, ref) satisfies Draft, status: 200 }) };
  }

  // The newest consumer change (M3-5) of these sends that no publish covers yet, or 0.
  unpublishedProgress(ids: string[]): number { return unpublishedProgress(this.sql, ids); }

  getSend(params: Record<string, string>): Send {
    if (!validSendId(params.sendId)) return fail('not_found');
    return this.getSendBody(params.sendId);
  }

  async listSends(params: Record<string, string>, who?: string) {
    const { cursor, ...query } = params;
    if (query.active !== undefined && query.active !== 'true' && query.active !== 'false') return invalid('/active');
    const limit = pageLimit(query.limit);
    const scope = await sha256(utf8(canonical([this.scope.workspaceId, this.scope.mailboxId, this.incarnation, who ?? null, 'listSends', query])));
    const through = flushed(this.sql), now = this.clock();
    const rows = sendPage(this.sql, query.active === 'true', through, limit + 1, cursorPosition(cursor, scope));
    const more = rows.length > limit;
    if (more) rows.pop();
    const last = rows.at(-1);
    return {
      items: rows.map(row => wireSend(row, ledger(this.sql, row.id), through, now, dispatchRow(this.sql, row.id).delayedUntil)),
      nextCursor: more && last ? makeCursor(scope, [last.createdAt, last.id]) : null,
      state: mailboxState(this.incarnation, revision(this.sql), through),
    };
  }
}

const STALE = Symbol('stale');
// A send attachment whose bytes do not match its content-addressed key.
class SourceMismatch extends Error { constructor() { super('Send attachment digest mismatch'); } }
const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
type Stale = typeof STALE;
type Start = { token: string; incarnation: string; scope: SendScope; row: SendRow };

// One directory statement marks each recipient that routes to a mailbox of
// this workspace as internal, by the inbound routing rules. Only the
// classification is recorded; the destination is resolved at delivery (M3-8).
const INTERNAL_LOOKUP = `SELECT CAST(j.key AS INTEGER) AS idx FROM json_each(?1) AS j
  JOIN domains AS original ON original.name = json_extract(j.value, '$[1]')
  JOIN domains AS destination ON destination.workspace_id = original.workspace_id
    AND destination.id = coalesce(original.alias_of, original.id) AND destination.kind <> 'alias'
  JOIN addresses AS a ON a.address_norm = (json_extract(j.value, '$[0]') || '@' || destination.name)
    AND a.workspace_id = destination.workspace_id
  WHERE original.workspace_id = ?2 AND json_type(j.value) = 'array'`;

export class SendDriver {
  constructor(private readonly ports: SendPorts, private readonly timer: TimerRun) {}

  private get ref() { return this.timer.ref; }

  async run(): Promise<void> {
    const start = await this.ports.local(timers => this.begin(timers));
    if (!start) return;
    const { row } = start;
    if (row.finishPending) return this.finish(start);
    switch (row.state) {
      case 'pending':
      case 'releasing': return this.release(start);
      case 'queued':
      case 'sending':
      case 'delayed': return this.dispatch(start);
      default: return;
    }
  }

  // The handler re-arms before acting, takes a fresh driver token and reads the state it acts on.
  private begin(timers: TimerTable): Start | null {
    const { sql } = this.ports;
    const ready = this.ports.ready();
    const row = validSendId(this.ref) ? sendRow(sql, this.ref) : undefined;
    if (!row) { timers.delete(SEND_DRIVE, this.ref); return null; }
    if (!ready) return null;
    if (TERMINAL.includes(row.state) && !row.finishPending) {
      timers.delete(SEND_DRIVE, this.ref);
      return null;
    }
    // A send held while the path was off could not be undone then: it gets a
    // fresh undo window, as in the restore epilogue, and is not released now.
    const held = sql.exec<{ held: number }>('SELECT held FROM mailbox_send_drivers WHERE send_id = ?', row.id).toArray()[0]?.held === 1;
    if (row.state === 'pending' && held) {
      const undoUntil = Math.max(row.undoUntil, this.timer.now + row.record.undoSeconds * 1000);
      if (undoUntil > row.undoUntil) ready.index.commitEvents([{ type: 'send_window', id: row.id, undoUntil }]);
      sql.exec('UPDATE mailbox_send_drivers SET held = 0, token = ? WHERE send_id = ?', crypto.randomUUID(), row.id);
      timers.set(SEND_DRIVE, row.id, undoUntil);
      this.ports.journalDue(timers);
      return null;
    }
    if (row.state === 'pending' && this.timer.now < row.undoUntil) {
      timers.set(SEND_DRIVE, this.ref, row.undoUntil);
      return null;
    }
    const stored = sql.exec<{ backoff: number }>('SELECT backoff FROM mailbox_send_drivers WHERE send_id = ?', row.id).toArray()[0]?.backoff ?? 0;
    const wait = Math.min(DRIVE_BACKOFF_MAX_MS, Math.max(DRIVE_BACKOFF_MS, stored));
    timers.set(SEND_DRIVE, row.id, this.timer.now + wait);
    const token = crypto.randomUUID();
    sql.exec(`INSERT INTO mailbox_send_drivers (send_id, token, backoff) VALUES (?, ?, ?)
      ON CONFLICT(send_id) DO UPDATE SET token = excluded.token, backoff = excluded.backoff`,
      row.id, token, Math.min(DRIVE_BACKOFF_MAX_MS, wait * 2));
    return { token, incarnation: ready.incarnation, scope: ready.scope, row };
  }

  // Every commit of a run is conditional on its driver token and the state it started from.
  private commit<T>(start: Start, states: readonly SendRowState[], step: (timers: TimerTable, row: SendRow, index: MailboxIndex) => T): Promise<T | Stale> {
    return this.ports.local((timers): T | Stale => {
      const ready = this.ports.ready();
      if (!ready || ready.incarnation !== start.incarnation || !this.current(start)) return STALE;
      const row = sendRow(this.ports.sql, this.ref);
      if (!row || !states.includes(row.state)) return STALE;
      return step(timers, row, ready.index);
    }) as Promise<T | Stale>;
  }

  private current(start: Start): boolean {
    return this.ports.sql.exec('SELECT 1 FROM mailbox_send_drivers WHERE send_id = ? AND token = ?', this.ref, start.token).toArray().length === 1;
  }

  private resetBackoff(): void {
    this.ports.sql.exec('UPDATE mailbox_send_drivers SET backoff = 0 WHERE send_id = ?', this.ref);
  }

  private async release(start: Start): Promise<void> {
    const { ports } = this;
    let row = start.row;
    // Step 1: pending to releasing, only once a publish covers the sendDraft event.
    if (row.state === 'pending') {
      if (!await ports.publishThrough(row.createdSeq)) return;
      const released = await this.commit(start, ['pending'], (_timers, _row, index) => {
        index.commitEvents([{ type: 'send_release', id: this.ref }]);
        this.resetBackoff();
        return sendRow(ports.sql, this.ref)!;
      });
      if (released === STALE) return;
      row = released;
      await ports.checkpoint?.('released');
    }
    // Step 2: re-check the sender, the limits and the sources; classify recipients.
    const { record } = row;
    const kinds = await this.classify(start.scope, record);
    let failure: SendFailure | null = null;
    // Null once read and found invalid for good; undefined if never read.
    let draft: DraftObject | null | undefined;
    let forwarded: Map<number, Uint8Array<ArrayBuffer>> | null = new Map();
    // A deploy that dropped the frozen builder version is our invariant breach, never the sender's failure.
    if (!ports.mime.get(record.builderVersion)) return this.breach(start);
    if (!await this.senderValid(start.scope, record)) failure = 'invalid_sender';
    // A lost source is never read: its object may be gone.
    else if (await this.sourceLost(record)) failure = 'delivery_error';
    // A draft revision that no longer matches its digest is unusable, like a lost source.
    else if (!(draft = await this.draftOf(start, record))) failure = 'delivery_error';
    else {
      let withinLimits: boolean;
      try { withinLimits = this.withinLimits(record, draft); }
      catch (error) { return this.mimeRefusal(start, kinds, error); }
      if (!withinLimits) failure = 'message_too_large';
      // A forwarded part that no longer decodes to the bytes attached is unusable, like a lost source.
      else if (!(forwarded = await this.forwardedParts(start, record, draft))) failure = 'delivery_error';
    }
    if (failure || !draft || !forwarded) return this.fail(start, kinds, failure ?? 'delivery_error', draft === null || !forwarded);
    // Step 3: build, register (holders before PUT), then PUT.
    const builder = ports.mime.get(record.builderVersion);
    if (!builder) return this.breach(start);
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = await builder.build(mimeMessage(record, draft), this.parts(start, draft, forwarded)); }
    catch (error) {
      // An att/ object that does not match its content-addressed digest is
      // corrupt for good, like a lost source; a failed read still retries.
      if (error instanceof SourceMismatch) return this.fail(start, kinds, 'delivery_error', true);
      return this.mimeRefusal(start, kinds, error);
    }
    const digest = await sha256(bytes);
    const registration = await ports.sweeper(start.scope.workspaceId).registerSend(start.scope.mailboxId, record.id, digest,
      { raw: sendRawHolder(start.scope.holderScope, record.id), index: `message:${start.scope.holderScope}:${sentCopyId(record.id)}` });
    if (registration.state !== 'registered' || parseObjectKey(registration.key)?.digest !== digest) return this.breach(start);
    // A PUT starts only right after this run's own registration, while its token is current.
    if (!await ports.local(() => this.current(start))) return;
    await ports.put(start.scope.workspaceId, registration.key, bytes);
    await ports.checkpoint?.('stored');
    // Step 4: index the sent copy and write the ledger, then `queued`.
    const parsed = await parseMail(bytes, registration.key, true);
    const queued = await this.commit(start, ['releasing'], (_timers, _row, index) => {
      index.commitSentCopy(this.ref, registration.key, record.dateAt, parsed, SENT_COPY_FLAGS, kinds);
      this.resetBackoff();
      // Step 3 passed: an earlier run's invariant breach, and with it its alert, is over.
      ports.sql.exec('DELETE FROM mailbox_send_breaches WHERE send_id = ?', this.ref);
      return sendRow(ports.sql, this.ref)!;
    });
    if (queued === STALE) return;
    await ports.checkpoint?.('queued');
    return this.dispatch({ ...start, row: queued });
  }

  private mimeRefusal(start: Start, kinds: SendRecipientKind[], error: unknown): Promise<void> {
    if (error instanceof SendMimeError && error.problem.code === 'message_too_large') {
      return this.fail(start, kinds, 'message_too_large', false);
    }
    // The frozen version accepted this input at submission. A deterministic
    // refusal now means drift or invalid stored inputs, not a transient read.
    if (error instanceof SendMimeError || error instanceof SendMimeInvariantError) return this.breach(start);
    throw error;
  }

  // A release-time failure (section 2.4, step 2); `unusable` also marks the send's
  // source unusable, which raises the lost-source alert.
  private async fail(start: Start, kinds: SendRecipientKind[], reason: SendFailure, unusable: boolean): Promise<void> {
    const { ports } = this;
    const failed = await this.commit(start, ['releasing'], (timers, row, index) => {
      index.commitEvents([
        ...(unusable ? [{ type: 'api_source_lost' as const, kind: 'send' as const, id: this.ref, holder: row.holder }] : []),
        { type: 'send_fail', id: this.ref, reason, kinds },
      ]);
      timers.set(SEND_DRIVE, this.ref, this.timer.now);
      this.resetBackoff();
      ports.journalDue(timers);
      return sendRow(ports.sql, this.ref)!;
    });
    if (failed === STALE) return;
    return this.finish({ ...start, row: failed });
  }

  // Step 4a and 5: publish the release, record stored provider results, then
  // act on the consumer's state: finish, wait, or enqueue while an external
  // recipient is open and no live lease or backoff holds the send.
  private async dispatch(start: Start): Promise<void> {
    const { row } = start;
    if (row.queuedSeq === null) return;
    if (!await this.ports.publishThrough(row.queuedSeq)) return;
    // The restore epilogue moves this row to now, so results stored meanwhile are recorded here.
    // Until every stored result is recorded, nothing is enqueued: a retry could resend an accepted call.
    // First, best effort, every stored result that can apply now: a terminal
    // decision below then sees it. A later one still corrects a recipient through
    // late confirmation (notices or the reconciler, also after cleanup).
    const stored = await this.ports.dispatcher.storedSettled(start.scope, this.ref);
    const decision = await this.commit(start, ['queued', 'sending', 'delayed', ...TERMINAL], (timers, current, index) => {
      if (current.finishPending) return 'finish' as const;
      if (TERMINAL.includes(current.state)) return null;
      const ready = this.ports.ready()!;
      return this.ports.dispatcher.drive(index, current, timers, ready, this.timer.now);
    });
    if (decision === STALE) return;
    // Unresolved stored results bring the drive row back when the earliest is due, also
    // when the decision set a later wait (after a failed lookup it keeps its backoff).
    const next = stored.settled || decision === 'finish' ? null : stored.next;
    if (next !== null) await this.ports.local(timers => { if (this.current(start)) timers.lower(SEND_DRIVE, this.ref, Math.max(1, next, this.timer.now)); });
    if (decision === null) return;
    if (decision === 'release') return this.releaseHeld(start);
    if (decision === 'finish') {
      const finished = await this.ports.local(() => sendRow(this.ports.sql, this.ref));
      return finished ? this.finish({ ...start, row: finished }) : undefined;
    }
    // Unresolved stored results gate only reclaim and enqueue.
    if (!stored.settled) return;
    if (!this.ports.queue) throw new Error('Send queue binding missing');
    await this.ports.queue.send({ kind: 'dispatch', ws: start.scope.workspaceId, mb: start.scope.mailboxId, sendId: this.ref });
    await this.ports.checkpoint?.('enqueued');
  }

  // The finish rule (section 2.4), from its step 2: publish, release, then clear.
  private async finish(start: Start): Promise<void> {
    const { ports } = this;
    const { row } = start;
    if (row.terminalSeq === null || !await ports.publishThrough(row.terminalSeq)) return;
    // `raw` only if release step 4 committed in the published state; never from the index row now.
    const mode = row.queuedSeq !== null && row.queuedSeq <= row.terminalSeq ? 'raw' : 'all';
    // A restore can reuse `terminalSeq` for other events, so a run overtaken by
    // a restore or a later run must not release a send it no longer drives.
    if (!await ports.local(() => this.current(start) && ports.ready()?.incarnation === start.incarnation)) return;
    // The quota part of step 3: every fence on the release list, in one idempotent call; kept charges stay.
    const fences = await ports.local(() => finishReleases(ports.sql, this.ref));
    await this.releaseFences(start, fences);
    await ports.sweeper(start.scope.workspaceId).releaseSend(start.scope.mailboxId, row.id, mode);
    await this.commit(start, TERMINAL, (timers, current, index) => {
      if (!current.finishPending) return;
      index.commitEvents([{ type: 'send_finish', id: this.ref }]);
      timers.delete(SEND_DRIVE, this.ref);
      for (const id of current.record.uploadIds) {
        const upload = uploadRow(ports.sql, id);
        if (upload && !uploadReferenced(ports.sql, id)) timers.set(UPLOAD_EXPIRY, id, Math.max(1, upload.expiresAt));
      }
      ports.sql.exec('DELETE FROM mailbox_send_drivers WHERE send_id = ?', this.ref);
      ports.sql.exec('DELETE FROM mailbox_send_breaches WHERE send_id = ?', this.ref);
      ports.journalDue(timers);
    });
  }

  // Releases fences in batches the quota call takes at once; an absent reservation is a no-op.
  private async releaseFences(start: Start, fences: SendFence[]): Promise<void> {
    if (!fences.length) return;
    const quota = this.ports.quota();
    if (!quota) throw new Error('Send quota binding missing');
    const scope = { workspaceId: start.scope.workspaceId, mailboxId: start.scope.mailboxId, sendId: this.ref };
    for (let at = 0; at < fences.length; at += RELEASE_BATCH) await quota.release(scope, fences.slice(at, at + RELEASE_BATCH));
  }

  // A held send's never-authorized charges go while it waits for an operator; the list stays until finish or Mark.
  private async releaseHeld(start: Start): Promise<void> {
    const fences = await this.ports.local(() => finishReleases(this.ports.sql, this.ref));
    try { await this.releaseFences(start, fences); }
    catch (error) { console.error({ code: 'send_quota_release', error: error instanceof Error ? error.message : String(error) }); }
  }

  private async breach(start: Start): Promise<void> {
    await this.ports.local(() => {
      if (!this.current(start)) return;
      this.ports.sql.exec('INSERT OR IGNORE INTO mailbox_send_breaches VALUES (?, ?)', this.ref, this.timer.now);
    });
    console.error({ code: 'send_invariant' });
  }

  // Null when the stored revision is invalid for good: declared empty, over the
  // cap, not matching its digest, or digest-verified bytes that do not decode
  // to a draft object release can build. A missing object or a failed read still retries.
  private async draftOf(start: Start, record: SendRecord): Promise<DraftObject | null> {
    const ready = this.ports.ready();
    if (!ready || ready.incarnation !== start.incarnation) throw new Error('Mailbox changed during release');
    let draft: DraftObject;
    try {
      draft = await readDraftObject(ready.index, { id: record.draftId, rawKey: record.draft.rawKey, revision: record.draft.revision, updatedAt: record.draft.updatedAt });
    } catch (error) {
      if (error instanceof ObjectInvalidError) return null;
      throw error;
    }
    return sendableDraftObject(draft) ? draft : null;
  }

  // Reads the small forwarded parts, one source at a time, and checks each against
  // the digest and size frozen in the record and the size the builder lays out;
  // null on a mismatch or a part that no longer exists.
  private async forwardedParts(start: Start, record: SendRecord, draft: DraftObject): Promise<Map<number, Uint8Array<ArrayBuffer>> | null> {
    const wanted: { index: number; key: string; part: number; frozen: SendPart }[] = [];
    for (const [index, { wire, key }] of files(draft).entries()) {
      if (wire.kind !== 'message' || !inlinePart(key)) continue;
      const frozen = record.parts.find(entry => entry.messageId === wire.messageId && entry.part === wire.part);
      if (!frozen || frozen.size !== wire.size) return null;
      wanted.push({ index, key, part: wire.part, frozen });
    }
    const verified = new Map<number, Uint8Array<ArrayBuffer>>();
    let matched = true;
    try {
      await eachForwardedPart(key => {
        const ready = this.ports.ready();
        if (!ready || ready.incarnation !== start.incarnation) throw new Error('Mailbox changed during release');
        return this.readSource(ready.index, key);
      }, wanted, async ({ index, frozen }, bytes) => {
        if (!bytes || bytes.byteLength !== frozen.size || await sha256(bytes) !== frozen.digest) return matched = false;
        verified.set(index, bytes);
      });
    } catch (error) {
      // The parser checks each source against its raw/ key's digest before parsing.
      if (error instanceof SourceMismatch || error instanceof RawDigestMismatch) return null;
      throw error;
    }
    return matched ? verified : null;
  }

  // A stored object declared empty or over the cap is invalid for good, like a
  // digest mismatch; a missing object or a failed read still retries.
  private async readSource(index: MailboxIndex, key: string): Promise<Uint8Array<ArrayBuffer>> {
    try { return await index.readObject(key); }
    catch (error) {
      if (error instanceof ObjectInvalidError) throw new SourceMismatch();
      throw error;
    }
  }

  private parts(start: Start, draft: DraftObject, forwarded: Map<number, Uint8Array<ArrayBuffer>>): SendMimeParts {
    const list = files(draft);
    return async index => {
      // A small forwarded part was read and verified before the build.
      const verified = forwarded.get(index);
      if (verified) return verified;
      const ready = this.ports.ready();
      if (!ready || ready.incarnation !== start.incarnation) throw new Error('Mailbox changed during release');
      const { wire, key } = list[index];
      const parsed = parseObjectKey(key);
      // Uploads and large forwarded parts are att/ objects, verified against their content-addressed key.
      if (parsed?.kind !== 'att') throw new Error('Invalid send attachment reference');
      // Object reads refuse a declared empty body, but an empty upload is a valid file.
      if (wire.size === 0) {
        if (parsed.digest !== EMPTY_DIGEST) throw new SourceMismatch();
        return new Uint8Array(0);
      }
      const raw = await this.readSource(ready.index, key);
      if (raw.byteLength !== wire.size || await sha256(raw) !== parsed.digest) throw new SourceMismatch();
      return raw;
    };
  }

  private senderValid(scope: SendScope, record: SendRecord): Promise<boolean> {
    return senderActive(this.ports.directory, { ...scope, ownerUserId: record.ownerUserId, from: record.from.email });
  }

  private async classify(scope: SendScope, record: SendRecord): Promise<SendRecipientKind[]> {
    const addresses = record.recipients.map(({ email }) => {
      try {
        const normalized = normalizeAddress(email);
        const at = normalized.lastIndexOf('@');
        return [normalized.slice(0, at), normalized.slice(at + 1)];
      } catch { return null; }
    });
    const { results } = await this.ports.directory.withSession('first-primary').prepare(INTERNAL_LOOKUP)
      .bind(JSON.stringify(addresses), scope.workspaceId).all<{ idx: number }>();
    const internal = new Set(results.map(({ idx }) => idx));
    return record.recipients.map((_, idx) => internal.has(idx) ? 'internal' : 'external');
  }

  private withinLimits(record: SendRecord, draft: DraftObject): boolean {
    const builder = this.ports.mime.get(record.builderVersion);
    return record.recipients.length <= LIMITS.recipientsPerMessage && files(draft).length <= LIMITS.attachmentsPerMessage &&
      !!builder && builder.encodedSize(mimeMessage(record, draft)) <= LIMITS.outboundMessageBytes;
  }

  private sourceLost(record: SendRecord): Promise<boolean> {
    return this.ports.local(() => sendSourceLost(this.ports.sql, record));
  }
}

// Only a sweeper `confirm` answer of `lost` marks a source unusable (section 2.7):
// the send's draft revision, a forwarded part or an upload.
export function sendSourceLost(sql: SqlStorage, record: SendRecord): boolean {
  return unusableSource(sql, 'send', record.id) || record.uploadIds.some(id => unusableSource(sql, 'upload', id));
}

// While the send path is off, its held handler marks a due `pending` send, so
// the first firing with the path on gives it a fresh undo window (section 2.5).
export function markSendHeld(sql: SqlStorage, id: string): void {
  if (!validSendId(id) || sendRow(sql, id)?.state !== 'pending') return;
  sql.exec(`INSERT INTO mailbox_send_drivers (send_id, token, held) VALUES (?, ?, 1)
    ON CONFLICT(send_id) DO UPDATE SET held = 1`, id, crypto.randomUUID());
}

// The restore epilogue (section 2.5), inside the transaction that sets the
// mailbox ready: every restored send that is not finished gets its drive row.
// A pending send gets a fresh undo window, so an undo lost with an unpublished
// delta can be retried before it goes out.
export function restoreEpilogue(sql: SqlStorage, index: () => MailboxIndex | undefined, timers: TimerTable, now: number): void {
  const rows = sql.exec<{ id: string }>(`SELECT id FROM mailbox_sends WHERE finish_pending = 1
    OR state NOT IN ('sent', 'partial', 'failed', 'cancelled') ORDER BY id`).toArray();
  for (const { id } of rows) {
    const row = sendRow(sql, id)!;
    if (row.state === 'pending') {
      const undoUntil = Math.max(row.undoUntil, now + row.record.undoSeconds * 1000);
      if (undoUntil > row.undoUntil) {
        const target = index();
        if (!target) throw new Error('Mailbox not ready for its restore epilogue');
        target.commitEvents([{ type: 'send_window', id, undoUntil } satisfies JournalEvent]);
      }
      timers.set(SEND_DRIVE, id, undoUntil);
    } else if (row.state === 'delayed' && !row.finishPending) {
      // A delayed send waits for its reset, unless an internal handoff is still open.
      const until = delayedUntil(sql, id);
      const handoff = sql.exec(`SELECT 1 FROM mailbox_send_recipients WHERE send_id = ? AND kind = 'internal' AND state = 'pending' LIMIT 1`, id)
        .toArray().length === 1;
      timers.set(SEND_DRIVE, id, Math.max(1, handoff || until === null ? now : until));
    } else timers.set(SEND_DRIVE, id, Math.max(1, now));
  }
}

export function sendDrive(ports: SendPorts): TimerKind {
  return {
    run: timer => new SendDriver(ports, timer).run(),
    rebuild(timers, now) {
      restoreEpilogue(ports.sql, () => ports.ready()?.index, timers, now);
      ports.journalDue(timers);
      return undefined;
    },
  };
}
