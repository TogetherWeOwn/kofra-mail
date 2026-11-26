import { authVerdict, AUTH_VERDICT } from './auth-verdict.ts';
import { MAX_RAW_BYTES, sha256 } from './bytes.ts';
import { isObjectKey } from './kofra.ts';
import { ObjectInvalidError, ObjectMissingError } from './object-errors.ts';
import { MailJournal, type JournalEvent, type JournalRow, type SendRecipientKind, type SentCopy } from './mail-journal.ts';
import { checkKinds, checkSendRecord, SEND_FAILURES, sendRow, sentCopyId, TERMINAL, validSendId } from './mailbox-send-store.ts';
import { ATTACHMENT_SEARCH_BOUNDARY, MAILBOX_SCHEMA } from './mailbox-schema.ts';
import { JOURNAL_FLUSH } from './mailbox-timers.ts';
import { IDEM_EXPIRY } from './mailbox-upload.ts';
import type { ConfirmAnswer, ConfirmEntry, HoldTarget } from './sweep-ledger.ts';
import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import { parseObjectKey, type ObjectKind } from './object-key.ts';
import { isDeliveryId } from './outbox.ts';
import { normalizeSearch, parseMail, type ParsedMail } from './parse-mail.ts';

export type MailboxObjects = {
  get(key: string): Promise<Uint8Array<ArrayBuffer>>;
  put(key: string, content: Uint8Array<ArrayBuffer>): Promise<void>;
  putUpload?(key: string, content: ReadableStream<Uint8Array>, size: number, digest: string, timeoutMs: number): Promise<void>;
  register(kind: ObjectKind, digest: string, holder: string): Promise<string>;
  holdProvisional?(target: HoldTarget, holder: string): Promise<string>;
  hold(key: string, holder: string): Promise<void>;
  release(key: string, holder: string): Promise<void>;
};

// The stored message can never be indexed: a digest mismatch, an unparseable
// message or a size cap. Transport and storage failures are never permanent.
export class PermanentMailError extends Error {}
// The raw object is verifiably gone.
export class MissingMailError extends PermanentMailError {}
export class LifecycleConflict extends Error {}

type MessageEvent = Extract<JournalEvent, { type: 'message' }>;
type MessageSource = Pick<MessageEvent, 'id' | 'rawKey' | 'createdAt'>;
type Prepared = Omit<ParsedMail, 'attachments'> & { attachments: Array<{
  part: number; name: string; mimeType: string; size: number; key: string | null;
}> };
type SnapshotTable = 'messages' | 'labels' | 'drafts' | 'bayes' | 'settings';
export type SnapshotRow = { row_no: number; kind: string; value: string };
type SnapshotMessage = Omit<MessageEvent, 'type'> & { flags: number; gmailId: string | null; labels: string[]; expiresAt?: number | null };
export type ApiDraftRef = { id: string; rawKey: string; holder: string; revision: string; updatedAt: number };
export type PendingConfirmation = ConfirmEntry & { seq: number; publishedAt: number | null };
export type HolderConfirmationCursor = [seq: number, key: string, holder: string];
export const HOLDER_CONFIRM_BATCH = 64;
const trashLabel = 'trash';

const SUBJECT_KEY = /^[a-f0-9]{64}$/;
// The dedupe key is `<Message-ID>:<body sha256>` when a Message-ID exists.
const messageIdOf = (dedupeKey: string) => dedupeKey.startsWith('<') && /:[a-f0-9]{64}$/.test(dedupeKey) ? dedupeKey.slice(0, -65) : null;
const bounded = (s: unknown, limit: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= limit;
const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

// Snapshot message rows carry no subject key; their threads do.
function validMessage(m: Partial<MessageEvent>, snapshot = false): asserts m is MessageEvent {
  const raw = typeof m.rawKey === 'string' ? parseObjectKey(m.rawKey) : null;
  if (!isDeliveryId(m.id) || !isDeliveryId(m.threadId) || raw?.kind !== 'raw' || !count(m.createdAt) ||
      !bounded(m.dedupeKey, 2048) || (!snapshot && (typeof m.subjectKey !== 'string' || !SUBJECT_KEY.test(m.subjectKey))) || typeof m.auth !== 'string' || !AUTH_VERDICT.test(m.auth) ||
      !Array.isArray(m.attKeys) || m.attKeys.length > 4096 ||
      m.attKeys.some(key => typeof key !== 'string' || parseObjectKey(key)?.kind !== 'att')) {
    throw new Error('Invalid mailbox message state');
  }
}

export function storedLifecycle<T>(storage: DurableObjectStorage): T | null {
  storage.sql.exec(MAILBOX_SCHEMA);
  const row = storage.sql.exec<{ value: string }>('SELECT value FROM lifecycle WHERE id = 1').toArray()[0];
  return row ? JSON.parse(row.value) as T : null;
}

export class MailboxIndex {
  private readonly storage: DurableObjectStorage;
  private readonly objects: MailboxObjects;
  private readonly holderScope: string;
  private readonly sql: SqlStorage;
  readonly journal: MailJournal;

  constructor(storage: DurableObjectStorage, objects: MailboxObjects, holderScope: string, private readonly mailApiEnabled = false) {
    this.storage = storage;
    this.objects = objects;
    this.holderScope = holderScope;
    this.sql = storage.sql;
    this.sql.exec(MAILBOX_SCHEMA);
    this.journal = new MailJournal(this.sql);
  }

  // Recovery and backup state for this mailbox. Stored in SQLite so a change can
  // commit atomically with the rows it describes.
  lifecycle<T>(): T | null {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM lifecycle WHERE id = 1').toArray()[0];
    return row ? JSON.parse(row.value) as T : null;
  }

  // Every transition keeps the incarnation; only `init` may create the row. A
  // writer holding state from before a wipe or another incarnation is refused,
  // which also rolls back the transaction it is part of.
  setLifecycle<T extends { state: string; incarnation: string }>(value: T): void {
    const current = this.lifecycle<{ incarnation: string }>();
    if (current ? current.incarnation !== value.incarnation : value.state !== 'init') {
      throw new LifecycleConflict('Mailbox lifecycle changed');
    }
    this.sql.exec('INSERT INTO lifecycle VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', JSON.stringify(value));
  }

  transaction<T>(operation: () => T): T { return this.storage.transactionSync(operation); }

  async ingest(id: string, rawKey: string, createdAt: number, authResults: string | null = null): Promise<void> {
    if (!isDeliveryId(id) || !Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('Invalid delivery for mailbox');
    if (this.received(id)) return;
    const parsed = await this.parse(rawKey);
    const source: MessageSource = { id, rawKey, createdAt };
    const prepared = this.known(parsed.dedupeKey) ? null : await this.holdAndStore(source, parsed);
    const auth = authVerdict(authResults, parsed.sender, parsed.singleFrom);
    this.storage.transactionSync(() => {
      if (this.received(id)) return;
      if (this.known(parsed.dedupeKey)) {
        this.apply({ type: 'receipt', id });
        this.journal.append({ type: 'receipt', id });
      } else {
        if (!prepared) throw new Error('Mailbox fingerprint changed unexpectedly');
        this.journal.append(this.insertMessage(source, prepared, auth));
      }
    });
  }

  received(id: string): boolean {
    return this.sql.exec('SELECT 1 FROM receipts WHERE id = ?', id).toArray().length > 0;
  }

  private known(key: string): boolean {
    return this.sql.exec('SELECT 1 FROM fingerprints WHERE key = ?', key).toArray().length > 0;
  }

  private async parse(key: string): Promise<ParsedMail> {
    if (!key.startsWith('raw/') || !isObjectKey(key)) throw new PermanentMailError('Invalid raw key');
    let content: Uint8Array<ArrayBuffer>;
    try {
      content = await this.objects.get(key);
    } catch (error) {
      if (error instanceof ObjectMissingError) throw new MissingMailError('Raw message object does not exist');
      if (error instanceof ObjectInvalidError) throw new PermanentMailError('Invalid mailbox object size');
      throw error;
    }
    if (content.byteLength === 0 || content.byteLength > MAX_RAW_BYTES) throw new PermanentMailError('Invalid mailbox object size');
    try {
      return await parseMail(content, key, this.mailApiEnabled);
    } catch (error) {
      throw new PermanentMailError(error instanceof Error ? error.message : 'Unparseable message');
    }
  }

  // Restore found a completed delivery whose raw object is verifiably gone (for
  // example, a duplicate whose object was collected). Record its receipt so the
  // replay can continue; it was never, or can no longer be, shown.
  skipMissing(id: string): void {
    if (!isDeliveryId(id)) throw new Error('Invalid delivery for mailbox');
    this.storage.transactionSync(() => {
      if (this.received(id)) return;
      this.apply({ type: 'receipt', id });
      this.journal.append({ type: 'receipt', id });
    });
  }

  private referenceFor(id: string): string { return `message:${this.holderScope}:${id}`; }

  private async holdAndStore(message: MessageSource, parsed: ParsedMail): Promise<Prepared> {
    const holder = this.referenceFor(message.id);
    await this.objects.hold(message.rawKey, holder);
    const attachments: Prepared['attachments'] = [];
    for (const { external, ...attachment } of parsed.attachments) {
      let key: string | null = null;
      if (external) {
        const digest = await sha256(external);
        key = await this.objects.register('att', digest, holder);
        const registered = parseObjectKey(key);
        if (registered?.kind !== 'att' || registered.digest !== digest) throw new Error('Invalid registered attachment key');
        await this.objects.put(key, external);
      }
      attachments.push({ ...attachment, key });
    }
    return { ...parsed, attachments };
  }

  private insertMessage(source: MessageSource, parsed: Prepared, auth: string): MessageEvent {
    let threadId = source.id;
    for (const ref of parsed.refs) {
      const matches = this.sql.exec<{ threadId: string }>(`SELECT m.thread_id AS threadId FROM messages m
        JOIN threads t ON t.id = m.thread_id WHERE m.message_id = ? AND t.subject_key = ? AND t.assigned < 100
        ORDER BY m.internal_date DESC, m.id DESC LIMIT 1`, ref, parsed.subjectKey).toArray();
      if (matches.length) { threadId = matches[0].threadId; break; }
    }
    const attKeys = [...new Set(parsed.attachments.flatMap(a => a.key ? [a.key] : []))];
    const event: MessageEvent = { type: 'message', ...source, threadId, dedupeKey: parsed.dedupeKey,
      subjectKey: parsed.subjectKey, auth, attKeys };
    this.upsertThread(threadId, parsed.subjectNorm, parsed.subjectKey, source.createdAt);
    const rowid = this.sql.exec<{ rowid: number }>(`INSERT INTO messages
      (id, raw_key, size, sent_date, sender, recipients, cc, subject, snippet, thread_id, flags, internal_date,
       gmail_id, message_id, dedupe_key, auth, att_keys, indexed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, ?, 1)
       RETURNING rowid`,
    source.id, source.rawKey, parsed.size, parsed.sentDate, parsed.sender, parsed.to, parsed.cc, parsed.subject,
    parsed.snippet, threadId, source.createdAt, parsed.messageId, parsed.dedupeKey, auth, JSON.stringify(attKeys)).one().rowid;
    this.insertDerived(source.id, rowid, parsed);
    this.sql.exec('INSERT INTO receipts VALUES (?)', source.id);
    this.sql.exec('INSERT INTO fingerprints VALUES (?)', parsed.dedupeKey);
    return event;
  }

  private upsertThread(id: string, subjectNorm: string, subjectKey: string, createdAt: number) {
    this.sql.exec(`INSERT INTO threads (id, subject_norm, last_date, count, assigned, subject_key) VALUES (?, ?, ?, 1, 1, ?)
      ON CONFLICT(id) DO UPDATE SET count = count + 1, assigned = assigned + 1, last_date = max(last_date, excluded.last_date),
      subject_key = CASE WHEN subject_key = '' THEN excluded.subject_key ELSE subject_key END`, id, subjectNorm, createdAt, subjectKey);
  }

  private insertSearchDisplay(id: string, rowid: number, parsed: ParsedMail | Prepared) {
    const display = parsed.display;
    const searchBody = display ? normalizeSearch(parsed.body) : parsed.body;
    let names: string;
    if (display) {
      // Keep the existing filename-character budget; the separators add at
      // most two extra characters per indexed attachment.
      let remaining = 8192;
      const bounded = parsed.attachments.flatMap(({ name }) => {
        if (remaining <= 0) return [];
        const clipped = name.slice(0, remaining);
        remaining -= clipped.length + 1;
        return [clipped];
      });
      names = normalizeSearch(bounded.join(` ${ATTACHMENT_SEARCH_BOUNDARY} `));
    } else names = parsed.attachments.map(a => a.name).join(' ').slice(0, 8192);
    this.sql.exec('INSERT INTO fts(rowid, id, subject, addresses, body, attachment_names) VALUES (?, ?, ?, ?, ?, ?)',
      rowid, id, display?.searchSubject ?? parsed.subject,
      display ? `${display.searchFrom} ${display.searchTo}`.slice(0, 16_384) : `${parsed.sender} ${parsed.to} ${parsed.cc}`,
      searchBody, names);
    if (display) this.sql.exec('INSERT OR REPLACE INTO mailbox_api_display VALUES (?, ?, ?)', id, JSON.stringify(display),
      searchBody === parsed.body ? null : parsed.body);
  }

  private insertDerived(id: string, rowid: number, parsed: Prepared) {
    this.insertSearchDisplay(id, rowid, parsed);
    for (const attachment of parsed.attachments) {
      this.sql.exec('INSERT OR REPLACE INTO attachments VALUES (?, ?, ?, ?, ?, ?)', id, attachment.part, attachment.name,
        attachment.mimeType, attachment.size, attachment.key);
    }
  }

  // Restore inserts non-derived message state only. Text, attachments and FTS
  // are rebuilt from the digest-verified raw message by reindex() afterwards.
  private insertRestoredMessage(m: MessageEvent, flags = 0, gmailId: string | null = null) {
    this.sql.exec(`INSERT INTO messages
      (id, raw_key, size, sent_date, sender, recipients, cc, subject, snippet, thread_id, flags, internal_date,
       gmail_id, message_id, dedupe_key, auth, att_keys, indexed) VALUES (?, ?, 0, NULL, '', '', '', '', '', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    m.id, m.rawKey, m.threadId, flags, m.createdAt, gmailId, messageIdOf(m.dedupeKey), m.dedupeKey, m.auth, JSON.stringify(m.attKeys));
    this.sql.exec('INSERT OR IGNORE INTO receipts VALUES (?)', m.id);
    this.sql.exec('INSERT OR IGNORE INTO fingerprints VALUES (?)', m.dedupeKey);
  }

  unindexed(after: string, limit: number): Array<{ id: string; rawKey: string }> {
    return this.sql.exec<{ id: string; rawKey: string }>(
      'SELECT id, raw_key AS rawKey FROM messages WHERE indexed = 0 AND id > ? ORDER BY id LIMIT ?', after, limit).toArray();
  }

  private pendingReindex(id: string): boolean {
    return this.sql.exec('SELECT 1 FROM messages WHERE id = ? AND indexed = 0', id).toArray().length > 0;
  }

  // Rebuilds the derived columns of one restored message. Holders use the same
  // per-message holder ID, so re-holding a live reference is a no-op.
  async reindex(id: string, rawKey: string): Promise<void> {
    let prepared: Prepared;
    try {
      prepared = await this.holdAndStore({ id, rawKey, createdAt: 0 }, await this.parse(rawKey));
    } catch (error) {
      if (!this.pendingReindex(id)) return; // Purged meanwhile.
      if (!(error instanceof PermanentMailError)) throw error;
      this.sql.exec('UPDATE messages SET indexed = 2 WHERE id = ? AND indexed = 0', id);
      return;
    }
    const kept = this.storage.transactionSync(() => {
      const row = this.sql.exec<{ rowid: number; threadId: string; attKeys: string }>(
        'SELECT rowid, thread_id AS threadId, att_keys AS attKeys FROM messages WHERE id = ? AND indexed = 0', id).toArray()[0];
      if (!row) return false;
      const attKeys = new Set<string>(JSON.parse(row.attKeys) as string[]);
      for (const a of prepared.attachments) if (a.key) attKeys.add(a.key);
      this.sql.exec(`UPDATE messages SET size = ?, sent_date = ?, sender = ?, recipients = ?, cc = ?, subject = ?, snippet = ?,
        message_id = ?, att_keys = ?, indexed = 1 WHERE id = ?`, prepared.size, prepared.sentDate, prepared.sender, prepared.to,
      prepared.cc, prepared.subject, prepared.snippet, prepared.messageId, JSON.stringify([...attKeys]), id);
      this.insertDerived(id, row.rowid, prepared);
      // Members of a thread share its normalized subject, so any member can restore it.
      this.sql.exec(`UPDATE threads SET subject_norm = CASE WHEN subject_norm = '' THEN ?1 ELSE subject_norm END,
        subject_key = CASE WHEN subject_key = '' THEN ?2 ELSE subject_key END WHERE id = ?3`, prepared.subjectNorm, prepared.subjectKey, row.threadId);
      return true;
    });
    if (!kept && !this.sql.exec('SELECT 1 FROM messages WHERE id = ?', id).toArray().length) {
      // Purged while its objects were being held again: drop those holds.
      const keys = new Set([rawKey, ...prepared.attachments.flatMap(a => a.key ? [a.key] : [])]);
      for (const key of keys) await this.objects.release(key, this.referenceFor(id));
    }
  }

  search(query: string): string[] {
    const token = query.trim();
    if (!token || token.length > 256) return [];
    return this.sql.exec<{ id: string }>('SELECT id FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT 50',
      `"${token.replaceAll('"', '""')}"`).toArray().map(row => row.id);
  }

  setLabel(id: string, name: string) { this.change({ type: 'label', id, name }); }
  setFlags(id: string, flags: number, labels: string[]) { this.change({ type: 'flags', id, flags, labels }); }
  setBayes(token: string, ham: number, spam: number) { this.change({ type: 'bayes', token, ham, spam }); }
  setSetting(kind: 'filter' | 'send-as', id: string, definition: string) { this.change({ type: 'setting', kind, id, definition }); }

  async emptyTrash(limit = 64): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error('Invalid purge limit');
    const candidates = this.sql.exec<{ id: string }>(`SELECT m.id FROM message_labels l
      JOIN messages m ON m.id = l.message_id WHERE l.label_id = ? ORDER BY l.message_id LIMIT ?`, trashLabel, limit).toArray();
    // No awaits during removal: a concurrent change cannot rescue a message after selection.
    const releases = this.storage.transactionSync(() => candidates.map(({ id }) => {
      const keys = this.messageObjectKeys(id);
      const event = { type: 'purge', id } as const;
      this.apply(event);
      this.journal.append(event);
      return { id, keys: new Set(keys) };
    }));
    for (const { id, keys } of releases) for (const key of keys) await this.objects.release(key, this.referenceFor(id));
    return candidates.length;
  }

  async readObject(key: string): Promise<Uint8Array<ArrayBuffer>> { return this.objects.get(key); }

  // M1 rows already have attachment links, so hydrate only the derived text
  // and display projection. Do not re-register or rewrite object holders.
  async hydrateApiDisplay(id: string, rawKey: string): Promise<void> {
    let parsed: ParsedMail;
    try { parsed = await this.parse(rawKey); }
    catch (error) {
      // A verified missing or invalid raw object cannot enrich this legacy
      // row. Keep its existing index and let the rest of the thread load.
      if (error instanceof PermanentMailError) return;
      throw error;
    }
    if (!parsed.display) throw new Error('API mailbox display is disabled');
    this.storage.transactionSync(() => {
      const row = this.sql.exec<{ rowid: number }>(`SELECT m.rowid FROM messages m WHERE m.id = ? AND m.raw_key = ? AND m.indexed = 1
        AND NOT EXISTS (SELECT 1 FROM mailbox_api_display d WHERE d.id = m.id)`, id, rawKey).toArray()[0];
      if (!row) return;
      this.sql.exec('DELETE FROM fts WHERE rowid = ?', row.rowid);
      this.insertSearchDisplay(id, row.rowid, parsed);
    });
  }

  async prepareApiDraft(id: string, bytes: Uint8Array<ArrayBuffer>, updatedAt: number, attachmentKeys: string[] = []): Promise<ApiDraftRef> {
    if (!bytes.byteLength || bytes.byteLength > MAX_RAW_BYTES || !this.objects.holdProvisional) throw new Error('Invalid draft storage');
    const revision = crypto.randomUUID();
    const holder = `draft:${this.holderScope}:${id}:${revision}`;
    const rawKey = await this.objects.holdProvisional({ kind: 'raw', digest: await sha256(bytes) }, holder);
    try {
      for (const key of attachmentKeys) await this.objects.holdProvisional({ key }, holder);
      await this.objects.put(rawKey, bytes);
    } catch (error) { await this.releaseDraft({ rawKey, holder }, attachmentKeys); throw error; }
    return { id, rawKey, holder, revision, updatedAt };
  }

  async releaseDraft(ref: Pick<ApiDraftRef, 'rawKey' | 'holder'>, attachments: string[] = []): Promise<void> {
    // Only preparations or commits known to have failed release here.
    for (const key of new Set([ref.rawKey, ...attachments])) await this.objects.release(key, ref.holder).catch(() => {});
  }

  async prepareUpload(id: string, digest: string, size: number, bytes: ReadableStream<Uint8Array>, remaining: () => number):
    Promise<{ objectKey: string; holder: string }> {
    if (!this.objects.putUpload || !this.objects.holdProvisional) throw new Error('Upload storage unavailable');
    const holder = `upload:${this.holderScope}:${id}`;
    const objectKey = await this.objects.holdProvisional({ kind: 'att', digest }, holder);
    try {
      const timeoutMs = remaining();
      if (timeoutMs <= 0) throw new Error('Upload lease expired before PUT');
      await this.objects.putUpload(objectKey, bytes, size, digest, timeoutMs);
    } catch (error) { await this.releaseUpload(holder, objectKey); throw error; }
    return { objectKey, holder };
  }

  async releaseUpload(holder: string, key: string): Promise<void> {
    await this.objects.release(key, holder).catch(() => {});
  }

  // Caller holds the work lane; membership/validation and all events commit together.
  changeMany(events: Iterable<Exclude<JournalEvent, MessageEvent>>, after?: () => void): void {
    this.storage.transactionSync(() => { this.commitEvents(events); after?.(); });
  }

  // Also usable in an existing synchronous timer transaction.
  commitEvents(events: Iterable<Exclude<JournalEvent, MessageEvent>>): void {
    for (const event of events) { this.apply(event); this.journal.append(event); }
  }

  enqueueRelease(seq: number, key: string, holder: string): void {
    if (!count(seq) || seq === 0 || !isObjectKey(key) || !bounded(holder, 256)) throw new Error('Invalid pending holder release');
    this.sql.exec('INSERT OR IGNORE INTO mailbox_pending_releases(seq, object_key, holder) VALUES (?, ?, ?)', seq, key, holder);
  }

  private enqueueConfirmation(seq: number, key: string, holder: string, publishedAt: number | null = null): PendingConfirmation {
    if (!count(seq) || seq === 0 || typeof key !== 'string' || !parseObjectKey(key) || !bounded(holder, 256) ||
        (publishedAt !== null && !count(publishedAt))) throw new Error('Invalid pending holder confirmation');
    this.sql.exec('INSERT OR IGNORE INTO mailbox_pending_confirmations(seq, object_key, holder, published_at) VALUES (?, ?, ?, ?)',
      seq, key, holder, publishedAt);
    return { seq, key, holder, publishedAt };
  }

  coverConfirmations(through: number, now: number): void {
    this.sql.exec(`UPDATE mailbox_pending_confirmations SET published_at = ?
      WHERE seq <= ? AND published_at IS NULL`, now, through);
  }

  pendingConfirmations(through: number): PendingConfirmation[] {
    return this.sql.exec<PendingConfirmation>(`SELECT seq, object_key AS key, holder, published_at AS publishedAt
      FROM mailbox_pending_confirmations WHERE seq <= ? ORDER BY seq, object_key, holder LIMIT ?`,
    through, HOLDER_CONFIRM_BATCH).toArray();
  }

  pendingRestoreConfirmations(after: HolderConfirmationCursor = [0, '', '']): PendingConfirmation[] {
    return this.sql.exec<PendingConfirmation>(`SELECT seq, object_key AS key, holder, published_at AS publishedAt
      FROM mailbox_pending_confirmations WHERE published_at IS NOT NULL AND lost_at IS NULL
      AND (seq, object_key, holder) > (?, ?, ?) ORDER BY seq, object_key, holder LIMIT ?`,
    ...after, HOLDER_CONFIRM_BATCH).toArray();
  }

  finishConfirmations(rows: PendingConfirmation[], answers: ConfirmAnswer[], restoring: boolean): void {
    if (answers.length !== rows.length || answers.some(answer =>
      answer !== 'held' && answer !== 'rehold' && answer !== 'released' && answer !== 'lost')) throw new Error('Invalid holder confirmation response');
    const metrics = this.storage.transactionSync(() => {
      const counts = { holder_rehold: 0, holder_released: 0, holder_lost_unreferenced: 0 };
      for (const [i, { seq, key, holder }] of rows.entries()) {
        const answer = answers[i];
        // Recovery must not write an event into the restored journal history.
        if (answer === 'lost' && restoring) {
          this.sql.exec(`UPDATE mailbox_pending_confirmations SET lost_at = ?
            WHERE seq = ? AND object_key = ? AND holder = ? AND lost_at IS NULL`, Date.now(), seq, key, holder);
          continue;
        }
        const removed = this.sql.exec(`DELETE FROM mailbox_pending_confirmations
          WHERE seq = ? AND object_key = ? AND holder = ?`, seq, key, holder).rowsWritten;
        if (removed !== 1) continue;
        if (answer === 'rehold') counts.holder_rehold++;
        else if (answer === 'released') counts.holder_released++;
        else if (answer === 'lost' && !this.markLostSource(key, holder)) counts.holder_lost_unreferenced++;
      }
      return counts;
    });
    for (const [code, total] of Object.entries(metrics)) if (total) console.info({ code, count: total });
  }

  private markLostSource(key: string, holder: string): boolean {
    const upload = this.sql.exec<{ id: string }>('SELECT id FROM mailbox_api_uploads WHERE holder = ? AND object_key = ?', holder, key).toArray().at(0);
    const draft = !upload && this.sql.exec<{ id: string }>(`SELECT d.id FROM drafts d WHERE d.holder = ? AND
      (d.raw_key = ? OR EXISTS (SELECT 1 FROM mailbox_api_draft_objects a WHERE a.draft_id = d.id AND a.object_key = ?))`, holder, key, key).toArray()[0];
    // A pending send keeps referencing its draft revision and its objects (section 2.7).
    // A cancelled send never reads them again; its restored draft, or a later send of it, holds the reference.
    const send = !upload && !draft && this.sql.exec<{ id: string }>(`SELECT s.id FROM mailbox_sends s WHERE s.holder = ?
      AND s.state <> 'cancelled' AND (s.finish_pending = 1 OR s.state NOT IN ('sent', 'partial', 'failed'))
      AND (json_extract(s.record, '$.draft.rawKey') = ? OR EXISTS (SELECT 1 FROM json_each(s.record, '$.attachmentKeys') k WHERE k.value = ?))`,
    holder, key, key).toArray()[0];
    const id = upload?.id ?? (draft ? draft.id : send ? send.id : undefined);
    if (!id) return false;
    const kind = upload ? 'upload' : draft ? 'draft' : 'send';
    if (!this.sql.exec('SELECT 1 FROM mailbox_unusable_sources WHERE kind = ? AND id = ? AND holder = ?', kind, id, holder).toArray().length) {
      this.commitEvents([{ type: 'api_source_lost', kind, id, holder }]);
    }
    return true;
  }

  private deferDraftRelease(id: string): void {
    const previous = this.sql.exec<{ key: string; holder: string }>('SELECT raw_key AS key, holder FROM drafts WHERE id = ?', id).toArray()[0];
    if (!previous) return;
    const seq = this.journal.revision() + 1;
    this.enqueueRelease(seq, previous.key, previous.holder);
    for (const { key } of this.sql.exec<{ key: string }>('SELECT object_key AS key FROM mailbox_api_draft_objects WHERE draft_id = ?', id)) {
      this.enqueueRelease(seq, key, previous.holder);
    }
  }

  pruneApiKeys(now: number): void {
    this.storage.transactionSync(() => {
      // Rows written before M3-2 have no timer unless restored. Preserve the
      // legacy cleanup for those rows, not for a key owned by idem_expiry.
      this.sql.exec(`DELETE FROM mailbox_api_idempotency WHERE key IN (SELECT k.key FROM mailbox_api_idempotency k
        WHERE expires_at <= ? AND NOT EXISTS (SELECT 1 FROM timers WHERE kind = ? AND ref = k.key)
          AND json_extract(result, '$.status') IS NULL
        ORDER BY expires_at, k.key LIMIT 64)`, now, IDEM_EXPIRY);
      this.sql.exec(`DELETE FROM mailbox_api_in_progress WHERE key IN (SELECT key FROM mailbox_api_in_progress
        WHERE expires_at <= ? ORDER BY expires_at, key LIMIT 64)`, now);
    });
  }

  private change(event: Exclude<JournalEvent, MessageEvent>) { this.changeMany([event]); }

  private apply(event: Exclude<JournalEvent, MessageEvent>, snapshot = false) {
    switch (event.type) {
      case 'receipt':
        if (!isDeliveryId(event.id)) throw new Error('Invalid receipt');
        this.sql.exec('INSERT INTO receipts VALUES (?)', event.id);
        break;
      case 'label':
        if (!bounded(event.id, 256) || !bounded(event.name, 512)) throw new Error('Invalid label');
        this.sql.exec('INSERT INTO labels VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name', event.id, event.name);
        break;
      case 'label_delete':
        if (!bounded(event.id, 256)) throw new Error('Invalid label deletion');
        this.sql.exec('DELETE FROM message_labels WHERE label_id = ?', event.id);
        this.sql.exec('DELETE FROM labels WHERE id = ?', event.id);
        break;
      case 'api_settings':
        if (!bounded(event.definition, 64 * 1024)) throw new Error('Invalid API settings');
        JSON.parse(event.definition);
        this.sql.exec('INSERT OR REPLACE INTO mailbox_api_settings VALUES (1, ?)', event.definition);
        break;
      case 'api_result':
        if (!bounded(event.key, 64) || !SUBJECT_KEY.test(event.fingerprint) || !count(event.expiresAt) || !bounded(event.result, 4096)) {
          throw new Error('Invalid API result');
        }
        JSON.parse(event.result);
        this.sql.exec('INSERT OR REPLACE INTO mailbox_api_idempotency VALUES (?, ?, ?, ?)', event.key, event.fingerprint, event.expiresAt, event.result);
        break;
      case 'api_result_expire':
        if (!bounded(event.key, 64) || !count(event.expiresAt)) throw new Error('Invalid API result expiry');
        this.sql.exec('DELETE FROM mailbox_api_idempotency WHERE key = ? AND expires_at = ?', event.key, event.expiresAt);
        break;
      case 'api_upload':
        if (!bounded(event.id, 64) || typeof event.objectKey !== 'string' || parseObjectKey(event.objectKey)?.kind !== 'att' ||
            !bounded(event.name, 255) || !bounded(event.mediaType, 127) || !count(event.size) || event.size > LIMITS.uploadBytes ||
            !count(event.expiresAt) || event.expiresAt === 0) throw new Error('Invalid API upload');
        if (event.holder !== undefined && !bounded(event.holder, 256)) throw new Error('Invalid upload holder');
        this.sql.exec('INSERT INTO mailbox_api_uploads VALUES (?, ?, ?, ?, ?, ?, ?)', event.id, event.objectKey, event.name,
          event.mediaType, event.size, event.expiresAt, event.holder ?? `upload:${event.id}`);
        if (!snapshot && event.holder !== undefined) this.enqueueConfirmation(this.journal.revision() + 1, event.objectKey, event.holder);
        break;
      case 'api_upload_delete': {
        if (!bounded(event.id, 64) || typeof event.objectKey !== 'string' || parseObjectKey(event.objectKey)?.kind !== 'att') {
          throw new Error('Invalid API upload deletion');
        }
        const removed = this.sql.exec<{ holder: string }>('DELETE FROM mailbox_api_uploads WHERE id = ? AND object_key = ? RETURNING holder',
          event.id, event.objectKey).toArray()[0];
        if (!removed) throw new Error('Missing API upload for deletion');
        this.sql.exec("DELETE FROM mailbox_unusable_sources WHERE kind = 'upload' AND id = ?", event.id);
        this.enqueueRelease(this.journal.revision() + 1, event.objectKey, removed.holder);
        break;
      }
      case 'api_source_lost': {
        if ((event.kind !== 'draft' && event.kind !== 'upload' && event.kind !== 'send') || !bounded(event.id, 256) || !bounded(event.holder, 256)) {
          throw new Error('Invalid unusable source');
        }
        const table = event.kind === 'draft' ? 'drafts' : event.kind === 'send' ? 'mailbox_sends' : 'mailbox_api_uploads';
        const marked = this.sql.exec(`INSERT OR REPLACE INTO mailbox_unusable_sources(kind, id, holder)
          SELECT ?, id, holder FROM ${table} WHERE id = ? AND holder = ?`, event.kind, event.id, event.holder);
        // A concurrent delete must not cancel an alert that has yet to be accepted.
        if (marked.rowsWritten) this.sql.exec("INSERT OR IGNORE INTO mailbox_alerts(code, since) VALUES ('holder_source_lost', ?)", Date.now());
        break;
      }
      case 'setting':
        if ((event.kind !== 'filter' && event.kind !== 'send-as') || !bounded(event.id, 256) || !bounded(event.definition, 8192)) {
          throw new Error('Invalid mailbox setting');
        }
        JSON.parse(event.definition);
        this.sql.exec('INSERT INTO settings VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET definition=excluded.definition',
          event.kind, event.id, event.definition);
        break;
      case 'flags': {
        if (!isDeliveryId(event.id) || !count(event.flags) || !Array.isArray(event.labels) || event.labels.length > 64 ||
            event.labels.some(id => !bounded(id, 256))) throw new Error('Invalid flags');
        const updated = this.sql.exec('UPDATE messages SET flags = ? WHERE id = ?', event.flags, event.id);
        if (!updated.rowsWritten) throw new Error('Missing message for flag change');
        this.sql.exec('DELETE FROM message_labels WHERE message_id = ?', event.id);
        for (const id of new Set(event.labels)) this.sql.exec('INSERT INTO message_labels VALUES (?, ?)', event.id, id);
        if (event.expiresAt === null) this.sql.exec('DELETE FROM mailbox_api_expiry WHERE id = ?', event.id);
        else if (event.expiresAt !== undefined) {
          if (!count(event.expiresAt)) throw new Error('Invalid message expiry');
          this.sql.exec('INSERT OR REPLACE INTO mailbox_api_expiry VALUES (?, ?)', event.id, event.expiresAt);
        }
        break;
      }
      case 'draft': {
        const generated = typeof event.rawKey === 'string' && parseObjectKey(event.rawKey)?.kind === 'raw';
        if (!bounded(event.id, 256) || !bounded(event.holder, 256) || typeof event.rawKey !== 'string' ||
            (!generated && (!event.rawKey.startsWith('drafts/') || !isObjectKey(event.rawKey)))) {
          throw new Error('Invalid draft');
        }
        if (event.attachmentKeys !== undefined || event.uploadIds !== undefined) {
          if (!Array.isArray(event.attachmentKeys) || event.attachmentKeys.length > LIMITS.attachmentsPerMessage ||
              event.attachmentKeys.some(key => typeof key !== 'string' || !parseObjectKey(key)) ||
              !Array.isArray(event.uploadIds) || event.uploadIds.length > LIMITS.attachmentsPerMessage ||
              event.uploadIds.some(id => !bounded(id, 64))) throw new Error('Invalid draft attachments');
          if (!snapshot) this.deferDraftRelease(event.id);
        }
        this.sql.exec("DELETE FROM mailbox_unusable_sources WHERE kind = 'draft' AND id = ?", event.id);
        this.sql.exec('INSERT INTO drafts VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET raw_key=excluded.raw_key, holder=excluded.holder',
          event.id, event.rawKey, event.holder);
        if (event.attachmentKeys && event.uploadIds) {
          this.sql.exec('DELETE FROM mailbox_api_draft_objects WHERE draft_id = ?', event.id);
          this.sql.exec('DELETE FROM mailbox_api_draft_uploads WHERE draft_id = ?', event.id);
          for (const key of new Set(event.attachmentKeys)) this.sql.exec('INSERT INTO mailbox_api_draft_objects VALUES (?, ?)', event.id, key);
          for (const id of new Set(event.uploadIds)) this.sql.exec('INSERT INTO mailbox_api_draft_uploads VALUES (?, ?)', event.id, id);
        }
        if (event.revision != null || event.updatedAt != null) {
          if (!bounded(event.revision, 64) || !count(event.updatedAt)) throw new Error('Invalid API draft metadata');
          this.sql.exec('INSERT OR REPLACE INTO mailbox_api_drafts VALUES (?, ?, ?)', event.id, event.revision, event.updatedAt);
        }
        if (!snapshot && generated) {
          const seq = this.journal.revision() + 1;
          for (const key of new Set([event.rawKey, ...(event.attachmentKeys ?? [])])) this.enqueueConfirmation(seq, key, event.holder);
        }
        break;
      }
      case 'draft_delete':
        if (!bounded(event.id, 256)) throw new Error('Invalid draft deletion');
        if (event.deferRelease) this.deferDraftRelease(event.id);
        this.sql.exec("DELETE FROM mailbox_unusable_sources WHERE kind = 'draft' AND id = ?", event.id);
        this.sql.exec('DELETE FROM drafts WHERE id = ?', event.id);
        break;
      case 'bayes':
        if (!bounded(event.token, 256) || !count(event.ham) || !count(event.spam)) throw new Error('Invalid Bayes counts');
        this.sql.exec('INSERT INTO bayes VALUES (?, ?, ?) ON CONFLICT(token) DO UPDATE SET ham=excluded.ham, spam=excluded.spam',
          event.token, event.ham, event.spam);
        break;
      case 'purge': {
        const row = this.sql.exec<{ rowid: number; threadId: string }>('SELECT rowid, thread_id AS threadId FROM messages WHERE id = ?', event.id).one();
        this.sql.exec('DELETE FROM fts WHERE rowid = ?', row.rowid);
        this.sql.exec('DELETE FROM message_labels WHERE message_id = ?', event.id);
        this.sql.exec('DELETE FROM attachments WHERE message_id = ?', event.id);
        this.sql.exec('DELETE FROM messages WHERE id = ?', event.id);
        this.sql.exec('UPDATE threads SET count = count - 1 WHERE id = ?', row.threadId);
        // Receipts and fingerprints survive deletion: stale queue retries cannot resurrect it.
        break;
      }
      case 'send_create': {
        const { send, result } = event;
        checkSendRecord(send);
        this.sql.exec(`INSERT INTO mailbox_sends (id, draft_id, state, created_at, undo_until, holder, record, created_seq, finish_pending)
          VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, 0)`, send.id, send.draftId, send.createdAt, send.undoUntil, send.draft.holder,
        JSON.stringify(send), this.journal.revision() + 1);
        for (const id of new Set(send.uploadIds)) this.sql.exec('INSERT INTO mailbox_send_uploads VALUES (?, ?)', send.id, id);
        // The send keeps the revision, its objects and their pending
        // confirmations: deleting the draft row releases nothing (section 2.7).
        this.sql.exec("DELETE FROM mailbox_unusable_sources WHERE kind = 'draft' AND id = ?", send.draftId);
        this.sql.exec('DELETE FROM drafts WHERE id = ?', send.draftId);
        this.apply({ type: 'api_result', ...result });
        break;
      }
      case 'send_undo': {
        const row = validSendId(event.id) ? sendRow(this.sql, event.id) : undefined;
        if (!row || row.state !== 'pending' || !bounded(event.revision, 64) || !count(event.updatedAt)) throw new Error('Invalid send undo');
        const seq = this.journal.revision() + 1;
        this.sql.exec(`UPDATE mailbox_sends SET state = 'cancelled', finish_pending = 1, terminal_seq = ? WHERE id = ?`, seq, row.id);
        const { draft, attachmentKeys, uploadIds } = row.record;
        this.sql.exec('INSERT INTO drafts VALUES (?, ?, ?)', row.draftId, draft.rawKey, draft.holder);
        this.sql.exec('INSERT INTO mailbox_api_drafts VALUES (?, ?, ?)', row.draftId, event.revision, event.updatedAt);
        for (const key of new Set(attachmentKeys)) this.sql.exec('INSERT INTO mailbox_api_draft_objects VALUES (?, ?)', row.draftId, key);
        for (const id of new Set(uploadIds)) this.sql.exec('INSERT INTO mailbox_api_draft_uploads VALUES (?, ?)', row.draftId, id);
        // The restored draft takes over the send's references.
        this.sql.exec('DELETE FROM mailbox_send_uploads WHERE send_id = ?', row.id);
        this.sql.exec(`INSERT OR REPLACE INTO mailbox_unusable_sources(kind, id, holder)
          SELECT 'draft', ?, holder FROM mailbox_unusable_sources WHERE kind = 'send' AND id = ?`, row.draftId, row.id);
        this.sql.exec("DELETE FROM mailbox_unusable_sources WHERE kind = 'send' AND id = ?", row.id);
        this.apply({ type: 'api_result', ...event.result });
        break;
      }
      case 'send_release': {
        const row = validSendId(event.id) ? sendRow(this.sql, event.id) : undefined;
        if (!row || row.state !== 'pending') throw new Error('Invalid send release');
        this.sql.exec(`UPDATE mailbox_sends SET state = 'releasing', release_seq = ? WHERE id = ?`, this.journal.revision() + 1, row.id);
        break;
      }
      case 'send_queued': {
        // Replay: the sent copy's non-derived row; reindex rebuilds the rest.
        const message = { ...event.message, type: 'message' as const };
        const { flags } = event.message;
        delete (message as Partial<SentCopy>).flags;
        validMessage(message);
        if (!count(flags)) throw new Error('Invalid sent copy');
        this.queuedState(event.id, message.id, event.kinds);
        this.upsertThread(message.threadId, '', message.subjectKey, message.createdAt);
        this.insertRestoredMessage(message, flags);
        break;
      }
      case 'send_fail': {
        const row = validSendId(event.id) ? sendRow(this.sql, event.id) : undefined;
        if (!row || (row.state !== 'releasing' && row.state !== 'pending') || !SEND_FAILURES.includes(event.reason)) throw new Error('Invalid send failure');
        checkKinds(event.kinds, row.record);
        this.sql.exec(`UPDATE mailbox_sends SET state = 'failed', reason = ?, finish_pending = 1, terminal_seq = ? WHERE id = ?`,
          event.reason, this.journal.revision() + 1, row.id);
        this.sql.exec('DELETE FROM mailbox_send_recipients WHERE send_id = ?', row.id);
        for (const [idx, kind] of event.kinds.entries()) {
          this.sql.exec(`INSERT INTO mailbox_send_recipients VALUES (?, ?, ?, 'failed', ?)`, row.id, idx, kind, event.reason);
        }
        break;
      }
      case 'send_finish': {
        const row = validSendId(event.id) ? sendRow(this.sql, event.id) : undefined;
        if (!row || !row.finishPending || !TERMINAL.includes(row.state)) throw new Error('Invalid send finish');
        this.sql.exec('UPDATE mailbox_sends SET finish_pending = 0 WHERE id = ?', row.id);
        // A cancelled send's restored draft keeps these holders; otherwise they
        // go after this event is published, like any draft revision's.
        if (row.state !== 'cancelled') {
          const seq = this.journal.revision() + 1;
          for (const key of new Set([row.record.draft.rawKey, ...row.record.attachmentKeys])) this.enqueueRelease(seq, key, row.holder);
        }
        this.sql.exec('DELETE FROM mailbox_send_uploads WHERE send_id = ?', row.id);
        this.sql.exec("DELETE FROM mailbox_unusable_sources WHERE kind = 'send' AND id = ?", row.id);
        break;
      }
      case 'send_window': {
        const row = validSendId(event.id) ? sendRow(this.sql, event.id) : undefined;
        if (!row || row.state !== 'pending' || !count(event.undoUntil) || event.undoUntil < row.undoUntil) throw new Error('Invalid send window');
        this.sql.exec('UPDATE mailbox_sends SET undo_until = ? WHERE id = ?', event.undoUntil, row.id);
        break;
      }
      default: throw new Error('Unexpected journal event');
    }
  }

  // Release step 4's state change, shared by the live commit and replay.
  private queuedState(id: string, messageId: string, kinds: SendRecipientKind[]): void {
    const row = validSendId(id) ? sendRow(this.sql, id) : undefined;
    if (!row || row.state !== 'releasing' || messageId !== sentCopyId(row.id)) throw new Error('Invalid queued send');
    checkKinds(kinds, row.record);
    this.sql.exec(`UPDATE mailbox_sends SET state = 'queued', message_id = ?, queued_seq = ? WHERE id = ?`,
      messageId, this.journal.revision() + 1, row.id);
    this.sql.exec('DELETE FROM mailbox_send_recipients WHERE send_id = ?', row.id);
    for (const [idx, kind] of kinds.entries()) this.sql.exec(`INSERT INTO mailbox_send_recipients VALUES (?, ?, ?, 'pending', NULL)`, row.id, idx, kind);
  }

  // Release step 4 (section 2.4), inside the caller's transaction: the sent
  // copy's index row, fully derived from its verified bytes, the ledger and
  // `queued`, journalled as one event. Every attachment stays inside the
  // stored message: the send's registration covers every holder it needs.
  commitSentCopy(id: string, rawKey: string, createdAt: number, parsed: ParsedMail, flags: number, kinds: SendRecipientKind[]): void {
    const messageId = sentCopyId(id);
    if (this.sql.exec('SELECT 1 FROM messages WHERE id = ?', messageId).toArray().length) throw new Error('Sent copy already indexed');
    const prepared: Prepared = { ...parsed, attachments: parsed.attachments.map(({ external: _external, ...attachment }) => ({ ...attachment, key: null })) };
    const { type: _type, ...message } = this.insertMessage({ id: messageId, rawKey, createdAt }, prepared, 'none');
    this.sql.exec('UPDATE messages SET flags = ? WHERE id = ?', flags, messageId);
    const event: JournalEvent = { type: 'send_queued', id, message: { ...message, flags }, kinds };
    this.queuedState(id, messageId, kinds);
    this.journal.append(event);
  }

  // Every object a message holds, including attachment generations recorded
  // before its derived rows were rebuilt.
  messageObjectKeys(id: string): string[] {
    const message = this.sql.exec<{ key: string; attKeys: string }>(
      'SELECT raw_key AS key, att_keys AS attKeys FROM messages WHERE id = ?', id).toArray()[0];
    if (!message) return [];
    const keys = new Set([message.key, ...JSON.parse(message.attKeys) as string[]]);
    for (const row of this.sql.exec<{ key: string }>(
      'SELECT object_key AS key FROM attachments WHERE message_id = ? AND object_key IS NOT NULL ORDER BY part', id)) keys.add(row.key);
    return [...keys];
  }

  nonDerivedPage(table: SnapshotTable, after: string) {
    switch (table) {
      case 'messages': return this.sql.exec<{ id: string; rawKey: string; flags: number; gmailId: string | null; internalDate: number }>(
        `SELECT id, raw_key AS rawKey, flags, gmail_id AS gmailId, internal_date AS internalDate, thread_id AS threadId, auth
         FROM messages WHERE id > ? ORDER BY id LIMIT 64`, after)
        .toArray().map(row => ({ ...row, labels: this.sql.exec<{ label: string }>(
          'SELECT label_id AS label FROM message_labels WHERE message_id = ? ORDER BY label_id', row.id).toArray().map(x => x.label) }));
      case 'labels': return this.sql.exec('SELECT id, name FROM labels WHERE id > ? ORDER BY id LIMIT 64', after).toArray();
      case 'drafts': return this.sql.exec('SELECT id, raw_key AS rawKey, holder FROM drafts WHERE id > ? ORDER BY id LIMIT 64', after).toArray();
      case 'bayes': return this.sql.exec('SELECT token AS id, ham, spam FROM bayes WHERE token > ? ORDER BY token LIMIT 64', after).toArray();
      case 'settings': return this.sql.exec('SELECT kind, id, definition FROM settings ORDER BY kind, id LIMIT 64').toArray();
    }
  }

  // Stage the non-derived snapshot in SQLite without holding a mailbox write lock
  // over R2 requests. The staged rows are immutable until the next capture.
  captureSnapshot(): number {
    return this.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM backup_capture');
      this.sql.exec(`INSERT INTO backup_capture(kind, value)
        SELECT 'label', json_object('id', id, 'name', name) FROM labels;
        INSERT INTO backup_capture(kind, value)
        SELECT 'message', json_object('id', id, 'rawKey', raw_key, 'createdAt', internal_date, 'threadId', thread_id,
          'flags', flags, 'gmailId', gmail_id, 'dedupeKey', dedupe_key, 'auth', auth, 'attKeys', json(att_keys),
          'expiresAt', (SELECT expires_at FROM mailbox_api_expiry WHERE id = m.id),
          'labels', json((SELECT json_group_array(label_id) FROM message_labels WHERE message_id = m.id)))
        FROM messages AS m;
        INSERT INTO backup_capture(kind, value)
        SELECT 'thread', json_object('id', id, 'assigned', assigned, 'lastDate', last_date, 'count', count, 'subjectKey', subject_key)
        FROM threads WHERE count > 0;
        INSERT INTO backup_capture(kind, value)
        SELECT 'api_upload', json_object('id', id, 'objectKey', object_key, 'name', name, 'mediaType', media_type,
          'size', size, 'expiresAt', expires_at, 'holder', holder) FROM mailbox_api_uploads;
        INSERT INTO backup_capture(kind, value)
        SELECT 'draft', json_object('id', d.id, 'rawKey', d.raw_key, 'holder', d.holder, 'revision', a.revision, 'updatedAt', a.updated_at,
          'attachmentKeys', json((SELECT json_group_array(object_key) FROM mailbox_api_draft_objects WHERE draft_id = d.id)),
          'uploadIds', json((SELECT json_group_array(upload_id) FROM mailbox_api_draft_uploads WHERE draft_id = d.id)))
        FROM drafts d LEFT JOIN mailbox_api_drafts a ON a.id = d.id;
        INSERT INTO backup_capture(kind, value)
        SELECT 'send', json_object('id', id, 'draftId', draft_id, 'state', state, 'createdAt', created_at, 'undoUntil', undo_until,
          'holder', holder, 'record', json(record), 'createdSeq', created_seq, 'releaseSeq', release_seq, 'queuedSeq', queued_seq,
          'terminalSeq', terminal_seq, 'messageId', message_id, 'reason', reason, 'finishPending', finish_pending) FROM mailbox_sends;
        INSERT INTO backup_capture(kind, value)
        SELECT 'send_recipient', json_object('sendId', send_id, 'idx', idx, 'kind', kind, 'state', state, 'reason', reason)
        FROM mailbox_send_recipients;
        INSERT INTO backup_capture(kind, value)
        SELECT 'pending_release', json_object('seq', seq, 'key', object_key, 'holder', holder) FROM mailbox_pending_releases;
        INSERT INTO backup_capture(kind, value)
        SELECT 'pending_confirmation', json_object('seq', seq, 'key', object_key, 'holder', holder, 'publishedAt', published_at)
        FROM mailbox_pending_confirmations;
        INSERT INTO backup_capture(kind, value)
        SELECT 'api_source_lost', json_object('kind', kind, 'id', id, 'holder', holder) FROM mailbox_unusable_sources;
        INSERT INTO backup_capture(kind, value)
        SELECT 'api_settings', json_object('definition', definition) FROM mailbox_api_settings;
        INSERT INTO backup_capture(kind, value)
        SELECT 'api_result', json_object('key', key, 'fingerprint', fingerprint, 'expiresAt', expires_at, 'result', result)
        FROM mailbox_api_idempotency;
        INSERT INTO backup_capture(kind, value)
        SELECT 'bayes', json_object('token', token, 'ham', ham, 'spam', spam) FROM bayes;
        INSERT INTO backup_capture(kind, value)
        SELECT 'setting', json_object('kind', kind, 'id', id, 'definition', definition) FROM settings;
        INSERT INTO backup_capture(kind, value)
        SELECT 'receipt', json_quote(id) FROM receipts;
        INSERT INTO backup_capture(kind, value)
        SELECT 'fingerprint', json_quote(key) FROM fingerprints;`);
      return this.journal.revision();
    });
  }

  snapshotPage(after: number): SnapshotRow[] {
    return this.sql.exec<SnapshotRow>('SELECT row_no, kind, value FROM backup_capture WHERE row_no > ? ORDER BY row_no LIMIT 64', after).toArray();
  }

  clearSnapshot() { this.sql.exec('DELETE FROM backup_capture'); }

  // Call inside the transaction that also records the restore's first phase.
  // Timer rows derive from the state being replaced; the journal_flush row is
  // the restore's own schedule and stays. Each kind rebuilds its rows when the
  // restore finishes.
  resetForRestore() {
    this.sql.exec(`DELETE FROM fts; DELETE FROM message_labels; DELETE FROM attachments; DELETE FROM messages; DELETE FROM threads;
      DELETE FROM receipts; DELETE FROM fingerprints; DELETE FROM labels; DELETE FROM drafts; DELETE FROM bayes;
      DELETE FROM mailbox_api_uploads; DELETE FROM mailbox_pending_releases; DELETE FROM mailbox_pending_confirmations;
      DELETE FROM mailbox_unusable_sources;
      DELETE FROM mailbox_send_recipients; DELETE FROM mailbox_send_uploads; DELETE FROM mailbox_sends;
      DELETE FROM mailbox_send_drivers; DELETE FROM mailbox_send_breaches;
      DELETE FROM settings; DELETE FROM mailbox_api_settings; DELETE FROM mailbox_api_idempotency; DELETE FROM mailbox_api_in_progress;
      DELETE FROM journal; DELETE FROM backup_capture; UPDATE state SET modseq=0, flushed=0 WHERE id=1;`);
    this.sql.exec('DELETE FROM timers WHERE kind <> ?', JOURNAL_FLUSH);
  }

  finishSnapshot(seq: number) {
    this.sql.exec('UPDATE state SET modseq = ?, flushed = ? WHERE id = 1 AND modseq = 0', seq, seq);
    if (this.journal.revision() !== seq) throw new Error('Mailbox snapshot sequence mismatch');
  }

  // Applies one snapshot row. Call inside the transaction that advances the
  // restore cursor, so a resumed restore never applies a row twice.
  restoreSnapshotRow(row: SnapshotRow): PendingConfirmation | undefined {
    const value: unknown = JSON.parse(row.value);
    if (row.kind === 'message') {
      const message = value as SnapshotMessage;
      validMessage({ ...message, type: 'message' }, true);
      if (!count(message.flags) || (message.gmailId !== null && !bounded(message.gmailId, 256))) throw new Error('Invalid snapshot message');
      this.insertRestoredMessage({ ...message, type: 'message' }, 0, message.gmailId);
      this.apply({ type: 'flags', id: message.id, flags: message.flags, labels: message.labels, expiresAt: message.expiresAt });
    } else if (row.kind === 'thread') {
      const thread = value as { id: string; assigned: number; lastDate: number; count: number; subjectKey: string };
      if (!isDeliveryId(thread.id) || !count(thread.assigned) || !count(thread.lastDate) || !count(thread.count) ||
          typeof thread.subjectKey !== 'string' || (thread.subjectKey !== '' && !SUBJECT_KEY.test(thread.subjectKey))) {
        throw new Error('Invalid snapshot thread');
      }
      this.sql.exec(`INSERT INTO threads (id, subject_norm, last_date, count, assigned, subject_key) VALUES (?, '', ?, ?, ?, ?)`,
        thread.id, thread.lastDate, thread.count, thread.assigned, thread.subjectKey);
    } else if (row.kind === 'receipt' || row.kind === 'fingerprint') {
      if (!bounded(value, 2048)) throw new Error('Invalid snapshot key');
      this.sql.exec(`INSERT OR IGNORE INTO ${row.kind === 'receipt' ? 'receipts' : 'fingerprints'} VALUES (?)`, value);
    } else if (row.kind === 'send') {
      const send = value as { id: string; draftId: string; state: string; createdAt: number; undoUntil: number; holder: string;
        record: Parameters<typeof checkSendRecord>[0]; createdSeq: number; releaseSeq: number | null; queuedSeq: number | null;
        terminalSeq: number | null; messageId: string | null; reason: string | null; finishPending: number };
      checkSendRecord(send.record);
      const seqs = [send.releaseSeq, send.queuedSeq, send.terminalSeq];
      if (send.id !== send.record.id || send.draftId !== send.record.draftId || send.holder !== send.record.draft.holder ||
          !['pending', 'releasing', 'queued', 'sending', 'delayed', ...TERMINAL].includes(send.state) || !count(send.createdSeq) ||
          !count(send.undoUntil) || seqs.some(seq => seq !== null && !count(seq)) || (send.finishPending !== 0 && send.finishPending !== 1) ||
          (send.messageId !== null && send.messageId !== sentCopyId(send.id)) ||
          (send.reason !== null && !SEND_FAILURES.includes(send.reason as never))) throw new Error('Invalid snapshot send');
      this.sql.exec('INSERT INTO mailbox_sends VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', send.id, send.draftId, send.state,
        send.createdAt, send.undoUntil, send.holder, JSON.stringify(send.record), send.createdSeq, send.releaseSeq, send.queuedSeq,
        send.terminalSeq, send.messageId, send.reason, send.finishPending);
      const finished = send.finishPending === 0 && TERMINAL.includes(send.state as never);
      if (!finished && send.state !== 'cancelled') {
        for (const id of new Set(send.record.uploadIds)) this.sql.exec('INSERT INTO mailbox_send_uploads VALUES (?, ?)', send.id, id);
      }
    } else if (row.kind === 'send_recipient') {
      const entry = value as { sendId: string; idx: number; kind: string; state: string; reason: string | null };
      if (!validSendId(entry.sendId) || !count(entry.idx) || (entry.kind !== 'external' && entry.kind !== 'internal') ||
          !['pending', 'attempting', 'sent', 'failed', 'suppressed'].includes(entry.state) ||
          (entry.reason !== null && !bounded(entry.reason, 64))) throw new Error('Invalid snapshot send recipient');
      this.sql.exec('INSERT INTO mailbox_send_recipients VALUES (?, ?, ?, ?, ?)', entry.sendId, entry.idx, entry.kind, entry.state, entry.reason);
    } else if (row.kind === 'pending_release') {
      const entry = value as { seq: number; key: string; holder: string };
      this.enqueueRelease(entry.seq, entry.key, entry.holder);
    } else if (row.kind === 'pending_confirmation') {
      const entry = value as PendingConfirmation;
      return this.enqueueConfirmation(entry.seq, entry.key, entry.holder, entry.publishedAt);
    } else if (row.kind === 'label' || row.kind === 'bayes' || row.kind === 'draft' || row.kind === 'setting' ||
      row.kind === 'api_result' || row.kind === 'api_settings' || row.kind === 'api_upload' || row.kind === 'api_source_lost') {
      this.apply({ ...(value as object), type: row.kind } as Exclude<JournalEvent, MessageEvent>, true);
    } else throw new Error('Invalid snapshot state row');
  }

  // Applies one journal row, idempotently. Returns the object references a purge
  // released; release them after the enclosing transaction commits.
  replayRow(row: JournalRow): Array<{ key: string; holder: string }> {
    if (row.seq <= this.journal.revision()) {
      if (!this.journal.has(row.seq, row.event)) throw new Error('Conflicting mailbox journal');
      return [];
    }
    if (row.seq !== this.journal.revision() + 1) throw new Error('Mailbox journal gap');
    const event = JSON.parse(row.event) as JournalEvent;
    let releases: Array<{ key: string; holder: string }> = [];
    if (event.type === 'message') {
      validMessage(event);
      this.upsertThread(event.threadId, '', event.subjectKey, event.createdAt);
      this.insertRestoredMessage(event);
    } else {
      if (event.type === 'purge') releases = this.messageObjectKeys(event.id).map(key => ({ key, holder: this.referenceFor(event.id) }));
      this.apply(event);
    }
    this.journal.appendEncoded(row.seq, row.event);
    return releases;
  }

  async replay(row: JournalRow): Promise<void> {
    for (const { key, holder } of this.storage.transactionSync(() => this.replayRow(row))) await this.objects.release(key, holder);
  }
}
