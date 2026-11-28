import assert from 'node:assert/strict';
import test from 'node:test';
import type { MailService } from '../../../contracts/mail-api/src/index.ts';
import type { DraftInput } from '../../../contracts/mail-api/src/wire.ts';
import type { DispatchOutcome } from '../src/send-consumer.ts';
import type { EmailBehaviour, EmailCall } from './fixtures/send-consumer.ts';
import { startMailHttpFixture, type SendStateView } from './fixtures/mail-http.ts';

// The send consumer's dispatch core (docs/m3-outbound-plan.md, section 2.4,
// consumer steps 1 to 6 and the error classes; M3-5b), run in local workerd
// against the real Mailbox object, the recording quota fake, a scripted fake
// EMAIL binding and the real send_results table. After every test the
// harness checks the dispatch-fencing invariant over every EMAIL call.
type Fixture = Awaited<ReturnType<typeof startMailHttpFixture>>;
type Outcome = DispatchOutcome | { crashed: true; outcome: DispatchOutcome };
const second = 1000, minute = 60 * second, hour = 60 * minute;
const UNDO = 10 * second;
const LEASE = 5 * minute;
const SKEW = 30 * second;
const WS = 'w1', MB = 'mailbox-a';
const key = (idempotencyKey: string) => ({ idempotencyKey });
const draftInput = (from: string, patch: Partial<DraftInput> = {}): DraftInput => ({
  from, to: [{ email: 'friend@example.net' }], cc: [], bcc: [], subject: 'Hello', body: 'Body text', attachments: [], ...patch,
});

// Across all of these (plan, M3-5 "Dispatch fencing"): no EMAIL call starts
// after its authorization deadline or under a fence whose lease_until has passed.
// `forged`: how many calls a test deliberately made under a grant the mailbox never gave.
async function checkFencing(h: Fixture, forged: number) {
  const calls = await h.consumer<EmailCall[]>('emailCalls');
  const states = new Map<string, SendStateView>();
  assert.equal(calls.filter(call => !call.granted).length, forged, 'every EMAIL call follows a grant from the mailbox, except the deliberate forgeries');
  for (const call of calls) {
    assert.ok(call.fence && call.deadline !== null, `EMAIL call ${call.n} started without an authorization`);
    assert.ok(call.consumerNow < call.deadline, `EMAIL call ${call.n} started at ${call.consumerNow}, not before its deadline ${call.deadline}`);
    const scopeKey = JSON.stringify([call.mb, call.sendId]);
    const state = states.get(scopeKey) ?? await h.sendState(call.sendId, call.mb);
    states.set(scopeKey, state);
    const fence = state.fences.find(row => row.epoch === call.fence!.epoch && row.attempt === call.fence!.attempt);
    assert.ok(fence, `EMAIL call ${call.n} has no fence row`);
    assert.ok(call.authClock < fence.lease_until, `EMAIL call ${call.n} started at ${call.authClock}, not before lease_until ${fence.lease_until}`);
  }
}

async function withConsumer(run: (h: Fixture, mail: MailService, from: string) => Promise<void>,
  { forged = 0, ...options }: Parameters<typeof startMailHttpFixture>[0] & { forged?: number } = {}) {
  const fixture = await startMailHttpFixture({ send: true, ...options });
  try {
    const mail = fixture.as('member');
    const { mailbox } = await mail.getSession();
    assert.ok(mailbox);
    await run(fixture, mail, mailbox.primaryAddress);
    await checkFencing(fixture, forged);
  } finally { await fixture.close(); }
}

// A send released and enqueued.
async function queued(h: Fixture, mail: MailService, from: string, token: string, patch: Partial<DraftInput> = {}): Promise<string> {
  // After a restore the mailbox reindexes its restored messages in alarm slices before it takes new drafts.
  let draft;
  for (let slice = 0; !draft; slice++) {
    try { draft = await mail.createDraft(draftInput(from, patch), key(`draft-${token}`)); }
    catch (error) {
      if (slice >= 8 || (error as { problem?: { code?: string } }).problem?.code !== 'mailbox_restoring') throw error;
      await h.advance(0);
    }
  }
  const sent = await mail.sendDraft(draft.id, { ...key(`send-${token}`), ifMatch: draft.revision });
  await h.advance(UNDO);
  assert.equal((await h.sendState(sent.id)).row?.state, 'queued');
  return sent.id;
}

const dispatch = (sendId: string) => ({ kind: 'dispatch', ws: WS, mb: MB, sendId });
const consume = (h: Fixture, sendId: string) => h.consumer<Outcome>('consume', dispatch(sendId));
const drain = (h: Fixture) => h.consumer<Outcome[]>('drain', WS, MB);
const script = (h: Fixture, ...behaviours: EmailBehaviour[]) => h.consumer('scriptEmail', behaviours);
const calls = (h: Fixture) => h.consumer<EmailCall[]>('emailCalls');
// The stored consumer state without the journal positions, which background publishes may move.
const core = ({ flushed: _flushed, ...state }: SendStateView) => state;
const ledgerOf = (state: SendStateView) => state.ledger.map(({ state: s, reason }) => reason ? `${s}:${reason}` : s);
const step = (outcome: Outcome) => 'crashed' in outcome ? `crashed:${outcome.outcome.step}` : outcome.step;
const finished = async (h: Fixture, id: string) => {
  const state = await h.sendState(id);
  assert.equal(state.row?.finish_pending, 0, 'cleanup finished');
  assert.deepEqual(state.drive, [], 'no drive row');
  assert.equal((await h.sends.registration(id))?.released, 'raw', 'the send raw holder is released');
  return state;
};

test('a released send goes out once through the drive row\'s dispatch message and finishes', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'basic');
  assert.equal((await h.consumer<{ consumerNow: number }>('leads')).consumerNow, await h.sends.now(), 'the consumer reads the fixture clock');
  const outcomes = await drain(h);
  assert.deepEqual(outcomes.map(step), ['recorded']);
  const [call] = await calls(h);
  assert.deepEqual(call.to, ['friend@example.net']);
  const state = await h.sendState(id);
  assert.deepEqual(ledgerOf(state), ['sent']);
  assert.equal(state.row?.state, 'sent');
  await h.advance(minute);
  await finished(h, id);
  assert.equal((await mail.getSend(id)).state, 'sent');
}));

const MIXED = { to: [{ email: 'friend@example.net' }, { email: 'other@example.com' }] };
const THREE = { to: [{ email: 'friend@example.net' }, { email: 'second@example.net' }], cc: [{ email: 'third@example.net' }] };
const scope = (sendId: string) => ({ workspaceId: WS, mailboxId: MB, sendId });
const until = async (h: Fixture, at: number) => h.advance(Math.max(0, (Number.isFinite(at) ? at : 0) - await h.sends.now()));
// Outcomes that did something: a queue may also hold earlier messages, which are acknowledged.
const acted = (s: string) => s !== 'not_now' && s !== 'refused';
// Calls per recipient address, across To, Cc and Bcc.
const perRecipient = (list: EmailCall[]) => {
  const counts: Record<string, number> = {};
  for (const call of list) for (const address of [...call.to, ...call.cc, ...call.bcc]) counts[address] = (counts[address] ?? 0) + 1;
  return counts;
};
// The internal handoff (M3-8) waits while the outbox is down, and completes on the next drive run after it recovers.
const outbox = (h: Fixture, down: boolean) => h.box('member', 'setOutboxDown', down);
const changeOwner = (h: Fixture) => h.directoryChange("UPDATE mailboxes SET user_id = 'new-admin' WHERE workspace_id = ? AND id = ?", WS, MB);
const logged = (h: Fixture, code: string) => h.logs().filter(line => line.includes(`'${code}'`));
// The quota fake's day rolls only when told: the next day starts at the old day's end.
const nextDay = async (h: Fixture) => {
  const end = await h.quota<number>('resetAt');
  await h.quota('setDay', `day-${end}`, end + 24 * hour);
};
// A restore also wipes the fixture's record of enqueued messages.
const restore = async (h: Fixture) => {
  await h.restore();
  await h.consumer('resetDrain', WS, MB);
};
const pauseAt = (h: Fixture, point: string) => h.consumer('pauseAt', point);
const pausedAt = (h: Fixture, point: string) => h.consumer('pausedAt', point);
const resumeAt = (h: Fixture, point: string) => h.consumer('resumeAt', point);
const crashAt = (h: Fixture, point: string) => h.consumer('crashAt', point);
const fenceOf = (outcome: Outcome) => {
  const inner = 'crashed' in outcome ? outcome.outcome : outcome;
  assert.ok('fence' in inner, `expected a claimed outcome, got ${JSON.stringify(outcome)}`);
  return inner.fence;
};
const leaseOf = async (h: Fixture, id: string, outcome: Outcome) => {
  const fence = fenceOf(outcome);
  const row = (await h.sendState(id)).fences.find(entry => entry.epoch === fence.epoch && entry.attempt === fence.attempt);
  assert.ok(row);
  return row.lease_until;
};

test('a retry sends to pending recipients and to attempting ones whose lease expired, never to terminal ones', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'retry', THREE);
  // A scripted earlier consumer: fence A marks recipient 0 only and is accepted;
  // fence B marks recipient 1, is authorized, and its consumer disappears.
  const scripted = async (marked: number[], accept: boolean) => {
    const claim = await h.sendRpc<{ status: string; fence: { epoch: number; attempt: number }; leaseUntil: number; release: unknown[] }>('claimSend', id);
    assert.equal(claim.status, 'claimed');
    const reserved = await h.quota<{ status: string; dayEnd: number }>('reserve', scope(id), claim.fence, marked, claim.release, claim.leaseUntil + 2 * minute);
    assert.equal(reserved.status, 'ok');
    assert.deepEqual(await h.sendRpc('markSend', id, claim.fence, marked, claim.release), { status: 'ok' });
    const confirmed = await h.quota<{ dayEnd: number }>('confirm', scope(id), claim.fence, marked);
    assert.equal((await h.sendRpc<{ status: string }>('authorizeDispatch', id, claim.fence, marked, confirmed.dayEnd)).status, 'ok');
    if (accept) assert.deepEqual(await h.sendRpc('recordResult', id, claim.fence, { kind: 'accepted', messageId: 'scripted' }), { status: 'recorded' });
  };
  await scripted([0], true);
  await scripted([1], false);
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['sent', 'attempting', 'pending']);
  assert.equal(step(await consume(h, id)), 'not_now', 'the live lease of fence B holds the send');
  await h.advance(LEASE + SKEW);
  assert.deepEqual((await drain(h)).map(step).filter(acted), ['recorded']);
  const [call] = await calls(h);
  assert.deepEqual({ to: call.to, cc: call.cc, bcc: call.bcc }, { to: ['second@example.net'], cc: ['third@example.net'], bcc: [] },
    'the expired attempting and the pending recipient, each in its own field; never the sent one');
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['sent', 'sent', 'sent']);
}));

test('a crash between Mark and send(), and a crash after send(): every recipient gets the message, at most one extra copy, and the send ends', () => withConsumer(async (h, mail, from) => {
  const before = await queued(h, mail, from, 'crash-mark');
  await crashAt(h, 'after:markSend');
  const crashed = await consume(h, before);
  assert.equal(step(crashed), 'crashed:abandoned', 'the dead consumer never reached send()');
  assert.equal((await calls(h)).length, 0);
  await until(h, await leaseOf(h, before, crashed) + SKEW);
  assert.deepEqual((await drain(h)).map(step).filter(acted), ['recorded']);
  assert.deepEqual(perRecipient(await calls(h)), { 'friend@example.net': 1 }, 'a crash before send() is no ambiguous event');

  const after = await queued(h, mail, from, 'crash-send', { to: [{ email: 'second@example.net' }] });
  await crashAt(h, 'before:recordResult');
  const lost = await consume(h, after);
  assert.equal(step(lost), 'crashed:store_failed', 'the result died with the consumer');
  await until(h, await leaseOf(h, after, lost) + SKEW);
  assert.deepEqual((await drain(h)).map(step).filter(acted), ['recorded']);
  assert.deepEqual(perRecipient(await calls(h)), { 'friend@example.net': 1, 'second@example.net': 2 }, 'one extra copy for the lost result');
  await h.advance(minute);
  for (const id of [before, after]) assert.equal((await finished(h, id)).row?.state, 'sent');
}));

test('a redelivery within the lease is acknowledged, and the drive row at the lease expiry re-drives the send', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'redelivery');
  await crashAt(h, 'after:markSend');
  const crashed = await consume(h, id);
  const leaseUntil = await leaseOf(h, id, crashed);
  assert.deepEqual(await consume(h, id), { ack: true, step: 'not_now' }, 'the redelivered message is acknowledged');
  assert.deepEqual((await h.sendState(id)).drive, [leaseUntil + SKEW], 'one drive row, at the lease expiry');
  await until(h, leaseUntil + SKEW - 1);
  assert.equal((await calls(h)).length, 0);
  await h.advance(1);
  assert.deepEqual((await drain(h)).map(step).filter(acted), ['recorded']);
  assert.equal((await calls(h)).length, 1);
}));

test('three ambiguous provider errors end the external recipients with delivery_error, rate limits never do; the mixed send finishes after its handoff', () => withConsumer(async (h, mail, from) => {
  await outbox(h, true);
  const id = await queued(h, mail, from, 'cap', MIXED);
  assert.deepEqual((await h.sendState(id)).ledger.map(({ kind }) => kind), ['external', 'internal']);
  const next = async () => {
    await until(h, Number((await h.sendState(id)).dispatch?.next_attempt_at));
    return consume(h, id);
  };
  for (let i = 0; i < 4; i++) {
    await script(h, { result: 'reject', code: 'E_RATE_LIMIT_EXCEEDED' });
    assert.equal(step(await next()), 'recorded');
  }
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['pending', 'pending'], 'rate limits never count toward the cap');
  for (let i = 0; i < 3; i++) {
    await script(h, { result: 'reject', code: 'E_INTERNAL_SERVER_ERROR' });
    assert.equal(step(await next()), 'recorded');
  }
  const capped = await h.sendState(id);
  assert.deepEqual(ledgerOf(capped), ['failed:delivery_error', 'pending'], 'the third ambiguous error ends the external recipient');
  assert.equal(capped.row?.state, 'sending', 'the internal handoff is still pending');
  assert.equal(capped.dispatch?.ambiguous, 3);
  assert.equal((await calls(h)).length, 7);
  await outbox(h, false);
  await h.advance(hour);
  const done = await finished(h, id);
  assert.deepEqual(ledgerOf(done), ['failed:delivery_error', 'sent']);
  assert.equal(done.row?.state, 'partial');
  assert.ok(logged(h, 'send_ambiguous_cap').length >= 1, 'the cap raises its alert');
}));

test('a stray message right after an ambiguous error is refused until next_attempt_at', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'stray');
  await script(h, { result: 'reject', code: 'E_INTERNAL_SERVER_ERROR' });
  assert.equal(step(await consume(h, id)), 'recorded');
  const next = Number((await h.sendState(id)).dispatch?.next_attempt_at);
  assert.equal(next - await h.sends.now(), 30 * minute);
  assert.deepEqual(await consume(h, id), { ack: true, step: 'not_now' }, 'the stray message is refused at once');
  await until(h, next - 1);
  assert.deepEqual(await consume(h, id), { ack: true, step: 'not_now' }, 'and until next_attempt_at');
  assert.equal((await calls(h)).length, 1);
  await h.advance(1);
  assert.equal(step(await consume(h, id)), 'recorded');
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['sent']);
}));

test('a rate-limit backoff shorter than the lease: the lease ends with the report and the backoff timer re-drives', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'rate');
  await script(h, { result: 'reject', code: 'E_RATE_LIMIT_EXCEEDED' });
  const limited = await consume(h, id);
  assert.equal(step(limited), 'recorded');
  const state = await h.sendState(id);
  const now = await h.sends.now();
  assert.equal(state.dispatch?.lease_epoch, null, 'the report ended the lease');
  assert.deepEqual(state.drive, [now + minute], 'the drive row is at the one-minute backoff, not the lease expiry');
  assert.ok(now + minute < await leaseOf(h, id, limited));
  await h.advance(minute);
  assert.deepEqual((await drain(h)).map(step).filter(acted), ['recorded']);
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['sent']);
}));

test('restore matrix around send(): a restore during delayed, during sending, and between send() and its published result', () => withConsumer(async (h, mail, from) => {
  // During delayed: the quota gate is closed, the send waits for its reset across the restore.
  const delayedId = await queued(h, mail, from, 'restore-delayed');
  await h.quota('setExhausted', true);
  assert.equal(step(await consume(h, delayedId)), 'delayed');
  const delayedUntil = Number((await h.sendState(delayedId)).dispatch?.delayed_until);
  await h.advance(minute);
  await restore(h);
  await h.quota('setExhausted', false);
  assert.equal((await mail.getSend(delayedId)).state, 'delayed');
  await nextDay(h);
  await until(h, delayedUntil);
  assert.deepEqual((await drain(h)).map(step).filter(acted), ['recorded']);

  // During sending: Mark is published, then a restore raises the epoch before the authorization.
  const sendingId = await queued(h, mail, from, 'restore-sending', { to: [{ email: 'second@example.net' }] });
  await pauseAt(h, 'before:authorizeDispatch');
  const sending = consume(h, sendingId);
  await pausedAt(h, 'before:authorizeDispatch');
  await restore(h);
  await resumeAt(h, 'before:authorizeDispatch');
  const refused = await sending;
  assert.equal(step(refused), 'stale', 'the old fence is refused after the restore');
  assert.deepEqual(ledgerOf(await h.sendState(sendingId)), ['attempting'], 'the published Mark state is restored');
  await until(h, await leaseOf(h, sendingId, refused) + SKEW);
  assert.deepEqual((await drain(h)).map(step).filter(acted), ['recorded']);

  // Between send() and its published result: once the result still arrives, once it is lost.
  const resultId = await queued(h, mail, from, 'restore-result', { to: [{ email: 'third@example.net' }] });
  await pauseAt(h, 'before:recordResult');
  const recorded = consume(h, resultId);
  await pausedAt(h, 'before:recordResult');
  await restore(h);
  await resumeAt(h, 'before:recordResult');
  assert.equal(step(await recorded), 'recorded', 'a confirmed acceptance from the older epoch is kept');

  const lostId = await queued(h, mail, from, 'restore-lost', { to: [{ email: 'fourth@example.net' }] });
  await pauseAt(h, 'before:recordResult');
  const lost = consume(h, lostId);
  await pausedAt(h, 'before:recordResult');
  await restore(h);
  await h.consumer('resumeAt', 'before:recordResult', true);
  const lostOutcome = await lost;
  assert.equal(step(lostOutcome), 'crashed:store_failed');
  await until(h, await leaseOf(h, lostId, lostOutcome) + SKEW);
  assert.deepEqual((await drain(h)).map(step).filter(acted), ['recorded']);

  assert.deepEqual(perRecipient(await calls(h)), { 'friend@example.net': 1, 'second@example.net': 1, 'third@example.net': 1, 'fourth@example.net': 2 },
    'every recipient gets the message, with one extra copy only for the ambiguous case');
  await h.advance(minute);
  for (const id of [delayedId, sendingId, resultId, lostId]) assert.equal((await finished(h, id)).row?.state, 'sent');
}));

test('a restore after send() and before its result is published: the next claim counts the recipients as ambiguous, and three in a row never fail the send', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'three-restores');
  for (let round = 0; round < 3; round++) {
    await crashAt(h, 'before:recordResult');
    const lost = await consume(h, id);
    assert.equal(step(lost), 'crashed:store_failed');
    await restore(h);
    const restored = await h.sendState(id);
    assert.deepEqual(ledgerOf(restored), ['attempting'], `round ${round}: restored as attempting`);
    assert.equal(step(await consume(h, id)), 'not_now', 'never sent again before the old lease_until');
    await until(h, await leaseOf(h, id, lost) + SKEW);
  }
  assert.equal(step(await consume(h, id)), 'recorded');
  assert.equal(logged(h, 'send_ambiguous_retry').length, 3, 'each restore is an ambiguous event of our own (metric)');
  const state = await h.sendState(id);
  assert.deepEqual(ledgerOf(state), ['sent']);
  assert.equal(state.dispatch?.ambiguous, 0, 'none counts toward the provider-ambiguous cap');
  assert.deepEqual(perRecipient(await calls(h)), { 'friend@example.net': 4 });
}));

test('five consumer crashes after the authorization hold the send; it never fails', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'five-crashes');
  for (let round = 0; round < 5; round++) {
    await crashAt(h, 'after:authorizeDispatch');
    const crashed = await consume(h, id);
    assert.equal(step(crashed), 'crashed:abandoned');
    await until(h, await leaseOf(h, id, crashed) + SKEW);
  }
  assert.deepEqual(await consume(h, id), { ack: true, step: 'not_now' });
  const state = await h.sendState(id);
  assert.ok(state.dispatch?.held_at, 'held');
  assert.deepEqual(ledgerOf(state), ['attempting']);
  assert.equal((await mail.getSend(id)).state, 'sending');
  assert.equal((await calls(h)).length, 0);
}));

test('a held mixed send whose externals a late confirmation ended finishes when its handoff completes (M3-8)', () => withConsumer(async (h, mail, from) => {
  await outbox(h, true);
  const id = await queued(h, mail, from, 'held-handoff', MIXED);
  let fence;
  for (let round = 0; round < 5; round++) {
    await crashAt(h, 'after:authorizeDispatch');
    const crashed = await consume(h, id);
    fence = fenceOf(crashed);
    await until(h, await leaseOf(h, id, crashed) + SKEW);
  }
  assert.deepEqual(await consume(h, id), { ack: true, step: 'not_now' });
  assert.ok((await h.sendState(id)).dispatch?.held_at, 'held');
  // The last authorized call did reach the provider: its confirmed result arrives late, under a stale fence.
  assert.deepEqual(await h.sendRpc('recordResult', id, fence, { kind: 'accepted', messageId: 'late-provider-id' }), { status: 'recorded' });
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['sent', 'pending'], 'only the internal row is open');
  await outbox(h, false);
  await h.advance(hour);
  await h.advance(hour);
  const done = await finished(h, id);
  assert.deepEqual(ledgerOf(done), ['sent', 'sent']);
  assert.equal(done.row?.state, 'sent', 'never left held once every recipient was terminal');
}));

test('recordResult throws once after an accepted send(): the stored result is recorded, and each recipient gets exactly one call', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'record-throws', { to: [{ email: 'friend@example.net' }, { email: 'second@example.net' }] });
  await h.consumer('failNext', 'recordResult');
  const stored = await consume(h, id);
  assert.equal(step(stored), 'stored');
  const fence = fenceOf(stored);
  assert.deepEqual(await h.directoryRows('SELECT kind, message_id, detail, fence_epoch, fence_attempt FROM send_results WHERE send_id = ?', id),
    [{ kind: 'accepted', message_id: 'provider-1', detail: null, fence_epoch: fence.epoch, fence_attempt: fence.attempt }]);
  assert.deepEqual(await h.consumer('resultNotices'), [{ kind: 'result', ws: WS, mb: MB, sendId: id, fence }]);
  // The drive row at the lease expiry records it (a notice would do the same).
  await until(h, await leaseOf(h, id, stored) + SKEW);
  assert.deepEqual((await drain(h)).map(step).filter(acted), []);
  await h.advance(minute);
  assert.deepEqual(ledgerOf(await finished(h, id)), ['sent', 'sent']);
  assert.deepEqual(await h.directoryRows('SELECT 1 FROM send_results WHERE send_id = ?', id), []);
  assert.deepEqual(perRecipient(await calls(h)), { 'friend@example.net': 1, 'second@example.net': 1 });
}));

test('the stored result is not acknowledged when its D1 write fails too; the queue retries the message', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'store-fails');
  await h.consumer('failNext', 'recordResult');
  await h.consumer('failNext', 'storeResult');
  const outcome = await consume(h, id);
  assert.deepEqual(outcome, { ack: false, step: 'store_failed', fence: fenceOf(outcome) });
  assert.deepEqual(await h.consumer('resultNotices'), [], 'no notice without a stored row');
  assert.deepEqual(await consume(h, id), { ack: true, step: 'not_now' }, 'the retried message finds the lease live');
}));

test('a partial failure gives partial with per-recipient reasons', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'partial', MIXED);
  await script(h, { result: 'reject', code: 'E_VALIDATION_ERROR' });
  assert.equal(step(await consume(h, id)), 'recorded');
  await h.advance(hour);
  const done = await finished(h, id);
  assert.deepEqual(ledgerOf(done), ['failed:rejected', 'sent']);
  const send = await mail.getSend(id);
  assert.equal(send.state, 'partial');
  assert.deepEqual(send.recipients.map(({ state, reason }) => reason ? `${state}:${reason}` : state), ['failed:rejected', 'sent']);
}));

test('the provider\'s daily limit gives delayed with a timer, through delaySend', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'daily');
  await script(h, { result: 'reject', code: 'E_DAILY_LIMIT_EXCEEDED' });
  const delayed = await consume(h, id);
  assert.equal(step(delayed), 'delayed');
  const state = await h.sendState(id);
  const reset = await h.quota<number>('resetAt');
  assert.equal(state.dispatch?.delayed_until, reset + SKEW, 'the mailbox computes the reset plus clockSkew');
  assert.deepEqual(state.drive, [reset + SKEW]);
  assert.equal(state.fences.at(-1)?.outcome, 'delayed');
  assert.equal((await mail.getSend(id)).state, 'delayed');
  assert.equal(state.dispatch?.provider_wait, 0, 'a quota wait never counts toward the deadline');
  await nextDay(h);
  await until(h, reset + SKEW);
  assert.deepEqual((await drain(h)).map(step).filter(acted), ['recorded']);
  assert.equal((await calls(h)).length, 2);
}));

test('invalid_sender at the claim, and an alias removed while delayed, make no EMAIL call', () => withConsumer(async (h, mail, primary) => {
  const id = await queued(h, mail, primary, 'claim-owner');
  await changeOwner(h);
  assert.deepEqual(await consume(h, id), { ack: true, step: 'refused' });
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['failed:invalid_sender']);
  await h.directoryChange("UPDATE mailboxes SET user_id = 'member' WHERE workspace_id = ? AND id = ?", WS, MB);

  const admin = h.as('admin');
  const { mailbox } = await mail.getSession();
  const alias = (await admin.createAlias({ mailboxId: mailbox!.id, address: 'sales@example.com', sendAs: true }, key('alias'))).address;
  await h.sends.activateAlias(alias);
  const other = await queued(h, mail, alias, 'alias');
  await h.quota('setExhausted', true);
  assert.equal(step(await consume(h, other)), 'delayed');
  const delayedUntil = Number((await h.sendState(other)).dispatch?.delayed_until);
  await admin.deleteAlias(alias);
  await h.quota('setExhausted', false);
  await until(h, delayedUntil);
  assert.deepEqual((await drain(h)).map(step).filter(acted), []);
  assert.deepEqual(ledgerOf(await h.sendState(other)), ['failed:invalid_sender']);
  await h.advance(minute);
  await finished(h, other);
  assert.equal((await calls(h)).length, 0, 'no EMAIL call');
}));

// Dispatch fencing (plan, M3-5 acceptance), with the consumer's clock and the mailbox's clock under test control.

test('a restore starts while the quota confirmation stalls: no EMAIL call under the old fence, and the restored recipients are claimed only after the old lease_until', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'restore-confirm');
  await pauseAt(h, 'before:confirm');
  const stalled = consume(h, id);
  await pausedAt(h, 'before:confirm');
  await restore(h);
  await resumeAt(h, 'before:confirm');
  const old = await stalled;
  assert.deepEqual(old, { ack: true, step: 'abandoned', fence: fenceOf(old), cause: 'request_stale' }, 'the old fence gets no request and no authorization');
  assert.equal((await calls(h)).length, 0);
  const leaseUntil = await leaseOf(h, id, old);
  await until(h, leaseUntil + SKEW - 1);
  assert.deepEqual(await consume(h, id), { ack: true, step: 'not_now' });
  await h.advance(1);
  assert.equal(step(await consume(h, id)), 'recorded');
  const [call] = await calls(h);
  assert.ok(call.real >= leaseUntil + SKEW && call.fence!.epoch > fenceOf(old).epoch, 'sent once, under the new epoch, after the old lease_until');
}));

test('a restore between authorizeDispatch and send(): the old call starts before its deadline, the next claim waits for the old lease_until and counts the recipient as ambiguous', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'restore-authorized');
  await pauseAt(h, 'after:authorizeDispatch');
  await crashAt(h, 'before:recordResult');
  const old = consume(h, id);
  await pausedAt(h, 'after:authorizeDispatch');
  await restore(h);
  await resumeAt(h, 'after:authorizeDispatch');
  const lost = await old;
  assert.equal(step(lost), 'crashed:store_failed');
  const [first] = await calls(h);
  assert.ok(first.consumerNow < first.deadline!, 'the old call started inside its window');
  const leaseUntil = await leaseOf(h, id, lost);
  await until(h, leaseUntil + SKEW - 1);
  assert.deepEqual(await consume(h, id), { ack: true, step: 'not_now' });
  const retries = logged(h, 'send_ambiguous_retry').length;
  await h.advance(1);
  assert.equal(step(await consume(h, id)), 'recorded');
  assert.equal(logged(h, 'send_ambiguous_retry').length, retries + 1, 'the restored attempting recipient is an ambiguous event');
  assert.deepEqual(perRecipient(await calls(h)), { 'friend@example.net': 2 }, 'at most two calls');
}));

test('the owner changes while the quota confirmation stalls: the send ends failed with invalid_sender and no EMAIL call', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'owner-confirm');
  await pauseAt(h, 'before:confirm');
  const stalled = consume(h, id);
  await pausedAt(h, 'before:confirm');
  await changeOwner(h);
  await resumeAt(h, 'before:confirm');
  assert.equal(step(await stalled), 'stale');
  await h.advance(minute);
  assert.deepEqual(ledgerOf(await finished(h, id)), ['failed:invalid_sender']);
  assert.equal((await calls(h)).length, 0);
}));

test('the consumer stalls after authorizeDispatch past its deadline: no EMAIL call, abandonClaim, and the send goes out on the next attempt', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'deadline-stall');
  await pauseAt(h, 'after:authorizeDispatch');
  const stalled = consume(h, id);
  await pausedAt(h, 'after:authorizeDispatch');
  await h.advance(10 * second);
  await resumeAt(h, 'after:authorizeDispatch');
  const abandoned = await stalled;
  assert.deepEqual(abandoned, { ack: true, step: 'abandoned', fence: fenceOf(abandoned), cause: 'deadline' });
  assert.equal((await calls(h)).length, 0);
  const state = await h.sendState(id);
  assert.deepEqual(ledgerOf(state), ['pending']);
  assert.equal(state.fences.at(-1)?.outcome, 'abandoned');
  assert.equal(state.dispatch?.next_attempt_at, await h.sends.now() + minute);
  await h.advance(minute);
  assert.deepEqual((await drain(h)).map(step).filter(acted), ['recorded']);
  assert.equal((await calls(h)).length, 1);
}));

// Brings a consumer to the last allowed authorization of its lease: Mark set
// lease_until L, and authorizeDispatch runs at L - (10 s + clockSkew).
async function lastMomentAuthorization(h: Fixture, id: string) {
  // Paused before the consumer reads t0 for the authorization.
  await pauseAt(h, 'after:sendRequest');
  await pauseAt(h, 'after:authorizeDispatch');
  const run = consume(h, id);
  await pausedAt(h, 'after:sendRequest');
  const leaseUntil = (await h.sendState(id)).fences.at(-1)!.lease_until;
  await until(h, leaseUntil - 10 * second - SKEW);
  await resumeAt(h, 'after:sendRequest');
  await pausedAt(h, 'after:authorizeDispatch');
  return { run, leaseUntil };
}
// Moves the mailbox's clock ahead of real time by `lead`, as a reclaiming object on another machine.
const reclaimingClock = async (h: Fixture, lead: number) => {
  const { mailbox } = await h.consumer<{ mailbox: number }>('leads');
  await h.consumer('setLeads', { mailbox: lead });
  await h.advance(lead - mailbox);
};
const real = async (h: Fixture) => (await h.consumer<{ real: number }>('leads')).real;

test('independent clocks: with the reclaiming clock 55 s ahead, no two calls for one recipient have overlapping dispatch windows', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'clock-55');
  const { run, leaseUntil: L } = await lastMomentAuthorization(h, id);
  // The old consumer calls at the last moment of its window.
  await h.advance(10 * second - 1);
  await crashAt(h, 'before:recordResult');
  await resumeAt(h, 'after:authorizeDispatch');
  assert.equal(step(await run), 'crashed:store_failed');
  await reclaimingClock(h, 55 * second);
  await h.advance(L - 25 * second - 1 - await real(h));
  assert.deepEqual(await consume(h, id), { ack: true, step: 'not_now' }, 'not reclaimed before L + clockSkew on the reclaiming clock');
  await h.advance(1);
  assert.equal(step(await consume(h, id)), 'recorded');
  const [old, next] = await calls(h);
  assert.equal(old.real, L - 30 * second - 1);
  assert.equal(old.deadline, L - 30 * second, 'the old window ends clockSkew before lease_until');
  assert.equal(next.real, L - 25 * second);
  assert.ok(next.real > old.deadline!, 'the windows are 5 s apart');
}));

test('independent clocks: at 65 s ahead the reclaim starts inside the old dispatch window, documenting the 2 x clockSkew bound', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'clock-65');
  const { run, leaseUntil: L } = await lastMomentAuthorization(h, id);
  await reclaimingClock(h, 65 * second);
  await h.advance(5 * second);
  assert.equal(await real(h), L - 35 * second);
  assert.equal(step(await consume(h, id)), 'recorded', 'the reclaiming clock already reads L + clockSkew');
  await h.advance(5 * second - 1);
  await resumeAt(h, 'after:authorizeDispatch');
  assert.equal(step(await run), 'recorded', 'the old call is still inside its window, and its confirmed result is kept');
  const [next, old] = await calls(h);
  assert.equal(next.real, L - 35 * second);
  assert.equal(old.real, L - 30 * second - 1);
  assert.ok(next.real < old.deadline!, 'the dispatch windows overlap beyond the budget');
  assert.deepEqual(perRecipient(await calls(h)), { 'friend@example.net': 2 });
}));

test('independent clocks: the consumer\'s clock stepping back 20 s during authorizeDispatch, with the reclaiming clock 35 s ahead, keeps the windows apart', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'clock-step');
  const { run, leaseUntil: L } = await lastMomentAuthorization(h, id);
  await h.consumer('setLeads', { consumer: -20 * second });
  // The deadline is on the consumer's clock: it can now call until real time L - 10 s.
  await h.advance(30 * second - 1);
  await crashAt(h, 'before:recordResult');
  await resumeAt(h, 'after:authorizeDispatch');
  assert.equal(step(await run), 'crashed:store_failed');
  await reclaimingClock(h, 35 * second);
  await h.advance(L - 5 * second - 1 - await real(h));
  assert.deepEqual(await consume(h, id), { ack: true, step: 'not_now' });
  await h.advance(1);
  assert.equal(step(await consume(h, id)), 'recorded');
  const [old, next] = await calls(h);
  assert.equal(old.real, L - 10 * second - 1, 'the old call starts 10 s before lease_until in real time');
  assert.equal(next.real, L - 5 * second, '55 s of the 60 s budget: still 5 s apart');
}));

test('the owner changes while an authorized call is slow past its lease: the recipient is held one lease period, and the late confirmed sent is recorded instead of invalid_sender', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'slow-owner');
  await script(h, { result: 'hold', then: { result: 'accept', messageId: 'slow' } });
  await pauseAt(h, 'email');
  const slow = consume(h, id);
  await pausedAt(h, 'email');
  await changeOwner(h);
  const leaseUntil = (await h.sendState(id)).fences.at(-1)!.lease_until;
  await until(h, leaseUntil + SKEW);
  assert.deepEqual(await consume(h, id), { ack: true, step: 'refused' });
  const held = await h.sendState(id);
  assert.deepEqual(ledgerOf(held), ['attempting'], 'protected: the authorized call may have run');
  assert.equal(held.dispatch?.grace_until, leaseUntil + SKEW + LEASE);
  await resumeAt(h, 'email');
  assert.equal(step(await slow), 'recorded');
  const done = await h.sendState(id);
  assert.deepEqual(ledgerOf(done), ['sent']);
  assert.equal(done.row?.state, 'sent');
  assert.equal((await calls(h)).length, 1);
}));

test('the same with a restore longer than a lease: the hold starts at the end of the restore, and the stored sent result is recorded', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'slow-restore');
  await script(h, { result: 'hold', then: { result: 'accept', messageId: 'slow' } });
  await pauseAt(h, 'email');
  const slow = consume(h, id);
  await pausedAt(h, 'email');
  await changeOwner(h);
  await h.restoreAfter(LEASE + minute);
  await h.consumer('resetDrain', WS, MB);
  const restoredAt = Number((await h.sends.lifecycle())?.restoredAt);
  assert.deepEqual(await consume(h, id), { ack: true, step: 'refused' });
  const held = await h.sendState(id);
  assert.deepEqual(ledgerOf(held), ['attempting']);
  assert.equal(held.dispatch?.grace_until, restoredAt + LEASE, 'the hold starts at the end of the restore');
  await h.consumer('failNext', 'recordResult');
  await resumeAt(h, 'email');
  assert.equal(step(await slow), 'stored');
  await until(h, restoredAt + LEASE);
  await h.advance(minute);
  const done = await finished(h, id);
  assert.deepEqual(ledgerOf(done), ['sent'], 'the stored sent result replaced the hold, never invalid_sender');
  assert.equal((await calls(h)).length, 1);
}));

test('an empty claim: a duplicate dispatch for a mixed send whose external recipients are terminal takes no lease, attempt or reservation and leaves send_drive alone', () => withConsumer(async (h, mail, from) => {
  await outbox(h, true);
  const id = await queued(h, mail, from, 'empty', MIXED);
  assert.equal(step(await consume(h, id)), 'recorded');
  const before = await h.sendState(id);
  assert.deepEqual(ledgerOf(before), ['sent', 'pending']);
  const quotaCalls = (await h.quota<unknown[]>('calls')).length;
  assert.deepEqual(await consume(h, id), { ack: true, step: 'refused' });
  const after = await h.sendState(id);
  assert.equal(after.dispatch?.attempt, before.dispatch?.attempt);
  assert.equal(after.dispatch?.lease_epoch, null);
  assert.deepEqual(after.drive, before.drive);
  assert.equal((await h.quota<unknown[]>('calls')).length, quotaCalls);
  await outbox(h, false);
  await h.advance(hour);
  assert.equal((await finished(h, id)).row?.state, 'sent');
  assert.equal((await calls(h)).length, 1);
}));

// The send() classification (section 2.4, step 6; the error table).

test('only the settled send() promise is classified: a synchronous throw is a rejection, and a fulfilled call without a message id is accepted', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'sync-throw');
  await script(h, { result: 'throw', code: 'E_RATE_LIMIT_EXCEEDED' });
  assert.equal(step(await consume(h, id)), 'recorded');
  let state = await h.sendState(id);
  assert.equal(state.fences.at(-1)?.outcome, 'try_later', 'classified by its code, never abandoned');
  assert.deepEqual(ledgerOf(state), ['pending']);
  await h.advance(minute);
  await script(h, { result: 'throw' });
  assert.equal(step(await consume(h, id)), 'recorded');
  state = await h.sendState(id);
  assert.equal(state.fences.at(-1)?.outcome, 'ambiguous', 'a synchronous throw without a code is ambiguous');
  assert.equal(state.dispatch?.ambiguous, 1);
  await until(h, Number(state.dispatch?.next_attempt_at));
  await script(h, { result: 'accept', value: {} });
  assert.equal(step(await consume(h, id)), 'recorded');
  state = await h.sendState(id);
  assert.deepEqual(ledgerOf(state), ['sent']);
  assert.equal(state.marks.at(-1)?.provider_id, null, 'accepted with a null id');
}));

test('unknown and uncoded rejections are ambiguous: three end the send with delivery_error, each with the unknown-code alert', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'unknown');
  for (const behaviour of [{ result: 'reject', code: 'E_SOMETHING_NEW' }, { result: 'reject' }, { result: 'reject', typeError: true }] as EmailBehaviour[]) {
    await until(h, Number((await h.sendState(id)).dispatch?.next_attempt_at));
    await script(h, behaviour);
    assert.equal(step(await consume(h, id)), 'recorded');
    assert.equal((await h.sendState(id)).fences.at(-1)?.outcome, 'ambiguous', JSON.stringify(behaviour));
  }
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['failed:delivery_error']);
  assert.equal(logged(h, 'send_unknown_error').length, 3);
  assert.ok(logged(h, 'send_unknown_error').every(line => !line.includes('E_SOMETHING_NEW') && !line.includes('uncoded')),
    'only the stable alert code is logged, never provider data');
  assert.equal(logged(h, 'send_ambiguous_cap').length, 1);
}));

test('try-later and our-outage codes go through their own result kinds; an outage never counts toward the deadline', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'kinds');
  const run = async (code: string) => {
    await until(h, Number((await h.sendState(id)).dispatch?.next_attempt_at));
    await script(h, { result: 'reject', code });
    const outcome = await consume(h, id);
    assert.equal(step(outcome), 'recorded');
    const state = await h.sendState(id);
    const fence = fenceOf(outcome);
    const balance = (await h.quota<{ epoch: number; attempt: number; charges: number }[]>('balances'))
      .filter(row => row.epoch === fence.epoch && row.attempt === fence.attempt).length;
    return { outcome: state.fences.at(-1)?.outcome, wait: state.dispatch?.provider_wait, balance, ledger: ledgerOf(state) };
  };
  assert.deepEqual(await run('E_RATE_LIMIT_EXCEEDED'), { outcome: 'try_later', wait: minute, balance: 0, ledger: ['pending'] });
  assert.deepEqual(await run('E_SENDER_NOT_VERIFIED'), { outcome: 'outage', wait: minute, balance: 0, ledger: ['pending'] });
  assert.deepEqual(await run('E_SENDER_DOMAIN_NOT_AVAILABLE'), { outcome: 'outage', wait: minute, balance: 0, ledger: ['pending'] });
  assert.deepEqual(await run('E_CONTENT_TOO_LARGE'), { outcome: 'rejected', wait: minute, balance: 1, ledger: ['failed:message_too_large'] });
  assert.equal(logged(h, 'send_outage').length, 2);
}));

// The request (step 3a): built by the mailbox from the send's frozen inputs, never from the sent copy.

test('the send() request equals buildSendRequest over the frozen inputs of the stored sent copy, for the claimed recipients in their fields', () => withConsumer(async (h, mail, from) => {
  await h.sends.setReplyTo([{ email: 'replies@example.com', name: 'Replies' }]);
  const parent = await h.deliver({ from: { name: 'Mira Chen', email: 'mira@example.net' }, to: [{ name: 'Jordan Member', email: from }], subject: 'Plans', text: 'See attached',
    attachments: [{ name: 'plan.txt', type: 'text/plain', bytes: new TextEncoder().encode('plan bytes') }] });
  const part = (await mail.getThread(parent.threadId)).messages[0].attachments[0].part;
  const upload = await mail.createUpload({ name: 'résumé.txt', type: 'text/plain', bytes: new Blob(['upload bytes']) }, key('upload'));
  const id = await queued(h, mail, from, 'request', {
    to: [{ email: 'friend@example.net', name: 'Friend' }], cc: [{ email: 'cc@example.net' }], bcc: [{ email: 'bcc@example.net' }],
    subject: 'Re: Plans', body: 'Line one\nLine two', inReplyTo: parent.messageId,
    attachments: [{ kind: 'upload', uploadId: upload.id }, { kind: 'message', messageId: parent.messageId, part }],
  });
  assert.equal(step(await consume(h, id)), 'recorded');
  const request = await h.consumer<Record<string, unknown>>('emailRequest', 1);
  const record = JSON.parse((await h.sends.row(id))!.record) as { from: { email: string; name: string }; replyTo: { email: string; name?: string }[];
    dateAt: number; messageId: string; boundary: string; builderVersion: number };
  const sentCopy = await h.sentHeaders((await mail.getSend(id)).messageId!);
  const { buildSendRequest } = await import('../src/send-mime.ts');
  const expected = buildSendRequest({
    from: record.from, to: [{ email: 'friend@example.net', name: 'Friend' }], cc: [{ email: 'cc@example.net' }], bcc: [{ email: 'bcc@example.net' }],
    subject: 'Re: Plans', text: 'Line one\nLine two', frozenReplyTo: record.replyTo[0],
    threading: { inReplyTo: sentCopy['in-reply-to'], references: sentCopy.references }, dateAt: record.dateAt, messageId: record.messageId,
    boundary: record.boundary, builderVersion: record.builderVersion,
    attachments: [{ name: 'résumé.txt', type: 'text/plain', bytes: new TextEncoder().encode('upload bytes') },
      { name: 'plan.txt', type: 'text/plain', bytes: new TextEncoder().encode('plan bytes') }],
  });
  const base64 = (bytes: unknown) => Buffer.from(bytes as Uint8Array).toString('base64');
  assert.deepEqual(request, { ...expected, attachments: expected.attachments!.map(({ content, ...rest }) => ({ ...rest, content: base64(content) })) });
  assert.deepEqual(request.headers, { 'In-Reply-To': sentCopy['in-reply-to'], References: sentCopy.references }, 'the sent copy\'s threading headers');
  assert.match(sentCopy['reply-to'], /replies@example\.com/, 'the same frozen Reply-To as the sent copy');
}));

test('a stale fence gets no request; the current marked fence gets one for its Mark set only', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'request-fence', { to: [{ email: 'friend@example.net' }, { email: 'second@example.net' }] });
  const claimAndMark = async (marked: number[]) => {
    const claim = await h.sendRpc<{ status: string; fence: { epoch: number; attempt: number }; leaseUntil: number; release: unknown[] }>('claimSend', id);
    assert.equal(claim.status, 'claimed');
    await h.quota('reserve', scope(id), claim.fence, marked, claim.release, claim.leaseUntil + 2 * minute);
    assert.deepEqual(await h.sendRpc('markSend', id, claim.fence, marked, claim.release), { status: 'ok' });
    return claim.fence;
  };
  const a = await claimAndMark([0]);
  const ok = await h.sendRpc<{ status: string; request: { to: unknown } }>('sendRequest', id, a);
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.request.to, ['friend@example.net'], 'only the Mark set');
  await h.advance(LEASE + SKEW);
  const b = await claimAndMark([0, 1]);
  assert.deepEqual(await h.sendRpc('sendRequest', id, a), { status: 'stale' }, 'a stale fence gets no request');
  assert.deepEqual(await h.sendRpc('sendRequest', id, { ...b, attempt: b.attempt + 1 }), { status: 'stale' }, 'nor an unknown one');
  assert.equal((await h.sendRpc<{ status: string }>('sendRequest', id, b)).status, 'ok');
  await h.advance(LEASE);
  assert.deepEqual(await h.sendRpc('sendRequest', id, b), { status: 'stale' }, 'nor one whose lease has run out');
}));

test('without the EMAIL binding the consumer abandons before the authorization and sends nothing', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'binding');
  await h.consumer('removeBinding', true);
  const outcome = await consume(h, id);
  assert.deepEqual(outcome, { ack: true, step: 'abandoned', fence: fenceOf(outcome), cause: 'binding' });
  const state = await h.sendState(id);
  assert.equal(state.fences.at(-1)?.authorized, 0, 'never authorized');
  assert.deepEqual(ledgerOf(state), ['pending']);
  assert.equal(logged(h, 'send_binding_missing').length, 1);
  await h.consumer('removeBinding', false);
  await h.advance(minute);
  assert.deepEqual((await drain(h)).map(step).filter(acted), ['recorded']);
}));

test('a refusal under a stale fence releases only that fence\'s reservation, once, also after the send finished; a failed release keeps the charge', () => withConsumer(async (h, mail, from) => {
  for (const [token, finish, failing] of [['stale-open', false, false], ['stale-finished', true, false], ['stale-failing', false, true]] as const) {
    const id = await queued(h, mail, from, token);
    const charge = async (fence: { epoch: number; attempt: number }) => (await h.quota<{ sendId: string; epoch: number; attempt: number; charges: number }[]>('balances'))
      .filter(row => row.sendId === id && row.epoch === fence.epoch && row.attempt === fence.attempt).reduce((sum, row) => sum + row.charges, 0);
    await script(h, { result: 'hold', then: { result: 'reject', code: 'E_RATE_LIMIT_EXCEEDED' } });
    await pauseAt(h, 'email');
    const slow = consume(h, id);
    await pausedAt(h, 'email');
    await until(h, (await h.sendState(id)).fences.at(-1)!.lease_until + SKEW);
    // A newer fence claims, reserves and is authorized; for the finished case its call is accepted.
    await pauseAt(h, 'after:authorizeDispatch');
    const newer = consume(h, id);
    await pausedAt(h, 'after:authorizeDispatch');
    if (finish) {
      await resumeAt(h, 'after:authorizeDispatch');
      assert.equal(step(await newer), 'recorded');
      await h.advance(minute);
      await finished(h, id);
    }
    const state = await h.sendState(id);
    const [old, next] = state.fences.slice(-2);
    assert.equal(await charge(old), 1);
    const nextCharge = await charge(next);
    assert.equal(nextCharge, 1);
    const callsBefore = (await h.quota<unknown[]>('calls')).length;
    const failedBefore = logged(h, 'send_stale_release_failed').length;
    if (failing) await h.consumer('failNext', 'release');
    await resumeAt(h, 'email');
    assert.equal(step(await slow), 'unrecorded', 'the stale fence records nothing');
    const released = (await h.quota<{ method: string; scope: { sendId: string }; fences: { epoch: number; attempt: number }[] }[]>('calls')).slice(callsBefore);
    if (failing) {
      assert.deepEqual(released, [], 'the failed release reached nothing');
      assert.equal(await charge(old), 1, 'a failed release keeps the charge');
      assert.equal(logged(h, 'send_stale_release_failed').length, failedBefore + 1);
    } else {
      assert.deepEqual(released, [{ method: 'release', scope: { workspaceId: WS, mailboxId: MB, sendId: id }, fences: [{ epoch: old.epoch, attempt: old.attempt }] }],
        'exactly one release, of the stale fence');
      assert.equal(await charge(old), 0, 'its refused call is not charged');
    }
    assert.equal(await charge(next), nextCharge, 'the newer fence keeps its charge');
    assert.deepEqual(core(await h.sendState(id)), core(state), 'no recipient, lease, timer or release entry changed');
    if (!finish) {
      await resumeAt(h, 'after:authorizeDispatch');
      assert.equal(step(await newer), 'recorded');
    }
  }
}));

test('a refusal stored while it cannot be recorded, then replayed after a restore, releases its fence\'s reservation', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'stored-refusal');
  await script(h, { result: 'reject', code: 'E_RATE_LIMIT_EXCEEDED' });
  await h.consumer('failNext', 'recordResult');
  const stored = await consume(h, id);
  assert.equal(step(stored), 'stored');
  const fence = fenceOf(stored);
  const charge = async () => (await h.quota<{ sendId: string; epoch: number; attempt: number; charges: number }[]>('balances'))
    .filter(row => row.sendId === id && row.epoch === fence.epoch && row.attempt === fence.attempt).reduce((sum, row) => sum + row.charges, 0);
  assert.equal(await charge(), 1, 'storing a refusal releases nothing yet');
  // The restore raises the epoch, so the replayed refusal is stale; its notice replays it.
  await restore(h);
  assert.deepEqual(await h.sendRpc('recordStoredResults', id, fence), { status: 'recorded', recorded: 1 });
  assert.deepEqual(await h.directoryRows('SELECT 1 FROM send_results WHERE send_id = ?', id), [], 'replayed and deleted');
  assert.equal(await charge(), 0, 'the stale refusal released its own fence');
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['attempting'], 'and changed no recipient');
}));

test('the sendRequest answer is checked again after its reads: a fence that expires while the draft is read gets no request', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'request-expiry');
  const claim = await h.sendRpc<{ status: string; fence: { epoch: number; attempt: number }; leaseUntil: number; release: unknown[] }>('claimSend', id);
  await h.quota('reserve', scope(id), claim.fence, [0], claim.release, claim.leaseUntil + 2 * minute);
  assert.deepEqual(await h.sendRpc('markSend', id, claim.fence, [0], claim.release), { status: 'ok' });
  const leaseUntil = (await h.sendState(id)).fences.at(-1)!.lease_until;
  const { draft } = JSON.parse((await h.sends.row(id))!.record) as { draft: { rawKey: string } };
  const read = h.pauseNextGet(new RegExp(`/${draft.rawKey}$`));
  const pending = h.sendRpc<{ status: string }>('sendRequest', id, claim.fence);
  // A request that returns before reading the draft fails at once instead of waiting for the read.
  await Promise.race([read.started, pending.then(answer => assert.fail(`answered before its read: ${JSON.stringify(answer)}`))]);
  try { await until(h, leaseUntil); }
  finally { read.release(); }
  assert.deepEqual(await pending, { status: 'stale' }, 'the in-flight request answers stale once its lease ran out');
  assert.deepEqual(await h.sendRpc('sendRequest', id, claim.fence), { status: 'stale' }, 'as a fresh one does');
}));

test('the deadline check and the call have no await between them: a clock that reaches the deadline on the next tick never delays the call past it', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'no-yield');
  await h.consumer('trapYieldAfterCheck', true);
  assert.equal(step(await consume(h, id)), 'recorded');
  const [call] = await calls(h);
  assert.ok(call.consumerNow < call.deadline!, `the call started at ${call.consumerNow}, before its deadline ${call.deadline}`);
  assert.equal((await h.consumer<{ consumerNow: number }>('leads')).consumerNow, call.deadline, 'the trap moved the clock to the deadline right after the check');
}));

test('a request the frozen inputs can no longer build is abandoned with the longest retry and never sent', () => withConsumer(async (h, mail, from) => {
  const parent = await h.deliver({ from: { name: 'Mira Chen', email: 'mira@example.net' }, to: [{ name: 'Jordan Member', email: from }], subject: 'Plans',
    text: 'See attached', attachments: [{ name: 'plan.txt', type: 'text/plain', bytes: new TextEncoder().encode('plan bytes') }] });
  const part = (await mail.getThread(parent.threadId)).messages[0].attachments[0].part;
  const id = await queued(h, mail, from, 'invalid-request', { attachments: [{ kind: 'message', messageId: parent.messageId, part }] });
  // The frozen digest of the forwarded part no longer matches its source: an invariant breach after release.
  await h.sends.changePartDigest(id);
  const outcome = await consume(h, id);
  assert.deepEqual(outcome, { ack: true, step: 'abandoned', fence: fenceOf(outcome), cause: 'request_invalid' });
  const state = await h.sendState(id);
  assert.equal(state.dispatch?.next_attempt_at, await h.sends.now() + hour, 'retried at the one-hour maximum, not every minute');
  assert.deepEqual(ledgerOf(state), ['pending'], 'never failed by our own breach');
  assert.equal(logged(h, 'send_request_invalid').length, 1);
  assert.equal((await calls(h)).length, 0);
}));

// One request build that outlives its lease (the draft read is held until the lease ends).
// `dies`: the consumer dies right after the stale answer, so the attempt has no report.
async function slowBuild(h: Fixture, id: string, dies: boolean, label: string) {
  const { draft } = JSON.parse((await h.sends.row(id))!.record) as { draft: { rawKey: string } };
  const read = h.pauseNextGet(new RegExp(`/${draft.rawKey}$`));
  if (dies) await crashAt(h, 'after:sendRequest');
  const run = consume(h, id);
  // A held send never reaches the request: fail at once instead of waiting for its read.
  await Promise.race([read.started, run.then(outcome => assert.fail(`${label}: no request was built, the claim answered ${JSON.stringify(outcome)}`))]);
  const leaseUntil = (await h.sendState(id)).fences.at(-1)!.lease_until;
  try { await until(h, leaseUntil); }
  finally { read.release(); }
  assert.equal(step(await run), dies ? 'crashed:abandoned' : 'abandoned', label);
  return leaseUntil;
}

test('slow request builds with a live consumer are reported by abandonClaim: never counted, never held, and the next normal attempt sends', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'slow-alive');
  for (let round = 0; round < 6; round++) {
    await slowBuild(h, id, false, `round ${round}`);
    await until(h, Number((await h.sendState(id)).dispatch?.next_attempt_at));
  }
  const state = await h.sendState(id);
  assert.equal(state.dispatch?.held_at, null, 'never held');
  assert.equal(state.dispatch?.unfinished, 0, 'a reported attempt is never unfinished');
  assert.equal(step(await consume(h, id)), 'recorded');
}));

test('slow request builds whose consumer dies before reporting count as unfinished: the send is held after five', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'slow-dies');
  for (let round = 0; round < 5; round++) {
    const leaseUntil = await slowBuild(h, id, true, `round ${round}`);
    await until(h, leaseUntil + SKEW);
  }
  assert.deepEqual(await consume(h, id), { ack: true, step: 'not_now' });
  const state = await h.sendState(id);
  assert.ok(state.dispatch?.held_at, 'held after five unreported expiries (plan section 2.4, crash-loop cap)');
  assert.equal((await calls(h)).length, 0);
}));

test('an abandon never resets the crash streak: authorized expiries alternating with stale-request abandons hold the send after five', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'mixed-streak');
  for (let round = 0; round < 5; round++) {
    // An accepted call whose consumer dies before recordResult: an unfinished authorized attempt.
    await crashAt(h, 'before:recordResult');
    const lost = await consume(h, id);
    assert.equal(step(lost), 'crashed:store_failed', `round ${round}`);
    await until(h, await leaseOf(h, id, lost) + SKEW);
    if (round === 4) break;
    // A live consumer whose request build outlives the lease reports with abandonClaim.
    await slowBuild(h, id, false, `abandon ${round}`);
    await until(h, Number((await h.sendState(id)).dispatch?.next_attempt_at));
  }
  assert.deepEqual(await consume(h, id), { ack: true, step: 'not_now' }, 'held: no sixth call');
  const state = await h.sendState(id);
  assert.ok(state.dispatch?.held_at, 'held after five unfinished authorized attempts, whatever abandons sat between them');
  assert.equal((await calls(h)).length, 5);
}));

test('a gate delay never resets the crash streak either: authorized expiries alternating with quota waits hold the send after five', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'gate-streak');
  for (let round = 0; round < 5; round++) {
    await crashAt(h, 'before:recordResult');
    const lost = await consume(h, id);
    assert.equal(step(lost), 'crashed:store_failed', `round ${round}`);
    await until(h, await leaseOf(h, id, lost) + SKEW);
    if (round === 4) break;
    // Our own gate is closed: delaySend('gate') before any send() under the new fence.
    await h.quota('setExhausted', true);
    assert.equal(step(await consume(h, id)), 'delayed', `gate ${round}`);
    await h.quota('setExhausted', false);
    await nextDay(h);
    await until(h, Number((await h.sendState(id)).dispatch?.delayed_until));
  }
  assert.deepEqual(await consume(h, id), { ack: true, step: 'not_now' }, 'held: no sixth call');
  assert.ok((await h.sendState(id)).dispatch?.held_at, 'held after five unfinished authorized attempts, whatever gate waits sat between them');
  assert.equal((await calls(h)).length, 5);
}));

test('the send() request is built with the send\'s frozen builder version, not the current one', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'frozen-builder');
  await h.sends.bumpBuilder();
  assert.equal(step(await consume(h, id)), 'recorded');
  assert.deepEqual(await h.sends.requests(), [1], 'the request used version 1, as the sent copy did');
}));

test('a stale request answer abandons the claim at once: the recipients go back to pending and the fence\'s charge is released', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'stale-request');
  const { draft } = JSON.parse((await h.sends.row(id))!.record) as { draft: { rawKey: string } };
  const read = h.pauseNextGet(new RegExp(`/${draft.rawKey}$`));
  const run = consume(h, id);
  await Promise.race([read.started, run.then(outcome => assert.fail(`no request was built: ${JSON.stringify(outcome)}`))]);
  try { await until(h, (await h.sendState(id)).fences.at(-1)!.lease_until); }
  finally { read.release(); }
  const outcome = await run;
  assert.deepEqual(outcome, { ack: true, step: 'abandoned', fence: fenceOf(outcome), cause: 'request_stale' });
  const state = await h.sendState(id);
  assert.deepEqual(ledgerOf(state), ['pending'], 'pending now, not at the lease expiry');
  assert.equal(state.fences.at(-1)?.outcome, 'abandoned');
  assert.equal(state.dispatch?.lease_epoch, null, 'the lease ended');
  const fence = fenceOf(outcome);
  assert.equal((await h.quota<{ sendId: string; epoch: number; attempt: number }[]>('balances'))
    .filter(row => row.sendId === id && row.epoch === fence.epoch && row.attempt === fence.attempt).length, 0, 'the charge is released');
}));

test('a stored acceptance the mailbox answers stale is kept and flagged on replay; one whose send is gone is deleted as an orphan', () => withConsumer(async (h, mail, from) => {
  // Stale: an authorization the mailbox never recorded, so the real recordResult refuses the acceptance.
  const staleId = await queued(h, mail, from, 'stale-acceptance');
  await h.consumer('forgeNextAuthorization');
  const stale = await consume(h, staleId);
  assert.equal(step(stale), 'stored', 'a stale acceptance is stored, never dropped');
  assert.deepEqual((await calls(h)).map(call => call.granted), [false], 'the one forged grant, which the harness check expects');
  const staleFence = fenceOf(stale);
  const replay = await h.sendRpc<{ status: string; recorded: number }>('recordStoredResults', staleId, staleFence);
  assert.deepEqual({ status: replay.status, recorded: replay.recorded }, { status: 'retry', recorded: 0 }, 'not recorded: the row backs off');
  assert.deepEqual(await h.directoryRows('SELECT kind, unapplied FROM send_results WHERE send_id = ?', staleId), [{ kind: 'accepted', unapplied: 1 }],
    'kept and flagged');
  assert.ok(logged(h, 'send_result_unapplied').length >= 1, 'and alerted');

  // Gone: the stored row names a send the ready mailbox no longer has.
  const goneId = await queued(h, mail, from, 'gone-acceptance', { to: [{ email: 'second@example.net' }] });
  await h.consumer('answerNextRecord', 'gone');
  const gone = await consume(h, goneId);
  assert.equal(step(gone), 'stored');
  const goneFence = fenceOf(gone);
  const missing = '01KBN8ZJ7G0000000000000000';
  await h.directoryChange('UPDATE send_results SET send_id = ? WHERE send_id = ?', missing, goneId);
  assert.deepEqual(await h.sendRpc('recordStoredResults', missing, goneFence), { status: 'recorded', recorded: 1 });
  assert.deepEqual(await h.directoryRows('SELECT 1 FROM send_results WHERE send_id = ?', missing), [], 'deleted');
  assert.equal(logged(h, 'send_result_orphan').length, 1, 'and counted as an orphan');
}, { forged: 1 }));

test('the provider\'s daily-limit answer to a call ends the crash streak', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'daily-streak');
  // An unreported marked expiry: the consumer dies after Mark.
  await crashAt(h, 'after:markSend');
  const crashed = await consume(h, id);
  await until(h, await leaseOf(h, id, crashed) + SKEW);
  await script(h, { result: 'reject', code: 'E_DAILY_LIMIT_EXCEEDED' });
  await pauseAt(h, 'after:authorizeDispatch');
  const next = consume(h, id);
  await pausedAt(h, 'after:authorizeDispatch');
  assert.equal((await h.sendState(id)).dispatch?.unfinished, 1, 'the claim counted the unreported expiry');
  await resumeAt(h, 'after:authorizeDispatch');
  assert.equal(step(await next), 'delayed');
  assert.equal((await h.sendState(id)).dispatch?.unfinished, 0, 'delaySend(provider_daily) after a call resets the streak');
}));

const realQuota = { realQuota: {}, startedAt: Date.parse('2026-11-17T12:00:00Z') };
const quotaBalances = (h: Fixture) => h.quota<{ mb: string; sendId: string; attempt: number; day: string; charges: number }[]>('balances');
const chargeFor = async (h: Fixture, id: string, attempt: number) =>
  (await quotaBalances(h)).filter(row => row.sendId === id && row.attempt === attempt).reduce((sum, row) => sum + row.charges, 0);
const afterLease = async (h: Fixture, id: string, o: Outcome) => until(h, await leaseOf(h, id, o) + SKEW);

test('real quota: dispatch at the reset releases the old charge and dispatches in the new day', () => withConsumer(async (h, mail, from) => {
  const reset = Date.parse('2026-11-17T15:00:00Z');
  const id = await queued(h, mail, from, 'quota-reset');
  await h.pauseSenderCheck('after');
  const old = consume(h, id);
  // If the attempt does not reach the directory, show its outcome rather than hanging.
  await Promise.race([h.senderCheckPaused(), old.then(outcome => assert.fail(`Authorization never reached the directory: ${step(outcome)}`))]);
  assert.equal((await quotaBalances(h))[0]?.day, '2026-11-16');
  await h.advance(reset + second - await h.sends.now(), 'clock-only');
  await h.resumeSenderCheck();
  const delayed = await old;
  assert.equal(step(delayed), 'abandoned');
  assert.equal('cause' in delayed && delayed.cause, 'quota_window');
  assert.equal(await chargeFor(h, id, fenceOf(delayed).attempt), 0);
  assert.deepEqual(await calls(h), []);
  // abandonClaim clamps retryAfter to at least one minute from now.
  const retryAt = reset + second + minute;
  assert.equal((await h.sendState(id)).dispatch?.next_attempt_at, retryAt);
  await until(h, retryAt);
  const next = await consume(h, id);
  assert.equal(step(next), 'recorded');
  assert.deepEqual(await h.consumer('authorizationCalls'), [fenceOf(delayed), fenceOf(next)], 'only one authorizeDispatch per fence');
  const [call] = await calls(h);
  assert.ok(call.authClock >= reset, 'the EMAIL call started in the charged quota day');
  assert.deepEqual((await quotaBalances(h)).map(({ day, charges }) => ({ day, charges })), [{ day: '2026-11-17', charges: 1 }]);
}, { ...realQuota, startedAt: Date.parse('2026-11-17T14:58:00Z') }));

test('real quota: a kept charge does not stall the retry', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'quota-kept');
  await script(h, { result: 'reject' });
  const first = await consume(h, id);
  assert.equal(step(first), 'recorded');
  await until(h, Number((await h.sendState(id)).dispatch?.next_attempt_at));
  const retry = await consume(h, id);
  assert.equal(step(retry), 'recorded');
  assert.equal(await chargeFor(h, id, fenceOf(first).attempt), 1);
  assert.equal(await chargeFor(h, id, fenceOf(retry).attempt), 1);
  assert.equal((await calls(h)).length, 2);
}, realQuota));

test('real quota: finish drains a crashed consumer release list and preserves a kept charge', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'quota-finish');
  await script(h, { result: 'reject' });
  const a = await consume(h, id);
  assert.equal(step(a), 'recorded');
  await until(h, Number((await h.sendState(id)).dispatch?.next_attempt_at));
  await crashAt(h, 'after:confirm');
  const b = await consume(h, id);
  assert.equal(await chargeFor(h, id, fenceOf(b).attempt), 1);
  await afterLease(h, id, b);
  await crashAt(h, 'before:reserve');
  const c = await consume(h, id);
  assert.deepEqual((await h.sendState(id)).release, [fenceOf(b)]);
  await afterLease(h, id, c);
  await changeOwner(h);
  assert.equal(step(await consume(h, id)), 'refused');
  await h.advance(minute);
  assert.deepEqual((await finished(h, id)).release, []);
  assert.equal(await chargeFor(h, id, fenceOf(a).attempt), 1);
  assert.equal(await chargeFor(h, id, fenceOf(b).attempt), 0);
}, realQuota));

for (const fault of ['reserve', 'markSend'] as const) {
  test(`real quota: ${fault} failing for 30 minutes leaves pending recipients, no cap or leak`, () => withConsumer(async (h, mail, from) => {
    const id = await queued(h, mail, from, `quota-failed-${fault}`);
    for (let elapsed = 0; elapsed < 30; elapsed++) {
      if (fault === 'reserve') await h.quota('failNext', fault);
      else await h.consumer('failNext', fault);
      assert.equal(step(await consume(h, id)), 'abandoned');
      const state = await h.sendState(id);
      assert.deepEqual(ledgerOf(state), ['pending']);
      assert.equal(state.dispatch?.unfinished, 0);
      assert.equal(state.dispatch?.provider_wait, 0);
      assert.deepEqual(await quotaBalances(h), []);
      await h.advance(minute);
    }
    assert.equal((await calls(h)).length, 0);
    assert.equal(step(await consume(h, id)), 'recorded');
    assert.deepEqual(ledgerOf(await h.sendState(id)), ['sent']);
  }, realQuota));
}

for (const crashMiddle of [false, true]) {
  test(`real quota: a confirmation stalled past its lease${crashMiddle ? ' with the next consumer crashing before reserve' : ''} leaves one charge`, () => withConsumer(async (h, mail, from) => {
    const id = await queued(h, mail, from, `quota-stalled-${crashMiddle}`, THREE);
    await pauseAt(h, 'after:confirm');
    const old = consume(h, id);
    await Promise.race([pausedAt(h, 'after:confirm'), old.then(outcome => assert.fail(`Confirmation did not finish: ${step(outcome)}`))]);
    const first = (await h.sendState(id)).fences[0];
    await until(h, first.lease_until + SKEW);
    // Commit another claim while A is still paused. If A resumed first, its
    // own abandon would release the charge and the successor would not test the release list.
    if (crashMiddle) await crashAt(h, 'before:reserve');
    else await pauseAt(h, 'before:reserve');
    const successor = consume(h, id);
    const crashed = crashMiddle ? await successor : undefined;
    if (crashed) assert.ok('crashed' in crashed);
    else await Promise.race([pausedAt(h, 'before:reserve'), successor.then(outcome => assert.fail(`Successor did not claim: ${step(outcome)}`))]);
    await resumeAt(h, 'after:confirm');
    const abandoned = await old;
    assert.equal('cause' in abandoned && abandoned.cause, 'request_stale', 'the request check stops the old consumer before authorization');
    assert.deepEqual(await h.sendRpc('authorizeDispatch', id, fenceOf(abandoned), [0, 1, 2], await h.quota('resetAt')),
      { status: 'stale' }, 'the mailbox separately refuses authorization under the expired lease');
    assert.deepEqual(await calls(h), []);
    assert.equal(await chargeFor(h, id, first.attempt), 3);
    if (crashed) await afterLease(h, id, crashed);
    else await resumeAt(h, 'before:reserve');
    const next = await (crashed ? consume(h, id) : successor);
    assert.equal(step(next), 'recorded');
    assert.deepEqual((await quotaBalances(h)).map(({ attempt, charges }) => ({ attempt, charges })),
      [{ attempt: fenceOf(next).attempt, charges: 3 }]);
    assert.deepEqual(Object.values(perRecipient(await calls(h))), [1, 1, 1]);
    await h.advance(24 * hour);
    assert.deepEqual(await h.quota('reserve', scope(id), { attempt: first.attempt, epoch: first.epoch }, [0, 1, 2], [], await h.sends.now() + minute),
      { status: 'stale' }, 'released older fence cannot reappear tomorrow');
  }, realQuota));
}

test('real quota: refusals release immediately or through the durable release list', () => withConsumer(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'quota-provider-refusal');
  await script(h, { result: 'reject', code: 'E_RATE_LIMIT_EXCEEDED' }, { result: 'reject', code: 'E_EMAIL_SENDING_NOT_READY' });
  const a = await consume(h, id);
  assert.equal(step(a), 'recorded');
  assert.equal(await chargeFor(h, id, fenceOf(a).attempt), 0);
  await h.advance(minute);
  await h.quota('failNext', 'release');
  const b = await consume(h, id);
  assert.equal(step(b), 'recorded');
  assert.equal(await chargeFor(h, id, fenceOf(b).attempt), 1);
  assert.deepEqual((await h.sendState(id)).release, [fenceOf(b)]);
  await h.advance(2 * minute);
  assert.equal(step(await consume(h, id)), 'recorded');
  assert.equal(await chargeFor(h, id, fenceOf(b).attempt), 0);
  assert.deepEqual((await h.sendState(id)).release, []);
}, realQuota));

test('real quota: two mailboxes with the same sendId and recipient have independent charges and fences', () => withConsumer(async (h, mail, from) => {
  const other = h.as('other');
  const { mailbox } = await other.getSession();
  assert.ok(mailbox);
  const make = async (client: MailService, address: string) => {
    const draft = await client.createDraft(draftInput(address), key('collision-draft'));
    return (await client.sendDraft(draft.id, { ...key('collision-send'), ifMatch: draft.revision })).id;
  };
  const id = await make(mail, from);
  assert.equal(await make(other, mailbox.primaryAddress), id);
  await h.advance(UNDO, 'all-mailboxes');
  const otherMessage = { ...dispatch(id), mb: 'mailbox-b' };
  assert.equal((await h.sendState(id, otherMessage.mb)).row?.state, 'queued');
  await script(h, { result: 'reject', code: 'E_EMAIL_SENDING_NOT_READY' }, { result: 'accept' });
  await pauseAt(h, 'after:confirm');
  const otherRun = h.consumer<Outcome>('consume', otherMessage);
  await Promise.race([pausedAt(h, 'after:confirm'), otherRun.then(outcome => assert.fail(`Other mailbox did not confirm: ${step(outcome)}`))]);
  const a = await consume(h, id);
  assert.equal(step(a), 'recorded');
  assert.deepEqual((await quotaBalances(h)).map(({ mb, sendId, charges }) => ({ mb, sendId, charges })),
    [{ mb: otherMessage.mb, sendId: id, charges: 1 }], 'the first complete refusal did not release the other mailbox');
  await resumeAt(h, 'after:confirm');
  const b = await otherRun;
  assert.equal(step(b), 'recorded');
  assert.deepEqual(fenceOf(a), fenceOf(b), 'both mailboxes started with the same fence');
  assert.deepEqual(await h.quota('reserve', scope(id), fenceOf(a), [0], [], await h.sends.now() + minute), { status: 'stale' });
  assert.equal((await h.sendState(id, otherMessage.mb)).row?.state, 'sent');
  assert.deepEqual((await calls(h)).map(({ mb, to }) => ({ mb, to })),
    [MB, otherMessage.mb].map(mb => ({ mb, to: ['friend@example.net'] })));
}, { ...realQuota, fixedSendId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }));
