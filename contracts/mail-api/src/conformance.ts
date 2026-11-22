import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ERROR_STATUS, isMailApiError } from './errors.ts';
import type { MailErrorCode, Problem } from './errors.ts';
import { attachmentBudget, LIMITS } from './limits.ts';
import { ROUTES } from './routes.ts';
import type { ConformanceHarness, TestMessage } from './harness.ts';
import type { Conditional, Idempotent, MailService } from './service.ts';
import type { DraftInput, View } from './wire.ts';

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
        if (ROUTES[property].success === 204) assert.equal(result, undefined);
        else assert.notEqual(result, undefined, `${property} must return a JSON body`);
        return json(result);
      });
    },
  });
}

async function rejects(promise: Promise<unknown>, code: MailErrorCode): Promise<Problem> {
  let result!: Problem;
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(isMailApiError(error), 'expected a MailApiError');
    assert.equal(error.code, code);
    assert.equal(error.status, ERROR_STATUS[code]);
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
        try {
          const h: ConformanceHarness = {
            as: (principal) => checked(harness.as(principal)),
            deliver: async (...args) => json(await harness.deliver(...args)),
            advance: async (ms) => json(await harness.advance(ms)),
            contentOrigin: harness.contentOrigin,
            ...(harness.drivePick && { drivePick: async () => json(await harness.drivePick!()) }),
          };
          await body(h, h.as('member'));
        } finally {
          await harness.close?.();
        }
      });
    }

    run('1. session identifies the mailbox and its primary identity', async (_h, mail) => {
      const session = await mail.getSession();
      assert.equal(session.workspace.role, 'member');
      assert.ok(session.mailbox.id);
      assert.ok(session.mailbox.primaryAddress);
      assert.ok(session.csrfToken);
      for (const field of Object.keys(LIMITS)) assert.ok(Object.hasOwn(session.limits, field), field);
      assert.ok((await mail.listIdentities()).items.some((id) => id.primary && id.email === session.mailbox.primaryAddress));
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

    run('6. resources and listings are isolated by session mailbox', async (h, mail) => {
      const other = h.as('other');
      const { primaryAddress } = (await mail.getSession()).mailbox;
      const { threadId, messageId } = await h.deliver(message('Private', { html: '<p>Private</p>', attachments: [file] }));
      const label = await mail.createLabel({ name: 'Private' }, key('label'));
      const uploaded = await mail.createUpload(upload(), key('file'));
      const draft = await mail.createDraft(draftInput(primaryAddress), key('draft'));
      const outgoing = await mail.createDraft(draftInput(primaryAddress), key('outgoing'));
      const send = await mail.sendDraft(outgoing.id, { ...key('send'), ifMatch: outgoing.revision });
      await rejects(other.getThread(threadId), 'not_found');
      await rejects(other.getBodyUrl(messageId, { remoteImages: false }), 'not_found');
      await rejects(other.getDraft(draft.id), 'not_found');
      await rejects(other.renameLabel(label.id, { name: 'Renamed' }), 'not_found');
      await rejects(other.getSend(send.id), 'not_found');
      const otherFrom = (await other.getSession()).mailbox.primaryAddress;
      await rejects(other.createDraft(draftInput(otherFrom, {
        attachments: [{ kind: 'upload', uploadId: uploaded.id }],
      }), key('draft')), 'not_found'); // The key used in member's mailbox is independent.
      assert.ok(!ids(await other.listThreads({ view: 'all' })).includes(threadId));
      assert.ok(!ids(await other.listLabels()).includes(label.id));
      assert.ok(!ids(await other.listDrafts({})).includes(draft.id));
      assert.ok(!ids(await other.listSends({})).includes(send.id));
      const received = await h.deliver(message('Other mailbox'), 'other');
      assert.ok(ids(await other.listThreads({ view: 'all' })).includes(received.threadId));
      assert.ok(!ids(await mail.listThreads({ view: 'all' })).includes(received.threadId));
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
      const reply = await h.deliver(message('Re: Invoice', {
        inReplyTo: target.messageId, from: { name: 'Morgan', email: 'morgan@example.com' }, text: 'Ｃonfirmed',
      }));
      assert.equal(reply.threadId, target.threadId);
      assert.deepEqual(ids(await mail.listThreads({ view: 'inbox', q: 'confirmed' })), [target.threadId]);
      assert.deepEqual(ids(await mail.listThreads({ view: 'inbox', q: 'from:morgan@example.com has:attachment' })), []);
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

    run('11. idempotency replays creates and rejects mismatched or missing keys', async (h, mail) => {
      const { mailbox, limits } = await mail.getSession();
      const input = draftInput(mailbox.primaryAddress);
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
      const uploaded = await verify((opts) => mail.createUpload(upload(), opts),
        (opts) => mail.createUpload(upload(new Blob(['XYZ'])), opts), 'upload');
      assert.deepEqual((await mail.listLabels()).items.filter((item) => item.name === label.name), [label]);
      assert.deepEqual((await mail.listDrafts({})).items.filter((item) => item.subject === draft.subject), [draft]);
      // Uploads have no list route. The replayed id must address the original upload.
      const attached = await mail.replaceDraft(draft.id, { ...input, attachments: [{ kind: 'upload', uploadId: uploaded.id }] }, { ifMatch: draft.revision });
      assert.deepEqual(attached.attachments, [{ kind: 'upload', uploadId: uploaded.id, name: uploaded.name, type: uploaded.type, size: uploaded.size }]);
      const { from, ...rest } = input;
      assert.deepEqual(await mail.createDraft({ ...rest, from }, key('draft')), draft);
      await rejects(mail.createLabel({ name: label.name }, key('duplicate')), 'label_exists');
      await mail.deleteLabel(label.id);
      await rejects(mail.createLabel({ name: label.name }, key('duplicate')), 'label_exists');
      await h.advance(limits.idempotencyRetentionSeconds * second);
      const recreated = await mail.createLabel({ name: label.name }, key('duplicate'));
      assert.notEqual(recreated.id, label.id);
    });

    run('12. drafts require current revisions and valid send-as identities', async (_h, mail) => {
      const input = draftInput((await mail.getSession()).mailbox.primaryAddress);
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
      const { limits, mailbox } = await mail.getSession();
      const input = draftInput(mailbox.primaryAddress);
      const send = async (patch: Partial<DraftInput>, token: string) => {
        const draft = await mail.createDraft({ ...input, ...patch }, key(`draft-${token}`));
        return mail.sendDraft(draft.id, { ...key(`send-${token}`), ifMatch: draft.revision });
      };
      await rejects(send({ to: [] }, 'empty'), 'invalid_recipients');
      await rejects(send({ to: [{ email: 'invalid' }] }, 'invalid'), 'invalid_recipients');
      // Count limits apply at save time too, so invalid drafts need not be creatable.
      await rejects(send({ to: Array.from({ length: limits.recipientsPerMessage + 1 }, (_, i) => ({ email: `person${i}@example.net` })) }, 'recipients'), 'too_many_recipients');
      const attachments: DraftInput['attachments'] = [];
      for (let i = 0; i <= limits.attachmentsPerMessage; i++) {
        const file = await mail.createUpload({ ...upload(), name: `tiny-${i}.txt` }, key(`tiny-${i}`));
        attachments.push({ kind: 'upload', uploadId: file.id });
      }
      await rejects(send({ attachments }, 'parts'), 'too_many_attachments');
      const rawBytes = Math.ceil(limits.outboundMessageBytes * 3 / 4) + 1;
      assert.ok(rawBytes > attachmentBudget(limits, Buffer.byteLength(input.body)));
      const large = await mail.createUpload(upload(new Blob([new Uint8Array(rawBytes)])), key('large'));
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
      const releasing = await mail.sendDraft(other.id, { ...key('other-send'), ifMatch: other.revision });
      assert.deepEqual(await mail.sendDraft(draft.id, options), send);
      assert.deepEqual(new Set(ids(await mail.listSends({ active: true }))), new Set([send.id, releasing.id]));
      const undo = await mail.undoSend(send.id, key('undo'));
      assert.equal(undo.id, draft.id);
      assert.notEqual(undo.revision, draft.revision);
      assert.equal((await mail.getSend(send.id)).state, 'cancelled');
      assert.deepEqual(await mail.undoSend(send.id, key('undo')), undo);
      assert.ok(ids(await mail.listDrafts({})).includes(draft.id));
      await h.advance(undoSeconds * second);
      assert.equal((await mail.getSend(send.id)).state, 'cancelled');
      const released = await mail.getSend(releasing.id);
      assert.notEqual(released.state, 'pending');
      assert.ok(released.messageId);
      const sent = await mail.listThreads({ view: 'sent' });
      const copies = (await Promise.all(sent.items.map(({ id }) => mail.getThread(id)))).flatMap(({ messages }) => messages);
      assert.ok(copies.some((m) => m.id === released.messageId && m.sent));
      assert.ok(!copies.some((m) => m.send?.id === send.id));
      await rejects(mail.undoSend(releasing.id, key('too-late')), 'send_not_pending');
    });

    run('15. uploads enforce byte bounds and keep only referenced files past expiry', async (h, mail) => {
      const { limits, mailbox } = await mail.getSession();
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

    run('17. content URLs use the configured content origin and short expiry', async (h, mail) => {
      const { limits } = await mail.getSession();
      const html = await h.deliver(message('Formatted', {
        html: '<p>Formatted</p><img src="https://example.net/image.png">', remoteImages: true, attachments: [file],
      }));
      const { messages: [delivered] } = await mail.getThread(html.threadId);
      const now = Date.parse(delivered.receivedAt);
      const without = await mail.getBodyUrl(html.messageId, { remoteImages: false });
      const withImages = await mail.getBodyUrl(html.messageId, { remoteImages: true });
      const attachment = await mail.getAttachmentUrl(html.messageId, delivered.attachments[0].part);
      const plain = await h.deliver(message('Plain'));
      const [after] = (await mail.getThread(plain.threadId)).messages;
      for (const content of [without, withImages, attachment]) {
        const url = new URL(content.url);
        assert.equal(url.origin, new URL(h.contentOrigin).origin);
        assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
        assert.ok(Date.parse(content.expiresAt) > now);
        assert.ok(Date.parse(content.expiresAt) <= Date.parse(after.receivedAt) + limits.contentUrlSeconds * second);
      }
      assert.notEqual(without.url, withImages.url);
      await rejects(mail.getBodyUrl(plain.messageId, { remoteImages: false }), 'no_html_body');
      await rejects(mail.getAttachmentUrl(html.messageId, delivered.attachments[0].part + 1), 'not_found');
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
    });

    run('19. admin directory validates domains, mailbox addresses and alias limits', async (h, mail) => {
      const admin = h.as('admin');
      const { limits, mailbox } = await mail.getSession();
      const domain = { name: 'secondary.example.com', kind: 'secondary' } as const;
      const primaryDomain = mailbox.primaryAddress.split('@').at(-1);
      const added = await admin.addDomain(domain, key('domain'));
      assert.equal(added.routing, 'pending');
      assert.equal(added.sending, 'pending');
      await rejects(admin.addDomain(domain, key('domain-again')), 'domain_exists');
      assert.ok((await admin.listDomains()).items.some(({ name }) => name === added.name));
      const owner = (await admin.listMembers({})).items.find(({ hasMailbox }) => !hasMailbox);
      assert.ok(owner, 'harness needs a workspace member without a mailbox');
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
    });

    run('20. Drive copy grants produce usable uploads, or Drive is unavailable', async (h, mail) => {
      const { features, mailbox } = await mail.getSession();
      if (!features.drive) {
        await rejects(mail.importFromDrive({ pickId: missing, mode: 'copy' }, key('drive')), 'feature_unavailable');
        return;
      }
      assert.ok(h.drivePick);
      const { attachments } = await mail.importFromDrive({ pickId: await h.drivePick(), mode: 'copy' }, key('drive'));
      assert.equal(attachments.length, 1);
      const [attachment] = attachments;
      assert.equal(attachment.kind, 'upload');
      const draft = await mail.createDraft(draftInput(mailbox.primaryAddress, {
        attachments: [{ kind: 'upload', uploadId: attachment.uploadId }],
      }), key('draft'));
      assert.deepEqual(draft.attachments, attachments);
    });
  });
}
