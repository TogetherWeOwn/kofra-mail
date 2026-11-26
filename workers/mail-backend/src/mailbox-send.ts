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
import { draftObjectKeys, draftRef, draftUploadIds, readDraft, readDraftObject, type DraftObject, type DraftObjectRef } from './mailbox-api-drafts.ts';
import { apiKey, committedKey, fingerprintOf, RESULT_TTL_MS, scheduleResult } from './mailbox-api-idempotency.ts';
import { canonical, cursorPosition, fail, invalid, isId, makeCursor, need, pageLimit, utf8 } from './mailbox-api-input.ts';
import { SENT_COPY_FLAGS } from './mailbox-api-messages.ts';
import { mailboxState } from './mailbox-api.ts';
import type { MailboxIndex } from './mailbox-index.ts';
import type { SendMimeBuilders, SendMimeMessage, SendMimeParts } from './mailbox-send-mime.ts';
import {
  DRIVE_BACKOFF_MAX_MS, DRIVE_BACKOFF_MS, ledger, SEND_DRIVE, sendPage, sendRawHolder, sendRow, sentBoundary, sentCopyId,
  sentMessageIdHeader, TERMINAL, validSendId, wireSend, type SendRow, type SendRowState,
} from './mailbox-send-store.ts';
import type { TimerKind, TimerRun, TimerTable } from './mailbox-timers.ts';
import { UPLOAD_EXPIRY, unusableSource, uploadReferenced, uploadRow } from './mailbox-upload.ts';
import type { JournalEvent, JournalResult, SendAddress, SendFailure, SendRecipient, SendRecipientKind, SendRecord } from './mail-journal.ts';
import { parseObjectKey } from './object-key.ts';
import { decodedAttachment, parseMail, readMailMime } from './parse-mail.ts';
import type { SendDispatch, SweeperReferences } from './worker.ts';
import { ulid } from 'ulid';

export type SendScope = { workspaceId: string; mailboxId: string; holderScope: string };
type Ready = { incarnation: string; index: MailboxIndex; scope: SendScope };
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
  return extra === undefined && local.length <= 64 && email.length <= LIMITS.addressBytes && !!domain && validDomain(domain)
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
    messageId: sentMessageIdHeader(record), boundary: sentBoundary(record), date: record.dateAt,
    from: { email: record.from.email, ...(record.from.name ? { name: record.from.name } : {}) }, replyTo: record.replyTo,
    to: field('to'), cc: field('cc'), subject: draft.fields.subject, text: [draft.fields.body, ...links].join('\r\n'),
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

function replyToFromSettings(sql: SqlStorage): SendAddress[] {
  const row = sql.exec<{ definition: string }>('SELECT definition FROM mailbox_api_settings WHERE id = 1').toArray()[0];
  const value = row ? (JSON.parse(row.definition) as { replyTo?: unknown }).replyTo : undefined;
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const { email, name } = (entry ?? {}) as { email?: unknown; name?: unknown };
    if (typeof email !== 'string' || !validEmail(email) || (name !== undefined && (typeof name !== 'string' || hasHeaderControl(name)))) return [];
    return [{ email, ...(typeof name === 'string' && name ? { name } : {}) }];
  }).slice(0, 4);
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
    return wireSend(row, ledger(this.sql, id), through, this.clock());
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
    const from = options.canSendAs.find(email => email.toLowerCase() === draft.fields.from.toLowerCase());
    if (!from) return fail('invalid_sender');
    const uploadIds = draftUploadIds(draft);
    for (const id of uploadIds) if (!uploadRow(this.sql, id) || unusableSource(this.sql, 'upload', id)) return fail('not_found');
    if (!options.userId) throw new Error('Send submitter missing');
    const profile = await this.directory.withSession('first-primary').prepare(
      'SELECT display_name FROM mailbox_profiles WHERE workspace_id = ? AND mailbox_id = ?')
      .bind(this.scope.workspaceId, this.scope.mailboxId).first<{ display_name: string }>();
    const name = profile?.display_name && !hasHeaderControl(profile.display_name) ? profile.display_name : '';
    const committedAt = this.clock();
    const undoSeconds = settingsUndoSeconds(this.sql);
    const undoUntil = committedAt + undoSeconds * 1000;
    const record: SendRecord = {
      id: ulid(committedAt), draftId: ref.id, createdAt: committedAt, undoUntil, dateAt: undoUntil, undoSeconds,
      ownerUserId: options.userId, from: { email: from, name }, replyTo: replyToFromSettings(this.sql), builderVersion: this.mime.current,
      draft: { rawKey: ref.rawKey, holder: ref.holder, revision: ref.revision, updatedAt: ref.updatedAt },
      attachmentKeys: draftObjectKeys(draft), uploadIds, recipients,
    };
    const builder = this.mime.get(record.builderVersion)!;
    if (builder.encodedSize(mimeMessage(record, draft)) > LIMITS.outboundMessageBytes) {
      return fail('message_too_large', { limit: LIMITS.outboundMessageBytes });
    }
    const result = resultOf('sendDraft', key, fingerprint, 202, { send: record.id }, committedAt);
    let seq = 0;
    // The pending send, the draft's removal and the idempotency result are one event.
    this.index.changeMany([{ type: 'send_create', send: record, result }], () => {
      seq = revision(this.sql);
      this.timers.set(SEND_DRIVE, record.id, undoUntil);
      scheduleResult(this.timers, { type: 'api_result', ...result });
      this.journalDue(this.timers);
    });
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
    const updatedAt = this.clock();
    const ref: DraftObjectRef = { id: row.draftId, rawKey: row.record.draft.rawKey, revision: crypto.randomUUID(), updatedAt };
    const result = resultOf('undoSend', key, fingerprint, 200, { draft: ref }, updatedAt);
    let seq = 0;
    this.index.changeMany([{ type: 'send_undo', id: row.id, revision: ref.revision, updatedAt, result }], () => {
      seq = revision(this.sql);
      // The drive row finishes the cancelled send now; the draft takes over its uploads.
      this.timers.set(SEND_DRIVE, row.id, updatedAt);
      for (const id of row.record.uploadIds) this.timers.delete(UPLOAD_EXPIRY, id);
      scheduleResult(this.timers, { type: 'api_result', ...result });
      this.journalDue(this.timers);
    });
    return { seq, answer: async () => ({ body: await readDraft(this.index, ref) satisfies Draft, status: 200 }) };
  }

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
      items: rows.map(row => wireSend(row, ledger(this.sql, row.id), through, now)),
      nextCursor: more && last ? makeCursor(scope, [last.createdAt, last.id]) : null,
      state: mailboxState(this.incarnation, revision(this.sql), through),
    };
  }
}

const STALE = Symbol('stale');
const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
type Stale = typeof STALE;
type Start = { token: string; incarnation: string; scope: SendScope; row: SendRow };

// The one-statement sender check of section 1: the workspace, the mailbox,
// the submitting user as its owner and `from` as its active identity, together.
const SENDER_CHECK = `SELECT 1 AS ok FROM mailboxes m WHERE m.workspace_id = ?1 AND m.id = ?2 AND m.user_id = ?3
  AND (m.primary_address = ?4 OR EXISTS (SELECT 1 FROM addresses a WHERE a.address_norm = ?4 AND a.workspace_id = m.workspace_id
    AND a.target_kind = 'mailbox' AND a.target_id = m.id AND a.kind = 'alias' AND a.send_as_policy = 'active'))`;
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
      case 'sending': return this.dispatch(start);
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
    if (row.state === 'pending' && this.timer.now < row.undoUntil) {
      timers.set(SEND_DRIVE, this.ref, row.undoUntil);
      return null;
    }
    const stored = sql.exec<{ backoff: number }>('SELECT backoff FROM mailbox_send_drivers WHERE send_id = ?', row.id).toArray()[0]?.backoff ?? 0;
    const wait = Math.min(DRIVE_BACKOFF_MAX_MS, Math.max(DRIVE_BACKOFF_MS, stored));
    timers.set(SEND_DRIVE, row.id, this.timer.now + wait);
    const token = crypto.randomUUID();
    sql.exec(`INSERT INTO mailbox_send_drivers VALUES (?, ?, ?) ON CONFLICT(send_id) DO UPDATE SET token = excluded.token, backoff = excluded.backoff`,
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
    let draft: DraftObject | undefined;
    // A deploy that dropped the frozen builder version is our invariant breach, never the sender's failure.
    if (!ports.mime.get(record.builderVersion)) return this.breach(start);
    if (!await this.senderValid(start.scope, record)) failure = 'invalid_sender';
    // A lost source is never read: its object may be gone.
    else if (await this.sourceLost(record)) failure = 'delivery_error';
    else if (!this.withinLimits(record, draft = await this.draftOf(start, record))) failure = 'message_too_large';
    if (failure || !draft) {
      const reason = failure ?? 'delivery_error';
      const failed = await this.commit(start, ['releasing'], (timers, _row, index) => {
        index.commitEvents([{ type: 'send_fail', id: this.ref, reason, kinds }]);
        timers.set(SEND_DRIVE, this.ref, this.timer.now);
        this.resetBackoff();
        ports.journalDue(timers);
        return sendRow(ports.sql, this.ref)!;
      });
      if (failed === STALE) return;
      return this.finish({ ...start, row: failed });
    }
    // Step 3: build, register (holders before PUT), then PUT.
    const builder = ports.mime.get(record.builderVersion);
    if (!builder) return this.breach(start);
    const bytes = await builder.build(mimeMessage(record, draft), this.parts(start, draft));
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
      return sendRow(ports.sql, this.ref)!;
    });
    if (queued === STALE) return;
    await ports.checkpoint?.('queued');
    return this.dispatch({ ...start, row: queued });
  }

  // Step 4a and 5: publish the release, then enqueue while an external recipient is not terminal.
  private async dispatch(start: Start): Promise<void> {
    const { row } = start;
    if (row.queuedSeq === null) return;
    if (!await this.ports.publishThrough(row.queuedSeq)) return;
    const pending = await this.ports.local(() => this.current(start) &&
      this.ports.sql.exec(`SELECT 1 FROM mailbox_send_recipients WHERE send_id = ? AND kind = 'external'
        AND state IN ('pending', 'attempting') LIMIT 1`, this.ref).toArray().length === 1);
    if (!pending) return;
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
      ports.journalDue(timers);
    });
  }

  private async breach(start: Start): Promise<void> {
    await this.ports.local(() => {
      if (!this.current(start)) return;
      this.ports.sql.exec('INSERT OR IGNORE INTO mailbox_send_breaches VALUES (?, ?)', this.ref, this.timer.now);
    });
    console.error({ code: 'send_invariant' });
  }

  private async draftOf(start: Start, record: SendRecord): Promise<DraftObject> {
    const ready = this.ports.ready();
    if (!ready || ready.incarnation !== start.incarnation) throw new Error('Mailbox changed during release');
    return readDraftObject(ready.index, { id: record.draftId, rawKey: record.draft.rawKey, revision: record.draft.revision, updatedAt: record.draft.updatedAt });
  }

  private parts(start: Start, draft: DraftObject): SendMimeParts {
    const list = files(draft);
    return async index => {
      const ready = this.ports.ready();
      if (!ready || ready.incarnation !== start.incarnation) throw new Error('Mailbox changed during release');
      const { wire, key } = list[index];
      const parsed = parseObjectKey(key);
      // Object reads refuse a declared empty body, but an empty upload is a valid file.
      if (parsed?.kind === 'att' && wire.size === 0) {
        if (parsed.digest !== EMPTY_DIGEST) throw new Error('Send attachment digest mismatch');
        return new Uint8Array(0);
      }
      const raw = await ready.index.readObject(key);
      if (parsed?.kind === 'att') {
        if (await sha256(raw) !== parsed.digest) throw new Error('Send attachment digest mismatch');
        return raw;
      }
      // A forwarded part kept inside its source message.
      if (parsed?.kind !== 'raw' || wire.kind !== 'message') throw new Error('Invalid send attachment reference');
      const message = await readMailMime(raw, key);
      const attachment = message.attachments[wire.part - 1];
      if (!attachment) throw new Error('Forwarded part missing');
      return decodedAttachment(attachment.content);
    };
  }

  private async senderValid(scope: SendScope, record: SendRecord): Promise<boolean> {
    const row = await this.ports.directory.withSession('first-primary').prepare(SENDER_CHECK)
      .bind(scope.workspaceId, scope.mailboxId, record.ownerUserId, record.from.email).first<{ ok: number }>();
    return row?.ok === 1;
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

  // Only a sweeper `confirm` answer of `lost` marks a source unusable (section 2.7).
  private sourceLost(record: SendRecord): Promise<boolean> {
    return this.ports.local(() => {
      const { sql } = this.ports;
      return unusableSource(sql, 'send', record.id) || record.uploadIds.some(id => unusableSource(sql, 'upload', id));
    });
  }
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
