import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addAlias, children, day, deleteAlias, second, handoff, handoffKeyOf, hour, ledgerOf, liveHolders, MEMBER, messages, minute, moveAlias, OTHER, outboxDown,
  released, submit, UNDO, withInternal, WS, type Fixture,
} from './fixtures/internal-delivery.ts';

// The pipeline's expansion of internal handoffs and the reconciler's part
// (M3-8 acceptance), with the real mailbox objects, sweeper and outbox.

const nextDrive = async (h: Fixture, id: string) => {
  const [due] = (await h.sendState(id)).drive;
  assert.ok(due, 'the send still has its drive row');
  await h.advance(Math.max(0, due - await h.sends.now()));
};
const TOMBSTONE_MS = 7 * day;

for (const order of ['plan first', 'reassign first'] as const) {
  test(`two expanders racing while an alias is reassigned from A to B (${order}): only the stored plan's mailbox receives a child`, () =>
    withInternal(async (h, mail, from) => {
      await addAlias(h, 'crew@example.com', 'mailbox-b');
      await h.sends.shortHandlerBudget();
      await h.box('member', 'pauseAt', 'expand:plan');
      const id = await submit(mail, from, 'race', ['crew@example.com']);
      await h.advance(UNDO);
      // The drive handler's expander waits before its plan statement; a second expander runs meanwhile.
      await h.box('member', 'pausedAt', 'expand:plan');
      if (order === 'reassign first') await moveAlias(h, 'crew@example.com', 'mailbox-c');
      assert.equal(await h.expand(handoffKeyOf(id)), 'expanded');
      if (order === 'plan first') await moveAlias(h, 'crew@example.com', 'mailbox-c');
      await h.box('member', 'resumeAt', 'expand:plan');
      await h.sends.driveIdle();
      const planned = order === 'plan first' ? 'mailbox-b' : 'mailbox-c';
      const stored = JSON.parse((await handoff(h, id))!.plan!) as [number, string | null][];
      assert.deepEqual(stored, [[0, planned]]);
      assert.deepEqual((await children(h)).map(row => row.mailbox), [planned], 'one child, from the stored plan');
      assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:sent']);
      await h.runDeliveries();
      assert.equal((await messages(h, 'other')).length, planned === 'mailbox-b' ? 1 : 0);
      assert.equal((await messages(h, 'admin')).length, planned === 'mailbox-c' ? 1 : 0);
    }));
}

test('a crash after the holds and before the write repeats with the same ids and strands no holder', () => withInternal(async (h, mail, from) => {
  await h.box('member', 'crashAtHandoff', 'expand:held');
  const id = await released(h, mail, from, 'held-crash', [OTHER]);
  const row = (await handoff(h, id))!;
  assert.equal(row.expanded_at, null, 'the inline expansion died after its holds');
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:sent'], 'handed off: the reconciler expands it');
  const held = (await liveHolders(h, row.raw_key)).filter(holder => holder.startsWith('delivery:'));
  assert.equal(held.length, 1);
  await h.advance(10 * minute, 'clock-only');
  await h.handoffCron();
  const [child, ...more] = await children(h);
  assert.deepEqual(more, []);
  assert.equal(`delivery:${child.id}`, held[0], 'the same id, so the same holder');
  await h.runDeliveries();
  assert.equal((await messages(h, 'other')).length, 1);
  assert.deepEqual((await liveHolders(h, row.raw_key)).map(holder => holder.split(':')[0]), ['message', 'message'], 'no stranded holder');
}));

test('an alias revoked after the expander started but before its plan commits is not in the plan', () => withInternal(async (h, mail, from) => {
  await addAlias(h, 'leaving@example.com', 'mailbox-b');
  await h.sends.shortHandlerBudget();
  // Held at the D1 boundary, just before the plan statement runs.
  await h.box('member', 'pauseStatement', 'UPDATE internal_handoffs SET plan');
  const id = await submit(mail, from, 'revoked', ['leaving@example.com']);
  await h.advance(UNDO);
  await h.box('member', 'statementPaused');
  await deleteAlias(h, 'leaving@example.com');
  await h.box('member', 'resumeStatement');
  await h.sends.driveIdle();
  assert.deepEqual(JSON.parse((await handoff(h, id))!.plan!), [[0, null]]);
  // The short handler budget runs the drive on real time added to the fixture clock.
  await h.advance(second, 'clock-only');
  await h.runDeliveries();
  assert.deepEqual(await messages(h, 'other'), []);
  assert.equal((await messages(h, 'member')).length, 2, 'the sent copy and a non-delivery notice');
}));

test('a crash after the expansion batch and before the holder release is finished by the reconciler; the handoff is not pruned before', () =>
  withInternal(async (h, mail, from) => {
    await h.box('member', 'crashAtHandoff', 'expand:written');
    const id = await released(h, mail, from, 'written-crash', [OTHER]);
    const flagged = (await handoff(h, id))!;
    assert.equal(flagged.holder_release_pending, 1);
    assert.ok(flagged.acknowledged_at, 'the sender finished and acknowledged');
    assert.equal(flagged.prune_after, null);
    assert.ok((await liveHolders(h, flagged.raw_key)).includes(`handoff:${flagged.key}`));
    // The release keeps failing, far past the tombstone time: the row is kept.
    await h.sweeper(WS, 'failTombstones', true);
    await h.advance(TOMBSTONE_MS + day, 'clock-only');
    assert.equal((await h.handoffCron()).errors, 1);
    assert.equal((await handoff(h, id))?.holder_release_pending, 1, 'never pruned while its release is pending');
    await h.sweeper(WS, 'failTombstones', false);
    await h.advance(hour, 'clock-only');
    await h.handoffCron();
    assert.equal(await handoff(h, id), undefined, 'released, then past its tombstone time');
    assert.ok(!(await liveHolders(h, flagged.raw_key)).includes(`handoff:${flagged.key}`));
    await h.runDeliveries();
    assert.equal((await messages(h, 'other')).length, 1);
  }));

test('a stale handoff insert that lands after a newer driver recorded and published a rejection is ignored; nothing is delivered', () =>
  withInternal(async (h, mail, from) => {
    await h.sends.shortHandlerBudget();
    await h.box('member', 'pauseAt', 'handoff:decide');
    const id = await submit(mail, from, 'stale', [OTHER]);
    await h.advance(UNDO);
    await h.box('member', 'pausedAt', 'handoff:decide');
    await h.directoryChange("UPDATE addresses SET send_as_policy = 'pending' WHERE address_norm = ?", MEMBER);
    // A later firing overtakes the stalled driver.
    await h.advance(6 * minute);
    await h.advance(minute);
    const rejected = await h.sendState(id);
    assert.deepEqual(ledgerOf(rejected), ['internal:failed:invalid_sender']);
    assert.equal(rejected.row?.state, 'failed');
    assert.equal(rejected.row?.finish_pending, 0, 'the failure was published and cleanup ran');
    assert.equal((await handoff(h, id))?.decision, 'rejected');
    await h.directoryChange("UPDATE addresses SET send_as_policy = 'active' WHERE address_norm = ?", MEMBER);
    await h.box('member', 'resumeAt', 'handoff:decide');
    await h.sends.driveIdle();
    assert.equal((await handoff(h, id))?.decision, 'rejected', 'the old insert was ignored');
    assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:failed:invalid_sender']);
    assert.deepEqual(await children(h), []);
    await h.runDeliveries();
    assert.deepEqual(await messages(h, 'other'), []);
  }));

test('a rejected handoff: internal rows end invalid_sender; after the publish the holder is tombstoned, then the row acknowledged', () =>
  withInternal(async (h, mail, from) => {
    await outboxDown(h, true);
    const id = await released(h, mail, from, 'rejected', [OTHER]);
    await h.directoryChange("UPDATE addresses SET send_as_policy = 'pending' WHERE address_norm = ?", MEMBER);
    await outboxDown(h, false);
    // The failure is committed but not yet published: the holder stays.
    await h.publishFailure(true);
    await nextDrive(h, id);
    const unpublished = (await handoff(h, id))!;
    assert.equal(unpublished.decision, 'rejected');
    assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:failed:invalid_sender']);
    assert.ok((await liveHolders(h, unpublished.raw_key)).includes(`handoff:${unpublished.key}`));
    assert.equal(unpublished.acknowledged_at, null);
    // Published, but the sweeper fails: no acknowledgement before the tombstone.
    await h.publishFailure(false);
    await h.sweeper(WS, 'failTombstones', true);
    await nextDrive(h, id);
    assert.equal((await handoff(h, id))?.acknowledged_at, null);
    assert.equal((await h.sendState(id)).row?.finish_pending, 1);
    await h.sweeper(WS, 'failTombstones', false);
    await nextDrive(h, id);
    const done = (await handoff(h, id))!;
    assert.ok(done.acknowledged_at);
    assert.equal(done.prune_after, done.acknowledged_at! + TOMBSTONE_MS, 'a rejected row is kept 7 days from the acknowledgement');
    const states = new Map((await h.holderDetails(done.raw_key)).map(row => [row.holder, row.state]));
    assert.equal(states.get(`handoff:${done.key}`), 'tombstone');
    assert.equal((await h.sendState(id)).row?.finish_pending, 0);
    assert.deepEqual(await children(h), [], 'a rejected row is never expanded');
    // With the sender's copy deleted, nothing holds the generation and it can be swept.
    await h.directoryChange("UPDATE addresses SET send_as_policy = 'active' WHERE address_norm = ?", MEMBER);
    await mail.updateThreads({ ids: [(await mail.listThreads({ view: 'sent' })).items[0].id], set: { folder: 'trash' } });
    await h.advance(31 * day, 'clock-only');
    assert.equal(await h.purgeTrash(), 1);
    assert.deepEqual(await liveHolders(h, done.raw_key), []);
    await h.sweepAt(await h.sends.now() + 36 * day);
    assert.notEqual((await h.sends.generation(done.raw_key))?.retry_at ?? null, null, 'retired by the sweep');
  }));

test('flagged handoffs whose sweeper calls keep timing out do not delay another workspace\'s release past the first run in which it is due', () =>
  withInternal(async (h, mail, from) => {
    await h.box('member', 'crashAtHandoff', 'expand:written');
    const id = await released(h, mail, from, 'other-workspace', [OTHER]);
    const mine = (await handoff(h, id))!;
    assert.equal(mine.holder_release_pending, 1);
    // A full page of another workspace's flagged handoffs, due earlier, whose sweeper never answers.
    const now = await h.sends.now();
    for (let i = 0; i < 12; i++) {
      const sendId = `01M8H0000000000000000000${String(i).padStart(2, '0')}`;
      await h.directoryChange(`INSERT INTO internal_handoffs (key, workspace_id, mailbox_id, send_id, raw_key, sender, addresses, message_id, folder_rev,
          decision, created_at, plan, expand_retry_at, expanded_at, holder_release_pending, release_retry_at)
        VALUES (?, 'w2', 'mailbox-z', ?, ?, 'foreign@example.net', '[[0,"a","example.net","a@example.net"]]', ?, 0, 'accepted', ?, '[[0,null]]', ?, ?, 1, ?)`,
      `internal:w2:mailbox-z:${sendId}`, sendId, `raw/${'a'.repeat(64)}/01M8H00000000000000000GEN0`, sendId, now - hour, now - hour, now - hour, now - hour);
    }
    await h.sweeper('w2', 'stallTombstones', true);
    await h.advance(10 * minute, 'clock-only');
    const started = Date.now();
    assert.equal((await h.handoffCron(200)).errors, 12, 'each stalled call ends at its bound');
    assert.ok(Date.now() - started < 5_000, 'the run does not wait for a stalled sweeper');
    assert.equal((await handoff(h, id))?.holder_release_pending, 0, 'released in the same run, behind a full page of failing rows');
    assert.ok(!(await liveHolders(h, mine.raw_key)).includes(`handoff:${mine.key}`));
  }));

test('a handoff repeated after processing but before the acknowledgement mark writes nothing; its tombstone outlives the mark by 7 days', () =>
  withInternal(async (h, mail, from) => {
    await h.sends.shortHandlerBudget();
    await h.box('member', 'pauseAt', 'handoff:hold');
    const id = await submit(mail, from, 'tombstone', [OTHER]);
    await h.advance(UNDO);
    await h.box('member', 'pausedAt', 'handoff:hold');
    await h.publishFailure(true);
    await h.box('member', 'resumeAt', 'handoff:hold');
    await h.sends.driveIdle();
    const processed = (await handoff(h, id))!;
    assert.ok(processed.expanded_at);
    assert.equal(processed.holder_release_pending, 0);
    assert.equal(processed.acknowledged_at, null, 'the finish has not run: its publish fails');
    const before = { handoffs: await h.directoryRows('SELECT * FROM internal_handoffs'), children: await children(h) };
    // The ledger commit is lost to a restore and the handoff repeats.
    await h.publishFailure(false);
    await h.restore();
    for (let i = 0; i < 8 && (await h.sends.lifecycle())?.state !== 'ready'; i++) await h.advance(0);
    assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:pending']);
    await h.box('member', 'pauseAt', 'handoff:commit');
    const repeat = h.advance(minute);
    await h.box('member', 'pausedAt', 'handoff:commit');
    assert.deepEqual({ handoffs: await h.directoryRows('SELECT * FROM internal_handoffs'), children: await children(h) }, before, 'nothing written');
    await h.box('member', 'resumeAt', 'handoff:commit');
    await repeat;
    await h.sends.driveIdle();
    assert.ok(!(await liveHolders(h, processed.raw_key)).includes(`handoff:${processed.key}`), 'the repeated hold resurrected nothing');
    await h.advance(minute);
    const marked = (await handoff(h, id))!;
    assert.ok(marked.acknowledged_at);
    assert.equal(marked.prune_after, Math.max(marked.acknowledged_at!, marked.expanded_at!) + TOMBSTONE_MS);
    await h.advance(marked.prune_after! - 1 - await h.sends.now(), 'clock-only');
    await h.handoffCron();
    assert.ok(await handoff(h, id), 'kept until the mark plus 7 days');
    await h.advance(1, 'clock-only');
    await h.handoffCron();
    assert.equal(await handoff(h, id), undefined, 'deleted after it');
    await h.runDeliveries();
    assert.equal((await messages(h, 'other')).length, 1);
  }));

test('a stalled handoff holder release never holds up the sender\'s ledger or its external recipients', () => withInternal(async (h, mail, from) => {
  await h.box('member', 'shortenHandoffBound', 200);
  await h.sweeper(WS, 'stallTombstones', true);
  const id = await released(h, mail, from, 'stalled-release', ['friend@example.net', OTHER]);
  await h.sends.driveIdle();
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['external:pending', 'internal:sent'], 'handed off although the expansion has not returned');
  assert.ok((await h.sends.queue()).some(entry => entry.sendId === id), 'the external recipient was enqueued');
  assert.equal((await handoff(h, id))?.holder_release_pending, 1, 'the children are written; the release is still pending');
  await h.sweeper(WS, 'stallTombstones', false);
  await h.advance(10 * minute, 'clock-only');
  await h.handoffCron();
  assert.equal((await handoff(h, id))?.holder_release_pending, 0, 'the reconciler finished the release');
  assert.deepEqual((await h.consumer<{ step: string }[]>('drain', WS, 'mailbox-a')).map(({ step }) => step).filter(step => step !== 'refused'), ['recorded']);
  await h.runDeliveries();
  assert.equal((await messages(h, 'other')).length, 1);
}));

for (const stage of ['expansion', 'release'] as const) {
  test(`a handoff ${stage} that keeps failing raises one handoff_stuck alert after 12 attempts`, () => withInternal(async (h, mail, from) => {
    // The drive's own attempt dies; from then on every reconciler attempt fails at the sweeper.
    await h.box('member', 'crashAtHandoff', stage === 'expansion' ? 'expand:plan' : 'expand:written');
    const id = await released(h, mail, from, `stuck-${stage}`, [OTHER]);
    await h.sweeper(WS, stage === 'expansion' ? 'failHolds' : 'failTombstones', true);
    const key = handoffKeyOf(id);
    const alerts = () => h.directoryRows('SELECT key, source FROM mail_alerts WHERE key = ?', `handoff_stuck:${key}`);
    for (let run = 1; run <= 14; run++) {
      await h.advance(hour, 'clock-only');
      await h.handoffCron(200);
      assert.equal((await alerts()).length, run >= 12 ? 1 : 0, `after ${run} attempts`);
    }
    assert.deepEqual(await alerts(), [{ key: `handoff_stuck:${key}`, source: 'mail:handoff_stuck' }], 'once per handoff');
    const row = (await handoff(h, id))!;
    assert.equal(stage === 'expansion' ? row.expanded_at : row.holder_release_pending, stage === 'expansion' ? null : 1, 'still failing');
  }));
}

test('the outbox refuses a rejected handoff row without its reason', () => withInternal(async h => {
  const insert = (reason: string | null) => h.directoryChange(`INSERT INTO internal_handoffs (key, workspace_id, mailbox_id, send_id, raw_key, sender,
      addresses, message_id, folder_rev, decision, reason, created_at) VALUES (?, 'w1', 'mailbox-a', ?, ?, ?, '[[0,"other","example.com","other@example.com"]]', ?,
      0, 'rejected', ?, 0)`, `internal:w1:mailbox-a:${reason ?? 'none'}`, 'x', `raw/${'c'.repeat(64)}/01M8H00000000000000000GEN0`, MEMBER, 'x', reason)
    .then(() => 'written', () => 'refused');
  assert.equal(await insert('invalid_sender'), 'written');
  assert.equal(await insert(null), 'refused');
}));

test('a failed stuck-alert insert never holds up the rows the reconciler took, and the alert is inserted on a later attempt', () =>
  withInternal(async (h, mail, from) => {
    await h.box('member', 'crashAtHandoff', 'expand:written');
    const id = await released(h, mail, from, 'alert-outage', [OTHER]);
    const mine = (await handoff(h, id))!;
    await h.directoryChange('UPDATE internal_handoffs SET release_attempts = 11 WHERE key = ?', mine.key);
    // Another workspace's flagged handoff whose sweeper never answers, also about to reach the threshold.
    const stuck = 'internal:w2:mailbox-z:01M8H000000000000000000099';
    const now = await h.sends.now();
    await h.directoryChange(`INSERT INTO internal_handoffs (key, workspace_id, mailbox_id, send_id, raw_key, sender, addresses, message_id, folder_rev,
        decision, created_at, plan, expand_retry_at, expanded_at, holder_release_pending, release_retry_at, release_attempts)
      VALUES (?, 'w2', 'mailbox-z', '01M8H000000000000000000099', ?, 'foreign@example.net', '[[0,"a","example.net","a@example.net"]]', 'x', 0,
        'accepted', ?, '[[0,null]]', ?, ?, 1, ?, 11)`, stuck, `raw/${'a'.repeat(64)}/01M8H00000000000000000GEN0`, now - hour, now - hour, now - hour, now - hour);
    await h.sweeper('w2', 'stallTombstones', true);
    await h.directoryChange('ALTER TABLE mail_alerts RENAME TO mail_alerts_unavailable');
    await h.advance(10 * minute, 'clock-only');
    await h.handoffCron(200);
    assert.equal((await handoff(h, id))?.holder_release_pending, 0, 'released although the alert insert failed');
    await h.directoryChange('ALTER TABLE mail_alerts_unavailable RENAME TO mail_alerts');
    assert.deepEqual(await h.directoryRows("SELECT key FROM mail_alerts WHERE key LIKE 'handoff_stuck:%'"), []);
    await h.advance(2 * hour, 'clock-only');
    await h.handoffCron(200);
    assert.deepEqual(await h.directoryRows("SELECT key FROM mail_alerts WHERE key LIKE 'handoff_stuck:%'"), [{ key: `handoff_stuck:${stuck}` }]);
  }));

test('a failed second take still acts on the rows the first page took', () => withInternal(async (h, mail, from) => {
  await h.box('member', 'crashAtHandoff', 'expand:written');
  const id = await released(h, mail, from, 'second-take', [OTHER]);
  const mine = (await handoff(h, id))!;
  // A full first page: this handoff, due first, and 11 of another workspace's whose sweeper never answers.
  const now = await h.sends.now();
  await h.directoryChange('UPDATE internal_handoffs SET release_retry_at = ? WHERE key = ?', now - 2 * hour, mine.key);
  for (let i = 0; i < 11; i++) {
    const sendId = `01M8H0000000000000000001${String(i).padStart(2, '0')}`;
    await h.directoryChange(`INSERT INTO internal_handoffs (key, workspace_id, mailbox_id, send_id, raw_key, sender, addresses, message_id, folder_rev,
        decision, created_at, plan, expand_retry_at, expanded_at, holder_release_pending, release_retry_at)
      VALUES (?, 'w2', 'mailbox-z', ?, ?, 'foreign@example.net', '[[0,"a","example.net","a@example.net"]]', ?, 0, 'accepted', ?, '[[0,null]]', ?, ?, 1, ?)`,
    `internal:w2:mailbox-z:${sendId}`, sendId, `raw/${'a'.repeat(64)}/01M8H00000000000000000GEN0`, sendId, now - hour, now - hour, now - hour, now - hour);
  }
  await h.sweeper('w2', 'stallTombstones', true);
  await h.handoffCron(200, 2);
  assert.equal((await handoff(h, id))?.holder_release_pending, 0, 'the first page was acted on although the second take failed');
}));
