import type { Attachment, Conversation, DirectoryUser, Domain, Draft, Group, Label, MailApi, MailboxId, PendingSend, Settings } from './index.ts';
import { attachments, driveFiles, identities, labels, seed } from './fixtures.ts';
import { matchesQuery } from './search.ts';
import { secureHttpsLink } from './index.ts';

const day = 86_400_000;
const folders = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', archive: 'Archive', spam: 'Spam', trash: 'Trash' } satisfies Record<MailboxId, string>;
const hidden = (id: MailboxId) => id === 'spam' || id === 'trash';
const copy = structuredClone;
const email = /^[^\s@,]+@[^\s@,.]+(?:\.[^\s@,.]+)+$/;
const attachmentLimit = 25 * 1024 * 1024;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const normalizeSubject = (subject: string) => subject.trim().replace(/^(?:(?:re|fwd?):\s*)+/i, '').toLowerCase();
const addresses = (values: string[]) => values.map((email) => ({ name: email, email }));

export function createFakeMailApi(clock: () => number = Date.now, options: { contentOrigin?: string } = {}): MailApi {
  const threads = new Map(seed(clock()).map((t) => [t.id, copy(t)]));
  const allLabels = copy(labels);
  const pending = new Map<string, PendingSend & { draft: Draft }>();
  const drafts = new Map<string, Draft>();
  const blobs = new Map<string, Blob>(attachments.map((a, i) => [a.id, new Blob([i ? 'Room,Cost\nKitchen,120\n' : 'Kitchen wall: confirm before Tuesday.\n'], { type: a.type })]));
  const files = copy(driveFiles);
  let settings: Settings = { defaultFrom: identities[0].email, signature: '', undoSeconds: 10 };
  const domains: Domain[] = [{ name: 'example.com', kind: 'Primary', status: 'Active' }];
  const users: DirectoryUser[] = [{ ...identities[0], aliases: [identities[1].email] }];
  const groups: Group[] = [{ email: 'team@example.com', name: 'Team', members: 4, moderated: true }];
  let serial = 0;
  const nextId = () => `demo-${++serial}`;

  function refresh(now: number) {
    for (const [id, thread] of threads) {
      if (thread.expiresAt === undefined || now < thread.expiresAt) continue;
      threads.delete(id);
      for (const message of thread.messages) for (const file of message.attachments) release(file.id);
    }
    for (const [id, entry] of pending) {
      if (now < entry.undoUntil) continue;
      pending.delete(id);
      const draft = entry.draft;
      const sender = identities.find((a) => a.email === draft.from)!;
      const previous = draft.replyToThreadId ? threads.get(draft.replyToThreadId) : undefined;
      const date = new Date(entry.undoUntil).toISOString();
      const from = { name: sender.name, email: sender.email };
      const message = { id, from, to: addresses(draft.to), cc: addresses(draft.cc), bcc: addresses(draft.bcc), date, subject: draft.subject, text: draft.body, attachments: draft.attachments };
      if (previous && !hidden(previous.mailboxId) && previous.messages.length < 100 && normalizeSubject(previous.subject) === normalizeSubject(draft.subject)) {
        previous.messages.push(message);
        Object.assign(previous, { date, from, snippet: draft.body, count: previous.messages.length, hasAttachments: previous.hasAttachments || message.attachments.length > 0 });
      } else {
        threads.set(id, { id, subject: draft.subject, snippet: draft.body, date, from, mailboxId: 'sent', count: 1, labelIds: [], starred: false, unread: false, hasAttachments: message.attachments.length > 0, messages: [message] });
      }
    }
  }

  function needAttachment(id: string): Blob {
    const blob = blobs.get(id);
    if (!blob) throw new Error('Attachment not found.');
    return blob;
  }

  function release(id: string) {
    const contains = (items: Attachment[]) => items.some((file) => file.id === id);
    if (files.some((file) => file.id === id) || [...drafts.values()].some((draft) => contains(draft.attachments)) ||
        [...pending.values()].some(({ draft }) => contains(draft.attachments)) ||
        [...threads.values()].some((thread) => thread.messages.some((message) => contains(message.attachments)))) return;
    blobs.delete(id);
  }

  function store(file: Blob, name: string): Attachment {
    if (file.size > attachmentLimit) throw new Error('Attachments cannot exceed 25 MiB.');
    const id = nextId();
    blobs.set(id, file);
    return { id, name, size: file.size, type: file.type || 'application/octet-stream' };
  }

  return {
    async listMailboxes() {
      refresh(clock());
      return (Object.entries(folders) as [MailboxId, string][]).map(([id, name]) => ({ id, name, unread: [...threads.values()].filter((t) => t.mailboxId === id && t.unread).length }));
    },
    async listThreads(filter) {
      refresh(clock());
      return [...threads.values()].filter((t) => {
        if (filter.mailboxId === 'sent') {
          if (hidden(t.mailboxId) || !t.messages.some((m) => identities.some((a) => a.email === m.from.email))) return false;
        } else if (filter.mailboxId ? t.mailboxId !== filter.mailboxId : hidden(t.mailboxId)) return false;
        return (!filter.labelId || t.labelIds.includes(filter.labelId)) && (!filter.starred || t.starred) && (!filter.query || matchesQuery(t, filter.query, allLabels));
      }).sort((a, b) => b.date.localeCompare(a.date)).map(({ messages: _messages, ...thread }) => copy(thread));
    },
    async getThread(id) { refresh(clock()); return copy(threads.get(id)); },
    async getMessageContent(id, { remoteImages }) {
      // Fixture routes only. The real adapter will receive a short-lived URL
      // from an authorized service, not turn a message ID into an endpoint.
      refresh(clock());
      const thread = threads.get('plan');
      if (!options.contentOrigin || id !== 'plan-latest' || !thread || hidden(thread.mailboxId)) return undefined;
      const url = new URL('/body/plan-latest', options.contentOrigin);
      if (remoteImages) url.searchParams.set('images', '1');
      return url.href;
    },
    async updateThread(id, update) {
      const now = clock();
      refresh(now);
      const t = threads.get(id);
      if (!t) throw new Error('Conversation not found.');
      if (update.mailboxId && update.mailboxId !== t.mailboxId) {
        t.mailboxId = update.mailboxId;
        t.expiresAt = hidden(t.mailboxId) ? now + 30 * day : undefined;
      }
      if (update.unread !== undefined) t.unread = update.unread;
      if (update.starred !== undefined) t.starred = update.starred;
      if (update.labelId && allLabels.some((label) => label.id === update.labelId)) {
        t.labelIds = t.labelIds.filter((id) => id !== update.labelId);
        if (update.labelled) t.labelIds.push(update.labelId);
      }
    },
    async listLabels() { return copy(allLabels); },
    async createLabel(name) {
      name = name.trim();
      if (!name || name.length > 72) throw new Error('Enter a label name of 1–72 characters.');
      if (allLabels.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw new Error('A label with that name already exists.');
      const label: Label = { id: nextId(), name };
      allLabels.push(label);
      return copy(label);
    },
    async listIdentities() { return copy(identities); },
    async listDrafts() { return copy([...drafts.values()].reverse()); },
    async saveDraft(draft) {
      const saved = { ...copy(draft), id: draft.id ?? nextId() };
      const old = drafts.get(saved.id);
      drafts.set(saved.id, saved);
      for (const file of old?.attachments ?? []) release(file.id);
      return copy(saved);
    },
    async discardDraft(id) {
      const old = drafts.get(id);
      drafts.delete(id);
      for (const file of old?.attachments ?? []) release(file.id);
    },
    async send(draft) {
      const now = clock();
      refresh(now);
      if (!identities.some((a) => a.email === draft.from)) throw new Error('Choose an available From address.');
      const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
      if (recipients.length < 1 || recipients.length > 50 || recipients.some((a) => !email.test(a))) throw new Error('Enter 1–50 valid recipient addresses.');
      if (draft.attachments.some((a) => a.link !== undefined && !secureHttpsLink(a.link))) throw new Error('Invalid Drive attachment link.');
      if (draft.attachments.reduce((sum, a) => sum + a.size, 0) > attachmentLimit) throw new Error('Attachments cannot exceed 25 MiB in total.');
      const result = { id: nextId(), undoUntil: now + settings.undoSeconds * 1000 };
      pending.set(result.id, { ...result, draft: copy(draft) });
      if (draft.id) {
        const old = drafts.get(draft.id);
        drafts.delete(draft.id);
        for (const file of old?.attachments ?? []) release(file.id);
      }
      return result;
    },
    async undoSend(id) {
      refresh(clock());
      const entry = pending.get(id);
      if (!entry) return undefined;
      pending.delete(id);
      const restored = { ...entry.draft, id: entry.draft.id ?? nextId() };
      drafts.set(restored.id, restored);
      return copy(restored);
    },
    async uploadAttachment(file, name) { return store(file, name); },
    async downloadAttachment(id) { return needAttachment(id); },
    async releaseAttachment(id) { release(id); },
    async listDriveFiles() { return copy(files); },
    async attachFromDrive(id, mode) {
      const file = files.find((item) => item.id === id);
      if (!file) throw new Error('Drive file not found.');
      if (mode === 'link') return { ...file, size: 0, link: `https://example.com/drive/${encodeURIComponent(file.id)}` };
      return store(blobs.get(file.id) ?? new Blob(['Demo Drive fixture'], { type: file.type }), file.name);
    },
    async saveToDrive(id) {
      const blob = needAttachment(id);
      const source = attachments.find((a) => a.id === id) ?? [...threads.values()].flatMap((t) => t.messages.flatMap((m) => m.attachments)).find((a) => a.id === id);
      const saved = store(blob, source?.name ?? 'Saved attachment');
      files.push(saved);
    },
    async getSettings() { return copy(settings); },
    async updateSettings(value) {
      if (!identities.some((a) => a.email === value.defaultFrom)) throw new Error('Choose an available From address.');
      settings = copy(value);
    },
    async listDomains() { return copy(domains); },
    async addDomain(name, kind) {
      name = name.trim().toLowerCase();
      const domainLabels = name.split('.');
      if (name.length > 253 || domainLabels.length < 2 || !domainLabels.every((label) => dnsLabel.test(label)) || !/[a-z]/i.test(domainLabels.at(-1)!)) throw new Error('Enter a valid domain.');
      if (domains.some((d) => d.name === name)) throw new Error('That domain already exists.');
      domains.push({ name, kind, status: 'Pending' });
    },
    async listUsers() { return copy(users); },
    async addUser(user) {
      if (!user.name.trim() || !email.test(user.email)) throw new Error('Enter a name and valid email address.');
      if (users.some((u) => u.email === user.email || u.aliases.includes(user.email))) throw new Error('That address already exists.');
      users.push({ ...copy(user), aliases: [] });
    },
    async addAlias(userEmail, alias) {
      const user = users.find((u) => u.email === userEmail);
      if (!user || !email.test(alias)) throw new Error('Choose a user and enter a valid email address.');
      if (users.some((u) => u.email === alias || u.aliases.includes(alias))) throw new Error('That address already exists.');
      user.aliases.push(alias);
    },
    async listGroups() { return copy(groups); },
    async addGroup(group) {
      if (!group.name.trim() || !email.test(group.email)) throw new Error('Enter a group name and valid email address.');
      if (groups.some((g) => g.email === group.email)) throw new Error('That group already exists.');
      groups.push(copy(group));
    }
  };
}
