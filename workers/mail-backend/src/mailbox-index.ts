import { authVerdict, AUTH_VERDICT } from './auth-verdict.ts';
import { MAX_RAW_BYTES, sha256 } from './bytes.ts';
import { isObjectKey } from './kofra.ts';
import { MailJournal, type JournalEvent, type JournalRow } from './mail-journal.ts';
import { MAILBOX_SCHEMA } from './mailbox-schema.ts';
import { parseObjectKey, type ObjectKind } from './object-key.ts';
import { isDeliveryId } from './outbox.ts';
import { parseMail, type ParsedMail } from './parse-mail.ts';

export type MailboxObjects = {
  get(key: string): Promise<Uint8Array<ArrayBuffer>>;
  put(key: string, content: Uint8Array<ArrayBuffer>): Promise<void>;
  register(kind: ObjectKind, digest: string, holder: string): Promise<string>;
  hold(key: string, holder: string): Promise<void>;
  release(key: string, holder: string): Promise<void>;
};

// The stored message can never be indexed: a digest mismatch, an unparseable
// message or a size cap. Transport and storage failures are never permanent.
export class PermanentMailError extends Error {}
export class LifecycleConflict extends Error {}

type MessageEvent = Extract<JournalEvent, { type: 'message' }>;
type MessageSource = Pick<MessageEvent, 'id' | 'rawKey' | 'createdAt'>;
type Prepared = Omit<ParsedMail, 'attachments'> & { attachments: Array<{
  part: number; name: string; mimeType: string; size: number; key: string | null;
}> };
type SnapshotTable = 'messages' | 'labels' | 'drafts' | 'bayes' | 'settings';
export type SnapshotRow = { row_no: number; kind: string; value: string };
type SnapshotMessage = Omit<MessageEvent, 'type'> & { flags: number; gmailId: string | null; labels: string[] };
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

  constructor(storage: DurableObjectStorage, objects: MailboxObjects, holderScope: string) {
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
    const content = await this.objects.get(key);
    if (content.byteLength === 0 || content.byteLength > MAX_RAW_BYTES) throw new PermanentMailError('Invalid mailbox object size');
    try {
      return await parseMail(content, key);
    } catch (error) {
      throw new PermanentMailError(error instanceof Error ? error.message : 'Unparseable message');
    }
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

  private insertDerived(id: string, rowid: number, parsed: Prepared) {
    this.sql.exec('INSERT INTO fts(rowid, id, subject, addresses, body, attachment_names) VALUES (?, ?, ?, ?, ?, ?)',
      rowid, id, parsed.subject, `${parsed.sender} ${parsed.to} ${parsed.cc}`, parsed.body,
      parsed.attachments.map(a => a.name).join(' ').slice(0, 8192));
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

  async saveDraft(id: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!id || id.length > 256 || !bytes.byteLength || bytes.byteLength > MAX_RAW_BYTES) throw new Error('Invalid draft');
    const rawKey = `drafts/${await sha256(bytes)}`;
    const holder = `draft:${crypto.randomUUID()}`;
    await this.objects.hold(rawKey, holder);
    await this.objects.put(rawKey, bytes);
    const previous = this.sql.exec<{ rawKey: string; holder: string }>('SELECT raw_key AS rawKey, holder FROM drafts WHERE id = ?', id).toArray()[0];
    this.change({ type: 'draft', id, rawKey, holder });
    if (previous) await this.objects.release(previous.rawKey, previous.holder);
  }

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

  private change(event: Exclude<JournalEvent, MessageEvent>) {
    this.storage.transactionSync(() => { this.apply(event); this.journal.append(event); });
  }

  private apply(event: Exclude<JournalEvent, MessageEvent>) {
    switch (event.type) {
      case 'receipt':
        if (!isDeliveryId(event.id)) throw new Error('Invalid receipt');
        this.sql.exec('INSERT INTO receipts VALUES (?)', event.id);
        break;
      case 'label':
        if (!bounded(event.id, 256) || !bounded(event.name, 512)) throw new Error('Invalid label');
        this.sql.exec('INSERT INTO labels VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name', event.id, event.name);
        break;
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
        break;
      }
      case 'draft':
        if (!bounded(event.id, 256) || !bounded(event.holder, 128) || typeof event.rawKey !== 'string' ||
            !event.rawKey.startsWith('drafts/') || !isObjectKey(event.rawKey)) {
          throw new Error('Invalid draft');
        }
        this.sql.exec('INSERT INTO drafts VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET raw_key=excluded.raw_key, holder=excluded.holder',
          event.id, event.rawKey, event.holder);
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
      default: throw new Error('Unexpected journal event');
    }
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
          'labels', json((SELECT json_group_array(label_id) FROM message_labels WHERE message_id = m.id)))
        FROM messages AS m;
        INSERT INTO backup_capture(kind, value)
        SELECT 'thread', json_object('id', id, 'assigned', assigned, 'lastDate', last_date, 'count', count, 'subjectKey', subject_key)
        FROM threads WHERE count > 0;
        INSERT INTO backup_capture(kind, value)
        SELECT 'draft', json_object('id', id, 'rawKey', raw_key, 'holder', holder) FROM drafts;
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
  resetForRestore() {
    this.sql.exec(`DELETE FROM fts; DELETE FROM message_labels; DELETE FROM attachments; DELETE FROM messages; DELETE FROM threads;
      DELETE FROM receipts; DELETE FROM fingerprints; DELETE FROM labels; DELETE FROM drafts; DELETE FROM bayes;
      DELETE FROM settings; DELETE FROM journal; DELETE FROM backup_capture; UPDATE state SET modseq=0, flushed=0 WHERE id=1;`);
  }

  finishSnapshot(seq: number) {
    this.sql.exec('UPDATE state SET modseq = ?, flushed = ? WHERE id = 1 AND modseq = 0', seq, seq);
    if (this.journal.revision() !== seq) throw new Error('Mailbox snapshot sequence mismatch');
  }

  // Applies one snapshot row. Call inside the transaction that advances the
  // restore cursor, so a resumed restore never applies a row twice.
  restoreSnapshotRow(row: SnapshotRow) {
    const value: unknown = JSON.parse(row.value);
    if (row.kind === 'message') {
      const message = value as SnapshotMessage;
      validMessage({ ...message, type: 'message' }, true);
      if (!count(message.flags) || (message.gmailId !== null && !bounded(message.gmailId, 256))) throw new Error('Invalid snapshot message');
      this.insertRestoredMessage({ ...message, type: 'message' }, 0, message.gmailId);
      this.apply({ type: 'flags', id: message.id, flags: message.flags, labels: message.labels });
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
    } else if (row.kind === 'label' || row.kind === 'bayes' || row.kind === 'draft' || row.kind === 'setting') {
      this.apply({ ...(value as object), type: row.kind } as Exclude<JournalEvent, MessageEvent>);
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
