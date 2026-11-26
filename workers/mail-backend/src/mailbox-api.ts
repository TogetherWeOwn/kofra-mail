import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { Operation } from '../../../contracts/mail-api/src/service.ts';
import type { Label, Settings } from '../../../contracts/mail-api/src/wire.ts';
import { sha256 } from './bytes.ts';
import { draftInput, draftObjectKeys, draftRef, draftRefs, draftUploadIds, encodeDraftObject, readDraft, readDraftObject, readDraftPage, sender, wireDraft } from './mailbox-api-drafts.ts';
import { apiKey, clearApiKey, fingerprintOf, ownsApiKey, replayApiKey, reserveApiKey, resultEvent, scheduleResult, type Committed } from './mailbox-api-idempotency.ts';
import type { HttpMailboxWrite } from './mailbox-http-write.ts';
import { unusableSource, uploadReferenced, uploadRow, UPLOAD_EXPIRY } from './mailbox-upload.ts';
import type { TimerTable } from './mailbox-timers.ts';
import { attachmentRow, displayOf, getThread, labels, listViews, messageRow, missingThreadDisplay, partNumber, threadChanges, threadPage } from './mailbox-api-messages.ts';
import { canonical, cursorPosition, fail, invalid, isId, makeCursor, need, object, pageLimit, text, utf8, type MailboxApiError } from './mailbox-api-input.ts';
import type { MailboxIndex } from './mailbox-index.ts';
import type { JournalEvent } from './mail-journal.ts';
import { parseObjectKey } from './object-key.ts';
import { decodedAttachment, normalizeSearch, readMailMime } from './parse-mail.ts';

export type MailboxApiOptions = { idempotencyKey?: string; ifMatch?: string; canSendAs: string[]; cursorScope?: string; httpWrite?: HttpMailboxWrite };
export type PreparedApiKey = { token: string; fingerprint: string };
export type MailboxApiResult = { body?: unknown; status?: number; replayed?: boolean; error?: MailboxApiError };
export type MailContentBody = { html?: string; text?: string; auth: string };
export type MailContentAttachment = { stream: ReadableStream<Uint8Array>, name: string; mediaType: string; sizeBytes: number };
export type MailContentResult = { body?: MailContentBody | MailContentAttachment; error?: MailboxApiError };
export type MailSource = { workspaceId: string; mailboxId: string; messageId: string } &
  ({ remoteImages: boolean } | { part: number; name: string; mediaType: string; sizeBytes: number });

type Event = Exclude<JournalEvent, { type: 'message' }>;
export const isIdempotentCreate = (operation: Operation) => operation === 'createLabel' || operation === 'createDraft' || operation === 'createUpload';
export const mailApiMutation = (operation: Operation) => isIdempotentCreate(operation) ||
  operation === 'replaceDraft' || operation === 'deleteDraft' || operation === 'updateThreads' ||
  operation === 'deleteLabel' || operation === 'renameLabel' || operation === 'updateSettings' || operation === 'deleteUpload';

export class MailboxApi {
  constructor(private readonly index: MailboxIndex, private readonly sql: SqlStorage, private readonly workspaceId: string,
    private readonly mailboxId: string, private readonly incarnation: string, private readonly now: number,
    private readonly timers?: TimerTable, private readonly preparedKey?: PreparedApiKey,
    private readonly clock: () => number = () => now, private readonly uploadsEnabled = false) {}

  private state() { return `${this.incarnation}-${this.index.journal.revision()}`; }

  private label(name: unknown, id?: string): Label {
    if (typeof name !== 'string' || name.length > LIMITS.labelNameChars * 2 + 1024) return invalid('/name');
    const cleaned = name.trim().normalize('NFC');
    if (!cleaned || /\p{Cc}/u.test(cleaned)) return invalid('/name');
    if ([...cleaned].length > LIMITS.labelNameChars) return invalid('/name', 'too_long');
    const existing = labels(this.sql);
    if (existing.some(item => item.id !== id && normalizeSearch(item.name) === normalizeSearch(cleaned))) return fail('label_exists');
    if (!id && existing.length >= LIMITS.labelsPerMailbox) return fail('limit_reached', { limit: LIMITS.labelsPerMailbox });
    return { id: id ?? crypto.randomUUID(), name: cleaned };
  }

  private settings(canSendAs: string[]): Settings {
    const row = this.sql.exec<{ definition: string }>('SELECT definition FROM mailbox_api_settings WHERE id = 1').toArray()[0];
    const defaults: Settings = { signature: '', undoSeconds: 10, defaultFrom: canSendAs[0] ?? '', replyFromReceivedAddress: true };
    if (!row) return defaults;
    const stored = JSON.parse(row.definition) as Settings;
    return { ...stored, defaultFrom: canSendAs.includes(stored.defaultFrom) ? stored.defaultFrom : defaults.defaultFrom };
  }

  private async withKey(operation: 'createLabel' | 'createDraft', params: Record<string, string>, input: unknown, options: MailboxApiOptions,
    change: (commit: (value: Committed, event: Event, after?: () => void) => void) => Promise<unknown>): Promise<MailboxApiResult> {
    const key = apiKey(options.idempotencyKey);
    const reservation = this.preparedKey ?? reserveApiKey(this.sql, key, this.now);
    if ('row' in reservation) return replayApiKey(this.index, reservation.row, await fingerprintOf(operation, params, input));
    const verify = () => {
      if (!ownsApiKey(this.sql, key, reservation.token, this.clock())) return fail('idempotency_in_progress', { retryAfterSeconds: 1 });
    };
    try {
      const fingerprint = 'fingerprint' in reservation ? reservation.fingerprint : await fingerprintOf(operation, params, input);
      verify();
      return { body: await change((value, event, after) => {
        verify();
        const stored = resultEvent(operation, key, fingerprint, value, this.clock());
        this.index.changeMany([event, stored], () => {
          if (this.timers) scheduleResult(this.timers, stored);
          after?.();
          clearApiKey(this.sql, key, reservation.token);
        });
      }) };
    } finally {
      clearApiKey(this.sql, key, reservation.token);
    }
  }

  private draftUploads(id: string): string[] {
    return this.sql.exec<{ id: string }>('SELECT upload_id AS id FROM mailbox_api_draft_uploads WHERE draft_id = ?', id)
      .toArray().map(row => row.id);
  }

  private rescheduleUploads(ids: Iterable<string>): void {
    if (!this.timers) return;
    for (const id of new Set(ids)) {
      const row = uploadRow(this.sql, id);
      if (!row || uploadReferenced(this.sql, id)) this.timers.delete(UPLOAD_EXPIRY, id);
      else this.timers.set(UPLOAD_EXPIRY, id, row.expiresAt);
    }
  }

  private async listScope(operation: Operation, params: Record<string, string>, who?: string) {
    const { cursor: _cursor, ...query } = params;
    return sha256(utf8(canonical([this.workspaceId, this.mailboxId, this.incarnation, who ?? null, operation, query])));
  }

  async call(operation: Operation, params: Record<string, string>, input: unknown, options: MailboxApiOptions): Promise<MailboxApiResult> {
    const { canSendAs } = options;
    switch (operation) {
      case 'getSession': return { body: { state: this.state() } };
      case 'listViews': return { body: listViews(this.sql, this.now, this.state()) };
      case 'listThreads': {
        const limit = pageLimit(params.limit);
        const scope = await this.listScope(operation, params, options.cursorScope);
        const items = threadPage(this.sql, params, this.now, limit + 1, cursorPosition(params.cursor, scope));
        const more = items.length > limit;
        if (more) items.pop();
        const last = items.at(-1);
        return { body: { items, nextCursor: more && last ? makeCursor(scope, [Date.parse(last.lastDate), last.id]) : null, state: this.state() } };
      }
      case 'getThread': {
        const missing = missingThreadDisplay(this.sql, params.threadId, this.now);
        for (let i = 0; i < missing.length; i += 2) {
          // Bound concurrent reads of messages up to 25 MiB; both calls must
          // settle before relinquishing the mailbox work lane.
          const results = await Promise.allSettled(missing.slice(i, i + 2).map(row => this.index.hydrateApiDisplay(row.id, row.raw_key)));
          for (const result of results) if (result.status === 'rejected') throw result.reason;
        }
        return { body: getThread(this.sql, params.threadId, this.now, this.state()) };
      }
      case 'updateThreads': {
        this.index.changeMany(threadChanges(this.sql, input, this.now));
        return { body: { state: this.state() } };
      }
      case 'getBodyUrl': {
        const { remoteImages } = object(input, ['remoteImages']);
        if (typeof remoteImages !== 'boolean') return invalid('/remoteImages');
        const message = messageRow(this.sql, params.messageId, this.now);
        return { body: { workspaceId: this.workspaceId, mailboxId: this.mailboxId, messageId: message.id, remoteImages } satisfies MailSource };
      }
      case 'getAttachmentUrl': {
        const message = messageRow(this.sql, params.messageId, this.now);
        const part = partNumber(params.part, '/part');
        const row = attachmentRow(this.sql, message, part);
        return { body: { workspaceId: this.workspaceId, mailboxId: this.mailboxId, messageId: message.id, part,
          name: row.name, mediaType: row.mime_type, sizeBytes: row.size } satisfies MailSource };
      }
      case 'listLabels': return { body: { items: labels(this.sql), state: this.state() } };
      case 'createLabel': return this.withKey(operation, params, input, options, async commit => {
        const label = this.label(object(input, ['name']).name);
        commit({ label }, { type: 'label', ...label });
        return label;
      });
      case 'renameLabel': {
        const { name } = object(input, ['name']);
        const existing = need(this.sql.exec<{ id: string; name: string }>('SELECT id, name FROM labels WHERE id = ?', params.labelId ?? '').toArray()[0]);
        const label = this.label(name, existing.id);
        if (label.name !== existing.name) this.index.changeMany([{ type: 'label', ...label }]);
        return { body: label };
      }
      case 'deleteLabel': {
        const id = params.labelId ?? '';
        if (this.sql.exec('SELECT 1 FROM labels WHERE id = ?', id).toArray().length) this.index.changeMany([{ type: 'label_delete', id }]);
        return {};
      }
      case 'getSettings': return { body: this.settings(canSendAs) };
      case 'updateSettings': {
        const patch = object(input, ['signature', 'undoSeconds', 'defaultFrom', 'replyFromReceivedAddress']);
        const previous = this.settings(canSendAs);
        const settings = { ...previous };
        if (patch.signature !== undefined) settings.signature = text(patch.signature, LIMITS.signatureBytes, '/signature');
        if (patch.undoSeconds !== undefined) {
          const seconds = patch.undoSeconds as Settings['undoSeconds'];
          if (!LIMITS.undoSecondsOptions.includes(seconds)) return invalid('/undoSeconds');
          settings.undoSeconds = seconds;
        }
        if (patch.replyFromReceivedAddress !== undefined) {
          if (typeof patch.replyFromReceivedAddress !== 'boolean') return invalid('/replyFromReceivedAddress');
          settings.replyFromReceivedAddress = patch.replyFromReceivedAddress;
        }
        if (patch.defaultFrom !== undefined) settings.defaultFrom = sender(patch.defaultFrom, canSendAs);
        if (canonical(settings) !== canonical(previous)) this.index.changeMany([{ type: 'api_settings', definition: JSON.stringify(settings) }]);
        return { body: settings };
      }
      case 'listDrafts': {
        const limit = pageLimit(params.limit);
        const scope = await this.listScope(operation, params, options.cursorScope);
        const refs = draftRefs(this.sql, limit + 1, cursorPosition(params.cursor, scope));
        const { items, last, more } = await readDraftPage(this.index, refs, limit);
        return { body: { items, nextCursor: more && last ? makeCursor(scope, [last.updatedAt, last.id]) : null, state: this.state() } };
      }
      case 'getDraft': {
        const ref = need(draftRef(this.sql, params.draftId));
        if (unusableSource(this.sql, 'draft', ref.id)) return fail('unavailable');
        return { body: await readDraft(this.index, ref) };
      }
      case 'createDraft': return this.withKey(operation, params, input, options, async commit => {
        const draft = await draftInput(this.sql, this.index, input, canSendAs, this.now, undefined, this.uploadsEnabled);
        const attachmentKeys = draftObjectKeys(draft), uploadIds = draftUploadIds(draft);
        const ref = await this.index.prepareApiDraft(crypto.randomUUID(), encodeDraftObject(draft), this.now, attachmentKeys);
        const { holder: _holder, ...replay } = ref;
        try {
          commit({ draft: replay }, { type: 'draft', ...ref, attachmentKeys, uploadIds },
            () => this.rescheduleUploads(uploadIds));
        } catch (error) { await this.index.releaseDraft(ref, attachmentKeys); throw error; }
        return wireDraft(ref, draft);
      });
      case 'replaceDraft': {
        if (!options.ifMatch) return fail('precondition_required');
        const previous = need(draftRef(this.sql, params.draftId));
        if (previous.revision !== options.ifMatch) return fail('revision_mismatch');
        const oldUploads = this.draftUploads(previous.id);
        const draft = await draftInput(this.sql, this.index, input, canSendAs, this.now,
          await readDraftObject(this.index, previous), this.uploadsEnabled);
        const attachmentKeys = draftObjectKeys(draft), uploadIds = draftUploadIds(draft);
        const ref = await this.index.prepareApiDraft(previous.id, encodeDraftObject(draft), this.now, attachmentKeys);
        try {
          this.index.changeMany([{ type: 'draft', ...ref, attachmentKeys, uploadIds }],
            () => this.rescheduleUploads([...oldUploads, ...uploadIds]));
        } catch (error) { await this.index.releaseDraft(ref, attachmentKeys); throw error; }
        return { body: wireDraft(ref, draft) };
      }
      case 'deleteDraft': {
        const previous = draftRef(this.sql, params.draftId);
        if (!previous) return {};
        if (options.ifMatch !== undefined && previous.revision !== options.ifMatch) return fail('revision_mismatch');
        const uploads = this.draftUploads(previous.id);
        const hasObjects = this.sql.exec('SELECT 1 FROM mailbox_api_draft_objects WHERE draft_id = ? LIMIT 1', previous.id).toArray().length;
        if (!this.uploadsEnabled && hasObjects) return fail('not_implemented');
        this.index.changeMany([{ type: 'draft_delete', id: previous.id, deferRelease: true }],
          () => this.rescheduleUploads(uploads));
        return {};
      }
      case 'deleteUpload': {
        if (!this.timers || !this.uploadsEnabled) return fail('not_implemented');
        const id = params.uploadId;
        const upload = isId(id) && uploadRow(this.sql, id);
        if (upload && !uploadReferenced(this.sql, id)) this.index.changeMany([
          { type: 'api_upload_delete', id, objectKey: upload.objectKey },
        ], () => this.timers!.delete(UPLOAD_EXPIRY, id));
        return {};
      }
      default: return fail('not_implemented');
    }
  }

  async content(messageId: string, part: number | undefined): Promise<MailContentResult> {
    const message = messageRow(this.sql, messageId, this.now);
    if (part === undefined) {
      const parsed = await readMailMime(await this.index.readObject(message.raw_key), message.raw_key);
      return { body: { html: parsed.html, text: parsed.text, auth: message.auth } };
    }
    partNumber(part, '/part');
    const row = attachmentRow(this.sql, message, part);
    let bytes: Uint8Array<ArrayBuffer>;
    if (row.object_key) {
      const key = parseObjectKey(row.object_key);
      if (key?.kind !== 'att') throw new Error('Invalid attachment reference');
      bytes = await this.index.readObject(row.object_key);
      if (await sha256(bytes) !== key.digest) throw new Error('Attachment digest mismatch');
    } else {
      const parsed = await readMailMime(await this.index.readObject(message.raw_key), message.raw_key);
      const attachment = parsed.attachments[part - 1];
      if (!attachment || (parsed.attachments.length > 512 && part >= 512) || displayOf(message)?.syntheticPart === part) return fail('not_found');
      bytes = decodedAttachment(attachment.content);
    }
    if (bytes.byteLength !== row.size) throw new Error('Attachment size mismatch');
    return { body: { stream: new Blob([bytes]).stream(), name: row.name, mediaType: row.mime_type, sizeBytes: row.size } };
  }
}
