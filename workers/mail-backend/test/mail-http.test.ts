import assert from 'node:assert/strict';
import test from 'node:test';
import { defineConformance } from '../../../contracts/mail-api/src/conformance.ts';
import { isMailApiError } from '../../../contracts/mail-api/src/errors.ts';
import { ATTACHMENT_SEARCH_BOUNDARY } from '../src/mailbox-schema.ts';
import { startMailHttpFixture } from './fixtures/mail-http.ts';

defineConformance('mail API over HTTP in local workerd (M2-W)', startMailHttpFixture);

test('search phrases match within a filename, not across filenames', async () => {
  const fixture = await startMailHttpFixture();
  try {
    const deliver = (...names: string[]) => fixture.deliver({ from: { name: 'Sender', email: 'sender@example.net' }, to: [],
      subject: 'Attachments', text: 'Packing list',
      attachments: names.map(name => ({ name, type: 'text/plain', bytes: new Uint8Array([42]) })) });
    const split = await deliver('blue.pdf', 'train.txt');
    const same = await deliver('BLUE-train.pdf');
    const mail = fixture.as('member');
    const search = async (q: string) => (await mail.listThreads({ view: 'inbox', q })).items.map(({ id }) => id).sort();

    assert.deepEqual(await search('blue train'), [split.threadId, same.threadId].sort());
    assert.deepEqual(await search('"blue train"'), [same.threadId]);
    assert.deepEqual(await search('"blue pdf train"'), []);
    const contiguous = await deliver('blue.pdf-train.txt');
    assert.deepEqual(await search('"packing list" "blue pdf train"'), [contiguous.threadId]);
    assert.deepEqual(await search(`"pdf ${ATTACHMENT_SEARCH_BOUNDARY} train"`), []);
    assert.deepEqual(await search(ATTACHMENT_SEARCH_BOUNDARY), []);
  } finally { await fixture.close(); }
});

test('the interactive demo mints fresh content URLs after its initial clock expires', async () => {
  const fixture = await startMailHttpFixture({ demo: true, startedAt: Date.now() - 660_000 });
  try {
    const mail = fixture.as('demo');
    const plan = (await mail.listThreads({ view: 'inbox' })).items.find(({ subject }) => subject === 'Floor plan revisions');
    assert.ok(plan);
    const { messages: [message] } = await mail.getThread(plan.id);
    const body = await mail.getBodyUrl(message.id, { remoteImages: false });
    assert.ok(Date.parse(body.expiresAt) > Date.now());
    assert.equal((await fetch(body.url)).status, 200);
  } finally { await fixture.close(); }
});

test('directory creates replay by key and reject changed payloads before field validation', async () => {
  const fixture = await startMailHttpFixture();
  try {
    const admin = fixture.as('admin');
    const input = { name: 'replay.example.com', kind: 'secondary' as const };
    const changed = { ...input, unknown: true };
    const options = { idempotencyKey: 'create-directory-domain' };
    const created = await admin.addDomain(input, options);
    assert.deepEqual(await admin.addDomain(input, options), created);
    await assert.rejects(admin.addDomain(changed, options), (error) => isMailApiError(error, 'idempotency_key_reused'));
    await assert.rejects(admin.addDomain(changed, { idempotencyKey: 'invalid' }), (error) => isMailApiError(error, 'unknown_field'));
    assert.equal((await admin.listDomains()).items.filter(({ name }) => name === input.name).length, 1);
  } finally { await fixture.close(); }
});

test('directory writers reject plus-tagged mailboxes and aliases that would route to another owner', async () => {
  const fixture = await startMailHttpFixture();
  try {
    const admin = fixture.as('admin');
    const { mailbox } = await admin.getSession();
    assert.ok(mailbox);
    const { user } = await fixture.as('newAdmin').getSession();
    const otherOwnersAddress = 'member+claim@example.com';
    await assert.rejects(admin.createAlias({ mailboxId: mailbox.id, address: otherOwnersAddress, sendAs: false },
      { idempotencyKey: 'tagged-alias' }), (error) => isMailApiError(error, 'invalid_request'));
    await assert.rejects(admin.createMailbox({ primaryAddress: otherOwnersAddress, displayName: 'New', ownerUserId: user.id },
      { idempotencyKey: 'tagged-mailbox' }), (error) => isMailApiError(error, 'invalid_request'));
  } finally { await fixture.close(); }
});

test('drafts can use a pending send-as alias but settings still require an active identity', async () => {
  const fixture = await startMailHttpFixture();
  try {
    const member = fixture.as('member');
    const { mailbox } = await member.getSession();
    assert.ok(mailbox);
    const alias = await fixture.as('admin').createAlias({ mailboxId: mailbox.id, address: 'pending@example.com', sendAs: true },
      { idempotencyKey: 'register-pending-alias' });
    assert.equal(alias.sendAs, 'pending');
    const input = { from: alias.address, to: [], cc: [], bcc: [], subject: '', body: '', attachments: [] };
    const draft = await member.createDraft(input, { idempotencyKey: 'create-with-pending' });
    assert.equal(draft.from, alias.address);
    const replaced = await member.replaceDraft(draft.id, { ...input, subject: 'Draft in progress' }, { ifMatch: draft.revision });
    assert.equal(replaced.from, alias.address);
    await assert.rejects(member.updateSettings({ defaultFrom: alias.address }), (error) => isMailApiError(error, 'invalid_sender'));
  } finally { await fixture.close(); }
});

test('content is not served from the API origin and a transfer revokes the old URL', async () => {
  const fixture = await startMailHttpFixture();
  try {
    const member = fixture.as('member');
    const { mailbox } = await member.getSession();
    assert.ok(mailbox);
    const { messageId, threadId } = await fixture.deliver({ from: { name: 'Sender', email: 'sender@example.net' }, to: [],
      subject: 'Attachment', text: 'Body', attachments: [{ name: 'note.txt', type: 'text/plain', bytes: new Uint8Array([42]) }] });
    const { part } = (await member.getThread(threadId)).messages[0].attachments[0];
    const { url } = await member.getAttachmentUrl(messageId, part);
    assert.equal(new URL(url).origin, fixture.contentOrigin);
    assert.equal((await fetch(new URL(new URL(url).pathname, fixture.origin))).status, 404);
    const before = await fetch(url);
    assert.equal(before.status, 200);
    assert.match(before.headers.get('content-disposition')!, /^attachment;/);
    assert.deepEqual(new Uint8Array(await before.arrayBuffer()), new Uint8Array([42]));
    const nextOwner = (await fixture.as('newAdmin').getSession()).user.id;
    await fixture.as('admin').updateMailbox(mailbox.id, { ownerUserId: nextOwner });
    const after = await fetch(url);
    assert.equal(after.status, 404);
    assert.equal(await after.text(), '');
  } finally { await fixture.close(); }
});
