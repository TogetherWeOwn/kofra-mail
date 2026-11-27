import { indexedAttachmentName } from '../../../contracts/mail-api/src/headers.ts';
import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import { VIEWS, type Address, type Conversation, type Folder, type Label, type Message, type MessageAttachment,
  type ThreadSummary, type Verdict, type View, type ViewList } from '../../../contracts/mail-api/src/wire.ts';
import type { JournalEvent } from './mail-journal.ts';
import { fail, invalid, iso, isId, need, object, requireId, text } from './mailbox-api-input.ts';
import { ATTACHMENT_SEARCH_BOUNDARY } from './mailbox-schema.ts';
import { normalizeSearch, type MessageDisplay } from './parse-mail.ts';
import { sendByMessage, summaryState, unpublishedProgress, UnpublishedSend } from './mailbox-send-store.ts';

const FOLDERS = ['inbox', 'archive', 'spam', 'trash'] as const;
// M1 uses zero for new inbound mail. Reserve a separate bit range so its
// existing numeric flags are not reinterpreted as new folder or keyword state.
const FOLDER_SHIFT = 16;
const FOLDER_MASK = 3 << FOLDER_SHIFT;
const READ = 1 << 18;
const STARRED = 1 << 19;
// A copy this mailbox wrote through the send path; folder changes keep it.
export const SENT = 1 << 20;
// The sent copy at release: read, in Archive (the self-send filing into Inbox is M3-8's).
export const SENT_COPY_FLAGS = SENT | READ | (FOLDERS.indexOf('archive') << FOLDER_SHIFT);
const DAY = 86_400_000;
export const folderOf = (flags: number): Folder => FOLDERS[(flags & FOLDER_MASK) >> FOLDER_SHIFT];
const verdictOf = (flags: number): Verdict => folderOf(flags) === 'spam'
  ? { level: 'spam', reasons: ['user_reported'] } : { level: 'none', reasons: [] };
const unread = (flags: number) => !(flags & READ);
const starred = (flags: number) => !!(flags & STARRED);
const idList = (value: string) => JSON.parse(value) as string[];

export type MessageRow = {
  id: string; raw_key: string; thread_id: string; size: number; internal_date: number; sent_date: string | null;
  sender: string; recipients: string; cc: string; subject: string; snippet: string; flags: number; auth: string;
  expires_at: number | null; display: string | null; labels: string; attachment: number;
};
export type AttachmentRow = { part: number; name: string; mime_type: string; size: number; object_key: string | null };
export function displayOf(row: MessageRow): MessageDisplay | undefined {
  return row.display ? JSON.parse(row.display) as MessageDisplay : undefined;
}

const active = (alias: string) => `${alias}.indexed = 1 AND NOT EXISTS (SELECT 1 FROM mailbox_api_expiry e
  WHERE e.id = ${alias}.id AND e.expires_at <= ?)`;
const folderBits = (alias: string) => `(${alias}.flags & ${FOLDER_MASK})`;
function viewWhere(alias: string, view: View, values: SqlStorageValue[], now: number) {
  const bits = folderBits(alias);
  switch (view) {
    case 'all': return `${bits} < ${2 << FOLDER_SHIFT}`;
    case 'starred': return `${bits} < ${2 << FOLDER_SHIFT} AND (${alias}.flags & ${STARRED}) != 0`;
    case 'sent': return `(${alias}.flags & ${SENT}) != 0 AND ${bits} < ${2 << FOLDER_SHIFT}`;
    case 'archive': {
      values.push(now);
      return `${bits} = ${1 << FOLDER_SHIFT} AND NOT EXISTS (SELECT 1 FROM messages inbox
        WHERE inbox.thread_id = ${alias}.thread_id AND ${folderBits('inbox')} = 0 AND ${active('inbox')})`;
    }
    default: return `${bits} = ${FOLDERS.indexOf(view) << FOLDER_SHIFT}`;
  }
}

const projection = `m.id, m.raw_key, m.thread_id, m.size, m.internal_date, m.sent_date, m.sender, m.recipients, m.cc,
  m.subject, m.snippet, m.flags, m.auth, e.expires_at, d.data AS display,
  coalesce((SELECT json_group_array(label_id ORDER BY label_id) FROM message_labels WHERE message_id = m.id), '[]') AS labels,
  EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS attachment`;
const sources = `FROM messages m LEFT JOIN mailbox_api_expiry e ON e.id = m.id LEFT JOIN mailbox_api_display d ON d.id = m.id`;

export function messageRow(sql: SqlStorage, id: string | undefined, now: number): MessageRow {
  if (!isId(id)) return fail('not_found');
  return need(sql.exec<MessageRow>(`SELECT ${projection} ${sources} WHERE m.id = ? AND ${active('m')}`, id, now).toArray()[0]);
}
function threadRows(sql: SqlStorage, threadId: string, now: number): MessageRow[] {
  return sql.exec<MessageRow>(`SELECT ${projection} ${sources} WHERE m.thread_id = ? AND ${active('m')}
    ORDER BY m.internal_date, m.id LIMIT ?`, threadId, now, LIMITS.threadMessages).toArray();
}
export function attachmentRow(sql: SqlStorage, message: MessageRow, part: number): AttachmentRow {
  if (part === displayOf(message)?.syntheticPart) return fail('not_found');
  const row = need(sql.exec<AttachmentRow>(`SELECT part, name, mime_type, size, object_key FROM attachments WHERE message_id = ? AND part = ?`,
    message.id, part).toArray()[0]);
  return { ...row, name: indexedAttachmentName(row.name) };
}
export interface MailboxContentRecord {
  rawKey: string;
  attachments: { part: number; objectKey: string | null }[];
  verdict: Verdict['level'];
}

export function contentRecord(sql: SqlStorage, id: string, now: number): MailboxContentRecord | null {
  const row = sql.exec<{ rawKey: string; flags: number; syntheticPart: number | null }>(`
    SELECT m.raw_key AS rawKey, m.flags, json_extract(d.data, '$.syntheticPart') AS syntheticPart
      FROM messages m LEFT JOIN mailbox_api_display d ON d.id = m.id WHERE m.id = ? AND ${active('m')}`, id, now).toArray()[0];
  if (!row) return null;
  const attachments = sql.exec<{ part: number; objectKey: string | null }>(`
    SELECT part, object_key AS objectKey FROM attachments WHERE message_id = ? AND part IS NOT ? ORDER BY part`,
    id, row.syntheticPart).toArray().map(({ part, objectKey }) => ({ part, objectKey }));
  return { rawKey: row.rawKey, attachments, verdict: verdictOf(row.flags).level };
}

export function partNumber(value: string | number | undefined, field: string): number {
  const part = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(part) || part < 1) return invalid(field);
  return part;
}
const folderHidden = (folder: Folder) => folder === 'trash' || folder === 'spam';
function qualifies(row: MessageRow, view: View): boolean {
  const folder = folderOf(row.flags);
  if (view === 'all') return !folderHidden(folder);
  if (view === 'starred') return !folderHidden(folder) && starred(row.flags);
  if (view === 'sent') return !folderHidden(folder) && !!(row.flags & SENT);
  return folder === view;
}
const fallbackAddress = (email: string): Address => ({ name: '', email });
const from = (row: MessageRow) => displayOf(row)?.from ?? fallbackAddress(row.sender.split(', ')[0]);
function summarize(all: MessageRow[], selected: MessageRow[], view?: View): ThreadSummary {
  const latest = need(selected.at(-1));
  const expiresAt = view === 'trash' || view === 'spam' ? Math.min(...selected.map(row => row.expires_at ?? Infinity)) : Infinity;
  return {
    id: latest.thread_id, subject: latest.subject, snippet: [...latest.snippet.replace(/\s+/g, ' ').trim()].slice(0, 200).join(''),
    lastDate: iso(latest.internal_date), from: from(latest), count: selected.length,
    unread: selected.some(row => unread(row.flags)), starred: selected.some(row => starred(row.flags)),
    folders: FOLDERS.filter(folder => all.some(row => folderOf(row.flags) === folder)),
    labelIds: [...new Set(selected.flatMap(row => idList(row.labels)))], hasAttachments: selected.some(row => row.attachment === 1),
    ...(Number.isFinite(expiresAt) && { expiresAt: iso(expiresAt) }),
  };
}

const emailList = (flat: string) => flat ? flat.split(', ').map(fallbackAddress) : [];
export function missingThreadDisplay(sql: SqlStorage, id: string, now: number): { id: string; raw_key: string }[] {
  if (!isId(id)) return fail('not_found');
  return sql.exec<{ id: string; raw_key: string }>(`SELECT m.id, m.raw_key FROM messages m WHERE m.thread_id = ? AND ${active('m')}
    AND NOT EXISTS (SELECT 1 FROM mailbox_api_display d WHERE d.id = m.id) LIMIT ?`, id, now, LIMITS.threadMessages).toArray();
}
export function getThread(sql: SqlStorage, id: string, now: number, state: string): Conversation {
  if (!isId(id)) return fail('not_found');
  const rows = threadRows(sql, id, now);
  if (!rows.length) return fail('not_found');
  const flushed = sql.exec<{ flushed: number }>('SELECT flushed FROM state WHERE id = 1').one().flushed;
  const messages = rows.map((row): Message => {
    const send = row.flags & SENT ? sendByMessage(sql, row.id) : undefined;
    // A sent copy reports its send's state only once published, as getSend does.
    const unpublished = send ? unpublishedProgress(sql, [send.id]) : 0;
    if (unpublished) throw new UnpublishedSend(unpublished);
    const display = displayOf(row);
    const body = sql.exec<{ body: string }>(`SELECT coalesce(d.body_override, f.body, '') AS body FROM messages m
      LEFT JOIN fts f ON m.rowid = f.rowid LEFT JOIN mailbox_api_display d ON m.id = d.id WHERE m.id = ?`, row.id).one().body;
    const attachments = sql.exec<AttachmentRow>(`SELECT part, name, mime_type, size, object_key FROM attachments
      WHERE message_id = ? ORDER BY part`, row.id).toArray().filter(a => a.part !== display?.syntheticPart).map((a): MessageAttachment => ({
      part: a.part, name: indexedAttachmentName(a.name), type: a.mime_type, size: a.size, inline: display?.inline.includes(a.part) ?? false,
    }));
    const date = Date.parse(row.sent_date ?? '');
    const folder = folderOf(row.flags);
    return {
      id: row.id, threadId: row.thread_id, folder, unread: unread(row.flags), starred: starred(row.flags), labelIds: idList(row.labels),
      sent: !!(row.flags & SENT), from: display?.from ?? from(row), to: display?.to ?? emailList(row.recipients), cc: display?.cc ?? emailList(row.cc),
      ...(send ? { bcc: send.record.recipients.filter(({ field }) => field === 'bcc').map(({ email, name }) => ({ email, name: name ?? '' })) } : {}),
      ...(display?.replyTo.length ? { replyTo: display.replyTo } : {}), date: iso(Number.isFinite(date) ? date : row.internal_date),
      receivedAt: iso(row.internal_date), subject: row.subject, text: body, textTruncated: display?.textTruncated ?? false,
      hasHtml: display?.hasHtml ?? false, remoteImages: display?.remoteImages ?? false, size: row.size, attachments,
      verdict: verdictOf(row.flags),
      ...(send ? { send: { id: send.id, state: summaryState(send, flushed) } } : {}),
    };
  });
  return { thread: summarize(rows, rows), messages, state };
}

export function listViews(sql: SqlStorage, now: number, state: string): ViewList {
  const items = VIEWS.map(view => {
    const values: SqlStorageValue[] = [now];
    const condition = viewWhere('m', view, values, now);
    const unreadThreads = sql.exec<{ n: number }>(`SELECT count(DISTINCT m.thread_id) AS n FROM messages m
      WHERE ${active('m')} AND (m.flags & ${READ}) = 0 AND ${condition}`, ...values).one().n;
    return { view, unreadThreads };
  });
  return { items, drafts: sql.exec<{ n: number }>('SELECT count(*) AS n FROM mailbox_api_drafts').one().n, state };
}

function midnight(value: string, zone: Intl.DateTimeFormat | undefined): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const utc = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(utc) || iso(utc).slice(0, 10) !== value) return NaN;
  if (!zone) return utc;
  const offset = (instant: number) => {
    const name = zone.formatToParts(instant).find(part => part.type === 'timeZoneName')?.value;
    const m = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(name ?? '');
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0)) * 1000 : 0;
  };
  const candidates = [-DAY, 0, DAY].map(delta => utc - offset(utc + delta));
  const exact = candidates.filter(instant => instant + offset(instant) === utc);
  return exact.length ? Math.min(...exact) : Math.max(...candidates);
}

type Search = { clauses: string[]; values: SqlStorageValue[] };
function searchWhere(sql: SqlStorage, query: string, timezone: string | undefined): Search {
  let zone: Intl.DateTimeFormat | undefined;
  if (timezone !== undefined) {
    if (timezone.length > 128 || /^[+-]/.test(timezone)) return invalid('/tz');
    try { zone = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' }); }
    catch { return invalid('/tz'); }
  }
  const clauses: string[] = [];
  const values: SqlStorageValue[] = [];
  const fts: string[] = [];
  const legacyPhrases: string[] = [];
  const literals = new Set<string>();
  const literalPhrases = new Set<string>();
  const hasDisplay = 'EXISTS (SELECT 1 FROM mailbox_api_display WHERE id = s.id)';
  const add = (condition: string, ...params: SqlStorageValue[]) => { clauses.push(condition); values.push(...params); };
  const terms = normalizeSearch(query).matchAll(/(before|after|larger):(?=\s|$)|(?:([a-z]+):)?(?:"([^"]*)"|([^\s"]+))/g);
  for (const [, empty, op, quoted, word] of terms) {
    const term = quoted ?? word ?? '';
    switch (empty ?? op) {
      case 'from': case 'to': case 'subject': {
        const column = op === 'from' ? 'sender' : op === 'to' ? 'recipients' : 'subject';
        const property = op === 'from' ? 'searchFrom' : op === 'to' ? 'searchTo' : 'searchSubject';
        const fallback = op === 'to' ? "s.recipients || ' ' || s.cc" : `s.${column}`;
        add(`instr(coalesce((SELECT json_extract(data, '$.${property}') FROM mailbox_api_display WHERE id = s.id),
          lower(${fallback})), ?) > 0`, term);
        break;
      }
      case 'label': {
        const ids = labels(sql).filter(label => normalizeSearch(label.name) === term).map(label => label.id);
        if (!ids.length) add('0');
        else add('EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = s.id AND ml.label_id IN (SELECT value FROM json_each(?)))', JSON.stringify(ids));
        break;
      }
      case 'has': add(term === 'attachment' ? 'EXISTS (SELECT 1 FROM attachments WHERE message_id = s.id)' : '0'); break;
      case 'is': add(term === 'unread' ? `(s.flags & ${READ}) = 0` : term === 'starred' ? `(s.flags & ${STARRED}) != 0` : '0'); break;
      case 'before': case 'after': {
        const boundary = midnight(term, zone);
        if (!Number.isFinite(boundary)) add('0');
        else add(`coalesce(unixepoch(s.sent_date)*1000, s.internal_date) ${op === 'before' ? '<' : '>='} ?`, boundary);
        break;
      }
      case 'larger': {
        const m = /^(\d+)([km])?$/.exec(term);
        const size = m ? Number(m[1]) * (m[2] === 'm' ? 1024 ** 2 : m[2] === 'k' ? 1024 : 1) : NaN;
        if (Number.isSafeInteger(size)) add('s.size > ?', size);
        else add('0');
        break;
      }
      default: {
        const literal = op ? `${op}:${term}` : term;
        if (literal) {
          // Quote every term; user input is never FTS syntax. For a literal
          // operator or punctuation-only input, preserve punctuation exactly.
          if (!op && !literal.endsWith(':') && /[\p{L}\p{N}]/u.test(literal)) {
            // A query cannot match the filename boundary, even when it explicitly includes it.
            const columns = literal.includes(ATTACHMENT_SEARCH_BOUNDARY) ? '-attachment_names : ' : '';
            const expression = `"${literal.replaceAll('"', '""')}"`;
            fts.push(`${columns}${expression}`);
            if (quoted !== undefined && !columns) legacyPhrases.push(`-attachment_names : ${expression}`);
          } else (quoted === undefined ? literals : literalPhrases).add(literal);
        }
      }
    }
  }
  if (fts.length) add('s.rowid IN (SELECT rowid FROM fts WHERE fts MATCH ?)', fts.join(' AND '));
  // M1 rows have one concatenated attachment string. Only their unquoted
  // searches can use that column until digest-verified hydration rewrites it.
  if (legacyPhrases.length) add(`(${hasDisplay} OR s.rowid IN (SELECT rowid FROM fts WHERE fts MATCH ?))`, legacyPhrases.join(' AND '));
  for (const [terms, quoted] of [[literals, false], [literalPhrases, true]] as const) {
    if (!terms.size) continue;
    add(`EXISTS (SELECT 1 FROM fts x WHERE x.rowid = s.rowid AND NOT EXISTS (
      SELECT 1 FROM json_each(?) terms WHERE max(instr(lower(x.subject), terms.value),
        instr(lower(x.addresses), terms.value), instr(lower(x.body), terms.value),
        CASE WHEN instr(terms.value, ?) = 0 ${quoted ? `AND ${hasDisplay}` : ''}
          THEN instr(lower(x.attachment_names), terms.value) ELSE 0 END) = 0))`,
    JSON.stringify([...terms]), ATTACHMENT_SEARCH_BOUNDARY);
  }
  return { clauses, values };
}

export function labels(sql: SqlStorage): Label[] {
  return sql.exec<{ id: string; name: string }>('SELECT id, name FROM labels ORDER BY id LIMIT ?', LIMITS.labelsPerMailbox).toArray();
}
export function threadPage(sql: SqlStorage, params: Record<string, string>, now: number, limit: number, position?: [number, string]) {
  const view = params.view as View;
  if (!VIEWS.includes(view)) return invalid('/view');
  if (params.labelId !== undefined) {
    if (!isId(params.labelId)) return fail('not_found');
    need(sql.exec('SELECT 1 FROM labels WHERE id = ?', params.labelId).toArray()[0]);
  }
  const query = params.q === undefined ? '' : text(params.q, LIMITS.queryBytes, '/q');
  const search = searchWhere(sql, query, params.tz);
  if (params.labelId !== undefined) {
    search.clauses.push('EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = s.id AND ml.label_id = ?)');
    search.values.push(params.labelId);
  }
  if (search.clauses.includes('0')) return [];
  const values: SqlStorageValue[] = [now];
  const qualify = viewWhere('m', view, values, now);
  if (position) values.push(...position);
  values.push(now);
  const latest = viewWhere('v', view, values, now);
  let searched = '';
  if (search.clauses.length) {
    values.push(now);
    const searchView = viewWhere('s', view, values, now);
    searched = `AND EXISTS (SELECT 1 FROM messages s WHERE s.thread_id = m.thread_id AND ${active('s')}
      AND ${searchView} AND ${search.clauses.join(' AND ')})`;
    values.push(...search.values);
  }
  // An index-backed range seeks to the cursor. A candidate must be the latest
  // qualifying message in its thread (regardless of whether it matches search).
  const hits = sql.exec<{ id: string }>(`SELECT m.thread_id AS id FROM messages m INDEXED BY mailbox_api_recent
    WHERE ${active('m')} AND ${qualify} ${position ? 'AND (m.internal_date, m.thread_id) < (?, ?)' : ''}
    AND m.id = (SELECT v.id FROM messages v WHERE v.thread_id = m.thread_id AND ${active('v')} AND ${latest}
      ORDER BY v.internal_date DESC, v.id DESC LIMIT 1) ${searched}
    ORDER BY m.internal_date DESC, m.thread_id DESC, m.id DESC LIMIT ?`, ...values, limit).toArray();
  return hits.map(hit => {
    const all = threadRows(sql, hit.id, now);
    return summarize(all, all.filter(row => qualifies(row, view)), view);
  });
}

type ThreadEvent = Extract<JournalEvent, { type: 'flags' | 'bayes' }>;
export function threadChanges(sql: SqlStorage, input: unknown, now: number): ThreadEvent[] {
  const { ids, set: change } = object(input, ['ids', 'set']);
  const set = object(change, ['folder', 'unread', 'starred', 'addLabelIds', 'removeLabelIds'], '/set');
  if (!Array.isArray(ids)) return invalid('/ids');
  if (ids.length > LIMITS.batchThreads) return invalid('/ids', 'too_many');
  const folder = set.folder as Folder | undefined;
  if (folder !== undefined && !FOLDERS.includes(folder)) return invalid('/set/folder');
  for (const field of ['unread', 'starred'] as const) {
    if (set[field] !== undefined && typeof set[field] !== 'boolean') return invalid(`/set/${field}`);
  }
  const rows = [...new Set(ids.map((id, i) => requireId(id, `/ids/${i}`)))].flatMap(id => {
    const members = threadRows(sql, id, now);
    if (!members.length) return fail('not_found');
    return members;
  });
  const available = new Set(labels(sql).map(label => label.id));
  function labelIds(field: 'addLabelIds' | 'removeLabelIds'): string[] {
    const list = set[field];
    if (list === undefined) return [];
    if (!Array.isArray(list)) return invalid(`/set/${field}`);
    if (list.length > LIMITS.labelsPerMailbox) return invalid(`/set/${field}`, 'too_many');
    return list.map((id, i) => {
      if (!isId(id) || !available.has(id)) return invalid(`/set/${field}/${i}`);
      return id;
    });
  }
  const add = labelIds('addLabelIds');
  const remove = new Set(labelIds('removeLabelIds'));
  const training = new Map<string, { ham: number; spam: number }>();
  const events: ThreadEvent[] = [];
  for (const row of rows) {
    const oldFolder = folderOf(row.flags);
    const previous = idList(row.labels);
    const applied = [...new Set([...previous, ...add])].filter(id => !remove.has(id)).sort();
    if (applied.length > LIMITS.labelsPerMessage) return fail('limit_reached', { limit: LIMITS.labelsPerMessage });
    let flags = row.flags;
    if (set.unread !== undefined) flags = set.unread ? flags & ~READ : flags | READ;
    if (set.starred !== undefined) flags = set.starred ? flags | STARRED : flags & ~STARRED;
    let expiresAt: number | null | undefined;
    if (folder !== undefined && folder !== oldFolder) {
      flags = (flags & ~FOLDER_MASK) | (FOLDERS.indexOf(folder) << FOLDER_SHIFT);
      expiresAt = folderHidden(folder) ? now + LIMITS.spamTrashRetentionDays * DAY : null;
      if (oldFolder === 'spam' || folder === 'spam') {
        const sender = from(row).email;
        if (sender) {
          const token = `sender:${normalizeSearch(sender)}`.slice(0, 256);
          const counts = training.get(token) ?? sql.exec<{ ham: number; spam: number }>('SELECT ham, spam FROM bayes WHERE token = ?', token).toArray()[0] ?? { ham: 0, spam: 0 };
          counts[folder === 'spam' ? 'spam' : 'ham']++;
          training.set(token, counts);
        }
      }
    }
    if (flags !== row.flags || applied.length !== previous.length || applied.some((id, i) => id !== previous[i])) {
      events.push({ type: 'flags', id: row.id, flags, labels: applied, ...(expiresAt !== undefined && { expiresAt }) });
    }
  }
  events.push(...Array.from(training, ([token, counts]) => ({ type: 'bayes' as const, token, ...counts })));
  return events;
}
