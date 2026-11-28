import assert from 'node:assert/strict';
import test from 'node:test';
import type { EmailCall } from './fixtures/send-consumer.ts';
import { LONG_WS, type SendStateView } from './fixtures/mail-http.ts';
import {
  addAlias, ADMIN, children, deleteAlias, emailCalls, folderOf, handoff, handoffKeyOf, hour, ledgerOf, liveHolders, MEMBER, messages, minute,
  moveAlias, OTHER, outboxDown, OUTSIDE, released, SENT_FLAG, submit, UNDO, withInternal, WS, type Fixture,
} from './fixtures/internal-delivery.ts';

// Internal delivery (docs/m3-outbound-plan.md, M3-8 acceptance), against the
// real mailbox objects, sweeper, outbox and the delivery pipeline's deliver().

const sentCopyThread = async (h: Fixture) => (await h.as('member').listThreads({ view: 'sent' })).items[0].id;
// The drive row's next run, after the handoff's backoff.
const nextDrive = async (h: Fixture, id: string) => {
  const [due] = (await h.sendState(id)).drive;
  assert.ok(due, 'the send still has its drive row');
  await h.advance(Math.max(0, due - await h.sends.now()));
};

test('an internal recipient receives the message with no EMAIL call, and its sender is trusted only from the source column', () =>
  withInternal(async (h, mail, from) => {
    const id = await released(h, mail, from, 'one', [OTHER]);
    const state = await h.sendState(id);
    assert.deepEqual(ledgerOf(state), ['internal:sent']);
    assert.equal(state.row?.state, 'sent');
    const row = await handoff(h, id);
    assert.equal(row?.decision, 'accepted');
    assert.ok(row?.expanded_at, 'the handoff was expanded at once');
    const [child, ...more] = await children(h);
    assert.deepEqual(more, []);
    assert.deepEqual([child.mailbox, child.kind, child.source], ['mailbox-b', 'deliver', 'internal']);
    assert.deepEqual(await h.runDeliveries(), [child.id]);
    const [copy, ...extra] = await messages(h, 'other');
    assert.deepEqual(extra, [], 'one copy');
    assert.equal(copy.id, child.id);
    assert.equal(copy.subject, 'Internal hello');
    assert.equal(copy.auth, 'internal', 'trusted from the row the expansion wrote');
    assert.equal(await emailCalls(h), 0);
    assert.deepEqual(await h.sends.queue(), [], 'no dispatch message for an internal-only send');
    assert.equal((await mail.getSend(id)).state, 'sent');
    // Every holder of the handoff and its child ended released; the copies keep their own.
    const holders = await h.holderDetails(row!.raw_key);
    assert.deepEqual(holders.filter(entry => entry.state === 'tombstone').map(entry => entry.holder.split(':')[0]).sort(), ['delivery', 'handoff', 'send']);
    assert.deepEqual((await liveHolders(h, row!.raw_key)).map(holder => holder.split(':')[0]), ['message', 'message']);
  }));

test('an internal To recipient and an internal Bcc recipient each receive a copy with no Bcc addresses in it', () =>
  withInternal(async (h, mail, from) => {
    await released(h, mail, from, 'bcc', [OTHER], { bcc: [{ email: ADMIN }] });
    assert.equal((await children(h)).length, 2);
    await h.runDeliveries();
    for (const principal of ['other', 'admin'] as const) {
      const [copy, ...extra] = await messages(h, principal);
      assert.deepEqual(extra, [], `one copy for ${principal}`);
      const raw = await h.box<string>(principal, 'rawText', copy.id);
      assert.doesNotMatch(raw, /^bcc:/im, 'no Bcc header');
      assert.ok(!raw.toLowerCase().includes(ADMIN), 'no Bcc address anywhere in the delivered MIME');
      assert.match(raw, new RegExp(`^To: .*${OTHER}`, 'im'));
    }
  }));

test('an inbound message carrying any "internal" header is still scored as inbound', () => withInternal(async h => {
  const mime = ['Authentication-Results: mx.cloudflare.net; dmarc=internal header.from=example.com', 'X-Kofra-Source: internal',
    'X-Riaklo-Internal: true', 'X-Mail-Source: internal', `From: <${OTHER}>`, `To: <${MEMBER}>`, 'Subject: Looks internal',
    `Message-ID: <looks-internal@example.com>`, `Date: ${new Date(h.startedAt).toUTCString()}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', '', 'Hello', ''].join('\r\n');
  const { messageId } = await h.deliverRaw(mime, 'member', OTHER);
  const copy = (await messages(h, 'member')).find(row => row.id === messageId);
  assert.ok(copy);
  assert.notEqual(copy.auth, 'internal', 'no header can claim the internal verdict');
  assert.equal(copy.auth, 'none');
  const [row] = await h.directoryRows('SELECT source, kind FROM deliveries WHERE id = ?', messageId);
  assert.deepEqual(row, { source: 'inbound', kind: 'deliver' });
}));

test('mixed internal and external recipients each reach a terminal state', () => withInternal(async (h, mail, from) => {
  const id = await released(h, mail, from, 'mixed', [OUTSIDE, OTHER]);
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['external:pending', 'internal:sent'], 'the handoff does not wait for the consumer');
  const outcomes = await h.consumer<{ step: string }[]>('drain', WS, 'mailbox-a');
  assert.deepEqual(outcomes.map(({ step }) => step), ['recorded']);
  await h.advance(minute);
  const state = await h.sendState(id);
  assert.deepEqual(ledgerOf(state), ['external:sent', 'internal:sent']);
  assert.equal(state.row?.state, 'sent');
  assert.equal(state.row?.finish_pending, 0);
  await h.runDeliveries();
  assert.equal((await messages(h, 'other')).length, 1);
  const calls = await h.consumer<EmailCall[]>('emailCalls');
  assert.deepEqual(calls.map(call => call.to), [[OUTSIDE]], 'only the external recipient reached EMAIL');
  assert.deepEqual((await mail.getSend(id)).recipients.map(({ state: s }) => s), ['sent', 'sent']);
}));

test('sending to oneself and to an alias of oneself leaves one copy, the sent copy, and no delivery', () => withInternal(async (h, mail, from) => {
  await addAlias(h, 'me2@example.com', 'mailbox-a');
  const id = await released(h, mail, from, 'self', [MEMBER, 'me2@example.com']);
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:sent', 'internal:sent']);
  const [child, ...more] = await children(h);
  assert.deepEqual(more, [], 'one child for one mailbox, however many of its addresses');
  assert.deepEqual([child.mailbox, child.kind, child.file_message_id, child.file_folder_rev], ['mailbox-a', 'file_sent', id, 0]);
  await h.runDeliveries();
  const [copy, ...extra] = await messages(h, 'member');
  assert.deepEqual(extra, [], 'the sent copy only');
  assert.equal(copy.id, id);
  assert.ok(copy.flags & SENT_FLAG);
  assert.equal(folderOf(copy.flags), 'inbox', 'filed into Inbox');
  assert.ok((await h.box<string[]>('member', 'receipts')).includes(child.id), 'with the delivery receipt');
}));

test('an alias of the sender that moves to another mailbox between the release lookup and the handoff delivers there', () =>
  withInternal(async (h, mail, from) => {
    await addAlias(h, 'me3@example.com', 'mailbox-a');
    await outboxDown(h, true);
    const id = await released(h, mail, from, 'self-moved', [MEMBER, 'me3@example.com']);
    assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:pending', 'internal:pending']);
    await moveAlias(h, 'me3@example.com', 'mailbox-b');
    await outboxDown(h, false);
    await nextDrive(h, id);
    assert.deepEqual((await children(h)).map(row => [row.mailbox, row.kind]).sort(), [['mailbox-a', 'file_sent'], ['mailbox-b', 'deliver']]);
    await h.runDeliveries();
    assert.equal((await messages(h, 'other')).length, 1);
    assert.deepEqual((await messages(h, 'member')).map(row => row.id), [id]);
  }));

test('an alias moved to the sender after release files the sent copy, from Archive, into Inbox; still one copy', () =>
  withInternal(async (h, mail, from) => {
    await addAlias(h, 'o2@example.com', 'mailbox-b');
    await outboxDown(h, true);
    const id = await released(h, mail, from, 'moved-in', ['o2@example.com']);
    const [before] = await messages(h, 'member');
    assert.equal(folderOf(before.flags), 'archive', 'release files the sent copy in Archive');
    await moveAlias(h, 'o2@example.com', 'mailbox-a');
    await outboxDown(h, false);
    await nextDrive(h, id);
    const [child] = await children(h);
    assert.equal(child.kind, 'file_sent');
    await h.runDeliveries();
    const [copy, ...extra] = await messages(h, 'member');
    assert.deepEqual(extra, []);
    assert.deepEqual([copy.id, folderOf(copy.flags), copy.folder_rev], [id, 'inbox', 1]);
    assert.deepEqual(await messages(h, 'other'), []);
    // A delivery repeated through the outbox after the filing leaves the copy where the user put it.
    await mail.updateThreads({ ids: [await sentCopyThread(h)], set: { folder: 'archive' } });
    await h.directoryChange("UPDATE deliveries SET state = 'pending', done_at = NULL, next_attempt_at = 0 WHERE id = ?", child.id);
    assert.deepEqual(await h.runDeliveries(), [child.id], 'redelivered through the real outbox');
    const [redelivered] = await h.directoryRows('SELECT state FROM deliveries WHERE id = ?', child.id);
    assert.equal(redelivered?.state, 'done', 'the redelivery completed');
    const [after] = await messages(h, 'member');
    assert.deepEqual([folderOf(after.flags), after.folder_rev], ['archive', 2]);
  }));

test('a sent copy moved to Trash and back to Archive after release stays in Archive, also when moved during an outbox outage', () =>
  withInternal(async (h, mail, from) => {
    await addAlias(h, 'o3@example.com', 'mailbox-b');
    await outboxDown(h, true);
    const id = await released(h, mail, from, 'folder-rev', ['o3@example.com']);
    await moveAlias(h, 'o3@example.com', 'mailbox-a');
    const thread = await sentCopyThread(h);
    await mail.updateThreads({ ids: [thread], set: { folder: 'trash' } });
    await mail.updateThreads({ ids: [thread], set: { folder: 'archive' } });
    // Both moves published before the delivery.
    await h.advance(hour);
    assert.equal((await h.sendState(id)).flushed.flushed, (await h.sendState(id)).flushed.modseq);
    await outboxDown(h, false);
    await nextDrive(h, id);
    await h.runDeliveries();
    const [copy, ...extra] = await messages(h, 'member');
    assert.deepEqual(extra, []);
    assert.deepEqual([copy.id, folderOf(copy.flags), copy.folder_rev], [id, 'archive', 2], 'the handoff carries the release-time folder_rev');
  }));

test('two unroutable addresses give the sender two distinct notices, each exactly once across retries, apart from the file_sent child', () =>
  withInternal(async (h, mail, from) => {
    for (const alias of ['x1@example.com', 'x2@example.com']) await addAlias(h, alias, 'mailbox-b');
    await outboxDown(h, true);
    const id = await released(h, mail, from, 'ndn', [MEMBER, 'x1@example.com', 'x2@example.com']);
    for (const alias of ['x1@example.com', 'x2@example.com']) await deleteAlias(h, alias);
    // The first expansion dies after its holds, notices registered and stored; the reconciler repeats it.
    await h.box('member', 'crashAtHandoff', 'expand:held');
    await outboxDown(h, false);
    await nextDrive(h, id);
    assert.equal((await handoff(h, id))?.expanded_at, null);
    await h.advance(10 * minute, 'clock-only');
    await h.handoffCron();
    await h.expand(handoffKeyOf(id));
    const rows = await children(h);
    assert.equal(new Set(rows.map(row => row.id)).size, 3, 'three distinct ids');
    assert.deepEqual(rows.map(row => [row.mailbox, row.kind]).sort(), [['mailbox-a', 'deliver'], ['mailbox-a', 'deliver'], ['mailbox-a', 'file_sent']]);
    await h.runDeliveries();
    await h.runDeliveries();
    const copies = await messages(h, 'member');
    assert.equal(copies.length, 3, 'the sent copy and two notices');
    const notices = copies.filter(row => row.id !== id);
    assert.deepEqual(notices.map(row => row.auth), ['internal', 'internal']);
    const texts = await Promise.all(notices.map(row => h.box<string>('member', 'rawText', row.id)));
    assert.deepEqual(texts.map(text => ['x1@example.com', 'x2@example.com'].filter(address => text.includes(address))).sort(),
      [['x1@example.com'], ['x2@example.com']]);
    assert.deepEqual(await messages(h, 'other'), []);
  }));

test('a domain moved to another workspace, or an alias deleted, while the handoff is pending: nothing delivered there, a notice to the sender', () =>
  withInternal(async (h, mail, from) => {
    await h.directoryChange("INSERT INTO domains VALUES ('org1', 'w1', 'example.org', 'secondary', NULL, 'active', 'active')");
    await addAlias(h, 'pat@example.org', 'mailbox-b');
    await addAlias(h, 'gone@example.com', 'mailbox-c');
    await outboxDown(h, true);
    const id = await released(h, mail, from, 'moved-domain', ['pat@example.org', 'gone@example.com']);
    assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:pending', 'internal:pending'], 'both routed internally at release');
    // The domain and its address move to another workspace's mailbox.
    await h.directoryChange("UPDATE domains SET workspace_id = 'w2' WHERE id = 'org1'");
    await h.directoryChange("UPDATE addresses SET workspace_id = 'w2', target_id = 'mailbox-z' WHERE address_norm = 'pat@example.org'");
    await deleteAlias(h, 'gone@example.com');
    await outboxDown(h, false);
    await nextDrive(h, id);
    assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:sent', 'internal:sent'], 'accepted, then undeliverable: still sent');
    await h.runDeliveries();
    assert.deepEqual(await messages(h, 'other'), []);
    assert.deepEqual(await messages(h, 'admin'), []);
    assert.ok((await children(h)).every(row => row.mailbox === 'mailbox-a'), 'never resolved outside the sending workspace');
    assert.deepEqual(await h.directoryRows("SELECT id FROM deliveries WHERE json_extract(resolved_mailbox_ids, '$[0]') = 'mailbox-z'"), []);
    assert.equal((await messages(h, 'member')).length, 3, 'the sent copy and one notice per address');
  }));

test('outbox down, then an alias reassigned from A to B or deleted: delivered to B, never A; a deleted alias nowhere', () =>
  withInternal(async (h, mail, from) => {
    await addAlias(h, 'team@example.com', 'mailbox-b');
    await addAlias(h, 'old@example.com', 'mailbox-b');
    await outboxDown(h, true);
    const id = await released(h, mail, from, 'reassigned', ['team@example.com', 'old@example.com']);
    for (let i = 0; i < 3; i++) await nextDrive(h, id);
    assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:pending', 'internal:pending']);
    await moveAlias(h, 'team@example.com', 'mailbox-c');
    await deleteAlias(h, 'old@example.com');
    await outboxDown(h, false);
    await nextDrive(h, id);
    await h.runDeliveries();
    assert.deepEqual(await messages(h, 'other'), [], 'never A');
    assert.equal((await messages(h, 'admin')).length, 1, 'B');
    assert.equal((await messages(h, 'member')).length, 2, 'the sent copy and the notice for the deleted alias');
  }));

test('two mailboxes with the same sendId each get their own handoff row; neither is marked sent from the other\'s', () =>
  withInternal(async (h, mail, from) => {
    await outboxDown(h, true, 'other');
    // Distinct bodies: the forced id also forces one Message-ID, and the recipient deduplicates by Message-ID and body.
    const mine = await submit(mail, from, 'same-a', [ADMIN], { body: 'From the member' });
    const theirs = await submit(h.as('other'), OTHER, 'same-b', [ADMIN], { body: 'From the other mailbox' });
    assert.equal(mine, theirs, 'the fixture forces one send id');
    await h.advance(UNDO, 'all-mailboxes');
    assert.equal((await handoff(h, mine))?.decision, 'accepted');
    assert.equal(await handoff(h, theirs, 'mailbox-b'), undefined);
    assert.deepEqual(ledgerOf(await h.sendState(mine)), ['internal:sent']);
    assert.deepEqual(ledgerOf(await h.sendState(theirs, 'mailbox-b')), ['internal:pending'], 'not sent from the other mailbox\'s row');
    await outboxDown(h, false, 'other');
    await h.advance(10 * minute, 'all-mailboxes');
    assert.equal((await handoff(h, theirs, 'mailbox-b'))?.mailbox_id, 'mailbox-b');
    assert.deepEqual(ledgerOf(await h.sendState(theirs, 'mailbox-b')), ['internal:sent']);
    await h.runDeliveries();
    assert.equal((await messages(h, 'admin')).length, 2, 'one copy from each sender');
  }, { fixedSendId: '01M8H00000000000000000SAME' }));

test('a handoff row under this send\'s key that does not match this send is never taken as its decision', () => withInternal(async (h, mail, from) => {
  const id = await submit(mail, from, 'foreign-row', [OTHER]);
  // A row for this key whose raw object is not this send's (as from another incarnation of the key).
  await h.directoryChange(`INSERT INTO internal_handoffs (key, workspace_id, mailbox_id, send_id, raw_key, sender, addresses, message_id, folder_rev,
      decision, created_at, expand_retry_at) VALUES (?, 'w1', 'mailbox-a', ?, ?, ?, '[[0,"other","example.com","other@example.com"]]', ?, 0, 'accepted', 0, 0)`,
  handoffKeyOf(id), id, `raw/${'b'.repeat(64)}/01M8H00000000000000000GEN0`, MEMBER, id);
  await h.advance(UNDO);
  const state = await h.sendState(id);
  assert.deepEqual(ledgerOf(state), ['internal:pending'], 'not marked sent from a row that is not its own');
  assert.deepEqual(await h.sends.breaches(), [id], 'an invariant breach, with its alert');
  assert.deepEqual(await children(h), []);
}));

test('a duplicate dispatch during a pending handoff changes nothing, and the handoff still completes', () => withInternal(async (h, mail, from) => {
  await outboxDown(h, true);
  const id = await released(h, mail, from, 'empty', [OUTSIDE, OTHER]);
  assert.deepEqual((await h.consumer<{ step: string }[]>('drain', WS, 'mailbox-a')).map(({ step }) => step), ['recorded']);
  const before = await h.sendState(id);
  assert.deepEqual(ledgerOf(before), ['external:sent', 'internal:pending']);
  assert.deepEqual(await h.consumer('consume', { kind: 'dispatch', ws: WS, mb: 'mailbox-a', sendId: id }), { ack: true, step: 'refused' });
  const after = await h.sendState(id);
  assert.deepEqual([after.dispatch, after.drive, after.ledger], [before.dispatch, before.drive, before.ledger]);
  await outboxDown(h, false);
  await nextDrive(h, id);
  const done = await h.sendState(id);
  assert.deepEqual(ledgerOf(done), ['external:sent', 'internal:sent']);
  assert.equal(done.row?.state, 'sent');
  await h.runDeliveries();
  assert.equal((await messages(h, 'other')).length, 1);
  assert.equal((await h.consumer<EmailCall[]>('emailCalls')).length, 1);
}));

test('workspace, mailbox and send ids at their longest supported lengths are handed off and delivered', () => withInternal(async h => {
  const sender = h.as('longSender');
  const { mailbox } = await sender.getSession();
  assert.ok(mailbox);
  assert.deepEqual([LONG_WS.length, mailbox.id.length], [58, 128]);
  const id = await submit(sender, mailbox.primaryAddress, 'long', ['recipient@long.example']);
  await h.advance(UNDO, 'all-mailboxes');
  const key = `internal:${LONG_WS}:${mailbox.id}:${id}`;
  assert.equal(key.length, 223);
  const [row] = await h.directoryRows('SELECT decision, expanded_at FROM internal_handoffs WHERE key = ?', key);
  assert.equal(row?.decision, 'accepted', 'the handoff row was written');
  assert.ok(row?.expanded_at);
  assert.deepEqual(ledgerOf(await h.box<SendStateView>('longSender', 'sendState', id)), ['internal:sent']);
  await h.runDeliveries();
  const [copy, ...extra] = await messages(h, 'longRecipient');
  assert.deepEqual(extra, []);
  assert.equal(copy?.subject, 'Internal hello');
  assert.equal(copy?.auth, 'internal');
}, { longIds: true }));
