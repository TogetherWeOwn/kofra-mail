import assert from 'node:assert/strict';
import test from 'node:test';
import type { EmailCall } from './fixtures/send-consumer.ts';
import {
  addAlias, ADMIN, children, day, second, emailCalls, folderOf, handoff, hour, key, ledgerOf, liveHolders, MEMBER, messages, minute, moveAlias, OTHER,
  outboxDown, OUTSIDE, released, submit, UNDO, withInternal, WS, type Fixture,
} from './fixtures/internal-delivery.ts';

// Internal delivery's crash and restore cases (M3-8 acceptance), each with
// the real mailbox objects, sweeper, outbox and pipeline in Miniflare.

const objectPath = (rawKey: string) => `/mail-${WS}/${rawKey}`;
const nextDrive = async (h: Fixture, id: string) => {
  const [due] = (await h.sendState(id)).drive;
  assert.ok(due, 'the send still has its drive row');
  await h.advance(Math.max(0, due - await h.sends.now()));
};
const rawKeyOf = async (h: Fixture, id: string) => (await h.sends.registration(id))!.key!;
const sendRawHolder = async (h: Fixture, id: string) => (await h.sends.registration(id))!.raw_holder!;
const indexHolder = async (h: Fixture, id: string) => (await h.sends.registration(id))!.index_holder!;
const drain = (h: Fixture) => h.consumer<{ step: string }[]>('drain', WS, 'mailbox-a');
// Restores the member mailbox from its backups and runs alarms until it is
// ready; `settle` then lets the backup lane reindex the restored messages (and
// the drive rows run) before the API takes writes again.
async function restoreMember(h: Fixture, settle = true) {
  await h.restore();
  for (let i = 0; i < 8 && (await h.sends.lifecycle())?.state !== 'ready'; i++) await h.advance(0);
  assert.equal((await h.sends.lifecycle())?.state, 'ready');
  if (settle) for (let i = 0; i < 4; i++) await h.advance(second);
}

for (const step of ['handoff:hold', 'handoff:decide'] as const) {
  for (const mixed of [false, true]) {
    test(`a crash ${step === 'handoff:hold' ? 'after release step 4a, before the hold and the insert' : 'after the hold, before the insert'}`
      + ` of ${mixed ? 'a mixed send whose external recipients are terminal' : 'an internal-only send'}: re-driven, one delivery each, holders kept`,
    () => withInternal(async (h, mail, from) => {
      const to = mixed ? [OUTSIDE, OTHER, ADMIN] : [OTHER, ADMIN];
      let id: string;
      if (mixed) {
        await outboxDown(h, true);
        id = await released(h, mail, from, 'crash', to);
        assert.deepEqual((await drain(h)).map(({ step: s }) => s), ['recorded']);
        await outboxDown(h, false);
        await h.box('member', 'crashAtHandoff', step);
        await nextDrive(h, id);
      } else {
        await h.box('member', 'crashAtHandoff', step);
        id = await released(h, mail, from, 'crash', to);
      }
      const crashed = await h.sendState(id);
      assert.deepEqual(ledgerOf(crashed).filter(entry => entry.startsWith('internal')), ['internal:pending', 'internal:pending']);
      assert.ok(['queued', 'sending'].includes(crashed.row!.state), 'the send does not finish');
      assert.equal(crashed.row?.finish_pending, 0);
      assert.equal(crashed.drive.length, 1, 'the drive row re-drives the handoff');
      assert.equal(await handoff(h, id), undefined, 'no handoff row was written');
      const rawKey = await rawKeyOf(h, id);
      assert.ok(h.objects.has(objectPath(rawKey)), 'the raw object exists');
      assert.equal((await h.sends.registration(id))?.released, null, 'the send\'s own holders stay while an internal row is pending');
      assert.ok((await liveHolders(h, rawKey)).includes(await sendRawHolder(h, id)));
      await nextDrive(h, id);
      const done = await h.sendState(id);
      assert.deepEqual(ledgerOf(done).filter(entry => entry.startsWith('internal')), ['internal:sent', 'internal:sent']);
      assert.equal(done.row?.finish_pending, 0);
      assert.equal((await h.sends.registration(id))?.released, 'raw', 'released only after every internal row is sent');
      await h.runDeliveries();
      await h.runDeliveries();
      assert.equal((await messages(h, 'other')).length, 1);
      assert.equal((await messages(h, 'admin')).length, 1);
      assert.ok(h.objects.has(objectPath(rawKey)));
      assert.ok((await liveHolders(h, rawKey)).includes(await indexHolder(h, id)), 'the sent copy\'s index holder stays with its Sent entry');
      assert.equal((await h.consumer<EmailCall[]>('emailCalls')).length, mixed ? 1 : 0);
    }));
  }
}

test('a release whose publish fails, then a restore, then undo: no internal delivery, the handoff waits for the published release', () =>
  withInternal(async (h, mail, from) => {
    const id = await submit(mail, from, 'unpublished', [OTHER]);
    await h.publishFailure(true);
    await h.advance(UNDO);
    assert.equal((await h.sendState(id)).row?.state, 'queued', 'release step 4 committed');
    assert.deepEqual(await h.directoryRows('SELECT key FROM internal_handoffs'), [], 'no handoff before the release is published');
    await h.publishFailure(false);
    await restoreMember(h);
    assert.equal((await mail.getSend(id)).state, 'pending', 'the restore rewound the unpublished release');
    await mail.undoSend(id, key('undo'));
    await h.advance(minute);
    assert.equal((await h.sendState(id)).row?.state, 'cancelled');
    await h.advance(UNDO + hour);
    assert.deepEqual(await h.directoryRows('SELECT key FROM internal_handoffs'), []);
    assert.deepEqual(await children(h), []);
    await h.runDeliveries();
    assert.deepEqual(await messages(h, 'other'), []);
    assert.equal(await emailCalls(h), 0);
  }));

for (const lost of [false, true]) {
  test(`a restore after an unpublished release, then undo: neither sent-copy holder survives${lost ? ', also after a lost registration reply' : ''}`, () =>
    withInternal(async (h, mail, from) => {
      const id = await submit(mail, from, 'undo-holders', [OTHER]);
      await h.publishFailure(true);
      if (lost) await h.sweeper(WS, 'loseNextRegisterReply');
      await h.advance(UNDO);
      const registration = await h.sends.registration(id);
      assert.ok(registration?.key, 'the sweeper registered both holders');
      assert.equal((await h.sendState(id)).row?.state, lost ? 'releasing' : 'queued');
      await h.publishFailure(false);
      await restoreMember(h);
      await mail.undoSend(id, key('undo'));
      await h.advance(minute);
      const after = await h.sends.registration(id);
      assert.equal(after?.released, 'all', 'found through the registration');
      const states = new Map((await h.holderDetails(registration.key!)).map(row => [row.holder, row.state]));
      assert.equal(states.get(registration.raw_holder!), 'tombstone');
      assert.equal(states.get(registration.index_holder!), 'tombstone');
      assert.deepEqual(await liveHolders(h, registration.key!), []);
      assert.deepEqual(await h.directoryRows('SELECT key FROM internal_handoffs'), []);
    }));
}

test('a re-handoff after the pipeline expanded the handoff, its ledger commit lost to a restore, writes nothing new and leaves no live holder', () =>
  withInternal(async (h, mail, from) => {
    await h.sends.shortHandlerBudget();
    await h.box('member', 'pauseAt', 'handoff:hold');
    const id = await submit(mail, from, 'rehandoff', [OTHER]);
    await h.advance(UNDO);
    await h.box('member', 'pausedAt', 'handoff:hold');
    // The release is published; the `sent` commit and the finish will not be.
    await h.publishFailure(true);
    await h.box('member', 'resumeAt', 'handoff:hold');
    await h.sends.driveIdle();
    assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:sent']);
    const row = await handoff(h, id);
    assert.ok(row?.expanded_at);
    await h.runDeliveries();
    const [first] = await children(h);
    await h.publishFailure(false);
    await restoreMember(h, false);
    assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:pending'], 'the restore lost the ledger commit');
    await h.advance(minute);
    const state = await h.sendState(id);
    assert.deepEqual(ledgerOf(state), ['internal:sent']);
    assert.equal(state.row?.finish_pending, 0);
    assert.deepEqual(await children(h), [first], 'no second child');
    assert.deepEqual((await handoffRows(h)).length, 1);
    await h.runDeliveries();
    assert.equal((await messages(h, 'other')).length, 1, 'no second delivery');
    const holders = await h.holderDetails(row!.raw_key);
    for (const holder of [`handoff:${row!.key}`, `delivery:${first.id}`]) {
      assert.equal(holders.find(entry => entry.holder === holder)?.state, 'tombstone', `${holder} ends released`);
    }
    assert.deepEqual((await liveHolders(h, row!.raw_key)).map(holder => holder.split(':')[0]), ['message', 'message'], 'only the two copies hold it');
  }));

const handoffRows = (h: Fixture) => h.directoryRows('SELECT key FROM internal_handoffs');

for (const restore of [false, true]) {
  test(`a crash after the outbox insert and before the ledger commit${restore ? ', with a restore in the same gap' : ''}: the insert repeats as a no-op, one message`,
    () => withInternal(async (h, mail, from) => {
      await h.box('member', 'crashAtHandoff', 'handoff:commit');
      const id = await released(h, mail, from, 'commit-gap', [OTHER]);
      assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:pending']);
      assert.equal((await handoff(h, id))?.decision, 'accepted');
      if (restore) await restoreMember(h, false);
      await nextDrive(h, id);
      assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:sent']);
      assert.equal((await handoffRows(h)).length, 1);
      assert.equal((await children(h)).length, 1);
      await h.runDeliveries();
      await h.runDeliveries();
      assert.equal((await messages(h, 'other')).length, 1);
    }));
}

test('a recipient mailbox that restores after indexing its child delivery, before its backup covers it, gets the message back by replay', () =>
  withInternal(async (h, mail, from) => {
    await released(h, mail, from, 'recipient-restore', [OTHER]);
    await h.runDeliveries();
    const [copy] = await messages(h, 'other');
    assert.ok(copy);
    await h.beginRestore('other');
    for (let i = 0; i < 8 && (await messages(h, 'other')).length === 0; i++) await h.advance(0, 'all-mailboxes');
    const [replayed, ...extra] = await messages(h, 'other');
    assert.deepEqual(extra, []);
    assert.deepEqual([replayed.id, replayed.auth], [copy.id, 'internal'], 'replayed as an internal delivery');
  }));

test('one recipient restoring during a two-mailbox fan-out gets the message back; the other keeps exactly one copy', () =>
  withInternal(async (h, mail, from) => {
    await released(h, mail, from, 'fan-out', [OTHER, ADMIN]);
    const [toOther] = (await children(h)).filter(row => row.mailbox === 'mailbox-b');
    // The first recipient indexes its child, then restores while the second's is still pending.
    await h.directoryChange("UPDATE deliveries SET next_attempt_at = next_attempt_at + 3600000 WHERE source = 'internal' AND id <> ?", toOther.id);
    await h.runDeliveries();
    assert.equal((await messages(h, 'other')).length, 1);
    await h.beginRestore('other');
    await h.directoryChange("UPDATE deliveries SET next_attempt_at = 0 WHERE source = 'internal'");
    await h.runDeliveries();
    for (let i = 0; i < 8 && (await messages(h, 'other')).length === 0; i++) await h.advance(0, 'all-mailboxes');
    await h.advance(hour, 'all-mailboxes');
    await h.runDeliveries();
    assert.equal((await messages(h, 'other')).length, 1);
    assert.equal((await messages(h, 'admin')).length, 1);
  }));

test('a sender restore after self-filing replays the file_sent row through the conditional filing, never ingest', () =>
  withInternal(async (h, mail, from) => {
    const id = await released(h, mail, from, 'self-restore', [MEMBER]);
    const [child] = await children(h);
    await h.runDeliveries();
    assert.deepEqual((await messages(h, 'member')).map(row => [row.id, folderOf(row.flags)]), [[id, 'inbox']]);
    await restoreMember(h);
    const [copy, ...extra] = await messages(h, 'member');
    assert.deepEqual(extra, [], 'no second copy');
    assert.deepEqual([copy.id, folderOf(copy.flags), copy.folder_rev], [id, 'inbox', 1], 'filed again by the replay');
    assert.ok((await h.box<string[]>('member', 'receipts')).includes(child.id));
    assert.equal(await h.eventCount('message'), 0, 'never through ingest');
  }));

test('a sender restore replays a file_sent row only if the folder_rev matches, and as a no-op without the sent copy', () =>
  withInternal(async (h, mail, from) => {
    await addAlias(h, 'o4@example.com', 'mailbox-b');
    await outboxDown(h, true);
    const id = await released(h, mail, from, 'replay-rev', ['o4@example.com']);
    await moveAlias(h, 'o4@example.com', 'mailbox-a');
    const thread = (await mail.listThreads({ view: 'sent' })).items[0].id;
    await mail.updateThreads({ ids: [thread], set: { folder: 'trash' } });
    await mail.updateThreads({ ids: [thread], set: { folder: 'archive' } });
    await h.advance(hour);
    await outboxDown(h, false);
    await nextDrive(h, id);
    await h.runDeliveries();
    await restoreMember(h);
    const [copy, ...extra] = await messages(h, 'member');
    assert.deepEqual(extra, []);
    assert.deepEqual([folderOf(copy.flags), copy.folder_rev], ['archive', 2], 'its folder_rev changed since release: it stays');
    // With the sent copy gone, the replayed filing is a no-op.
    await mail.updateThreads({ ids: [thread], set: { folder: 'trash' } });
    await h.advance(31 * day, 'clock-only');
    assert.equal(await h.purgeTrash(), 1);
    await h.forceSnapshot();
    await restoreMember(h);
    assert.deepEqual(await messages(h, 'member'), []);
  }));

test('an outbox write failing for 30 minutes leaves the rows pending and fails nothing; the handoff completes after recovery', () =>
  withInternal(async (h, mail, from) => {
    await outboxDown(h, true);
    const id = await released(h, mail, from, 'outage', [OTHER]);
    const start = await h.sends.now();
    while (await h.sends.now() - start < 30 * minute) {
      await nextDrive(h, id);
      const state = await h.sendState(id);
      assert.deepEqual(ledgerOf(state), ['internal:pending']);
      assert.equal(state.row?.state, 'queued');
    }
    assert.deepEqual(await handoffRows(h), []);
    await outboxDown(h, false);
    await nextDrive(h, id);
    assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:sent']);
    assert.equal((await mail.getSend(id)).state, 'sent');
    await h.runDeliveries();
    assert.equal((await messages(h, 'other')).length, 1);
  }));

test('an outbox outage while the external recipients are delayed by quota: the internal delivery completes long before the reset', () =>
  withInternal(async (h, mail, from) => {
    await outboxDown(h, true);
    const id = await released(h, mail, from, 'delayed', [OUTSIDE, OTHER]);
    await h.consumer('scriptEmail', [{ result: 'reject', code: 'E_DAILY_LIMIT_EXCEEDED' }]);
    assert.deepEqual((await drain(h)).map(({ step }) => step), ['delayed']);
    const delayed = await h.sendState(id);
    assert.equal(delayed.row?.state, 'delayed');
    const until = Number(delayed.dispatch?.delayed_until);
    assert.ok(delayed.drive[0] < until, 'the quota wait never postpones the handoff\'s retry');
    await outboxDown(h, false);
    await nextDrive(h, id);
    const state = await h.sendState(id);
    assert.deepEqual(ledgerOf(state), ['external:pending', 'internal:sent']);
    assert.equal(state.row?.state, 'delayed', 'the external recipients stay delayed');
    assert.ok(await h.sends.now() < until - hour);
    await h.runDeliveries();
    assert.equal((await messages(h, 'other')).length, 1);
  }));

test('the sender deletes the sent copy and the sweeper runs while the outbox is down: the raw object survives through the send\'s raw holder', () =>
  withInternal(async (h, mail, from) => {
    // Every handoff attempt dies before its hold, so only the send's own holder protects the object.
    await h.box('member', 'crashAtHandoff', 'handoff:hold', 1_000);
    const id = await released(h, mail, from, 'deleted-copy', [OTHER]);
    const rawKey = await rawKeyOf(h, id);
    await mail.updateThreads({ ids: [(await mail.listThreads({ view: 'sent' })).items[0].id], set: { folder: 'trash' } });
    await h.advance(31 * day, 'clock-only');
    assert.equal(await h.purgeTrash(), 1);
    assert.deepEqual(await liveHolders(h, rawKey), [await sendRawHolder(h, id)]);
    await h.sweepAt(await h.sends.now() + 60 * day);
    assert.equal((await h.sends.generation(rawKey))?.retry_at, null, 'never retired');
    assert.ok(h.objects.has(objectPath(rawKey)));
    await h.box('member', 'crashAtHandoff', 'handoff:hold', 0);
    await nextDrive(h, id);
    assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:sent']);
    await h.runDeliveries();
    const [copy] = await messages(h, 'other');
    assert.equal(copy?.subject, 'Internal hello');
    assert.deepEqual(await messages(h, 'member'), []);
  }));

const changeOwner = (h: Fixture) => h.directoryChange("UPDATE mailboxes SET user_id = 'new-admin' WHERE workspace_id = 'w1' AND id = 'mailbox-a'");
const deactivateSender = (h: Fixture) => h.directoryChange("UPDATE addresses SET send_as_policy = 'pending' WHERE address_norm = ?", MEMBER);

for (const change of ['owner', 'alias'] as const) {
  test(`${change === 'owner' ? 'an owner change' : 'the sending identity removed'} while the outbox is down ends the internal rows invalid_sender; nothing delivered`,
    () => withInternal(async (h, mail, from) => {
      await outboxDown(h, true);
      const id = await released(h, mail, from, `down-${change}`, [OTHER]);
      await (change === 'owner' ? changeOwner(h) : deactivateSender(h));
      await outboxDown(h, false);
      await nextDrive(h, id);
      const state = await h.sendState(id);
      assert.deepEqual(ledgerOf(state), ['internal:failed:invalid_sender']);
      assert.equal(state.row?.state, 'failed');
      assert.equal((await handoff(h, id))?.decision, 'rejected');
      assert.deepEqual(await children(h), []);
      await h.runDeliveries();
      assert.deepEqual(await messages(h, 'other'), []);
      // The member who lost the mailbox can no longer read it; the identity's owner still can.
      if (change === 'alias') assert.deepEqual((await mail.getSend(id)).recipients.map(({ state: s, reason }) => `${s}:${reason}`), ['failed:invalid_sender']);
    }));
}

for (const when of ['before', 'after'] as const) {
  test(`an owner change committing while the handoff statement is in flight, ${when} it: ${when === 'before' ? 'rejected, nothing delivered' : 'no longer recalls it'}`,
    () => withInternal(async (h, mail, from) => {
      const point = when === 'before' ? 'handoff:decide' : 'handoff:decided';
      await h.sends.shortHandlerBudget();
      await h.box('member', 'pauseAt', point);
      const id = await submit(mail, from, `inflight-${when}`, [OTHER]);
      await h.advance(UNDO);
      await h.box('member', 'pausedAt', point);
      await changeOwner(h);
      await h.box('member', 'resumeAt', point);
      await h.sends.driveIdle();
      await h.advance(minute);
      await h.runDeliveries();
      if (when === 'before') {
        assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:failed:invalid_sender']);
        assert.deepEqual(await messages(h, 'other'), []);
      } else {
        assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:sent']);
        assert.equal((await messages(h, 'other')).length, 1);
      }
    }));
}

test('a handoff still pending 24 hours after release raises the stall alert, once', () => withInternal(async (h, mail, from) => {
  await outboxDown(h, true);
  const id = await released(h, mail, from, 'stalled', [OTHER]);
  const stalled = async () => (await h.directoryRows("SELECT source FROM mail_alerts WHERE source = 'mail:send_stalled'")).length;
  await h.advance(23 * hour);
  assert.equal(await stalled(), 0, 'not before 24 hours');
  await h.advance(2 * hour);
  await h.advance(hour);
  assert.equal(await stalled(), 1);
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:pending'], 'our own outage never fails it');
  await outboxDown(h, false);
  await nextDrive(h, id);
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:sent']);
}));

test('a mixed send\'s external activity never postpones the stall alert of its pending handoff', () => withInternal(async (h, mail, from) => {
  await outboxDown(h, true);
  const id = await released(h, mail, from, 'stall-mixed', [OUTSIDE, OTHER]);
  const stalled = async () => (await h.directoryRows("SELECT source FROM mail_alerts WHERE source = 'mail:send_stalled'")).length;
  await h.advance(23 * hour);
  // The external recipient reaches the provider (Mark) 23 hours in, and is told to try later.
  await h.consumer('scriptEmail', [{ result: 'reject', code: 'E_RATE_LIMIT_EXCEEDED' }]);
  assert.ok((await drain(h)).some(({ step }) => step === 'recorded'));
  assert.equal(await stalled(), 0);
  await h.advance(2 * hour);
  await h.advance(hour);
  assert.equal(await stalled(), 1, 'the handoff has been pending more than 24 hours');
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['external:pending', 'internal:pending']);
}));
