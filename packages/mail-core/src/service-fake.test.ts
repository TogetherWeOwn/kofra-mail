import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentBudget } from '@kofra/mail-contract';
import { defineConformance } from '@kofra/mail-contract/conformance';
import { createFakeMailHarness } from './service-fake.ts';

defineConformance('in-memory fake', async () => createFakeMailHarness({ contentOrigin: 'https://content.usercontent.example' }));
defineConformance('in-memory fake, Drive off', async () => createFakeMailHarness({ contentOrigin: 'https://content.usercontent.example', drive: false }));

test('a workspace cannot register a domain already used by another workspace', async () => {
  const harness = createFakeMailHarness();
  const foreignAdmin = harness.as('foreignAdmin');
  await assert.rejects(foreignAdmin.addDomain({ name: 'example.com', kind: 'secondary' }, { idempotencyKey: 'duplicate-domain' }), {
    code: 'domain_exists', status: 409,
  });
  assert.ok(!(await foreignAdmin.listDomains()).items.some(({ name }) => name === 'example.com'));
});

test('an upload reserves its key before opening the byte stream', async (t) => {
  const mail = createFakeMailHarness().as('member');
  const input = { name: 'test.txt', type: 'text/plain', bytes: new Blob(['test']) };
  const options = { idempotencyKey: 'upload' };
  let duplicate: ReturnType<typeof mail.createUpload> | undefined;
  let opened = false;
  const stream = Blob.prototype.stream;
  t.mock.method(Blob.prototype, 'stream', function (this: Blob) {
    if (!opened) {
      opened = true;
      duplicate = mail.createUpload(input, options);
    }
    return stream.call(this);
  });
  const first = mail.createUpload(input, options);
  assert.ok(duplicate);
  const [uploaded] = await Promise.all([
    first,
    assert.rejects(duplicate, { code: 'idempotency_in_progress', status: 409 }),
  ]);
  assert.deepEqual(await mail.createUpload(input, options), uploaded);
});

test('oversized uploads are refused before the stream is opened', async (t) => {
  const mail = createFakeMailHarness().as('member');
  const { limits } = await mail.getSession();
  const input = { name: 'big.txt', type: 'text/plain', bytes: new Blob([new Uint8Array(limits.uploadBytes + 1)]) };
  const stream = Blob.prototype.stream;
  t.mock.method(Blob.prototype, 'stream', function (this: Blob) {
    if (this.size > limits.uploadBytes) throw new Error('Oversized upload stream opened');
    return stream.call(this);
  });
  await assert.rejects(mail.createUpload(input, { idempotencyKey: '' }), { code: 'invalid_request' });
  const opts = { idempotencyKey: 'upload' };
  await assert.rejects(mail.createUpload(input, opts), { code: 'payload_too_large', status: 413 });
  assert.equal((await mail.createUpload({ ...input, bytes: new Blob(['ok']) }, opts)).size, 2);
  await assert.rejects(mail.createUpload(input, opts), { code: 'idempotency_key_reused' });
});

test('empty date operators match nothing while unknown operators remain literal', async () => {
  const h = createFakeMailHarness();
  const mail = h.as('member');
  const { threadId } = await h.deliver({
    from: { name: 'Sender', email: 'sender@example.com' }, to: [], subject: 'before: after: unknown:', text: '',
  });
  for (const q of ['before:', 'after:', 'before: subject:before', 'after:""', 'before:2026-02-30']) {
    assert.deepEqual((await mail.listThreads({ view: 'inbox', q })).items, [], q);
  }
  assert.deepEqual((await mail.listThreads({ view: 'inbox', q: 'unknown:' })).items.map(({ id }) => id), [threadId]);
});

test('date boundaries use the offset on the search date, including daylight saving transitions', async () => {
  const cases = [
    ['America/New_York', '2026-07-01T04:00:00Z'], // Summer offset.
    ['America/Havana', '2026-11-01T04:00:00Z'], // The first of two local midnights.
    ['America/Sao_Paulo', '2018-11-04T03:00:00Z'], // Clock skips to 01:00 at the start of the day.
  ];
  const input = { from: { name: 'Sender', email: 'sender@example.com' }, to: [], subject: 'Date boundary', text: '' };
  for (const [tz, at] of cases) {
    const h = createFakeMailHarness({ start: Date.parse(at) - 1 });
    const mail = h.as('member');
    const before = await h.deliver(input);
    await h.advance(1);
    const after = await h.deliver(input);
    const date = at.slice(0, 10);
    const query = { view: 'inbox', tz } as const;
    assert.deepEqual((await mail.listThreads({ ...query, q: `before:${date}` })).items.map(({ id }) => id), [before.threadId], tz);
    assert.deepEqual((await mail.listThreads({ ...query, q: `after:${date}` })).items.map(({ id }) => id), [after.threadId], tz);
  }
});

test('getThread snapshots messages, summary and state before a same-turn update', async () => {
  const h = createFakeMailHarness();
  const mail = h.as('member');
  const { threadId } = await h.deliver({
    from: { name: 'Sender', email: 'sender@example.com' }, to: [], subject: 'Read snapshot', text: '',
  });
  const reading = mail.getThread(threadId);
  const updating = mail.updateThreads({ ids: [threadId], set: { folder: 'archive', unread: false } });
  const [snapshot, updated] = await Promise.all([reading, updating]);
  assert.notEqual(snapshot.state, updated.state);
  assert.deepEqual(snapshot.thread.folders, ['inbox']);
  assert.equal(snapshot.thread.unread, true);
  assert.equal(snapshot.messages[0].folder, 'inbox');
  assert.equal(snapshot.messages[0].unread, true);
  assert.equal((await mail.getThread(threadId)).messages[0].folder, 'archive');
});

test('sending to a receiving address or its alias-domain variant keeps the sent copy in Inbox', async () => {
  const h = createFakeMailHarness();
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const alias = await h.as('admin').createAlias({ mailboxId: mailbox.id, address: 'receive@example.com', sendAs: false }, { idempotencyKey: 'receive' });
  assert.equal(alias.sendAs, 'off');
  const { undoSeconds } = await mail.getSettings();
  const cases = [
    [mailbox.primaryAddress, 'inbox'], ['MEMBER@example.net', 'inbox'],
    [alias.address, 'inbox'], ['receive@example.net', 'inbox'], ['external@example.net', 'archive'],
  ];
  for (const [i, [email, folder]] of cases.entries()) {
    const subject = `sent-copy-${i}`;
    const draft = await mail.createDraft({
      from: mailbox.primaryAddress, to: [{ email }], cc: [], bcc: [], subject, body: '', attachments: [],
    }, { idempotencyKey: `draft-${i}` });
    await mail.sendDraft(draft.id, { idempotencyKey: `send-${i}`, ifMatch: draft.revision });
    await h.advance(undoSeconds * 1000);
    const { items: [thread] } = await mail.listThreads({ view: 'sent', q: `subject:${subject}` });
    assert.deepEqual(thread.folders, [folder], email);
  }
});

test('the first send response stays pending if the send releases before the response is copied out', async () => {
  const h = createFakeMailHarness();
  const mail = h.as('member');
  const { defaultFrom, undoSeconds } = await mail.getSettings();
  const draft = await mail.createDraft({
    from: defaultFrom, to: [{ email: 'recipient@example.net' }], cc: [], bcc: [], subject: 'Send snapshot', body: '', attachments: [],
  }, { idempotencyKey: 'draft' });
  const sending = mail.sendDraft(draft.id, { idempotencyKey: 'send', ifMatch: draft.revision });
  // Let replay commit the send, but move the clock before the outer proxy clones the response.
  await Promise.resolve();
  await h.advance(undoSeconds * 1000);
  const send = await sending;
  assert.equal(send.state, 'pending');
  assert.equal(send.recipients[0].state, 'pending');
  assert.equal(send.undoRemainingMs, undoSeconds * 1000);
  assert.equal((await mail.getSend(send.id)).state, 'sent');
});

test('a replacement can keep an expired reply target but cannot name a foreign message', async () => {
  const harness = createFakeMailHarness();
  const mail = harness.as('member');
  const { defaultFrom } = await mail.getSettings();
  const { limits } = await mail.getSession();
  const message = {
    from: { name: 'Sender', email: 'sender@example.net' }, to: [{ name: 'Member', email: defaultFrom }],
    subject: 'Reply to this', text: 'Hello',
  };
  const source = await harness.deliver(message);
  const foreign = await harness.deliver(message, 'other');
  const input = {
    from: defaultFrom, to: [message.from], cc: [], bcc: [], subject: 'Re: Reply to this', body: 'Reply', attachments: [],
    inReplyTo: source.messageId,
  };
  const draft = await mail.createDraft(input, { idempotencyKey: 'reply' });
  await mail.updateThreads({ ids: [source.threadId], set: { folder: 'trash' } });
  await harness.advance(limits.spamTrashRetentionDays * 86_400_000);
  await assert.rejects(mail.getThread(source.threadId), { code: 'not_found' });
  const edited = await mail.replaceDraft(draft.id, { ...input, body: 'Edited reply' }, { ifMatch: draft.revision });
  assert.equal(edited.inReplyTo, source.messageId);
  const options = { ifMatch: edited.revision };
  await assert.rejects(mail.replaceDraft(edited.id, { ...input, inReplyTo: foreign.messageId }, options), { code: 'not_found' });
  await assert.rejects(mail.replaceDraft(edited.id, { ...input, forwardOf: foreign.messageId }, options), { code: 'not_found' });
});

test('encoded address headers can push a budget-sized file over the send limit', async () => {
  const mail = createFakeMailHarness().as('member');
  const { limits } = await mail.getSession();
  const { defaultFrom } = await mail.getSettings();
  const body = 'Hello';
  const uploaded = await mail.createUpload({
    name: 'file.txt', type: 'text/plain', bytes: new Blob([new Uint8Array(attachmentBudget(limits, body))]),
  }, { idempotencyKey: 'file' });
  const recipients = Array.from({ length: limits.recipientsPerMessage }, (_, i) => ({
    email: `long-recipient-name-${i}@example.net`, name: 'é'.repeat(limits.displayNameBytes / 2),
  }));
  const draft = await mail.createDraft({
    from: defaultFrom, to: recipients.slice(0, 1), cc: recipients.slice(1), bcc: [], subject: 'Encoded headers', body,
    attachments: [{ kind: 'upload', uploadId: uploaded.id }],
  }, { idempotencyKey: 'draft' });
  await assert.rejects(mail.sendDraft(draft.id, { idempotencyKey: 'send', ifMatch: draft.revision }), {
    code: 'message_too_large',
  });
});

test('attachment filename encoding contributes to the sent MIME size', async () => {
  const h = createFakeMailHarness();
  const mail = h.as('member');
  const { defaultFrom, undoSeconds } = await mail.getSettings();
  async function sentSize(name: string, token: string) {
    const uploaded = await mail.createUpload({ name, type: 'text/plain', bytes: new Blob(['file']) }, { idempotencyKey: `file-${token}` });
    const draft = await mail.createDraft({
      from: defaultFrom, to: [{ email: 'recipient@example.net' }], cc: [], bcc: [], subject: `Attachment-${token}`, body: '',
      attachments: [{ kind: 'upload', uploadId: uploaded.id }],
    }, { idempotencyKey: `draft-${token}` });
    await mail.sendDraft(draft.id, { idempotencyKey: `send-${token}`, ifMatch: draft.revision });
    await h.advance(undoSeconds * 1000);
    const { items: [thread] } = await mail.listThreads({ view: 'sent', q: `subject:attachment-${token}` });
    assert.ok(thread, 'expected a sent copy');
    return (await mail.getThread(thread.id)).messages[0].size;
  }
  assert.ok(await sentSize('é'.repeat(100) + '.txt', 'long') > await sentSize('file.txt', 'short'));
});

test('the fake counts base64 line wrapping and expansion for the body as well as the file', async () => {
  const mail = createFakeMailHarness().as('member');
  const { defaultFrom } = await mail.getSettings();
  const { limits } = await mail.getSession();
  // Leave room for headers after base64 expansion, but not for line wrapping.
  const body = 'é'.repeat(limits.bodyBytes / 2);
  const rawFileBytes = (limits.outboundMessageBytes - 64 * 1024) * 3 / 4 - Buffer.byteLength(body);
  const uploaded = await mail.createUpload({ name: 'file.txt', type: 'text/plain', bytes: new Blob([new Uint8Array(rawFileBytes)]) }, { idempotencyKey: 'file' });
  const draft = await mail.createDraft({
    from: defaultFrom, to: [{ email: 'recipient@example.net' }], cc: [], bcc: [], subject: 'Encoded size', body,
    attachments: [{ kind: 'upload', uploadId: uploaded.id }],
  }, { idempotencyKey: 'draft' });
  await assert.rejects(mail.sendDraft(draft.id, { idempotencyKey: 'send', ifMatch: draft.revision }), { code: 'message_too_large' });
});
