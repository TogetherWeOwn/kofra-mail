import assert from 'node:assert/strict';
import test from 'node:test';
import { isMailApiError, type MailService } from '../../../contracts/mail-api/src/index.ts';
import type { DraftInput } from '../../../contracts/mail-api/src/wire.ts';
import { startMailHttpFixture } from './fixtures/mail-http.ts';

// Send-as (docs/m3-outbound-plan.md, section 3, M3-7): `from` must be an
// identity of the mailbox with `sendAs: 'active'`, checked by the mailbox
// itself on sendDraft and again at release through the one directory
// statement of section 1, and no user-supplied Sender, From, Return-Path or
// Reply-To header reaches a send.
type Fixture = Awaited<ReturnType<typeof startMailHttpFixture>>;
const UNDO = 10_000;
const key = (idempotencyKey: string) => ({ idempotencyKey });
const draftInput = (from: string, patch: Partial<DraftInput> = {}): DraftInput => ({
  from, to: [{ email: 'friend@example.net' }], cc: [], bcc: [], subject: 'Hello', body: 'Body text', attachments: [], ...patch,
});
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error) => isMailApiError(error, code as never));
const objectPath = (key: string) => `/mail-w1/${key}`;
const ALIAS = 'sales@example.com';

async function withSend(run: (h: Fixture, mail: MailService, primary: string, mailboxId: string) => Promise<void>) {
  const fixture = await startMailHttpFixture({ send: true });
  try {
    const mail = fixture.as('member');
    const { mailbox } = await mail.getSession();
    assert.ok(mailbox);
    await run(fixture, mail, mailbox.primaryAddress, mailbox.id);
  } finally { await fixture.close(); }
}

async function alias(h: Fixture, mailboxId: string, active: boolean): Promise<string> {
  const { address } = await h.as('admin').createAlias({ mailboxId, address: ALIAS, sendAs: true }, key('alias'));
  if (active) await h.sends.activateAlias(address);
  return address;
}

// A send that never reached the mailbox's state: no send row, and the draft is still a draft.
async function assertNoSend(h: Fixture, mail: MailService, draftId: string) {
  assert.deepEqual(await h.sends.ids(), []);
  assert.deepEqual((await mail.listSends({})).items, []);
  assert.equal((await mail.getDraft(draftId)).id, draftId);
  await h.advance(UNDO);
  assert.deepEqual(await h.sends.queue(), []);
  assert.equal(await h.sends.emailCalls(), 0);
}

test('an identity that is not active (pending) is refused on sendDraft with invalid_sender', () => withSend(async (h, mail, _primary, mailboxId) => {
  const from = await alias(h, mailboxId, false);
  const identity = (await mail.listIdentities()).items.find(({ email }) => email === from);
  assert.equal(identity?.sendAs, 'pending');
  // A draft may name a pending identity; only sending needs it active.
  const draft = await mail.createDraft(draftInput(from), key('draft'));
  await rejects(mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision }), 'invalid_sender');
  await assertNoSend(h, mail, draft.id);
}));

// The API layer reads the session's mailbox and identities before it calls
// the mailbox. A change that commits in between is seen only by the
// mailbox's own check, which must be the one directory statement.
const revocations = {
  'set back to pending': ["UPDATE addresses SET send_as_policy = 'pending' WHERE address_norm = ?", ALIAS],
  'turned off': ["UPDATE addresses SET send_as_policy = 'off' WHERE address_norm = ?", ALIAS],
  'removed': ['DELETE FROM addresses WHERE address_norm = ?', ALIAS],
  'moved to another mailbox': ["UPDATE addresses SET target_id = 'mailbox-b' WHERE address_norm = ?", ALIAS],
} as const;
for (const [change, [statement, ...binds]] of Object.entries(revocations)) {
  test(`an active alias ${change} after the API layer listed it is refused on sendDraft by the mailbox's own check`,
    () => withSend(async (h, mail, _primary, mailboxId) => {
      const from = await alias(h, mailboxId, true);
      const draft = await mail.createDraft(draftInput(from), key('draft'));
      await h.sends.beforeMailboxSend(statement, ...binds);
      await rejects(mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision }), 'invalid_sender');
      await assertNoSend(h, mail, draft.id);
    }));
}

// The contract's answer to a user without the mailbox is `forbidden`, as the
// API layer gives when it sees the change first (conformance case 22).
test('a mailbox given to another member after the API layer resolved it is refused on sendDraft with forbidden',
  () => withSend(async (h, mail, primary, mailboxId) => {
    const draft = await mail.createDraft(draftInput(primary), key('draft'));
    await h.sends.beforeMailboxSend('UPDATE mailboxes SET user_id = ? WHERE workspace_id = ? AND id = ?', 'new-admin', 'w1', mailboxId);
    await rejects(mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision }), 'forbidden');
    assert.deepEqual(await h.sends.ids(), []);
    await h.advance(UNDO);
    assert.deepEqual(await h.sends.queue(), []);
    assert.equal(await h.sends.emailCalls(), 0);
  }));

test('an active identity of the owner is still accepted on sendDraft, primary and alias', () => withSend(async (h, mail, primary, mailboxId) => {
  const from = await alias(h, mailboxId, true);
  for (const [i, address] of [primary, from].entries()) {
    const draft = await mail.createDraft(draftInput(address), key(`draft-${i}`));
    assert.equal((await mail.sendDraft(draft.id, { ...key(`send-${i}`), ifMatch: draft.revision })).state, 'pending');
  }
  await h.advance(UNDO);
  assert.equal((await h.sends.queue()).length, 2);
}));

// Release repeats the check (M3-3 built it; the removal case is in
// mail-send.test.ts). A send-as revocation that keeps the alias fails too.
for (const change of ['set back to pending', 'moved to another mailbox'] as const) {
  test(`an alias ${change} during the undo window fails the send at release with invalid_sender`, () => withSend(async (h, mail, _primary, mailboxId) => {
    const from = await alias(h, mailboxId, true);
    const draft = await mail.createDraft(draftInput(from), key('draft'));
    const pending = await mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision });
    const [statement, ...binds] = revocations[change];
    await h.directoryChange(statement, ...binds);
    await h.advance(UNDO);
    const failed = await mail.getSend(pending.id);
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })), [{ state: 'failed', reason: 'invalid_sender' }]);
    assert.deepEqual(await h.sends.queue(), []);
    assert.equal(await h.sends.emailCalls(), 0);
    assert.deepEqual((await mail.listThreads({ view: 'sent' })).items, []);
  }));
}

// ---------------------------------------------------------------- user-supplied headers

const HEADER_FIELDS = ['sender', 'replyTo', 'returnPath', 'headers', 'Sender', 'From', 'Return-Path', 'Reply-To'] as const;
const headerValue = (field: string) => field === 'headers'
  ? { Sender: 'evil@example.net', From: 'evil@example.net', 'Return-Path': '<evil@example.net>', 'Reply-To': 'evil@example.net' }
  : field === 'replyTo' ? [{ email: 'evil@example.net' }] : 'evil@example.net';

test('a draft carrying a Sender, From, Return-Path or Reply-To header field is refused, on create and on replace',
  () => withSend(async (h, mail, primary) => {
    const draft = await mail.createDraft(draftInput(primary), key('draft'));
    for (const field of HEADER_FIELDS) {
      const input = { ...draftInput(primary), [field]: headerValue(field) } as DraftInput;
      await rejects(mail.createDraft(input, key(`create-${field.replace(/[^A-Za-z]/g, '')}`)), 'unknown_field');
      await rejects(mail.replaceDraft(draft.id, input, { ifMatch: draft.revision }), 'unknown_field');
    }
    assert.equal((await mail.getDraft(draft.id)).revision, draft.revision);
    assert.equal((await mail.listDrafts({})).items.length, 1);
  }));

test('`from` is an identity address, never a header value: a display name, a list or a folded header is refused',
  () => withSend(async (h, mail, primary) => {
    await rejects(mail.createDraft(draftInput(`"Someone Else" <${primary}>`), key('named')), 'invalid_sender');
    await rejects(mail.createDraft(draftInput(`${primary}, evil@example.net`), key('list')), 'invalid_sender');
    await rejects(mail.createDraft(draftInput(`${primary}\r\nReply-To: evil@example.net`), key('folded')), 'invalid_header');
    assert.deepEqual((await mail.listDrafts({})).items, []);
  }));

// A raw sendDraft, to put header fields where a client could try them.
async function rawSend(h: Fixture, mail: MailService, draftId: string, ifMatch: string, idempotencyKey: string,
  extra: { query?: string; body?: string; headers?: Record<string, string> } = {}) {
  const { csrfToken } = await mail.getSession();
  return fetch(`${h.origin}/api/v1/drafts/${draftId}/send${extra.query ?? ''}`, { method: 'POST', body: extra.body, headers: {
    origin: h.origin, 'x-fixture-account': 'member', 'x-csrf-token': csrfToken, 'idempotency-key': idempotencyKey, 'if-match': ifMatch,
    ...extra.headers } });
}

test('sendDraft takes no header from the request: Reply-To in its query is refused, and nothing in its body or HTTP headers reaches the message',
  () => withSend(async (h, mail, primary) => {
    await h.sends.setReplyTo([{ email: 'replies@example.com' }]);
    const draft = await mail.createDraft(draftInput(primary), key('draft'));
    for (const query of ['?replyTo=evil%40example.net', '?Reply-To=evil%40example.net', '?sender=evil%40example.net', '?from=evil%40example.net']) {
      const refused = await rawSend(h, mail, draft.id, draft.revision, 'send', { query });
      assert.equal(refused.status, 400, query);
      assert.equal(((await refused.json()) as { code: string }).code, 'unknown_field', query);
    }
    assert.deepEqual(await h.sends.ids(), []);
    const sent = await rawSend(h, mail, draft.id, draft.revision, 'send', {
      body: JSON.stringify({ headers: headerValue('headers'), replyTo: [{ email: 'evil@example.net' }], from: 'evil@example.net' }),
      headers: { 'content-type': 'application/json', sender: 'evil@example.net', 'reply-to': 'evil@example.net',
        'return-path': '<evil@example.net>', from: 'evil@example.net' },
    });
    assert.equal(sent.status, 202);
    const { id } = await sent.json() as { id: string };
    await h.advance(UNDO);
    assert.equal((await mail.getSend(id)).state, 'sending');
    const registration = await h.sends.registration(id);
    assert.ok(registration?.key);
    const text = new TextDecoder().decode(h.objects.get(objectPath(registration.key)));
    const header = text.slice(0, text.indexOf('\r\n\r\n'));
    assert.doesNotMatch(text, /evil@example\.net/, 'no user-supplied address anywhere in the stored message');
    assert.doesNotMatch(header, /^(?:Sender|Return-Path):/im);
    assert.deepEqual(header.match(/^From: .*$/gim), [`From: "Jordan Member" <${primary}>`]);
    assert.deepEqual(header.match(/^Reply-To: .*$/gim), ['Reply-To: replies@example.com'], 'Reply-To comes only from settings');
  }));
