import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineConformance } from '@kofra/mail-contract/conformance';
import { createFakeMailHarness } from './service-fake.ts';

defineConformance('in-memory fake', async () => createFakeMailHarness({ contentOrigin: 'https://content.usercontent.example' }));

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
