import { createHash, randomUUID } from 'node:crypto';
import { LIMITS as limits, MailApiError, ROUTES, VIEWS, isMailApiError, problem } from '@kofra/mail-contract';
import type {
  Address, AddressInput, AdminMailbox, Alias, Conditional, ConformanceHarness, Domain, Draft, DraftAttachment,
  DraftInput, FieldError, Folder, Id, Idempotent, Identity, Label, MailErrorCode, MailService, Member,
  Message, Operation, Page, Principal, Problem, Send, Settings, TestMessage, ThreadSummary, Upload, View,
} from '@kofra/mail-contract';

const second = 1000;
const day = 86_400 * second;
const maxAuthAge = 600;
const copy = structuredClone;
const iso = (ms: number) => new Date(ms).toISOString();
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const normalized = (s: string) => s.normalize('NFKC').toLowerCase();
const subjectKey = (s: string) => normalized(s.trim().replace(/^(?:(?:re|fwd?):\s*)+/i, ''));
const address = ({ name = '', email }: AddressInput): Address => ({ name, email });
const folders: readonly Folder[] = ['inbox', 'archive', 'spam', 'trash'];
const hidden = (folder: Folder) => folder === 'spam' || folder === 'trash';

type ProblemExtra = Parameters<typeof problem>[1];
function fail(code: MailErrorCode, extra?: ProblemExtra): never { throw new MailApiError(problem(code, extra)); }
function invalid(field: string, code: FieldError['code'] = 'invalid'): never {
  fail('invalid_request', { errors: [{ field, code }] });
}
function need<T>(value: T | undefined): T { if (value === undefined) fail('not_found'); return value; }
function fields(input: unknown, allowed: readonly string[], field = ''): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(field);
  if (Object.keys(input).some((key) => !allowed.includes(key))) fail('unknown_field');
}
function boundedText(value: unknown, max: number, field: string): void {
  if (typeof value !== 'string') invalid(field);
  if (bytes(value) > max) invalid(field, 'too_long');
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b))) : item);
}
function prefix(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const data = Buffer.from(text);
  let end = max;
  while ((data[end] & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString('utf8');
}
function validDomain(name: string): boolean {
  const labels = name.split('.');
  return name.length <= 253 && labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}
function validEmail(email: string): boolean {
  const [local, domain, extra] = email.split('@');
  return extra === undefined && local.length <= 64 && email.length <= 254 && !!domain && validDomain(domain)
    && /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local);
}

interface StoredMessage {
  message: Message;
  indexedText: string;
  references: Id[];
  expires?: number;
}
interface StoredSend {
  send: Send;
  pending?: { draft: Draft; size: number; from: Address; references: Id[] };
}
interface Replay {
  fingerprint: Promise<string>;
  expires: number;
  outcome?: { value: unknown } | { error: Problem };
}
interface Mailbox {
  directory: AdminMailbox;
  version: number;
  threads: Map<Id, StoredMessage[]>;
  messages: Map<Id, StoredMessage>;
  labels: Map<Id, Label>;
  drafts: Map<Id, Draft>;
  sends: Map<Id, StoredSend>;
  uploads: Map<Id, Upload>;
  keys: Map<string, Replay>;
  training: Map<string, { spam: number; ham: number }>;
  driveFiles: Map<Id, { name: string; size: number; type: string }>;
  settings: Settings;
}
interface Cursor { binding: string; position: readonly [string, string] }

function qualifies(row: StoredMessage, view: View): boolean {
  const m = row.message;
  switch (view) {
    case 'sent': return m.sent && !hidden(m.folder);
    case 'starred': return m.starred && !hidden(m.folder);
    case 'all': return !hidden(m.folder);
    default: return m.folder === view;
  }
}
function inView(rows: StoredMessage[], view: View): StoredMessage[] {
  return view === 'archive' && rows.some(({ message }) => message.folder === 'inbox') ? [] : rows.filter((row) => qualifies(row, view));
}
function summarize(all: StoredMessage[], rows: StoredMessage[], view?: View): ThreadSummary {
  const messages = rows.map(({ message }) => message);
  const last = messages.reduce((a, b) => (compare(a.receivedAt, b.receivedAt) || compare(a.id, b.id)) < 0 ? b : a);
  const expires = view === 'spam' || view === 'trash' ? Math.min(...rows.map((row) => row.expires ?? Infinity)) : Infinity;
  return {
    id: last.threadId, subject: last.subject, snippet: [...last.text.replace(/\s+/g, ' ').trim()].slice(0, 200).join(''),
    lastDate: last.receivedAt, from: last.from, count: messages.length,
    unread: messages.some((m) => m.unread), starred: messages.some((m) => m.starred),
    folders: folders.filter((folder) => all.some(({ message }) => message.folder === folder)),
    labelIds: [...new Set(messages.flatMap((m) => m.labelIds))],
    hasAttachments: messages.some((m) => m.attachments.length > 0),
    ...(Number.isFinite(expires) && { expiresAt: iso(expires) }),
  };
}

function search(query: string, labels: Map<Id, Label>): (row: StoredMessage) => boolean {
  const terms = Array.from(normalized(query).matchAll(/(?:([a-z]+):)?(?:"([^"]*)"|([^\s"]+))/g), ([, op = '', phrase, word]) => [op, phrase ?? word]);
  const contains = (text: string, term: string) => normalized(text).includes(term);
  const addressMatches = (a: Address, term: string) => contains(`${a.name} ${a.email}`, term);
  return ({ message: m, indexedText }) => terms.every(([op, term]) => {
    switch (op) {
      case 'from': return addressMatches(m.from, term);
      case 'to': return [...m.to, ...m.cc].some((a) => addressMatches(a, term));
      case 'subject': return contains(m.subject, term);
      case 'label': return m.labelIds.some((id) => normalized(labels.get(id)?.name ?? '') === term);
      case 'has': return term === 'attachment' && m.attachments.length > 0;
      case 'is': return term === 'unread' ? m.unread : term === 'starred' && m.starred;
      case 'before':
      case 'after': {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(term)) return false;
        const date = Date.parse(`${term}T00:00:00Z`);
        if (!Number.isFinite(date) || iso(date).slice(0, 10) !== term) return false;
        return op === 'before' ? Date.parse(m.date) < date : Date.parse(m.date) >= date;
      }
      case 'larger': {
        const match = /^(\d+)([km])?$/.exec(term);
        return !!match && m.size > Number(match[1]) * (match[2] === 'm' ? 1024 ** 2 : match[2] === 'k' ? 1024 : 1);
      }
      default: {
        const literal = op ? `${op}:${term}` : term;
        return [m.subject, indexedText, ...m.attachments.map((a) => a.name)].some((text) => contains(text, literal))
          || [m.from, ...m.to, ...m.cc, ...(m.replyTo ?? []), ...(m.bcc ?? [])].some((a) => addressMatches(a, literal));
      }
    }
  });
}

async function sha256(blob: Blob): Promise<string> {
  const hash = createHash('sha256');
  const reader = blob.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return hash.digest('hex');
    hash.update(value);
  }
}

/** Test/demo fixture. Never binds a real session, delivers mail, or serves content bytes. */
export function createFakeMailHarness(options: { contentOrigin?: string; start?: number } = {}): ConformanceHarness {
  const contentOrigin = new URL(options.contentOrigin ?? 'https://content.example-usercontent.net').origin;
  const start = options.start ?? Date.parse('2026-11-22T12:00:00Z');
  let now = start;
  let sequence = 0;
  const id = () => `demo-${(++sequence).toString(36).padStart(8, '0')}`;
  const boxes = new Map<Id, Mailbox>();
  const members = new Map<Id, Omit<Member, 'hasMailbox'>>();
  const domains = new Map<string, Domain>([
    ['example.com', { name: 'example.com', kind: 'primary', routing: 'active', sending: 'active' }],
    ['example.net', { name: 'example.net', kind: 'alias', aliasOf: 'example.com', routing: 'active', sending: 'active' }],
  ]);
  const workspaceKeys = new Map<string, Replay>();
  const cursors = new Map<string, Cursor>();
  const picks = new Map<string, { mailboxId: Id; expires: number }>();
  const driveFile = { name: 'demo.txt', type: 'text/plain', bytes: new Blob(['Demo Drive file']) };

  function newMailbox(primaryAddress: string, displayName: string, ownerUserId: Id): AdminMailbox {
    const directory: AdminMailbox = { id: id(), primaryAddress, displayName, ownerUserId, aliases: [] };
    boxes.set(directory.id, {
      directory, version: 0, threads: new Map(), messages: new Map(), labels: new Map(), drafts: new Map(), sends: new Map(),
      uploads: new Map(), keys: new Map(), training: new Map(), driveFiles: new Map(),
      settings: { signature: '', undoSeconds: 10, defaultFrom: primaryAddress, replyFromReceivedAddress: true },
    });
    return directory;
  }
  for (const [user, name] of [['member', 'Member'], ['other', 'Other Member'], ['admin', 'Administrator'], ['invited', 'Invited Member']]) {
    const email = `${user}@example.com`;
    const invited = user === 'invited';
    members.set(user, { id: user, name, email, status: invited ? 'invited' : 'active' });
    if (!invited) newMailbox(email, name, user);
  }
  const ownerBox = (userId: Id) => [...boxes.values()].find(({ directory }) => directory.ownerUserId === userId);
  const state = (box: Mailbox) => `${box.directory.id}-${box.version}`;
  const bump = (box: Mailbox) => { box.version++; };

  function page<T>(items: T[], scope: string, operation: Operation, query: { limit?: number; cursor?: string },
    position: (item: T) => Cursor['position'], order: (a: Cursor['position'], b: Cursor['position']) => number): Page<T> {
    const { cursor, limit: requested, ...queryFilters } = query;
    const limit = requested === undefined ? limits.pageSizeDefault : requested;
    if (!Number.isInteger(limit) || limit < 1 || limit > limits.pageSizeMax) invalid('/limit');
    const binding = canonical([scope, operation, queryFilters, requested ?? null]);
    const anchor = cursor === undefined ? undefined : cursors.get(cursor);
    if (cursor !== undefined && (!anchor || anchor.binding !== binding)) fail('invalid_cursor');
    const sorted = items.map((item) => ({ item, position: position(item) })).sort((a, b) => order(a.position, b.position));
    const remaining = anchor ? sorted.filter((row) => order(row.position, anchor.position) > 0) : sorted;
    const window = remaining.slice(0, limit);
    const nextCursor = remaining.length > limit ? randomUUID() : null;
    if (nextCursor) cursors.set(nextCursor, { binding, position: window[window.length - 1].position });
    return { items: window.map(({ item }) => item), nextCursor };
  }
  const ascending = ([left, a]: Cursor['position'], [right, b]: Cursor['position']) => compare(left, right) || compare(a, b);
  const byTime = ([left, a]: Cursor['position'], [right, b]: Cursor['position']) => compare(right, left) || compare(a, b);
  const byThread = (a: Cursor['position'], b: Cursor['position']) => ascending(b, a);

  async function replay<T>(keys: Map<string, Replay>, opts: Idempotent | undefined, op: Operation, args: unknown[],
    fingerprintBody: unknown | (() => Promise<unknown>), run: () => T | Promise<T>): Promise<T> {
    const key = opts?.idempotencyKey;
    if (key === undefined) fail('precondition_required');
    if (typeof key !== 'string' || key.length > limits.idempotencyKeyChars || !/^[A-Za-z0-9_-]+$/.test(key)) invalid('/idempotencyKey');
    const existing = keys.get(key);
    const outcome = existing?.outcome;
    const fingerprint = Promise.resolve().then(async () => canonical([
      op, args, typeof fingerprintBody === 'function' ? await fingerprintBody() : fingerprintBody,
    ]));
    if (existing) {
      if (await fingerprint !== await existing.fingerprint) fail('idempotency_key_reused');
      if (!outcome) fail('idempotency_in_progress', { retryAfterSeconds: 1 });
      if ('error' in outcome) throw new MailApiError(copy(outcome.error));
      return copy(outcome.value as T);
    }
    const entry: Replay = { fingerprint, expires: now + limits.idempotencyRetentionSeconds * second };
    keys.set(key, entry);
    try {
      // Take a fingerprint before any side effects, even for invalid business inputs.
      await fingerprint;
      const value = await run();
      entry.outcome = { value: copy(value) };
      return value;
    } catch (error) {
      if (isMailApiError(error) && error.status >= 400 && error.status < 500) entry.outcome = { error: copy(error.problem) };
      else keys.delete(key);
      throw error;
    }
  }

  function identities(box: Mailbox): Identity[] {
    const { primaryAddress, aliases, displayName: name } = box.directory;
    const primary: Identity = { email: primaryAddress, name, primary: true, kind: 'primary', sendAs: 'active' };
    const explicit = aliases.filter((alias) => alias.sendAs !== 'off').map(({ address: email, sendAs }): Identity => ({
      name, email, kind: 'alias', primary: false, sendAs: sendAs === 'active' ? 'active' : 'pending',
    }));
    const implicit = [...domains.values()].filter((d) => d.kind === 'alias' && d.routing === 'active')
      .flatMap((d) => [primary, ...explicit].filter((source) => source.email.endsWith(`@${d.aliasOf}`)).map((source): Identity => ({
        name, email: `${source.email.split('@')[0]}@${d.name}`, kind: 'alias_domain', primary: false,
        sendAs: source.sendAs === 'active' && d.sending === 'active' ? 'active' : 'pending',
      })));
    return [primary, ...explicit, ...implicit];
  }
  function sender(box: Mailbox, email: string, active: boolean): Identity {
    if (typeof email !== 'string') fail('invalid_sender');
    const value = identities(box).find((identity) => identity.email === email.toLowerCase() && (!active || identity.sendAs === 'active'));
    if (!value) fail('invalid_sender');
    return value;
  }
  function part(box: Mailbox, messageId: Id, number: number) {
    return need(need(box.messages.get(messageId)).message.attachments.find((part) => part.part === number));
  }
  function checkRevision(draft: Draft, opts: Partial<Conditional> | undefined): void {
    if (opts?.ifMatch !== undefined && opts.ifMatch !== draft.revision) fail('revision_mismatch');
  }
  function requireRevision(opts: Conditional | undefined): void {
    if (!opts?.ifMatch) fail('precondition_required');
  }
  function uploadRef(file: Upload): DraftAttachment {
    const { id: uploadId, name, type, size } = file;
    return { kind: 'upload', uploadId, name, type, size };
  }
  function checkCounts(input: DraftInput): void {
    for (const field of ['to', 'cc', 'bcc', 'attachments'] as const) {
      if (!Array.isArray(input[field])) invalid(`/${field}`);
    }
    if (input.to.length + input.cc.length + input.bcc.length > limits.recipientsPerMessage) {
      fail('too_many_recipients', { limit: limits.recipientsPerMessage });
    }
    if (input.attachments.filter((attachment) => attachment?.kind !== 'link').length > limits.attachmentsPerMessage) {
      fail('too_many_attachments', { limit: limits.attachmentsPerMessage });
    }
  }
  function makeDraft(box: Mailbox, draftId: Id, input: DraftInput): Draft {
    fields(input, ['from', 'to', 'cc', 'bcc', 'subject', 'body', 'inReplyTo', 'forwardOf', 'attachments']);
    const from = sender(box, input.from, false).email;
    checkCounts(input);
    boundedText(input.subject, limits.subjectBytes, '/subject');
    boundedText(input.body, limits.bodyBytes, '/body');
    const { subject, body, inReplyTo, forwardOf } = input;
    for (const ref of [inReplyTo, forwardOf]) if (ref !== undefined) need(box.messages.get(ref));
    const cleanAddresses = (field: 'to' | 'cc' | 'bcc') => input[field].map((value, i) => {
      fields(value, ['name', 'email']);
      const { name, email } = value;
      if (typeof email !== 'string') invalid(`/${field}/${i}/email`);
      if (name !== undefined) boundedText(name, limits.displayNameBytes, `/${field}/${i}/name`);
      return { email, ...(name !== undefined && { name }) };
    });
    const attachments = input.attachments.map((ref, i): DraftAttachment => {
      const field = `/attachments/${i}`;
      if (!ref || typeof ref !== 'object') invalid(field);
      switch (ref.kind) {
        case 'upload':
          fields(ref, ['kind', 'uploadId']);
          return uploadRef(need(box.uploads.get(ref.uploadId)));
        case 'message': {
          fields(ref, ['kind', 'messageId', 'part']);
          const { messageId, part: number } = ref;
          const { name, type, size } = part(box, messageId, number);
          return { kind: 'message', messageId, part: number, name, type, size };
        }
        case 'link': {
          fields(ref, ['kind', 'url', 'name']);
          const url = typeof ref.url === 'string' ? URL.parse(ref.url) : null;
          if (url?.protocol !== 'https:' || url.username || url.password) invalid(`${field}/url`);
          if (typeof ref.name !== 'string') invalid(`${field}/name`);
          return { kind: 'link', url: ref.url, name: ref.name };
        }
        default: return invalid(`${field}/kind`);
      }
    });
    return {
      id: draftId, revision: id(), updatedAt: iso(now), from, to: cleanAddresses('to'), cc: cleanAddresses('cc'), bcc: cleanAddresses('bcc'),
      subject, body, attachments, ...(inReplyTo !== undefined && { inReplyTo }), ...(forwardOf !== undefined && { forwardOf }),
    };
  }
  function usesUpload(box: Mailbox, uploadId: Id): boolean {
    const refers = (draft: Draft) => draft.attachments.some((ref) => ref.kind === 'upload' && ref.uploadId === uploadId);
    return [...box.drafts.values()].some(refers) || [...box.sends.values()].some(({ pending }) => pending && refers(pending.draft));
  }
  function releaseDraftUploads(box: Mailbox, draft: Draft, immediately: boolean): void {
    for (const ref of draft.attachments) {
      if (ref.kind !== 'upload') continue;
      const file = box.uploads.get(ref.uploadId);
      if (file && (immediately || Date.parse(file.expiresAt) <= now) && !usesUpload(box, file.id)) box.uploads.delete(file.id);
    }
  }
  function storeUpload(box: Mailbox, name: string, type: string, size: number, sha256: string): Upload {
    const file = { id: id(), name, type, size, sha256, expiresAt: iso(now + limits.uploadRetentionSeconds * second) };
    box.uploads.set(file.id, file);
    bump(box);
    return file;
  }

  function append(box: Mailbox, linked: Id | undefined, value: Omit<Message, 'id' | 'threadId' | 'textTruncated'>, references?: Id[]): Message {
    const previous = linked === undefined ? undefined : box.messages.get(linked);
    const previousThread = previous && box.threads.get(previous.message.threadId);
    const threadId = previous && previousThread && previousThread.length < limits.threadMessages && subjectKey(previous.message.subject) === subjectKey(value.subject)
      ? previous.message.threadId : id();
    const text = prefix(value.text, limits.messageTextBytes);
    const message: Message = { ...copy(value), id: id(), threadId, text, textTruncated: text !== value.text };
    const stored: StoredMessage = {
      message, indexedText: prefix(value.text, limits.searchBodyBytes),
      references: references ?? (previous ? [...previous.references, previous.message.id] : []),
    };
    const thread = box.threads.get(threadId) ?? [];
    thread.push(stored);
    box.threads.set(threadId, thread);
    box.messages.set(message.id, stored);
    bump(box);
    return message;
  }
  function replyReferences(box: Mailbox, messageId: Id | undefined): Id[] {
    const parent = messageId === undefined ? undefined : box.messages.get(messageId);
    if (!parent) return [];
    const chain = [...parent.references, parent.message.id];
    return chain.length > 11 ? [chain[0], ...chain.slice(-10)] : chain;
    // Fixture IDs are short enough that 11 bracketed IDs always fit headerValueBytes.
  }
  function expire(box: Mailbox): void {
    for (const [threadId, rows] of box.threads) {
      const kept = rows.filter((row) => {
        if (row.expires === undefined || row.expires > now) return true;
        box.messages.delete(row.message.id);
        return false;
      });
      if (kept.length === rows.length) continue;
      if (kept.length) box.threads.set(threadId, kept);
      else box.threads.delete(threadId);
      bump(box);
    }
    for (const [uploadId, file] of box.uploads) {
      if (Date.parse(file.expiresAt) <= now && !usesUpload(box, uploadId)) {
        box.uploads.delete(uploadId);
        bump(box);
      }
    }
  }
  function release(box: Mailbox, stored: StoredSend): void {
    const { send, pending } = stored;
    if (!pending) return;
    const { draft, size, from, references } = pending;
    const date = send.undoUntil;
    const own = new Set(identities(box).map((identity) => identity.email));
    const toSelf = send.recipients.some(({ email }) => own.has(email.toLowerCase()) || box.directory.aliases.some(({ address }) => address === email.toLowerCase()));
    const message = append(box, draft.inReplyTo, {
      folder: toSelf ? 'inbox' : 'archive', sent: true, unread: false, starred: false, labelIds: [],
      from, to: draft.to.map(address), cc: draft.cc.map(address), bcc: draft.bcc.map(address), date, receivedAt: date, subject: draft.subject,
      text: [draft.body, ...draft.attachments.flatMap((a) => a.kind === 'link' ? [`${a.name}: ${a.url}`] : [])].join('\n'),
      hasHtml: false, remoteImages: false, size,
      attachments: draft.attachments.flatMap((a, i) => a.kind === 'link' ? [] : [{ part: i + 1, name: a.name, type: a.type, size: a.size, inline: false }]),
      verdict: { level: 'none', reasons: [] }, send: { id: send.id, state: 'sent' },
    }, references);
    send.messageId = message.id;
    send.state = 'sent';
    send.undoRemainingMs = 0;
    for (const recipient of send.recipients) recipient.state = 'sent';
    delete stored.pending;
    releaseDraftUploads(box, draft, true);
  }
  function advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('The fake clock can only move forward.');
    const end = now + ms;
    const due = [...boxes.values()].flatMap((box) => [...box.sends.values()].flatMap((entry) =>
      entry.pending && Date.parse(entry.send.undoUntil) <= end ? [{ box, entry, at: Date.parse(entry.send.undoUntil) }] : []));
    for (const { box, entry, at } of due.sort((a, b) => a.at - b.at)) {
      now = at;
      expire(box);
      release(box, entry);
    }
    now = end;
    for (const box of boxes.values()) expire(box);
    for (const keys of [workspaceKeys, ...[...boxes.values()].map((box) => box.keys)]) {
      for (const [key, entry] of keys) if (entry.outcome && entry.expires <= now) keys.delete(key);
    }
    for (const [pick, entry] of picks) if (entry.expires <= now) picks.delete(pick);
  }

  function contentUrl() { return { url: `${contentOrigin}/v1/c/${randomUUID()}`, expiresAt: iso(now + limits.contentUrlSeconds * second) }; }
  function labelName(box: Mailbox, value: string, except?: Id): string {
    if (typeof value !== 'string') invalid('/name');
    const name = value.trim();
    if (!name) invalid('/name', 'required');
    if ([...name].length > limits.labelNameChars) invalid('/name', 'too_long');
    if ([...box.labels.values()].some((label) => label.id !== except && label.name.toLowerCase() === name.toLowerCase())) fail('label_exists');
    return name;
  }
  function directoryAddress(value: string, field: string): string {
    if (typeof value !== 'string') invalid(field);
    const email = value.trim().toLowerCase();
    if (!validEmail(email)) invalid(field);
    const domain = domains.get(email.split('@')[1]);
    if (!domain || domain.kind === 'alias') fail('domain_not_in_workspace');
    if ([...boxes.values()].some(({ directory }) => directory.primaryAddress === email || directory.aliases.some((a) => a.address === email))) fail('address_taken');
    return email;
  }
  function availableOwner(userId: Id): void {
    need(members.get(userId));
    if (ownerBox(userId)) invalid('/ownerUserId', 'not_allowed');
  }
  function displayName(name: string): string {
    boundedText(name, limits.displayNameBytes, '/displayName');
    if (!name.trim()) invalid('/displayName', 'required');
    return name.trim();
  }

  function bind(principal: Principal): MailService {
    const admin = principal === 'admin' || principal === 'staleAdmin';
    const user = need(members.get(admin ? 'admin' : principal));
    const authTime = principal === 'staleAdmin' ? start - 11 * 60 * second : start;
    const csrfToken = randomUUID();
    const mailbox = () => {
      const box = ownerBox(user.id);
      if (!box) fail('forbidden');
      return box;
    };
    const service: MailService = {
      async getSession() {
        const box = mailbox();
        const { id, primaryAddress } = box.directory;
        return { user: { id: user.id, name: user.name }, mailbox: { id, primaryAddress }, workspace: { id: 'demo-workspace', role: admin ? 'admin' : 'member' },
          csrfToken, authTime: iso(authTime), limits, features: { drive: true, htmlContent: true }, state: state(box) };
      },
      async listViews() {
        const box = mailbox();
        return { items: VIEWS.map((view) => ({ view, unreadThreads: [...box.threads.values()].filter((rows) => inView(rows, view).some(({ message }) => message.unread)).length })),
          drafts: box.drafts.size, state: state(box) };
      },
      async listThreads(query) {
        const box = mailbox();
        fields(query, ROUTES.listThreads.query);
        const { view, labelId, q, tz } = query;
        if (!VIEWS.includes(view)) invalid('/view');
        if (labelId !== undefined) need(box.labels.get(labelId));
        if (q !== undefined) boundedText(q, limits.queryBytes, '/q');
        if (tz !== undefined) {
          if (typeof tz !== 'string' || /^[+-]/.test(tz)) invalid('/tz');
          try { new Intl.DateTimeFormat('en', { timeZone: tz }); }
          catch { invalid('/tz'); }
        }
        // The fake validates tz but evaluates date boundaries in UTC.
        const match = search(q ?? '', box.labels);
        const items = [...box.threads.values()].flatMap((all) => {
          const rows = inView(all, view);
          return rows.some((row) => (labelId === undefined || row.message.labelIds.includes(labelId)) && match(row)) ? [summarize(all, rows, view)] : [];
        });
        return { ...page(items, box.directory.id, 'listThreads', query, (item) => [item.lastDate, item.id], byThread), state: state(box) };
      },
      async getThread(threadId) {
        const box = mailbox();
        const rows = need(box.threads.get(threadId));
        return { thread: summarize(rows, rows), messages: rows.map(({ message }) => message), state: state(box) };
      },
      async updateThreads(update) {
        const box = mailbox();
        fields(update, ['ids', 'set']);
        const { ids, set } = update;
        fields(set, ['folder', 'unread', 'starred', 'addLabelIds', 'removeLabelIds'], '/set');
        if (!Array.isArray(ids)) invalid('/ids');
        if (ids.length > limits.batchThreads) invalid('/ids', 'too_many');
        if (set.folder !== undefined && !folders.includes(set.folder)) invalid('/set/folder');
        for (const field of ['unread', 'starred'] as const) {
          if (set[field] !== undefined && typeof set[field] !== 'boolean') invalid(`/set/${field}`);
        }
        const rows = [...new Set(ids)].flatMap((threadId) => need(box.threads.get(threadId)));
        for (const [field, labels] of [['addLabelIds', set.addLabelIds], ['removeLabelIds', set.removeLabelIds]] as const) {
          if (labels !== undefined && !Array.isArray(labels)) invalid(`/set/${field}`);
          for (const [i, label] of (labels ?? []).entries()) if (!box.labels.has(label)) invalid(`/set/${field}/${i}`);
        }
        const changes = rows.map((row) => {
          const m = row.message;
          const next = [...new Set([...m.labelIds, ...(set.addLabelIds ?? [])])].filter((label) => !set.removeLabelIds?.includes(label));
          if (next.length > limits.labelsPerMessage) fail('limit_reached', { limit: limits.labelsPerMessage });
          return { row, next };
        });
        let changed = false;
        for (const { row, next } of changes) {
          const m = row.message;
          if (set.folder !== undefined && set.folder !== m.folder) {
            if (set.folder === 'spam' || m.folder === 'spam') {
              const sample = box.training.get(m.from.email) ?? { spam: 0, ham: 0 };
              sample[set.folder === 'spam' ? 'spam' : 'ham']++;
              box.training.set(m.from.email, sample);
            }
            m.folder = set.folder;
            if (hidden(m.folder)) row.expires = now + limits.spamTrashRetentionDays * day;
            else delete row.expires;
            changed = true;
          }
          if (set.unread !== undefined && set.unread !== m.unread) { m.unread = set.unread; changed = true; }
          if (set.starred !== undefined && set.starred !== m.starred) { m.starred = set.starred; changed = true; }
          if (next.length !== m.labelIds.length || next.some((label, i) => label !== m.labelIds[i])) { m.labelIds = next; changed = true; }
        }
        if (changed) bump(box);
        return { state: state(box) };
      },
      async getBodyUrl(messageId, input) {
        fields(input, ['remoteImages']);
        if (typeof input.remoteImages !== 'boolean') invalid('/remoteImages');
        if (!need(mailbox().messages.get(messageId)).message.hasHtml) fail('no_html_body');
        return contentUrl();
      },
      async getAttachmentUrl(messageId, number) {
        part(mailbox(), messageId, number);
        return contentUrl();
      },
      async saveAttachmentToDrive(messageId, number, opts) {
        const box = mailbox();
        return replay(box.keys, opts, 'saveAttachmentToDrive', [messageId, number], null, () => {
          const { name, size, type } = part(box, messageId, number);
          const driveFileId = id();
          box.driveFiles.set(driveFileId, { name, size, type });
          return { driveFileId, name };
        });
      },
      async listLabels() { const box = mailbox(); return { items: [...box.labels.values()], state: state(box) }; },
      async createLabel(input, opts) {
        const box = mailbox();
        return replay(box.keys, opts, 'createLabel', [], input, () => {
          fields(input, ['name']);
          const name = labelName(box, input.name);
          if (box.labels.size >= limits.labelsPerMailbox) fail('limit_reached', { limit: limits.labelsPerMailbox });
          const label = { id: id(), name };
          box.labels.set(label.id, label);
          bump(box);
          return label;
        });
      },
      async renameLabel(labelId, input) {
        const box = mailbox();
        fields(input, ['name']);
        const label = need(box.labels.get(labelId));
        const name = labelName(box, input.name, labelId);
        if (name === label.name) return label;
        const renamed = { ...label, name };
        box.labels.set(labelId, renamed);
        bump(box);
        return renamed;
      },
      async deleteLabel(labelId) {
        const box = mailbox();
        if (box.labels.delete(labelId)) {
          for (const { message } of box.messages.values()) message.labelIds = message.labelIds.filter((label) => label !== labelId);
          bump(box);
        }
      },
      async listIdentities() { return { items: identities(mailbox()) }; },
      async getSettings() { return mailbox().settings; },
      async updateSettings(patch) {
        const box = mailbox();
        fields(patch, ['signature', 'undoSeconds', 'defaultFrom', 'replyFromReceivedAddress']);
        const { signature, undoSeconds, defaultFrom, replyFromReceivedAddress } = patch;
        if (signature !== undefined) boundedText(signature, limits.signatureBytes, '/signature');
        if (undoSeconds !== undefined && !limits.undoSecondsOptions.includes(undoSeconds)) invalid('/undoSeconds');
        if (replyFromReceivedAddress !== undefined && typeof replyFromReceivedAddress !== 'boolean') invalid('/replyFromReceivedAddress');
        const settings = {
          signature: signature ?? box.settings.signature, undoSeconds: undoSeconds ?? box.settings.undoSeconds,
          defaultFrom: defaultFrom === undefined ? box.settings.defaultFrom : sender(box, defaultFrom, true).email,
          replyFromReceivedAddress: replyFromReceivedAddress ?? box.settings.replyFromReceivedAddress,
        };
        if (canonical(settings) !== canonical(box.settings)) { box.settings = settings; bump(box); }
        return settings;
      },
      async listDrafts(query) {
        const box = mailbox();
        fields(query, ROUTES.listDrafts.query);
        return { ...page([...box.drafts.values()], box.directory.id, 'listDrafts', query, (d) => [d.updatedAt, d.id], byTime), state: state(box) };
      },
      async getDraft(draftId) { return need(mailbox().drafts.get(draftId)); },
      async createDraft(input, opts) {
        const box = mailbox();
        return replay(box.keys, opts, 'createDraft', [], input, () => {
          const draft = makeDraft(box, id(), input);
          box.drafts.set(draft.id, draft);
          bump(box);
          return draft;
        });
      },
      async replaceDraft(draftId, input, opts) {
        const box = mailbox();
        requireRevision(opts);
        const previous = need(box.drafts.get(draftId));
        checkRevision(previous, opts);
        const draft = makeDraft(box, draftId, input);
        box.drafts.set(draftId, draft);
        releaseDraftUploads(box, previous, false);
        bump(box);
        return draft;
      },
      async deleteDraft(draftId, opts) {
        const box = mailbox();
        const draft = box.drafts.get(draftId);
        if (!draft) return;
        checkRevision(draft, opts);
        box.drafts.delete(draftId);
        releaseDraftUploads(box, draft, true);
        bump(box);
      },
      async sendDraft(draftId, opts) {
        const box = mailbox();
        requireRevision(opts);
        return replay(box.keys, opts, 'sendDraft', [draftId], null, () => {
          const draft = need(box.drafts.get(draftId));
          checkRevision(draft, opts);
          checkCounts(draft);
          const all = [...draft.to, ...draft.cc, ...draft.bcc];
          if (!all.length || all.some(({ email }) => !validEmail(email))) fail('invalid_recipients');
          const from = address(sender(box, draft.from, true));
          // This fake does not generate MIME. Model its body plus encoded files, including base64 line breaks and header/part overhead.
          const size = bytes(draft.body) + 16 * 1024 + draft.attachments.reduce((sum, a) => {
            if (a.kind === 'link') return sum + bytes(`\r\n${a.name}: ${a.url}`);
            const base64 = 4 * Math.ceil(a.size / 3);
            return sum + base64 + 2 * Math.ceil(base64 / 76) + bytes(a.name) + bytes(a.type);
          }, 0);
          if (size > limits.outboundMessageBytes) fail('message_too_large', { limit: limits.outboundMessageBytes });
          const undoRemainingMs = box.settings.undoSeconds * second;
          const send: Send = {
            id: id(), draftId, state: 'pending', createdAt: iso(now), undoUntil: iso(now + undoRemainingMs), undoRemainingMs,
            recipients: all.map(({ email }) => ({ email, state: 'pending' })),
          };
          box.drafts.delete(draftId);
          box.sends.set(send.id, { send, pending: { draft, size, from, references: replyReferences(box, draft.inReplyTo) } });
          bump(box);
          return send;
        });
      },
      async listSends(query) {
        const box = mailbox();
        fields(query, ROUTES.listSends.query);
        if (query.active !== undefined && typeof query.active !== 'boolean') invalid('/active');
        const active = (send: Send) => ['pending', 'sending', 'delayed'].includes(send.state);
        const sends = [...box.sends.values()].map(({ send }) => send).filter((send) => !query.active || active(send));
        return { ...page(sends.map(sendResult), box.directory.id, 'listSends', query, (send) => [send.createdAt, send.id], byTime), state: state(box) };
      },
      async getSend(sendId) { return sendResult(need(mailbox().sends.get(sendId)).send); },
      async undoSend(sendId, opts) {
        const box = mailbox();
        return replay(box.keys, opts, 'undoSend', [sendId], null, () => {
          const entry = need(box.sends.get(sendId));
          if (!entry.pending) fail('send_not_pending');
          const draft = { ...entry.pending.draft, revision: id(), updatedAt: iso(now) };
          box.drafts.set(draft.id, draft);
          entry.send.state = 'cancelled';
          entry.send.undoRemainingMs = 0;
          delete entry.pending;
          bump(box);
          return draft;
        });
      },
      async createUpload(input, opts) {
        const box = mailbox();
        const { name, type, bytes: blob } = input ?? {};
        let digest: string;
        const fingerprint = async () => [name, type, blob instanceof Blob ? (digest = await sha256(blob)) : null];
        return replay(box.keys, opts, 'createUpload', [], fingerprint, () => {
          fields(input, ['name', 'type', 'bytes']);
          if (!(blob instanceof Blob)) invalid('/bytes');
          if (blob.size > limits.uploadBytes) fail('payload_too_large', { limit: limits.uploadBytes });
          boundedText(name, 255, '/name');
          if (!name || /[\\/\p{Cc}]/u.test(name)) invalid('/name');
          if (typeof type !== 'string') invalid('/type');
          return storeUpload(box, name, type, blob.size, digest);
        });
      },
      async deleteUpload(uploadId) {
        const box = mailbox();
        if (!usesUpload(box, uploadId) && box.uploads.delete(uploadId)) bump(box);
      },
      async importFromDrive(input, opts) {
        const box = mailbox();
        return replay(box.keys, opts, 'importFromDrive', [], input, async () => {
          fields(input, ['pickId', 'mode']);
          const pick = need(picks.get(input.pickId));
          if (pick.mailboxId !== box.directory.id) fail('not_found');
          if (input.mode === 'link') return { attachments: [{ kind: 'link', url: 'https://example.com/drive/demo', name: driveFile.name }] };
          if (input.mode !== 'copy') invalid('/mode');
          const digest = await sha256(driveFile.bytes);
          return { attachments: [uploadRef(storeUpload(box, driveFile.name, driveFile.type, driveFile.bytes.size, digest))] };
        });
      },
      async listDomains() { return { items: [...domains.values()].sort((a, b) => compare(a.name, b.name)) }; },
      async addDomain(input, opts) {
        return replay(workspaceKeys, opts, 'addDomain', [], input, () => {
          fields(input, ['name', 'kind', 'aliasOf']);
          if (typeof input.name !== 'string') invalid('/name');
          if (input.aliasOf !== undefined && typeof input.aliasOf !== 'string') invalid('/aliasOf');
          const name = input.name.trim().toLowerCase();
          if (!validDomain(name)) invalid('/name');
          if (domains.has(name)) fail('domain_exists');
          const { kind } = input;
          const aliasOf = input.aliasOf?.trim().toLowerCase();
          if (kind === 'alias') {
            const target = aliasOf === undefined ? undefined : domains.get(aliasOf);
            if (!target || target.kind === 'alias') invalid('/aliasOf');
          } else if (kind !== 'secondary' || aliasOf !== undefined) invalid(kind !== 'secondary' ? '/kind' : '/aliasOf');
          const domain: Domain = { name, kind, routing: 'pending', sending: 'pending', ...(aliasOf !== undefined && { aliasOf }) };
          domains.set(name, domain);
          return domain;
        });
      },
      async listMailboxes(query) {
        fields(query, ROUTES.listMailboxes.query);
        return page([...boxes.values()].map(({ directory }) => directory), 'workspace', 'listMailboxes', query, (d) => [d.primaryAddress, d.id], ascending);
      },
      async createMailbox(input, opts) {
        return replay(workspaceKeys, opts, 'createMailbox', [], input, () => {
          fields(input, ['primaryAddress', 'displayName', 'ownerUserId']);
          const primary = directoryAddress(input.primaryAddress, '/primaryAddress');
          availableOwner(input.ownerUserId);
          return newMailbox(primary, displayName(input.displayName), input.ownerUserId);
        });
      },
      async updateMailbox(mailboxId, patch) {
        fields(patch, ['displayName', 'ownerUserId']);
        const box = need(boxes.get(mailboxId));
        const name = patch.displayName === undefined ? box.directory.displayName : displayName(patch.displayName);
        const owner = patch.ownerUserId ?? box.directory.ownerUserId;
        if (owner !== box.directory.ownerUserId) availableOwner(owner);
        if (owner !== box.directory.ownerUserId || name !== box.directory.displayName) {
          box.directory.ownerUserId = owner;
          box.directory.displayName = name;
          bump(box);
        }
        return box.directory;
      },
      async createAlias(input, opts) {
        return replay(workspaceKeys, opts, 'createAlias', [], input, () => {
          fields(input, ['mailboxId', 'address', 'sendAs']);
          const box = need(boxes.get(input.mailboxId));
          const email = directoryAddress(input.address, '/address');
          if (typeof input.sendAs !== 'boolean') invalid('/sendAs');
          if (box.directory.aliases.length >= limits.aliasesPerMailbox) fail('limit_reached', { limit: limits.aliasesPerMailbox });
          const alias: Alias = { address: email, mailboxId: input.mailboxId, sendAs: input.sendAs ? 'pending' : 'off' };
          box.directory.aliases.push(alias);
          bump(box);
          return alias;
        });
      },
      async deleteAlias(value) {
        const email = value.trim().toLowerCase();
        for (const box of boxes.values()) {
          const index = box.directory.aliases.findIndex((alias) => alias.address === email);
          if (index !== -1) { box.directory.aliases.splice(index, 1); bump(box); break; }
        }
      },
      async listMembers(query) {
        fields(query, ROUTES.listMembers.query);
        const items = [...members.values()].map((m): Member => ({ ...m, hasMailbox: ownerBox(m.id) !== undefined }));
        return page(items, 'workspace', 'listMembers', query, (m) => [m.name, m.id], ascending);
      },
    };
    // All callers get detached snapshots; access checks precede route validation and replay.
    return new Proxy(service, {
      get(target, op: Operation) {
        if (!Object.hasOwn(ROUTES, op)) return undefined;
        return async (...input: unknown[]) => {
          const route = ROUTES[op];
          if (route.access === 'admin') {
            if (!admin) fail('forbidden');
            if (route.reauth && now - authTime > maxAuthAge * second) fail('reauth_required', { maxAgeSeconds: maxAuthAge });
          } else mailbox();
          return copy(await Reflect.apply(target[op], target, copy(input)));
        };
      },
    });
  }
  function sendResult(send: Send): Send {
    return { ...send, undoRemainingMs: send.state === 'pending' ? Math.max(0, Date.parse(send.undoUntil) - now) : 0 };
  }

  const sessions = { member: bind('member'), other: bind('other'), admin: bind('admin'), staleAdmin: bind('staleAdmin') };
  return {
    as: (principal) => sessions[principal],
    contentOrigin,
    async deliver(input: TestMessage, principal = 'member') {
      const box = need(ownerBox(principal === 'staleAdmin' ? 'admin' : principal));
      const date = iso(now);
      const attachments = (input.attachments ?? []).map((a, i) => ({ part: i + 1, name: a.name, type: a.type, size: a.bytes.length, inline: a.inline ?? false }));
      const message = append(box, input.inReplyTo, {
        from: input.from, to: input.to, cc: input.cc ?? [], subject: input.subject, text: input.text,
        date, receivedAt: date, folder: 'inbox', unread: true, starred: false, labelIds: [], sent: false,
        hasHtml: input.html !== undefined, remoteImages: input.html !== undefined && (input.remoteImages ?? false), attachments,
        size: bytes(input.text) + bytes(input.html ?? '') + attachments.reduce((sum, a) => sum + a.size, 0), verdict: { level: 'none', reasons: [] },
      });
      return { threadId: message.threadId, messageId: message.id };
    },
    async advance(ms) { advance(ms); },
    async drivePick() {
      const box = need(ownerBox('member'));
      const token = randomUUID();
      picks.set(token, { mailboxId: box.directory.id, expires: now + 5 * 60 * second });
      return token;
    },
  };
}
