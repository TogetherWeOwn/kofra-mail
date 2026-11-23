import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ERROR_STATUS, isMailApiError, PROBLEM_TYPE_PREFIX } from './errors.ts';
import type { MailErrorCode, Problem } from './errors.ts';
import { hasHeaderControl, threadingHeaders } from './headers.ts';
import { attachmentBudget, LIMITS } from './limits.ts';
import { ROUTES } from './routes.ts';
import type { ConformanceHarness, TestMessage } from './harness.ts';
import type { Conditional, Idempotent, MailService } from './service.ts';
import type { DraftInput, Session, View } from './wire.ts';

const second = 1000;
const day = 86_400 * second;
const missing = 'missing-id';
const noKey = {} as Idempotent;
const noRevision = {} as Conditional;
const key = (idempotencyKey: string): Idempotent => ({ idempotencyKey });
const file = { name: 'notes.txt', type: 'text/plain', bytes: new Uint8Array([65, 66, 67]) };
const upload = (bytes = new Blob([file.bytes])) => ({ name: file.name, type: file.type, bytes });
const message = (subject = 'Test message', patch: Partial<TestMessage> = {}): TestMessage => ({
  from: { name: 'Casey', email: 'casey@example.net' },
  to: [{ name: 'Mailbox', email: 'mailbox@example.com' }], subject, text: 'Mail fixture', ...patch,
});
const draftInput = (from: string, patch: Partial<DraftInput> = {}): DraftInput => ({
  from, to: [{ email: 'casey@example.net' }], cc: [], bcc: [], subject: 'Test draft', body: 'Hello', attachments: [], ...patch,
});
const ids = (page: { items: { id: string }[] }) => page.items.map(({ id }) => id);

function requiredMailbox(session: Session): NonNullable<Session['mailbox']> {
  assert.ok(session.mailbox, 'expected this principal to own a mailbox');
  return session.mailbox;
}

// Inspect the public token format only; MAC verification belongs to the content Worker.
function decodeContentUrl(url: URL) {
  const match = /^\/v1\/(body|att)\/[^./]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(url.pathname);
  assert.ok(match, 'expected a v1 body or attachment token');
  const [, purpose, payload] = match;
  const decoded = Buffer.from(payload, 'base64url');
  assert.equal(decoded.toString('base64url'), payload);
  const claims = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
  assert.equal(claims.v, 1);
  const { iat, exp } = claims;
  assert.ok(typeof iat === 'number' && Number.isInteger(iat));
  assert.ok(typeof exp === 'number' && Number.isInteger(exp) && exp > iat);
  return { purpose, claims, exp, ttl: exp - iat };
}

function json<T>(result: T): T {
  if (result === undefined) return result; // No response body (DELETE and harness control calls).
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  function visit(value: unknown, field?: string): void {
    if (value === null) assert.equal(field, 'nextCursor', 'only nextCursor may be null');
    else if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, key);
    }
  }
  visit(result);
  return result;
}

function checked(service: MailService): MailService {
  return new Proxy(service, {
    get(target, property: keyof MailService) {
      const method = target[property];
      return (...args: unknown[]) => (Reflect.apply(method, target, args) as Promise<unknown>).then((result) => {
        const route = ROUTES[property];
        if (route.success === 204) assert.equal(result, undefined);
        else assert.notEqual(result, undefined, `${property} must return a JSON body`);
        // Exactly the routes marked `state` carry the mailbox state; a Send's own `state` is its send state.
        if (route.state) assert.equal(typeof (result as { state?: unknown }).state, 'string', `${property} must carry state`);
        else if (result !== undefined && property !== 'sendDraft' && property !== 'getSend') {
          assert.ok(!Object.hasOwn(result as object, 'state'), `${property} must not carry state`);
        }
        return json(result);
      });
    },
  });
}

// The current case's problem type prefix; cases run one at a time.
let problemTypePrefix = PROBLEM_TYPE_PREFIX;

async function rejects(promise: Promise<unknown>, code: MailErrorCode): Promise<Problem> {
  let result!: Problem;
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(isMailApiError(error), 'expected a MailApiError');
    assert.equal(error.code, code);
    assert.equal(error.status, ERROR_STATUS[code]);
    assert.equal(error.problem.type, `${problemTypePrefix}${code}`);
    result = json(error.problem);
    return true;
  });
  return result;
}

export function defineConformance(name: string, makeHarness: () => Promise<ConformanceHarness>): void {
  describe(name, () => {
    function run(title: string, body: (h: ConformanceHarness, mail: MailService) => Promise<void>): void {
      test(title, async () => {
        const harness = await makeHarness();
        problemTypePrefix = harness.problemTypePrefix ?? PROBLEM_TYPE_PREFIX;
        try {
          const h: ConformanceHarness = {
            as: (principal) => checked(harness.as(principal)),
            deliver: async (...args) => json(await harness.deliver(...args)),
            advance: async (ms) => json(await harness.advance(ms)),
            sentHeaders: async (messageId) => json(await harness.sentHeaders(messageId)),
            contentOrigin: harness.contentOrigin,
            ...(harness.credentialEpoch && { credentialEpoch: (principal) => harness.credentialEpoch!(principal) }),
            ...(harness.drivePick && { drivePick: async () => json(await harness.drivePick!()) }),
            ...(harness.driveFaults && { driveFaults: harness.driveFaults }),
          };
          await body(h, h.as('member'));
        } finally {
          await harness.close?.();
        }
      });
    }

    run('1. sessions identify the user even before a mailbox is provisioned', async (h, mail) => {
      const session = await mail.getSession();
      const mailbox = requiredMailbox(session);
      assert.equal(session.workspace.role, 'member');
      assert.ok(mailbox.id);
      assert.ok(mailbox.primaryAddress);
      assert.ok(session.csrfToken);
      for (const field of Object.keys(LIMITS)) assert.ok(Object.hasOwn(session.limits, field), field);
      assert.ok((await mail.listIdentities()).items.some((id) => id.primary && id.email === mailbox.primaryAddress));

      const newAdmin = h.as('newAdmin');
      const before = await newAdmin.getSession();
      assert.equal(before.workspace.id, session.workspace.id);
      assert.equal(before.workspace.role, 'admin');
      assert.ok(!Object.hasOwn(before, 'mailbox'));
      await rejects(newAdmin.listThreads({ view: 'inbox' }), 'forbidden');
      assert.ok((await newAdmin.listMembers({})).items.some(({ id, hasMailbox }) => id === before.user.id && !hasMailbox));
      const created = await newAdmin.createMailbox({
        primaryAddress: `conformance-new-admin@${mailbox.primaryAddress.split('@').at(-1)}`,
        displayName: before.user.name, ownerUserId: before.user.id,
      }, key('new-admin-mailbox'));
      assert.deepEqual((await newAdmin.getSession()).mailbox, { id: created.id, primaryAddress: created.primaryAddress });
    });

    run('2. results are JSON-safe, with null allowed only on the last page cursor', async (h, mail) => {
      const { threadId } = await h.deliver(message());
      const result = await mail.listThreads({ view: 'inbox' });
      assert.ok(ids(result).includes(threadId));
      await mail.getThread(threadId);
      const label = await mail.createLabel({ name: 'JSON-only fixture' }, key('json-label'));
      const empty = await mail.listThreads({ view: 'trash', labelId: label.id });
      assert.deepEqual(empty.items, []);
      assert.equal(empty.nextCursor, null);
    });

    run('3. failures use catalogue problem codes and their fixed statuses', async (_h, mail) => {
      await rejects(mail.getThread(missing), 'not_found');
      await rejects(mail.listThreads({ view: 'inbox', limit: 0 }), 'invalid_request');
      await rejects(mail.listDomains(), 'forbidden');
    });

    run('4. listings order by date and id and use query-bound cursors', async (h, mail) => {
      const { limits } = await mail.getSession();
      const a = await h.deliver(message('Pagination Older'));
      await h.advance(second);
      const b = await h.deliver(message('Pagination Newer one'));
      const c = await h.deliver(message('Pagination Newer two'));
      const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
      const rows = await Promise.all([a, b, c].map(async ({ threadId }) => (await mail.getThread(threadId)).thread));
      const expected = rows.sort((a, b) => cmp(b.lastDate, a.lastDate) || cmp(b.id, a.id)).map(({ id }) => id);
      const query = { view: 'inbox', q: 'subject:pagination', limit: 1 } as const;
      let page = await mail.listThreads(query);
      const firstCursor = page.nextCursor;
      assert.ok(firstCursor);
      for (const [i, id] of expected.entries()) {
        assert.deepEqual(ids(page), [id]);
        if (i < expected.length - 1) {
          assert.ok(page.nextCursor);
          page = await mail.listThreads({ ...query, cursor: page.nextCursor });
        }
      }
      assert.equal(page.nextCursor, null);
      await rejects(mail.listThreads({ ...query, limit: 0 }), 'invalid_request');
      await rejects(mail.listThreads({ ...query, limit: limits.pageSizeMax + 1 }), 'invalid_request');
      await rejects(mail.listThreads({ ...query, cursor: '!!!not-a-cursor!!!' }), 'invalid_cursor');
      await rejects(mail.listThreads({ ...query, view: 'all', cursor: firstCursor }), 'invalid_cursor');
      await rejects(mail.listThreads({ ...query, limit: limits.pageSizeMax, cursor: firstCursor }), 'invalid_cursor');
      await h.advance(second);
      await h.deliver(message('Pagination Inserted above the cursor'));
      assert.deepEqual(ids(await mail.listThreads({ ...query, cursor: firstCursor })), [expected[1]]);
    });

    run('5. conversations expose MIME attachment metadata and bounded UTF-8 text', async (h, mail) => {
      const { messageTextBytes } = (await mail.getSession()).limits;
      const prefix = 'x'.repeat(messageTextBytes);
      const { threadId, messageId } = await h.deliver(message('Long body', { text: `${prefix}é`, attachments: [file] }));
      const conversation = await mail.getThread(threadId);
      const delivered = conversation.messages.find(({ id }) => id === messageId);
      assert.ok(delivered);
      assert.equal(delivered.text, prefix);
      assert.equal(delivered.textTruncated, true);
      assert.equal(delivered.attachments.length, 1);
      const [part] = delivered.attachments;
      assert.ok(Number.isInteger(part.part) && part.part >= 0);
      assert.equal(part.name, file.name);
      assert.equal(part.size, file.bytes.length);
      const split = await h.deliver(message('Split code point', { text: `${prefix.slice(1)}é` }));
      const [truncated] = (await mail.getThread(split.threadId)).messages;
      assert.equal(truncated.text, prefix.slice(1));
      assert.equal(truncated.textTruncated, true);
      await rejects(mail.getThread(missing), 'not_found');
    });

    run('6. reads, writes and listings respect mailbox and workspace boundaries', async (h, mail) => {
      const other = h.as('other');
      const session = await mail.getSession();
      const mailbox = requiredMailbox(session);
      const input = draftInput(mailbox.primaryAddress);
      const { threadId, messageId } = await h.deliver(message('Private', { html: '<p>Private</p>', attachments: [file] }));
      const { messages: [delivered] } = await mail.getThread(threadId);
      const [{ part }] = delivered.attachments;
      const label = await mail.createLabel({ name: 'Private' }, key('label'));
      const uploaded = await mail.createUpload(upload(), key('file'));
      const draft = await mail.createDraft(input, key('draft'));
      const outgoing = await mail.createDraft(input, key('outgoing'));
      const send = await mail.sendDraft(outgoing.id, { ...key('send'), ifMatch: outgoing.revision });
      const otherSession = await other.getSession();
      const otherInput = draftInput(requiredMailbox(otherSession).primaryAddress);
      const withUpload = (input: DraftInput): DraftInput => ({ ...input, attachments: [{ kind: 'upload', uploadId: uploaded.id }] });
      await rejects(other.getThread(threadId), 'not_found');
      await rejects(other.getBodyUrl(messageId, { remoteImages: false }), 'not_found');
      await rejects(other.getDraft(draft.id), 'not_found');
      await rejects(other.getSend(send.id), 'not_found');
      // Uploads have no get route. The key used in member's mailbox is independent.
      await rejects(other.createDraft(withUpload(otherInput), key('draft')), 'not_found');
      await rejects(other.createDraft({ ...otherInput, inReplyTo: messageId }, key('reply')), 'not_found');
      await rejects(other.createDraft({ ...otherInput, forwardOf: messageId }, key('forward')), 'not_found');
      await rejects(other.createDraft({ ...otherInput, attachments: [{ kind: 'message', messageId, part }] }, key('attach-message')), 'not_found');
      await rejects(other.updateThreads({ ids: [threadId], set: { folder: 'trash' } }), 'not_found');
      await rejects(other.getAttachmentUrl(messageId, part), 'not_found');
      await rejects(other.saveAttachmentToDrive(messageId, part, key('save')), otherSession.features.drive ? 'not_found' : 'feature_unavailable');
      await rejects(other.replaceDraft(draft.id, otherInput, { ifMatch: draft.revision }), 'not_found');
      await rejects(other.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision }), 'not_found');
      await rejects(other.undoSend(send.id, key('undo')), 'not_found');
      await rejects(other.renameLabel(label.id, { name: 'Renamed' }), 'not_found');
      assert.equal(await other.deleteDraft(draft.id), undefined);
      assert.equal(await other.deleteLabel(label.id), undefined);
      assert.equal(await other.deleteUpload(uploaded.id), undefined);
      assert.deepEqual(await mail.getDraft(draft.id), draft);
      assert.ok((await mail.listLabels()).items.some(({ id, name }) => id === label.id && name === label.name));
      const attached = await mail.createDraft(withUpload(input), key('surviving-upload'));
      assert.deepEqual(attached.attachments, [{ kind: 'upload', uploadId: uploaded.id, name: uploaded.name, type: uploaded.type, size: uploaded.size }]);
      assert.ok(!ids(await other.listThreads({ view: 'all' })).includes(threadId));
      assert.ok(!ids(await other.listLabels()).includes(label.id));
      assert.ok(!ids(await other.listDrafts({})).includes(draft.id));
      assert.ok(!ids(await other.listSends({})).includes(send.id));
      const received = await h.deliver(message('Other mailbox'), 'other');
      assert.ok(ids(await other.listThreads({ view: 'all' })).includes(received.threadId));
      assert.ok(!ids(await mail.listThreads({ view: 'all' })).includes(received.threadId));

      const admin = h.as('admin');
      const foreign = h.as('foreignAdmin');
      const foreignSession = await foreign.getSession();
      const foreignMailbox = requiredMailbox(foreignSession);
      assert.equal(foreignSession.workspace.role, 'admin');
      assert.notEqual(foreignSession.workspace.id, session.workspace.id);
      const alias = await admin.createAlias({
        mailboxId: mailbox.id, address: `conformance-private@${mailbox.primaryAddress.split('@').at(-1)}`, sendAs: true,
      }, key('private-alias'));
      await rejects(foreign.updateMailbox(mailbox.id, { displayName: 'Foreign update' }), 'not_found');
      const foreignDomain = foreignMailbox.primaryAddress.split('@').at(-1);
      assert.ok(foreignDomain);
      await rejects(foreign.createAlias({
        mailboxId: mailbox.id, address: `conformance-foreign@${foreignDomain}`, sendAs: true,
      }, key('foreign-alias')), 'not_found');
      assert.equal(await foreign.deleteAlias(alias.address), undefined);
      const localBoxes = await admin.listMailboxes({ limit: session.limits.pageSizeMax });
      const localBox = localBoxes.items.find(({ id }) => id === mailbox.id);
      assert.ok(localBox?.aliases.some(({ address }) => address === alias.address));
      const foreignBoxes = await foreign.listMailboxes({ limit: foreignSession.limits.pageSizeMax });
      assert.ok(ids(foreignBoxes).includes(foreignMailbox.id));
      assert.ok(ids(foreignBoxes).every((id) => !ids(localBoxes).includes(id)));
      const localMembers = await admin.listMembers({ limit: session.limits.pageSizeMax });
      const foreignMembers = await foreign.listMembers({ limit: foreignSession.limits.pageSizeMax });
      assert.ok(ids(foreignMembers).includes(foreignSession.user.id));
      assert.ok(ids(foreignMembers).every((id) => !ids(localMembers).includes(id)));
      const localDomains = (await admin.listDomains()).items.map(({ name }) => name);
      const foreignDomains = (await foreign.listDomains()).items.map(({ name }) => name);
      assert.ok(foreignDomains.includes(foreignDomain));
      assert.ok(foreignDomains.every((name) => !localDomains.includes(name)));
    });

    run('7. thread updates set values atomically and update unread counts', async (h, mail) => {
      const { limits } = await mail.getSession();
      const { threadId } = await h.deliver(message());
      const [initial] = (await mail.getThread(threadId)).messages;
      const move = { ids: [threadId], set: { folder: 'trash' as const, unread: true } };
      const updated = await mail.updateThreads(move);
      const trash = await mail.listThreads({ view: 'trash' });
      const trashed = trash.items.find(({ id }) => id === threadId);
      assert.ok(trashed?.expiresAt);
      const marker = await h.deliver(message('After the move'), 'other');
      const [after] = (await h.as('other').getThread(marker.threadId)).messages;
      const movedAt = Date.parse(trashed.expiresAt) - limits.spamTrashRetentionDays * day;
      assert.ok(movedAt >= Date.parse(initial.receivedAt) && movedAt <= Date.parse(after.receivedAt));
      assert.ok(!ids(await mail.listThreads({ view: 'inbox' })).includes(threadId));
      assert.ok(!ids(await mail.listThreads({ view: 'all' })).includes(threadId));
      assert.deepEqual(await mail.updateThreads(move), updated);
      assert.deepEqual(await mail.listThreads({ view: 'trash' }), trash);
      const label = await mail.createLabel({ name: 'Marked' }, key('label'));
      await mail.updateThreads({ ids: [threadId], set: { addLabelIds: [label.id] } });
      assert.ok((await mail.getThread(threadId)).messages.every((m) => m.labelIds.includes(label.id)));
      await mail.updateThreads({ ids: [threadId], set: { removeLabelIds: [label.id] } });
      const before = await mail.getThread(threadId);
      assert.ok(before.messages.every((m) => !m.labelIds.includes(label.id)));
      await rejects(mail.updateThreads({ ids: [threadId, missing], set: { unread: false } }), 'not_found');
      assert.deepEqual(await mail.getThread(threadId), before);
      await rejects(mail.updateThreads({ ids: [threadId], set: { unread: false, addLabelIds: [missing] } }), 'invalid_request');
      assert.deepEqual(await mail.getThread(threadId), before);
      const tooMany = [threadId];
      for (let i = 0; i < limits.batchThreads; i++) {
        tooMany.push((await h.deliver(message(`Batch fixture ${i}`))).threadId);
      }
      await rejects(mail.updateThreads({ ids: tooMany, set: { starred: true } }), 'invalid_request');
      const unread = async (view: View) => (await mail.listViews()).items.find((item) => item.view === view)?.unreadThreads;
      const count = await unread('trash');
      assert.ok(typeof count === 'number' && count > 0);
      await mail.updateThreads({ ids: [threadId], set: { unread: false } });
      assert.equal(await unread('trash'), count - 1);
    });

    run('8. Trash expires on schedule unless the message moved out first', async (h, mail) => {
      const { limits } = await mail.getSession();
      const a = await h.deliver(message('Expire'));
      const b = await h.deliver(message('Keep'));
      await mail.updateThreads({ ids: [a.threadId, b.threadId], set: { folder: 'trash' } });
      await h.advance(day);
      await mail.updateThreads({ ids: [b.threadId], set: { folder: 'archive' } });
      await h.advance((limits.spamTrashRetentionDays - 1) * day);
      await rejects(mail.getThread(a.threadId), 'not_found');
      assert.ok(!ids(await mail.listThreads({ view: 'trash' })).includes(a.threadId));
      assert.ok(ids(await mail.listThreads({ view: 'archive' })).includes(b.threadId));
    });

    run('9. search matches operators and adjacent phrases within the view', async (h, mail) => {
      const { limits } = await mail.getSession();
      const target = await h.deliver(message('Invoice', { text: 'The blue train left', attachments: [file] }));
      const decoy = await h.deliver(message('Meeting', {
        from: { name: 'Morgan', email: 'morgan@example.com' }, text: 'The blue evening train left',
      }));
      const label = await mail.createLabel({ name: 'Quarter End' }, key('label'));
      await mail.updateThreads({ ids: [target.threadId], set: { unread: true, addLabelIds: [label.id] } });
      await mail.updateThreads({ ids: [decoy.threadId], set: { unread: false } });
      for (const q of ['from:casey@example.net', 'subject:invoice', 'has:attachment', 'label:"quarter end"', 'is:unread', '"blue train"']) {
        assert.deepEqual(ids(await mail.listThreads({ view: 'inbox', q })), [target.threadId], q);
      }
      assert.deepEqual(ids(await mail.listThreads({ view: 'archive', q: 'subject:invoice' })), []);
      // An invalid size matches nothing; it is not literal text.
      await h.deliver(message('Size larger: than life'));
      assert.deepEqual(ids(await mail.listThreads({ view: 'inbox', q: 'larger:' })), []);
      assert.deepEqual(ids(await mail.listThreads({ view: 'inbox', q: 'larger:huge' })), []);
      const reply = await h.deliver(message('Re: Invoice', {
        inReplyTo: target.messageId, from: { name: 'Morgan', email: 'morgan@example.com' }, text: 'Ｃonfirmed',
      }));
      assert.equal(reply.threadId, target.threadId);
      assert.deepEqual(ids(await mail.listThreads({ view: 'inbox', q: 'confirmed' })), [target.threadId]);
      assert.deepEqual(ids(await mail.listThreads({ view: 'inbox', q: 'from:morgan@example.com has:attachment' })), []);
      const { messages: [delivered] } = await mail.getThread(decoy.threadId);
      // Move to the next 18:00 UTC, which is already the following day in Tokyo.
      const at = Date.parse(delivered.receivedAt);
      await h.advance((18 * 60 * 60 * second - (at % day) + day) % day);
      const evening = await h.deliver(message('Evening in UTC'));
      const { messages: [eveningMessage] } = await mail.getThread(evening.threadId);
      const nextDay = new Date(Date.parse(eveningMessage.receivedAt) + day).toISOString().slice(0, 10);
      const q = `after:${nextDay} subject:"evening in utc"`;
      assert.deepEqual(ids(await mail.listThreads({ view: 'inbox', q, tz: 'Asia/Tokyo' })), [evening.threadId]);
      assert.deepEqual(ids(await mail.listThreads({ view: 'inbox', q })), []);
      await rejects(mail.listThreads({ view: 'all', q: 'x'.repeat(limits.queryBytes + 1) }), 'invalid_request');
    });

    run('10. labels validate names and deletion unlabels messages', async (h, mail) => {
      const { limits } = await mail.getSession();
      const { threadId } = await h.deliver(message());
      const label = await mail.createLabel({ name: 'Project' }, key('create'));
      assert.ok((await mail.listLabels()).items.some((item) => item.id === label.id && item.name === 'Project'));
      await rejects(mail.createLabel({ name: 'pRoJeCt' }, key('duplicate')), 'label_exists');
      await rejects(mail.createLabel({ name: '' }, key('empty')), 'invalid_request');
      await rejects(mail.createLabel({ name: 'x'.repeat(limits.labelNameChars + 1) }, key('too-long')), 'invalid_request');
      await mail.updateThreads({ ids: [threadId], set: { addLabelIds: [label.id] } });
      const renamed = await mail.renameLabel(label.id, { name: 'Renamed' });
      assert.equal(renamed.id, label.id);
      assert.equal(renamed.name, 'Renamed');
      assert.ok((await mail.listLabels()).items.some((item) => item.id === label.id && item.name === 'Renamed'));
      assert.equal(await mail.deleteLabel(label.id), undefined);
      assert.ok(!ids(await mail.listLabels()).includes(label.id));
      const thread = await mail.getThread(threadId);
      assert.ok(!thread.thread.labelIds.includes(label.id));
      assert.ok(thread.messages.every((m) => !m.labelIds.includes(label.id)));
    });

    run('11. idempotency replays successes but lets failed actions retry', async (h, mail) => {
      const session = await mail.getSession();
      const input = draftInput(requiredMailbox(session).primaryAddress);
      async function verify<T>(create: (options: Idempotent) => Promise<T>, change: (options: Idempotent) => Promise<T>, token: string) {
        const first = await create(key(token));
        assert.deepEqual(await create(key(token)), first);
        await rejects(change(key(token)), 'idempotency_key_reused');
        await rejects(create(noKey), 'precondition_required');
        return first;
      }
      const label = await verify((opts) => mail.createLabel({ name: 'One label' }, opts),
        (opts) => mail.createLabel({ name: 'Another label' }, opts), 'label');
      const draft = await verify((opts) => mail.createDraft(input, opts),
        (opts) => mail.createDraft({ ...input, subject: 'Different' }, opts), 'draft');
      const uploadKey = key('upload');
      // Two same-key uploads started together: whether they overlap depends on
      // scheduling, so either the second is refused as in progress or it is a
      // replay of the first. Never two distinct uploads.
      const concurrentUploads = await Promise.allSettled([
        mail.createUpload(upload(), uploadKey),
        mail.createUpload(upload(), uploadKey),
      ]);
      const committed = concurrentUploads.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      assert.ok(committed.length >= 1);
      for (const result of concurrentUploads) {
        if (result.status !== 'rejected') continue;
        const busy = await rejects(Promise.reject(result.reason), 'idempotency_in_progress');
        assert.ok(Number.isInteger(busy.retryAfterSeconds) && busy.retryAfterSeconds! >= 0, 'idempotency_in_progress carries an integer retryAfterSeconds');
      }
      for (const other of committed) assert.deepEqual(other, committed[0]);
      const uploaded = committed[0];
      assert.deepEqual(await mail.createUpload(upload(), uploadKey), uploaded);
      await rejects(mail.createUpload(upload(new Blob(['XYZ'])), uploadKey), 'idempotency_key_reused');
      await rejects(mail.createUpload(upload(), noKey), 'precondition_required');
      assert.deepEqual((await mail.listLabels()).items.filter((item) => item.name === label.name), [label]);
      assert.deepEqual((await mail.listDrafts({})).items.filter((item) => item.subject === draft.subject), [draft]);
      // Uploads have no list route. The replayed id must address the original upload.
      const attached = await mail.replaceDraft(draft.id, { ...input, attachments: [{ kind: 'upload', uploadId: uploaded.id }] }, { ifMatch: draft.revision });
      assert.deepEqual(attached.attachments, [{ kind: 'upload', uploadId: uploaded.id, name: uploaded.name, type: uploaded.type, size: uploaded.size }]);
      const { from, ...rest } = input;
      assert.deepEqual(await mail.createDraft({ ...rest, from }, key('draft')), draft);
      await rejects(mail.createLabel({ name: label.name }, key('duplicate')), 'label_exists');
      await mail.deleteLabel(label.id);
      const recreated = await mail.createLabel({ name: label.name }, key('duplicate'));
      assert.notEqual(recreated.id, label.id);
      assert.equal(recreated.name, label.name);

      const sendOptions = key('revision-retry');
      await rejects(mail.sendDraft(attached.id, { ...sendOptions, ...noRevision }), 'precondition_required');
      await rejects(mail.sendDraft(attached.id, { ...sendOptions, ifMatch: draft.revision }), 'revision_mismatch');
      const sent = await mail.sendDraft(attached.id, { ...sendOptions, ifMatch: attached.revision });
      assert.equal(sent.draftId, attached.id);
      assert.equal(sent.state, 'pending');

      await h.advance(session.limits.idempotencyRetentionSeconds * second);
      const afterExpiry = await mail.createLabel({ name: 'After key expiry' }, key('duplicate'));
      assert.notEqual(afterExpiry.id, recreated.id);
    });

    run('12. drafts require current revisions and valid send-as identities', async (_h, mail) => {
      const input = draftInput(requiredMailbox(await mail.getSession()).primaryAddress);
      const draft = await mail.createDraft(input, key('draft'));
      assert.ok(draft.revision);
      const replaced = await mail.replaceDraft(draft.id, { ...input, subject: 'Edited' }, { ifMatch: draft.revision });
      assert.equal(replaced.id, draft.id);
      assert.equal(replaced.subject, 'Edited');
      assert.notEqual(replaced.revision, draft.revision);
      await rejects(mail.replaceDraft(draft.id, input, { ifMatch: draft.revision }), 'revision_mismatch');
      await rejects(mail.replaceDraft(draft.id, input, noRevision), 'precondition_required');
      await rejects(mail.replaceDraft(draft.id, { ...input, from: 'outside@example.net' }, { ifMatch: replaced.revision }), 'invalid_sender');
      assert.deepEqual(await mail.getDraft(draft.id), replaced);
      assert.equal(await mail.deleteDraft(draft.id, { ifMatch: replaced.revision }), undefined);
      assert.equal(await mail.deleteDraft(draft.id), undefined);
      assert.ok(!ids(await mail.listDrafts({})).includes(draft.id));
    });

    run('13. send checks enforce valid recipients, file count, size and revision', async (_h, mail) => {
      const session = await mail.getSession();
      const { limits } = session;
      const mailbox = requiredMailbox(session);
      const input = draftInput(mailbox.primaryAddress);
      const send = async (patch: Partial<DraftInput>, token: string) => {
        const draft = await mail.createDraft({ ...input, ...patch }, key(`draft-${token}`));
        return mail.sendDraft(draft.id, { ...key(`send-${token}`), ifMatch: draft.revision });
      };
      await rejects(send({ to: [] }, 'empty'), 'invalid_recipients');
      const invalidDraft = await mail.createDraft({ ...input, to: [{ email: 'invalid' }] }, key('draft-invalid'));
      await rejects(mail.sendDraft(invalidDraft.id, { ...key('send-invalid'), ifMatch: invalidDraft.revision }), 'invalid_recipients');
      // Count limits apply at save time too, so invalid drafts need not be creatable.
      await rejects(send({ to: Array.from({ length: limits.recipientsPerMessage + 1 }, (_, i) => ({ email: `person${i}@example.net` })) }, 'recipients'), 'too_many_recipients');
      const attachments: DraftInput['attachments'] = [];
      for (let i = 0; i <= limits.attachmentsPerMessage; i++) {
        const file = await mail.createUpload({ ...upload(), name: `tiny-${i}.txt` }, key(`tiny-${i}`));
        attachments.push({ kind: 'upload', uploadId: file.id });
      }
      await rejects(send({ attachments }, 'parts'), 'too_many_attachments');
      const rawBudget = attachmentBudget(limits, Buffer.byteLength(input.body));
      const boundary = await mail.createUpload(upload(new Blob([new Uint8Array(rawBudget)])), key('boundary'));
      const boundaryDraft = await mail.createDraft({ ...input, attachments: [{ kind: 'upload', uploadId: boundary.id }] }, key('draft-fits'));
      const boundarySend = await mail.sendDraft(boundaryDraft.id, { ...key('send-fits'), ifMatch: boundaryDraft.revision });
      assert.equal(boundarySend.state, 'pending');
      const tooLargeRaw = Math.ceil(limits.outboundMessageBytes * 3 / 4) + 1;
      const large = await mail.createUpload(upload(new Blob([new Uint8Array(tooLargeRaw)])), key('large'));
      const oversize = await rejects(send({ attachments: [{ kind: 'upload', uploadId: large.id }] }, 'oversize'), 'message_too_large');
      assert.equal(oversize.limit, limits.outboundMessageBytes);
      const current = await mail.createDraft(input, key('stale'));
      await mail.replaceDraft(current.id, input, { ifMatch: current.revision });
      await rejects(mail.sendDraft(current.id, { ...key('stale-send'), ifMatch: current.revision }), 'revision_mismatch');
    });

    run('14. send and undo are replay-safe and timers release only pending sends', async (h, mail) => {
      const { defaultFrom, undoSeconds } = await mail.getSettings();
      const draft = await mail.createDraft(draftInput(defaultFrom), key('draft'));
      const options = { ...key('send'), ifMatch: draft.revision };
      const send = await mail.sendDraft(draft.id, options);
      assert.equal(send.state, 'pending');
      assert.equal(Date.parse(send.undoUntil), Date.parse(send.createdAt) + undoSeconds * second);
      assert.ok(!ids(await mail.listDrafts({})).includes(draft.id));
      const other = await mail.createDraft(draftInput(defaultFrom, { subject: 'Send this one' }), key('other-draft'));
      const releaseOptions = { ...key('other-send'), ifMatch: other.revision };
      const releasing = await mail.sendDraft(other.id, releaseOptions);
      const replayed = await mail.sendDraft(draft.id, options);
      assert.equal(replayed.id, send.id);
      assert.equal(replayed.state, 'pending');
      assert.deepEqual(new Set(ids(await mail.listSends({ active: true }))), new Set([send.id, releasing.id]));
      const undo = await mail.undoSend(send.id, key('undo'));
      assert.equal(undo.id, draft.id);
      assert.notEqual(undo.revision, draft.revision);
      assert.equal((await mail.getSend(send.id)).state, 'cancelled');
      assert.deepEqual(await mail.undoSend(send.id, key('undo')), undo);
      // The draft exists again under a new revision; the old key still replays before any If-Match check.
      const afterUndo = await mail.sendDraft(draft.id, options);
      assert.equal(afterUndo.id, send.id);
      assert.equal(afterUndo.state, 'cancelled');
      assert.ok(ids(await mail.listDrafts({})).includes(draft.id));
      await h.advance(undoSeconds * second);
      assert.equal((await mail.getSend(send.id)).state, 'cancelled');
      const released = await mail.getSend(releasing.id);
      assert.notEqual(released.state, 'pending');
      assert.ok(released.messageId);
      assert.equal(released.undoRemainingMs, 0);
      const releasedReplay = await mail.sendDraft(other.id, releaseOptions);
      assert.equal(releasedReplay.id, released.id);
      assert.equal(releasedReplay.state, released.state);
      assert.equal(releasedReplay.undoRemainingMs, 0);
      const sent = await mail.listThreads({ view: 'sent' });
      const copies = (await Promise.all(sent.items.map(({ id }) => mail.getThread(id)))).flatMap(({ messages }) => messages);
      assert.ok(copies.some((m) => m.id === released.messageId && m.sent));
      assert.ok(!copies.some((m) => m.send?.id === send.id));
      await rejects(mail.undoSend(releasing.id, key('too-late')), 'send_not_pending');
    });

    run('15. drafts keep referenced uploads and forwarded parts past source expiry', async (h, mail) => {
      const session = await mail.getSession();
      const { limits } = session;
      const mailbox = requiredMailbox(session);
      await rejects(mail.createUpload(upload(new Blob([new Uint8Array(limits.uploadBytes + 1)])), key('huge')), 'payload_too_large');
      const loose = await mail.createUpload(upload(), key('loose'));
      const retained = await mail.createUpload(upload(), key('retained'));
      const withUpload = (uploadId: string) => draftInput(mailbox.primaryAddress, { attachments: [{ kind: 'upload', uploadId }] });
      const draft = await mail.createDraft(withUpload(retained.id), key('draft'));
      await h.advance(limits.uploadRetentionSeconds * second);
      await rejects(mail.createDraft(withUpload(loose.id), key('expired')), 'not_found');
      assert.deepEqual((await mail.getDraft(draft.id)).attachments, draft.attachments);
      const replaced = await mail.replaceDraft(draft.id, withUpload(retained.id), { ifMatch: draft.revision });
      assert.deepEqual(replaced.attachments, draft.attachments);

      const source = await h.deliver(message('Forward this file', { attachments: [file] }));
      const { messages: [delivered] } = await mail.getThread(source.threadId);
      const [{ part }] = delivered.attachments;
      await mail.updateThreads({ ids: [source.threadId], set: { folder: 'trash' } });
      const forwardInput = draftInput(mailbox.primaryAddress, {
        forwardOf: source.messageId,
        attachments: [{ kind: 'message', messageId: source.messageId, part }],
      });
      const forwarded = await mail.createDraft(forwardInput, key('forward'));
      const expected = [{ kind: 'message', messageId: source.messageId, part, name: file.name, type: file.type, size: file.bytes.length }];
      await h.advance(limits.spamTrashRetentionDays * day);
      await rejects(mail.getThread(source.threadId), 'not_found');
      assert.deepEqual((await mail.getDraft(forwarded.id)).attachments, expected);
      await rejects(mail.createDraft(forwardInput, key('expired-source')), 'not_found');
      const edited = await mail.replaceDraft(forwarded.id, { ...forwardInput, subject: 'Forward after expiry' }, { ifMatch: forwarded.revision });
      assert.equal(edited.forwardOf, source.messageId);
      assert.deepEqual(edited.attachments, expected);
      const send = await mail.sendDraft(edited.id, { ...key('send-forward'), ifMatch: edited.revision });
      assert.equal(send.state, 'pending');
      await h.advance((await mail.getSettings()).undoSeconds * second);
      const sent = await mail.getSend(send.id);
      assert.ok(sent.messageId);
      const copies = await mail.listThreads({ view: 'sent' });
      const messages = (await Promise.all(copies.items.map(({ id }) => mail.getThread(id)))).flatMap(({ messages }) => messages);
      const sentCopy = messages.find(({ id }) => id === sent.messageId);
      assert.ok(sentCopy);
      assert.deepEqual(sentCopy.attachments.map(({ name, type, size }) => ({ name, type, size })), [
        { name: file.name, type: file.type, size: file.bytes.length },
      ]);
      const sentPart = sentCopy.attachments[0].part;
      const url = new URL((await mail.getAttachmentUrl(sentCopy.id, sentPart)).url);
      assert.equal(url.origin, new URL(h.contentOrigin).origin);
      const token = decodeContentUrl(url);
      assert.equal(token.purpose, 'att');
      assert.equal(token.claims.mb, mailbox.id);
      assert.equal(token.claims.msg, sentCopy.id);
      assert.equal(token.claims.part, sentPart);
    });

    run('16. settings patch only specified fields and validate sender and undo duration', async (_h, mail) => {
      const before = await mail.getSettings();
      const patch = { signature: `${before.signature === 'Kind regards' ? 'Best' : 'Kind regards'}` };
      const expected = { ...before, ...patch };
      assert.deepEqual(await mail.updateSettings(patch), expected);
      assert.deepEqual(await mail.getSettings(), expected);
      await rejects(mail.updateSettings({ defaultFrom: 'outside@example.net' }), 'invalid_sender');
      await rejects(mail.updateSettings({ undoSeconds: 7 as 5 }), 'invalid_request');
      assert.deepEqual(await mail.getSettings(), expected);
    });

    run('17. content URLs carry scoped claims on the configured content origin', async (h, mail) => {
      const session = await mail.getSession();
      const { limits, workspace, user } = session;
      const mailbox = requiredMailbox(session);
      const html = await h.deliver(message('Formatted', {
        html: '<p>Formatted</p><img src="https://example.net/image.png">', remoteImages: true, attachments: [file],
      }));
      const { messages: [delivered] } = await mail.getThread(html.threadId);
      const now = Date.parse(delivered.receivedAt);
      const [{ part }] = delivered.attachments;
      const without = await mail.getBodyUrl(html.messageId, { remoteImages: false });
      const withImages = await mail.getBodyUrl(html.messageId, { remoteImages: true });
      const attachment = await mail.getAttachmentUrl(html.messageId, part);
      const plain = await h.deliver(message('Plain'));
      const plainBody = await mail.getBodyUrl(plain.messageId, { remoteImages: false });
      // Bracket the mint times with deliveries so this also works over HTTP.
      const marker = await h.deliver(message('After URL minting'));
      const [after] = (await mail.getThread(marker.threadId)).messages;
      const cases = [
        { content: without, purpose: 'body', msg: html.messageId, ri: false },
        { content: withImages, purpose: 'body', msg: html.messageId, ri: true },
        { content: attachment, purpose: 'att', msg: html.messageId, part },
        { content: plainBody, purpose: 'body', msg: plain.messageId, ri: false },
      ];
      for (const { content, purpose, msg, ri, part } of cases) {
        const url = new URL(content.url);
        assert.equal(url.origin, new URL(h.contentOrigin).origin);
        assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
        const token = decodeContentUrl(url);
        assert.equal(token.purpose, purpose);
        assert.equal(token.claims.ws, workspace.id);
        assert.equal(token.claims.mb, mailbox.id);
        assert.equal(token.claims.msg, msg);
        assert.equal(token.claims.sub, user.id);
        assert.ok(Number.isInteger(token.claims.ep), 'the credential epoch claim is present');
        if (h.credentialEpoch) assert.equal(token.claims.ep, await h.credentialEpoch('member'));
        assert.equal(token.claims.ri, ri);
        assert.equal(token.claims.part, part);
        assert.ok(token.ttl <= limits.contentUrlSeconds);
        assert.equal(Date.parse(content.expiresAt), token.exp * second);
        assert.ok(Date.parse(content.expiresAt) > now);
        assert.ok(Date.parse(content.expiresAt) <= Date.parse(after.receivedAt) + limits.contentUrlSeconds * second);
      }
      await rejects(mail.getAttachmentUrl(html.messageId, part + 1), 'not_found');
    });

    run('18. every admin route enforces role and admin writes enforce recent sign-in', async (h, mail) => {
      const writes = (service: MailService) => [
        () => service.addDomain({ name: 'secondary.example.com', kind: 'secondary' }, key('domain')),
        () => service.createMailbox({ primaryAddress: 'new@example.com', displayName: 'New', ownerUserId: missing }, key('mailbox')),
        () => service.updateMailbox(missing, { displayName: 'Updated' }),
        () => service.createAlias({ mailboxId: missing, address: 'alias@example.com', sendAs: true }, key('alias')),
        () => service.deleteAlias('alias@example.com'),
      ];
      for (const call of [() => mail.listDomains(), () => mail.listMailboxes({}), () => mail.listMembers({}), ...writes(mail)]) {
        await rejects(call(), 'forbidden');
      }
      const stale = h.as('staleAdmin');
      for (const call of writes(stale)) {
        const error = await rejects(call(), 'reauth_required');
        assert.equal(error.maxAgeSeconds, 600);
      }
      await stale.listDomains();
      const domain = { name: 'reauth.example.com', kind: 'secondary' } as const;
      const options = key('admin-replay');
      await h.as('admin').addDomain(domain, options);
      await rejects(mail.addDomain(domain, options), 'forbidden');
      const error = await rejects(stale.addDomain(domain, options), 'reauth_required');
      assert.equal(error.maxAgeSeconds, 600);
    });

    run('19. admin directory validates domains, mailbox addresses and alias limits', async (h, mail) => {
      const admin = h.as('admin');
      const session = await mail.getSession();
      const { limits } = session;
      const mailbox = requiredMailbox(session);
      const domain = { name: 'secondary.example.com', kind: 'secondary' } as const;
      const primaryDomain = mailbox.primaryAddress.split('@').at(-1);
      const added = await admin.addDomain(domain, key('domain'));
      assert.equal(added.routing, 'pending');
      assert.equal(added.sending, 'pending');
      await rejects(admin.addDomain(domain, key('domain-again')), 'domain_exists');
      assert.ok((await admin.listDomains()).items.some(({ name }) => name === added.name));
      const members = (await admin.listMembers({})).items;
      const invited = members.find(({ status, hasMailbox }) => status === 'invited' && !hasMailbox);
      assert.ok(invited, 'harness needs an invited member without a mailbox');
      const { user: owner } = await h.as('newAdmin').getSession();
      const input = { displayName: 'New owner', ownerUserId: owner.id };
      await rejects(admin.createMailbox({ ...input, primaryAddress: 'new@unknown.example.net' }, key('unknown')), 'domain_not_in_workspace');
      await rejects(admin.createMailbox({ ...input, primaryAddress: mailbox.primaryAddress }, key('taken')), 'address_taken');
      const created = await admin.createMailbox({ ...input, primaryAddress: `conformance-new@${primaryDomain}` }, key('new'));
      assert.equal(created.ownerUserId, owner.id);
      const directory = await admin.listMailboxes({ limit: limits.pageSizeMax });
      assert.ok(ids(directory).includes(created.id));
      const current = directory.items.find(({ id }) => id === mailbox.id);
      assert.ok(current && current.aliases.length < limits.aliasesPerMailbox);
      const aliasInput = { mailboxId: mailbox.id, sendAs: true };
      const alias = await admin.createAlias({ ...aliasInput, address: `conformance-alias-0@${primaryDomain}` }, key('alias-0'));
      const identity = (await mail.listIdentities()).items.find(({ email }) => email === alias.address);
      assert.equal(identity?.kind, 'alias');
      assert.equal(identity.sendAs, 'pending');
      for (let i = 1; i < limits.aliasesPerMailbox - current.aliases.length; i++) {
        await admin.createAlias({ ...aliasInput, address: `conformance-alias-${i}@${primaryDomain}` }, key(`alias-${i}`));
      }
      const error = await rejects(admin.createAlias({ ...aliasInput, address: `conformance-extra@${primaryDomain}` }, key('extra')), 'limit_reached');
      assert.equal(error.limit, limits.aliasesPerMailbox);
      await admin.deleteAlias(alias.address);
      assert.ok(!(await mail.listIdentities()).items.some(({ email }) => email === alias.address));
      const transferred = await admin.updateMailbox(mailbox.id, { ownerUserId: invited.id });
      assert.equal(transferred.ownerUserId, invited.id);
      await rejects(mail.listThreads({ view: 'inbox' }), 'forbidden');
    });

    run('20. Drive copy grants produce usable uploads, or Drive is unavailable', async (h, mail) => {
      const session = await mail.getSession();
      if (!session.features.drive) {
        assert.equal(h.drivePick, undefined);
        await rejects(mail.importFromDrive({ pickId: missing, mode: 'copy' }, key('drive')), 'feature_unavailable');
        return;
      }
      const mailbox = requiredMailbox(session);
      assert.ok(h.drivePick);
      const { attachments } = await mail.importFromDrive({ pickId: await h.drivePick(), mode: 'copy' }, key('drive'));
      assert.equal(attachments.length, 1);
      const [attachment] = attachments;
      assert.equal(attachment.kind, 'upload');
      const draft = await mail.createDraft(draftInput(mailbox.primaryAddress, {
        attachments: [{ kind: 'upload', uploadId: attachment.uploadId }],
      }), key('draft'));
      assert.deepEqual(draft.attachments, attachments);

      // A lost reply after Drive stored the file: the same-key retry returns that file and creates no second one.
      if (!h.driveFaults) return;
      const { messageId } = await h.deliver(message('Save me', { attachments: [file] }));
      const { messages: [delivered] } = await mail.getThread((await mail.listThreads({ view: 'inbox', q: 'subject:"save me"' })).items[0].id);
      assert.equal(delivered.id, messageId);
      const [{ part }] = delivered.attachments;

      // Keys are scoped to the account user: after an owner change the same key is the new owner's own action.
      const ownerSave = await mail.saveAttachmentToDrive(messageId, part, key('owner-save'));
      const newOwner = h.as('newAdmin');
      const admin = h.as('admin');
      // So is a Drive pick: it is the choosing user's grant and does not pass to the next owner.
      const memberPick = await h.drivePick!();
      await admin.updateMailbox(mailbox.id, { ownerUserId: (await newOwner.getSession()).user.id });
      const memberFiles = await h.driveFaults.savedFiles();
      const theirs = await newOwner.saveAttachmentToDrive(messageId, part, key('owner-save'));
      assert.notEqual(theirs.driveFileId, ownerSave.driveFileId);
      assert.equal(await h.driveFaults.savedFiles(), memberFiles, "the new owner's file is in their own Drive");
      await rejects(newOwner.importFromDrive({ pickId: memberPick, mode: 'copy' }, key('stale-pick')), 'not_found');
      await admin.updateMailbox(mailbox.id, { ownerUserId: session.user.id });
      assert.deepEqual(await mail.saveAttachmentToDrive(messageId, part, key('owner-save')), ownerSave);

      const before = await h.driveFaults.savedFiles();
      // The source sits in Trash and expires between the lost reply and the retry.
      const { limits } = session;
      await mail.updateThreads({ ids: [delivered.threadId], set: { folder: 'trash' } });
      await h.advance(limits.spamTrashRetentionDays * day - 60 * 60 * second);
      await h.driveFaults.loseNextSaveReply();
      const lost = await rejects(mail.saveAttachmentToDrive(messageId, part, key('save')), 'unavailable');
      assert.ok(Number.isInteger(lost.retryAfterSeconds));
      assert.equal(await h.driveFaults.savedFiles(), before + 1, 'Drive stored the file before the reply was lost');
      // The key stays bound to that action: another part under it is refused, not a second file.
      await rejects(mail.saveAttachmentToDrive(messageId, part + 1, key('save')), 'idempotency_key_reused');
      assert.equal(await h.driveFaults.savedFiles(), before + 1);
      await h.advance(2 * 60 * 60 * second);
      await rejects(mail.getThread(delivered.threadId), 'not_found');
      const saved = await mail.saveAttachmentToDrive(messageId, part, key('save'));
      assert.equal(saved.name, file.name);
      assert.deepEqual(await mail.saveAttachmentToDrive(messageId, part, key('save')), saved);
      assert.equal(await h.driveFaults.savedFiles(), before + 1);
      // A new key is a new action, and the expired source can no longer be saved.
      await rejects(mail.saveAttachmentToDrive(messageId, part, key('save-again')), 'not_found');
      assert.equal(await h.driveFaults.savedFiles(), before + 1);

    });

    run('21. header text is refused, and threading headers fit the header byte limit', async (h, mail) => {
      const session = await mail.getSession();
      const { limits } = session;
      const mailbox = requiredMailbox(session);
      const input = draftInput(mailbox.primaryAddress);
      const bad: [Partial<DraftInput>, string][] = [
        [{ subject: 'Hello\r\nBcc: victim@example.net' }, '/subject'],
        [{ subject: 'Line\nfeed' }, '/subject'],
        [{ to: [{ name: 'Casey\r\nBcc: victim@example.net', email: 'casey@example.net' }] }, '/to/0/name'],
        [{ cc: [{ email: 'casey@example.net\r\nBcc: victim@example.net' }] }, '/cc/0/email'],
        [{ bcc: [{ name: 'Null\u0000name', email: 'casey@example.net' }] }, '/bcc/0/name'],
        [{ from: `${mailbox.primaryAddress}\n` }, '/from'],
        // A control character is refused even when the text is also too long.
        [{ subject: `${'x'.repeat(limits.subjectBytes)}\r` }, '/subject'],
      ];
      for (const [i, [patch, field]] of bad.entries()) {
        const refused = await rejects(mail.createDraft({ ...input, ...patch }, key(`bad-${i}`)), 'invalid_header');
        assert.deepEqual(refused.errors, [{ field, code: 'invalid' }]);
      }
      const draft = await mail.createDraft(input, key('good'));
      await rejects(mail.replaceDraft(draft.id, { ...input, subject: 'Edited\r\nX-Injected: 1' }, { ifMatch: draft.revision }), 'invalid_header');
      assert.deepEqual(await mail.getDraft(draft.id), draft);
      assert.ok(!hasHeaderControl('Tab\tseparated'));
      // Draft text is bounded at save.
      const long = [
        { to: [{ email: `${'a'.repeat(limits.addressBytes)}@example.net` }] },
        { attachments: [{ kind: 'link' as const, url: `https://example.net/${'p'.repeat(limits.linkUrlBytes)}`, name: 'Link' }] },
        { attachments: [{ kind: 'link' as const, url: 'https://example.net/doc', name: 'n'.repeat(limits.linkNameBytes + 1) }] },
      ];
      for (const [i, patch] of long.entries()) await rejects(mail.createDraft({ ...input, ...patch }, key(`long-${i}`)), 'invalid_request');
      // Third-party attachment names are stored without controls or path separators, and still forward.
      const odd = await h.deliver(message('Odd name', { attachments: [{ ...file, name: 'evil\r\nX-Injected: 1/..\\name.txt' }] }));
      const { messages: [oddMessage] } = await mail.getThread(odd.threadId);
      assert.ok(!/[\p{Cc}/\\]/u.test(oddMessage.attachments[0].name));
      const forward = await mail.createDraft(draftInput(mailbox.primaryAddress, {
        forwardOf: odd.messageId, attachments: [{ kind: 'message', messageId: odd.messageId, part: oddMessage.attachments[0].part }],
      }), key('odd-forward'));
      assert.equal((await mail.sendDraft(forward.id, { ...key('odd-send'), ifMatch: forward.revision })).state, 'pending');
      // The mailbox name is the From display name of every identity.
      const admin = h.as('admin');
      const named = await rejects(admin.updateMailbox(mailbox.id, { displayName: 'Mailbox\r\nBcc: victim@example.net' }), 'invalid_header');
      assert.deepEqual(named.errors, [{ field: '/displayName', code: 'invalid' }]);
      const aliased = await rejects(admin.createAlias({ mailboxId: mailbox.id, address: `trailing@${mailbox.primaryAddress.split('@')[1]}\n`, sendAs: false }, key('lf-alias')), 'invalid_header');
      assert.deepEqual(aliased.errors, [{ field: '/address', code: 'invalid' }]);

      // A thread of 12 messages, each with a legal 200-byte Message-ID: 11 of them would exceed headerValueBytes.
      const idBytes = 200;
      const longId = (n: number) => {
        const tail = `.${n}@example.net>`;
        return `<${'m'.repeat(idBytes - 1 - tail.length)}${tail}`;
      };
      const chain: string[] = [];
      let parent: { threadId: string; messageId: string } | undefined;
      for (let n = 1; n <= 12; n++) {
        chain.push(longId(n));
        assert.equal(Buffer.byteLength(chain.at(-1)!), idBytes);
        parent = await h.deliver(message(n === 1 ? 'Long thread' : 'Re: Long thread', {
          messageId: chain.at(-1), ...(parent && { inReplyTo: parent.messageId }),
        }));
      }
      assert.ok(parent);
      const reply = await mail.createDraft(draftInput(mailbox.primaryAddress, {
        subject: 'Re: Long thread', inReplyTo: parent.messageId, bcc: [{ email: 'hidden@example.net' }],
        to: [{ name: 'é'.repeat(60), email: 'casey@example.net' }, { email: 'morgan@example.net' }],
      }), key('reply'));
      const send = await mail.sendDraft(reply.id, { ...key('send-reply'), ifMatch: reply.revision });
      await h.advance((await mail.getSettings()).undoSeconds * second);
      const sent = await mail.getSend(send.id);
      assert.ok(sent.messageId);
      const headers = await h.sentHeaders(sent.messageId);
      assert.equal(headers['in-reply-to'], chain.at(-1));
      const references = headers.references.split(' ');
      assert.ok(Buffer.byteLength(headers.references) <= limits.headerValueBytes);
      assert.equal(references[0], chain[0]);
      assert.equal(references.at(-1), chain.at(-1));
      const positions = references.map((id) => chain.indexOf(id));
      assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), 'References keeps chain order');
      // The parent, the first id, then the newest ids while they fit: 10 ids of 200 bytes and 9 spaces.
      assert.equal(references.length, Math.min(11, Math.floor((limits.headerValueBytes + 1) / (idBytes + 1))));
      assert.deepEqual(threadingHeaders(chain, limits), { inReplyTo: chain.at(-1), references: headers.references });
      assert.ok(!Object.hasOwn(headers, 'bcc'), 'no stored MIME carries Bcc');
      // Message-IDs come from third-party mail: an unsafe one is never repeated in a header.
      const hostile = await h.deliver(message('Hostile id', { messageId: '<a@example.net>\rBcc: victim@example.net' }));
      const answer = await mail.createDraft(draftInput(mailbox.primaryAddress, { subject: 'Re: Hostile id', inReplyTo: hostile.messageId }), key('hostile-reply'));
      const hostileSend = await mail.sendDraft(answer.id, { ...key('hostile-send'), ifMatch: answer.revision });
      await h.advance((await mail.getSettings()).undoSeconds * second);
      const hostileCopy = (await mail.getSend(hostileSend.id)).messageId;
      assert.ok(hostileCopy);
      const hostileHeaders = await h.sentHeaders(hostileCopy);
      assert.ok(!Object.hasOwn(hostileHeaders, 'in-reply-to') && !Object.hasOwn(hostileHeaders, 'references'));
      assert.ok(!JSON.stringify(hostileHeaders).includes('victim@example.net'));

      // Address syntax cannot smuggle recipients, and a quoted name stays one recipient.
      for (const [i, email] of ['casey@example.net, victim@example.net', 'Casey <victim@example.net>', 'casey@example.net>'].entries()) {
        const smuggled = await mail.createDraft(draftInput(mailbox.primaryAddress, { to: [{ email }] }), key(`smuggle-${i}`));
        await rejects(mail.sendDraft(smuggled.id, { ...key(`smuggle-send-${i}`), ifMatch: smuggled.revision }), 'invalid_recipients');
      }
      const quotedName = `Casey "the boss", Bcc <victim@example.net> ${'x'.repeat(100)}`;
      const quoted = await mail.createDraft(draftInput(mailbox.primaryAddress, { subject: 'Quoted name', to: [{ name: quotedName, email: 'casey@example.net' }] }), key('quoted'));
      const quotedSend = await mail.sendDraft(quoted.id, { ...key('quoted-send'), ifMatch: quoted.revision });
      assert.deepEqual(quotedSend.recipients.map(({ email }) => email), ['casey@example.net']);
      await h.advance((await mail.getSettings()).undoSeconds * second);
      const quotedCopy = (await mail.getSend(quotedSend.id)).messageId;
      assert.ok(quotedCopy);
      // Outside quoted strings and encoded words the To header holds exactly one address: the recipient's.
      const bare = (await h.sentHeaders(quotedCopy)).to.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/=\?[^?]+\?[BbQq]\?[^?]*\?=/g, '');
      assert.deepEqual(bare.match(/<[^>]*>/g), ['<casey@example.net>']);
      assert.ok(!bare.includes('victim@example.net') && !bare.includes(','), 'the name cannot add a recipient');
      assert.ok(!JSON.stringify(headers).includes('hidden@example.net'));
      for (const name of ['from', 'to', 'subject', 'date', 'message-id']) assert.ok(headers[name], name);
      for (const [name, value] of Object.entries(headers)) assert.ok(!/[\r\n]/.test(value), `${name} is unfolded`);
    });

    run('22. a pending send never goes out after the mailbox changes owner', async (h, mail) => {
      const session = await mail.getSession();
      const mailbox = requiredMailbox(session);
      const { undoSeconds } = await mail.getSettings();
      const draft = await mail.createDraft(draftInput(mailbox.primaryAddress, { subject: 'Before reassignment' }), key('draft'));
      const send = await mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision });
      const newOwner = h.as('newAdmin');
      const { user } = await newOwner.getSession();
      await h.as('admin').updateMailbox(mailbox.id, { ownerUserId: user.id });
      await rejects(mail.getSend(send.id), 'forbidden');
      await h.advance(undoSeconds * second);
      const failed = await newOwner.getSend(send.id);
      assert.equal(failed.state, 'failed');
      assert.equal(failed.messageId, undefined);
      assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })), [{ state: 'failed', reason: 'invalid_sender' }]);
      const copies = await newOwner.listThreads({ view: 'sent', q: 'subject:"before reassignment"' });
      assert.deepEqual(copies.items, []);

      // The same, with the send racing the reassignment: it is refused, or it fails at release.
      await h.as('admin').updateMailbox(mailbox.id, { ownerUserId: session.user.id });
      const racing = await mail.createDraft(draftInput(mailbox.primaryAddress, { subject: 'Racing reassignment' }), key('racing-draft'));
      const [raced] = await Promise.allSettled([
        mail.sendDraft(racing.id, { ...key('racing-send'), ifMatch: racing.revision }),
        h.as('admin').updateMailbox(mailbox.id, { ownerUserId: user.id }),
      ]);
      await h.advance(undoSeconds * second);
      if (raced.status === 'rejected') await rejects(Promise.reject(raced.reason), 'forbidden');
      else assert.equal((await newOwner.getSend(raced.value.id)).state, 'failed');
      assert.deepEqual((await newOwner.listThreads({ view: 'sent', q: 'subject:"racing reassignment"' })).items, []);
    });

    run('23. mailbox reads carry one state, and every change moves it', async (h, mail) => {
      const reads = async () => [
        (await mail.getSession()).state, (await mail.listViews()).state, (await mail.listThreads({ view: 'all' })).state,
        (await mail.listLabels()).state, (await mail.listDrafts({})).state, (await mail.listSends({})).state,
      ];
      const settled = async () => {
        const states = await reads();
        assert.equal(new Set(states).size, 1, 'every mailbox read reports the same state');
        return states[0];
      };
      const initial = await settled();
      const { threadId } = await h.deliver(message('State'));
      const delivered = await settled();
      assert.notEqual(delivered, initial);
      assert.equal((await mail.getThread(threadId)).state, delivered);
      await mail.createLabel({ name: 'State label' }, key('label'));
      const labelled = await settled();
      assert.notEqual(labelled, delivered);
      const { state } = await mail.updateThreads({ ids: [threadId], set: { starred: true } });
      assert.notEqual(state, labelled);
      assert.equal(await settled(), state);
      const draft = await mail.createDraft(draftInput(requiredMailbox(await mail.getSession()).primaryAddress), key('draft'));
      const drafted = await settled();
      assert.notEqual(drafted, state);
      await mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision });
      assert.notEqual(await settled(), drafted);
    });
  });
}
