import assert from 'node:assert/strict';
import test from 'node:test';
import type { MailService } from '../../../contracts/mail-api/src/index.ts';
import type { DraftInput } from '../../../contracts/mail-api/src/wire.ts';
import type {
  AbandonAnswer, AuthorizeAnswer, ClaimAnswer, DelayAnswer, MarkAnswer, ProviderResult, ReportAnswer, StoredAnswer,
} from '../src/mailbox-send-dispatch.ts';
import type { QuotaAnswer, SendFence } from '../src/mailbox-send-quota.ts';
import { startMailHttpFixture, type SendStateView } from './fixtures/mail-http.ts';

// The mailbox side of the send consumer (docs/m3-outbound-plan.md, section
// 2.4, consumer steps 1 to 7, the finish rule and the deadline; M3-5a),
// against the real Mailbox object in local workerd. A scripted caller drives
// the RPCs in place of the consumer, with a recording fake quota object.
type Fixture = Awaited<ReturnType<typeof startMailHttpFixture>>;
const second = 1000, minute = 60 * second, hour = 60 * minute;
const UNDO = 10 * second;
const LEASE = 5 * minute;
const SKEW = 30 * second;
const WS = 'w1', MB = 'mailbox-a';
// A quota day that ends far from now, for calls that do not test the reset.
const DAY_END = 8.64e15;
const key = (idempotencyKey: string) => ({ idempotencyKey });
const draftInput = (from: string, patch: Partial<DraftInput> = {}): DraftInput => ({
  from, to: [{ email: 'friend@example.net' }], cc: [], bcc: [], subject: 'Hello', body: 'Body text', attachments: [], ...patch,
});
const TWO = { to: [{ email: 'friend@example.net' }, { email: 'second@example.net' }] };

async function withSend(run: (h: Fixture, mail: MailService, from: string) => Promise<void>) {
  const fixture = await startMailHttpFixture({ send: true });
  try {
    const mail = fixture.as('member');
    const { mailbox } = await mail.getSession();
    assert.ok(mailbox);
    await run(fixture, mail, mailbox.primaryAddress);
  } finally { await fixture.close(); }
}

// A send released and enqueued: its release commit is published.
async function queued(h: Fixture, mail: MailService, from: string, token: string, patch: Partial<DraftInput> = {}): Promise<string> {
  const draft = await mail.createDraft(draftInput(from, patch), key(`draft-${token}`));
  const sent = await mail.sendDraft(draft.id, { ...key(`send-${token}`), ifMatch: draft.revision });
  await h.advance(UNDO);
  assert.equal((await h.sendState(sent.id)).row?.state, 'queued');
  return sent.id;
}

const scope = (sendId: string) => ({ workspaceId: WS, mailboxId: MB, sendId });

// The scripted caller: one consumer attempt, stopping after the named step.
type Attempt = { claim: Extract<ClaimAnswer, { status: 'claimed' }>; mark?: MarkAnswer; auth?: AuthorizeAnswer; record?: ReportAnswer };
async function attempt(h: Fixture, id: string, options: { stop?: 'claim' | 'mark' | 'authorize'; result?: ProviderResult; mark?: number[] } = {}): Promise<Attempt> {
  const claim = await h.sendRpc<ClaimAnswer>('claimSend', id);
  assert.equal(claim.status, 'claimed', `expected a claim, got ${JSON.stringify(claim)}`);
  if (claim.status !== 'claimed') throw new Error('unreachable');
  const recipients = options.mark ?? claim.recipients.map(({ idx }) => idx);
  const reserved = await h.quota<QuotaAnswer>('reserve', scope(id), claim.fence, recipients, claim.release, claim.leaseUntil + 2 * minute);
  assert.equal(reserved.status, 'ok');
  if (options.stop === 'claim') return { claim };
  const mark = await h.sendRpc<MarkAnswer>('markSend', id, claim.fence, recipients, claim.release);
  assert.deepEqual(mark, { status: 'ok' });
  if (options.stop === 'mark') return { claim, mark };
  const confirmed = await h.quota<QuotaAnswer>('confirm', scope(id), claim.fence, recipients);
  assert.equal(confirmed.status, 'ok');
  const auth = await h.sendRpc<AuthorizeAnswer>('authorizeDispatch', id, claim.fence, recipients, confirmed.status === 'ok' ? confirmed.dayEnd : 0);
  assert.deepEqual(auth, { status: 'ok', remainingMs: 10 * second });
  if (options.stop === 'authorize' || !options.result) return { claim, mark, auth };
  const record = await h.sendRpc<ReportAnswer>('recordResult', id, claim.fence, options.result);
  return { claim, mark, auth, record };
}

// The stored consumer state without the journal positions, which background publishes may move.
const core = ({ flushed: _flushed, ...state }: SendStateView) => state;
const ledgerOf = (state: SendStateView) => state.ledger.map(({ state: s, reason }) => reason ? `${s}:${reason}` : s);
const balanceOf = async (h: Fixture, fence: SendFence) =>
  (await h.quota<{ epoch: number; attempt: number; charges: number }[]>('balances'))
    .filter(row => row.epoch === fence.epoch && row.attempt === fence.attempt).reduce((sum, row) => sum + row.charges, 0);
const releaseCalls = async (h: Fixture) => (await h.quota<{ method: string }[]>('calls')).filter(({ method }) => method === 'release').length;
const changeOwner = (h: Fixture) => h.directoryChange("UPDATE mailboxes SET user_id = 'new-admin' WHERE workspace_id = ? AND id = ?", WS, MB);
const finished = async (h: Fixture, id: string) => {
  const state = await h.sendState(id);
  assert.equal(state.row?.finish_pending, 0, 'cleanup finished');
  assert.deepEqual(state.drive, [], 'no drive row');
  assert.equal((await h.sends.registration(id))?.released, 'raw', 'the send raw holder is released');
  return state;
};
const storeResult = (h: Fixture, id: string, fence: SendFence, kind: string, extra: { messageId?: string; detail?: string } = {}) =>
  h.directoryChange(`INSERT INTO send_results (workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt, kind, message_id, detail,
    created_at, notify_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`, WS, MB, id, fence.epoch, fence.attempt, kind, extra.messageId ?? null,
  extra.detail ?? null);
const storedRows = (h: Fixture, id: string) => h.directoryRows('SELECT fence_epoch, fence_attempt, notify_after, notify_failures FROM send_results WHERE send_id = ?', id);

test('a stale fence: abandonClaim, delaySend, Mark and failure, retry or ambiguous results change nothing; a confirmed sent is kept', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'stale');
  const a = await attempt(h, id, { stop: 'authorize' });
  await h.advance(LEASE + SKEW);
  const b = await attempt(h, id, { stop: 'mark' });
  assert.ok(b.claim.fence.attempt > a.claim.fence.attempt);
  const before = core(await h.sendState(id));
  const releasesBefore = await releaseCalls(h);
  assert.deepEqual(await h.sendRpc<AbandonAnswer>('abandonClaim', id, a.claim.fence, (await h.sends.now()) + minute), { status: 'stale' });
  assert.deepEqual(await h.sendRpc<DelayAnswer>('delaySend', id, a.claim.fence, 'gate', await h.quota<number>('resetAt')), { status: 'stale' });
  assert.deepEqual(await h.sendRpc<MarkAnswer>('markSend', id, a.claim.fence, [0], []), { status: 'stale' });
  for (const result of [{ kind: 'rejected', reason: 'rejected' }, { kind: 'try_later' }, { kind: 'ambiguous' }, { kind: 'outage', code: 'E_ACCOUNT_SUSPENDED' }] as ProviderResult[]) {
    assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, a.claim.fence, result), { status: 'stale' }, result.kind);
  }
  assert.deepEqual(core(await h.sendState(id)), before, 'the stale fence changed no recipient, lease, fence, release entry or timer');
  assert.equal(await releaseCalls(h), releasesBefore, 'and released no reservation');
  // A confirmed provider fact from the authorized stale fence is kept.
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, a.claim.fence, { kind: 'accepted', messageId: 'provider-a' }), { status: 'recorded' });
  const after = await h.sendState(id);
  assert.deepEqual(ledgerOf(after), ['sent']);
  assert.equal(after.row?.state, 'sent');
  assert.equal(after.dispatch?.lease_epoch, null, 'finish step 1 ended the newer lease');
  assert.deepEqual(after.marks.filter(mark => mark.attempt === a.claim.fence.attempt).map(mark => mark.provider_id), ['provider-a']);
}));

test('a fence that was never authorized cannot record even a confirmed result, current or stale', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'unauthorized');
  const a = await attempt(h, id, { stop: 'mark' });
  await h.advance(LEASE + SKEW);
  const b = await attempt(h, id, { stop: 'mark' });
  const before = core(await h.sendState(id));
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, a.claim.fence, { kind: 'accepted', messageId: null }), { status: 'stale' });
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, b.claim.fence, { kind: 'accepted', messageId: null }), { status: 'stale' });
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, b.claim.fence, { kind: 'rejected', reason: 'rejected' }), { status: 'stale' });
  assert.deepEqual(core(await h.sendState(id)), before);
}));

test('a terminal or cancelled send is stale for every fence and never gets a drive row back', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'terminal');
  const a = await attempt(h, id, { stop: 'authorize' });
  await h.advance(LEASE + SKEW);
  // Fence B holds a live, marked lease when fence A's confirmed result finishes the send.
  const b = await attempt(h, id, { stop: 'mark' });
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, a.claim.fence, { kind: 'accepted', messageId: 'a' }), { status: 'recorded' });
  const ended = await h.sendState(id);
  assert.equal(ended.row?.state, 'sent');
  const now = await h.sends.now();
  const staleEverywhere = async (fence: SendFence) => {
    assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'refused' });
    assert.deepEqual(await h.sendRpc<MarkAnswer>('markSend', id, fence, [0], []), { status: 'stale' });
    assert.deepEqual(await h.sendRpc<AuthorizeAnswer>('authorizeDispatch', id, fence, [0], DAY_END), { status: 'stale' });
    assert.deepEqual(await h.sendRpc<AbandonAnswer>('abandonClaim', id, fence, now + minute), { status: 'stale' });
    assert.deepEqual(await h.sendRpc<DelayAnswer>('delaySend', id, fence, 'gate', await h.quota<number>('resetAt')), { status: 'stale' });
    for (const result of [{ kind: 'rejected', reason: 'rejected' }, { kind: 'try_later' }, { kind: 'ambiguous' }] as ProviderResult[]) {
      assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, fence, result), { status: 'stale' }, result.kind);
    }
  };
  await staleEverywhere(b.claim.fence);
  assert.deepEqual(core(await h.sendState(id)), core(ended), 'no recipient, lease, fence, release entry or timer changed');
  await h.advance(minute);
  const done = await finished(h, id);
  await staleEverywhere(b.claim.fence);
  await staleEverywhere({ epoch: b.claim.fence.epoch, attempt: b.claim.fence.attempt + 1 });
  assert.deepEqual(core(await h.sendState(id)), core(done), 'and after cleanup no drive row comes back');

  const cancelled = await mail.createDraft(draftInput(from), key('draft-cancel'));
  const pending = await mail.sendDraft(cancelled.id, { ...key('send-cancel'), ifMatch: cancelled.revision });
  await mail.undoSend(pending.id, key('undo'));
  await h.advance(UNDO);
  const fresh = { epoch: 0, attempt: 1 };
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', pending.id), { status: 'refused' });
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', pending.id, fresh, { kind: 'accepted', messageId: null }), { status: 'stale' });
  assert.deepEqual(await h.sendRpc<AbandonAnswer>('abandonClaim', pending.id, fresh, now), { status: 'stale' });
  assert.deepEqual((await h.sendState(pending.id)).drive, []);
}));

test('the claim refuses until next_attempt_at and delayedUntil', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'gates');
  const a = await attempt(h, id, { result: { kind: 'ambiguous', code: 'E_INTERNAL_SERVER_ERROR' } });
  assert.deepEqual(a.record, { status: 'recorded' });
  const next = Number((await h.sendState(id)).dispatch?.next_attempt_at);
  assert.equal(next - await h.sends.now(), 30 * minute, 'an ambiguous result waits at least 30 minutes');
  await h.advance(30 * minute - second);
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'not_now', reason: 'backoff' });
  assert.deepEqual((await h.sendState(id)).drive, [next]);
  await h.advance(second);
  const b = await attempt(h, id, { stop: 'mark' });
  await h.quota('setExhausted', true);
  const delayed = await h.sendRpc<DelayAnswer>('delaySend', id, b.claim.fence, 'gate', await h.quota<number>('resetAt'));
  assert.equal(delayed.status, 'delayed');
  const until = delayed.status === 'delayed' ? delayed.until : 0;
  const reset = await h.quota<number>('resetAt');
  assert.equal(until, reset + SKEW, 'the mailbox computes the reset plus clockSkew');
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['pending']);
  assert.equal((await mail.getSend(id)).state, 'delayed');
  assert.equal((await mail.getSend(id)).delayedUntil, new Date(until).toISOString());
  await h.quota('setExhausted', false);
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'not_now', reason: 'delayed' });
  await h.advance(until - await h.sends.now() - second);
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'not_now', reason: 'delayed' });
  await h.advance(second);
  await attempt(h, id, { stop: 'claim' });
}));

test('exactly one drive row, at the lease expiry, after a claim races the enqueue', () => withSend(async (h, mail, from) => {
  const draft = await mail.createDraft(draftInput(from), key('draft'));
  const sent = await mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision });
  await h.pauseNextEnqueue();
  const advanced = h.advance(UNDO);
  await h.enqueuePaused();
  const claim = await h.sendRpc<ClaimAnswer>('claimSend', sent.id);
  assert.equal(claim.status, 'claimed');
  await h.resumeEnqueue();
  await advanced;
  await h.sends.driveIdle();
  assert.equal((await h.sends.queue()).length, 1);
  const leaseUntil = claim.status === 'claimed' ? claim.leaseUntil : 0;
  assert.deepEqual((await h.timers()).filter(({ kind }) => kind === 'send_drive').map(({ ref, due_at }) => [ref, due_at]),
    [[sent.id, leaseUntil + SKEW]]);
}));

test('exactly one drive row after a quota wait, and the claim refuses before delayedUntil', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'wait');
  const claim = await h.sendRpc<ClaimAnswer>('claimSend', id);
  assert.equal(claim.status, 'claimed');
  if (claim.status !== 'claimed') return;
  await h.quota('setExhausted', true);
  assert.equal((await h.quota<QuotaAnswer>('reserve', scope(id), claim.fence, [0], claim.release, 0)).status, 'exhausted');
  const delayed = await h.sendRpc<DelayAnswer>('delaySend', id, claim.fence, 'gate', await h.quota<number>('resetAt'));
  assert.equal(delayed.status, 'delayed');
  const until = delayed.status === 'delayed' ? delayed.until : 0;
  const drives = async () => (await h.timers()).filter(({ kind }) => kind === 'send_drive').map(({ ref, due_at }) => [ref, due_at]);
  assert.deepEqual(await drives(), [[id, until]]);
  await h.quota('setExhausted', false);
  await h.advance(until - await h.sends.now() - minute);
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'not_now', reason: 'delayed' });
  assert.deepEqual(await drives(), [[id, until]]);
  await h.advance(minute);
  assert.equal((await h.sendState(id)).row?.state, 'queued', 'the drive row ended the wait');
  assert.equal((await h.sends.queue()).length, 2, 'and enqueued once more');
  assert.equal((await drives()).length, 1);
  const next = await attempt(h, id, { stop: 'claim' });
  assert.deepEqual(await drives(), [[id, next.claim.leaseUntil + SKEW]]);
  assert.equal(await balanceOf(h, claim.fence), 0, 'the waiting fence holds no charge');
}));

test('the 72-hour deadline counts only provider wait: delayed time and outage results never count', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'deadline');
  const far = async (name: string) => h.quota('setDay', name, await h.sends.now() + 30 * 24 * hour);
  await far('far');
  let counted = 0;
  const elapsedStart = await h.sends.now();
  for (let round = 0; ; round++) {
    // Every eighth round: a quota wait of a day and an outage of our own, neither counted.
    if (round % 8 === 7) {
      await h.quota('setDay', `day-${round}`, await h.sends.now() + 6 * hour);
      const b = await attempt(h, id, { stop: 'mark' });
      const delayed = await h.sendRpc<DelayAnswer>('delaySend', id, b.claim.fence, 'gate', await h.quota<number>('resetAt'));
      assert.equal(delayed.status, 'delayed');
      await h.advance((delayed.status === 'delayed' ? delayed.until : 0) - await h.sends.now());
      await far(`far-${round}`);
      const outage = await attempt(h, id, { result: { kind: 'outage', code: 'E_SENDER_NOT_VERIFIED' } });
      assert.deepEqual(outage.record, { status: 'recorded' });
      assert.equal(Number((await h.sendState(id)).dispatch?.provider_wait), counted, 'neither the wait nor the outage counted');
      await h.advance(Number((await h.sendState(id)).dispatch?.next_attempt_at) - await h.sends.now());
    }
    const at = await h.sends.now();
    const a = await attempt(h, id, { result: { kind: 'try_later' } });
    assert.deepEqual(a.record, { status: 'recorded' });
    const state = await h.sendState(id);
    if (state.row?.state === 'failed') {
      assert.ok(counted < 72 * hour && counted + 60 * minute >= 72 * hour, 'it ended at the first report that reached 72 hours');
      assert.deepEqual(ledgerOf(state), ['failed:delivery_error']);
      assert.ok(await h.sends.now() - elapsedStart > 72 * hour + 24 * hour, 'more than 72 hours passed in total');
      break;
    }
    const next = Number(state.dispatch?.next_attempt_at);
    counted += next - at;
    assert.equal(Number(state.dispatch?.provider_wait), counted);
    assert.ok(round < 120, 'the deadline must end the send');
    await h.advance(next - at);
  }
  await h.advance(minute);
  await finished(h, id);
}));

test('grace transition: an owner change ends unprotected recipients now and holds a protected one for a lease period', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'grace', TWO);
  // Recipient 0 is attempting under an authorized fence that a restore leaves from an older epoch.
  await attempt(h, id, { stop: 'authorize', mark: [0] });
  await h.restore();
  await changeOwner(h);
  const restored = await h.sendState(id);
  assert.deepEqual(ledgerOf(restored), ['attempting', 'pending']);
  const fenceLease = restored.fences[0].lease_until;
  await h.advance(Math.max(0, fenceLease + SKEW - await h.sends.now()));
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'refused' });
  const held = await h.sendState(id);
  assert.deepEqual(ledgerOf(held), ['attempting', 'failed:invalid_sender'], 'the protected recipient is held; the other ends now');
  const life = await h.sends.lifecycle();
  const holdUntil = Math.max(fenceLease + SKEW, Number(life?.restoredAt)) + LEASE;
  assert.equal(held.dispatch?.grace_until, holdUntil);
  assert.deepEqual(held.drive, [holdUntil]);
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'not_now', reason: 'grace' });
  await h.advance(holdUntil - await h.sends.now() - second);
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['attempting', 'failed:invalid_sender']);
  await h.advance(second);
  const done = await finished(h, id);
  assert.deepEqual(ledgerOf(done), ['failed:invalid_sender', 'failed:invalid_sender']);
  assert.equal(done.row?.state, 'failed');
}));

test('late confirmation: an owner change during a long restore fails the recipient, and the stored sent result replaces it', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'late-owner');
  const a = await attempt(h, id, { stop: 'authorize' });
  await changeOwner(h);
  const before = await h.sends.now();
  await h.restoreAfter(6 * hour);
  const life = await h.sends.lifecycle();
  const restoredAt = Number(life?.restoredAt);
  assert.equal(restoredAt, before + 6 * hour, 'the restore ended six hours later');
  assert.ok(Number(life?.epoch) > a.claim.fence.epoch, 'the restore raised the recovery epoch');
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'refused' });
  const held = await h.sendState(id);
  assert.equal(held.dispatch?.grace_until, restoredAt + LEASE, 'the hold starts at the end of the restore');
  await h.advance(LEASE);
  const failed = await finished(h, id);
  assert.deepEqual(ledgerOf(failed), ['failed:invalid_sender']);
  const quotaCalls = (await h.quota<unknown[]>('calls')).length;
  await storeResult(h, id, a.claim.fence, 'accepted', { messageId: 'provider-late' });
  assert.deepEqual(await h.sendRpc<StoredAnswer>('recordStoredResults', id), { status: 'recorded', recorded: 1 });
  const late = await h.sendState(id);
  assert.deepEqual(ledgerOf(late), ['sent']);
  assert.equal(late.row?.state, 'sent', 'the send state is recomputed');
  assert.ok(late.flushed.flushed >= late.flushed.modseq, 'and published before the call answered');
  assert.deepEqual(late.drive, [], 'no drive row');
  assert.equal(late.dispatch?.lease_epoch, null, 'no lease');
  assert.equal((await h.quota<unknown[]>('calls')).length, quotaCalls, 'no reservation change');
  assert.deepEqual(await storedRows(h, id), [], 'the stored row is deleted after the publish');
  await h.directoryChange("UPDATE mailboxes SET user_id = 'member' WHERE workspace_id = ? AND id = ?", WS, MB);
  assert.equal((await mail.getSend(id)).state, 'sent');
}));

test('late confirmation: delivery_error after the ambiguous cap, and an acceptance after a later rejection', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'late-cap');
  // Fence A's consumer stalls after its authorized call; three later attempts report ambiguous errors.
  const first = await attempt(h, id, { stop: 'authorize' });
  await h.advance(LEASE + SKEW);
  for (let round = 0; round < 3; round++) {
    await attempt(h, id, { result: { kind: 'ambiguous' } });
    if (round < 2) await h.advance(30 * minute);
  }
  await h.advance(minute);
  assert.deepEqual(ledgerOf(await finished(h, id)), ['failed:delivery_error']);
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, first.claim.fence, { kind: 'accepted', messageId: 'late' }), { status: 'recorded' });
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['sent']);
  assert.equal((await mail.getSend(id)).state, 'sent');

  const other = await queued(h, mail, from, 'late-reject');
  const a = await attempt(h, other, { stop: 'authorize' });
  await h.advance(LEASE + SKEW);
  await attempt(h, other, { result: { kind: 'rejected', reason: 'rejected' } });
  await h.advance(minute);
  assert.deepEqual(ledgerOf(await finished(h, other)), ['failed:rejected']);
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', other, a.claim.fence, { kind: 'accepted', messageId: null }), { status: 'recorded' });
  assert.deepEqual(ledgerOf(await h.sendState(other)), ['sent'], 'the earlier attempt reached the provider');
  assert.deepEqual((await h.sendState(other)).drive, []);
}));

test('late confirmation: a fence whose Mark set did not hold a recipient changes nothing for it', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'late-subset', TWO);
  const a = await attempt(h, id, { stop: 'authorize', mark: [0] });
  await h.advance(LEASE + SKEW);
  await attempt(h, id, { result: { kind: 'rejected', reason: 'rejected' } });
  await h.advance(minute);
  assert.deepEqual(ledgerOf(await finished(h, id)), ['failed:rejected', 'failed:rejected']);
  await h.sendRpc<ReportAnswer>('recordResult', id, a.claim.fence, { kind: 'accepted', messageId: null });
  const state = await h.sendState(id);
  assert.deepEqual(ledgerOf(state), ['sent', 'failed:rejected']);
  assert.equal(state.row?.state, 'partial');
  assert.deepEqual((await mail.getSend(id)).recipients.map(({ state: s }) => s), ['sent', 'failed']);
}));

test('a stored sent result recorded during the post-restore hold replaces invalid_sender before it is reported', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'hold-result');
  const a = await attempt(h, id, { stop: 'authorize' });
  await h.restoreAfter(LEASE + SKEW);
  await changeOwner(h);
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'refused' });
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['attempting']);
  await storeResult(h, id, a.claim.fence, 'accepted', { messageId: 'provider-slow' });
  // The drive row's own lookup records it, without a notice.
  const hold = Number((await h.sendState(id)).dispatch?.grace_until);
  await h.advance(hold - await h.sends.now());
  const done = await finished(h, id);
  assert.deepEqual(ledgerOf(done), ['sent']);
  assert.deepEqual(await storedRows(h, id), []);
}));

test('a publish failure during finish, then recovery: holders are released only after the terminal state is published', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'finish-publish');
  const a = await attempt(h, id, { stop: 'authorize' });
  await h.publishFailure(true);
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, a.claim.fence, { kind: 'accepted', messageId: 'p' }), { status: 'unpublished' });
  await h.advance(minute);
  await h.advance(10 * minute);
  const pending = await h.sendState(id);
  assert.equal(pending.row?.state, 'sent');
  assert.equal(pending.row?.finish_pending, 1);
  assert.equal(pending.drive.length, 1, 'the drive row stays');
  assert.equal((await h.sends.registration(id))?.released, null, 'no holder is released before the publish');
  // A repeat of the same result is acknowledged once published, and changes nothing.
  await h.publishFailure(false);
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, a.claim.fence, { kind: 'accepted', messageId: 'p' }), { status: 'recorded' });
  await h.advance(Math.max(0, pending.drive[0] - await h.sends.now()));
  await finished(h, id);
  assert.equal((await mail.getSend(id)).state, 'sent');
}));

test('every terminal path releases the send\'s holders and deletes its timers', async (t) => {
  const paths: Record<string, (h: Fixture, id: string) => Promise<string[]>> = {
    accepted: async (h, id) => { await attempt(h, id, { result: { kind: 'accepted', messageId: 'm' } }); return ['sent']; },
    suppressed: async (h, id) => { await attempt(h, id, { result: { kind: 'accepted', messageId: null, suppressed: [0] } }); return ['suppressed']; },
    rejected: async (h, id) => { await attempt(h, id, { result: { kind: 'rejected', reason: 'rejected' } }); return ['failed:rejected']; },
    'ambiguous cap': async (h, id) => {
      for (let round = 0; round < 3; round++) {
        await attempt(h, id, { result: { kind: 'ambiguous' } });
        if (round < 2) await h.advance(30 * minute);
      }
      return ['failed:delivery_error'];
    },
    'invalid_sender at the claim': async (h, id) => {
      await changeOwner(h);
      assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'refused' });
      return ['failed:invalid_sender'];
    },
    'invalid_sender at authorization': async (h, id) => {
      const a = await attempt(h, id, { stop: 'mark' });
      await changeOwner(h);
      assert.deepEqual(await h.sendRpc<AuthorizeAnswer>('authorizeDispatch', id, a.claim.fence, [0], DAY_END), { status: 'stale' });
      return ['failed:invalid_sender'];
    },
    'the end of a grace hold': async (h, id) => {
      await attempt(h, id, { stop: 'authorize' });
      await h.restore();
      await changeOwner(h);
      await h.advance(LEASE + SKEW);
      assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'refused' });
      await h.advance(LEASE + SKEW);
      return ['failed:invalid_sender'];
    },
  };
  for (const [name, run] of Object.entries(paths)) {
    await t.test(name, () => withSend(async (h, mail, from) => {
      const id = await queued(h, mail, from, 'path');
      const expected = await run(h, id);
      await h.advance(minute);
      const done = await finished(h, id);
      assert.deepEqual(ledgerOf(done), expected);
      assert.deepEqual(done.release, [], 'finish cleared the release list');
    }));
  }
});

test('invalid_sender at the claim ends the send, and an alias removed while delayed ends it on the next attempt', () => withSend(async (h, mail, primary) => {
  const id = await queued(h, mail, primary, 'claim-owner');
  await changeOwner(h);
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'refused' });
  const failed = await h.sendState(id);
  assert.deepEqual(ledgerOf(failed), ['failed:invalid_sender']);
  assert.equal(failed.row?.state, 'failed');
  assert.equal(failed.dispatch?.attempt, 0, 'no attempt was taken');
  assert.equal((await h.quota<unknown[]>('calls')).length, 0, 'and nothing reserved');
  await h.directoryChange("UPDATE mailboxes SET user_id = 'member' WHERE workspace_id = ? AND id = ?", WS, MB);

  const admin = h.as('admin');
  const { mailbox } = await mail.getSession();
  const alias = (await admin.createAlias({ mailboxId: mailbox!.id, address: 'sales@example.com', sendAs: true }, key('alias'))).address;
  await h.sends.activateAlias(alias);
  const other = await queued(h, mail, alias, 'alias');
  const a = await attempt(h, other, { stop: 'mark' });
  await h.quota('setExhausted', true);
  const delayed = await h.sendRpc<DelayAnswer>('delaySend', other, a.claim.fence, 'gate', await h.quota<number>('resetAt'));
  assert.equal(delayed.status, 'delayed');
  await admin.deleteAlias(alias);
  await h.quota('setExhausted', false);
  await h.advance((delayed.status === 'delayed' ? delayed.until : 0) - await h.sends.now());
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', other), { status: 'refused' });
  assert.deepEqual(ledgerOf(await h.sendState(other)), ['failed:invalid_sender']);
  await h.advance(minute);
  await finished(h, other);
  assert.equal((await mail.getSend(other)).state, 'failed');
}));

test('a try-later or outage result leaves no charge under its fence, also when the immediate release fails once (fake quota, early coverage)', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'refused');
  const a = await attempt(h, id, { result: { kind: 'try_later' } });
  assert.equal(await balanceOf(h, a.claim.fence), 0);
  await h.advance(minute);
  // The immediate release fails: the fence stays on the release list, and the next consumer's quota call drains it.
  await h.quota('failNext', 'release');
  const b = await attempt(h, id, { result: { kind: 'outage', code: 'E_SENDER_DOMAIN_NOT_READY' } });
  assert.equal(await balanceOf(h, b.claim.fence), 1, 'the failed release left the charge');
  // Fence A left the list in B's Mark, after B's reservation released it.
  assert.deepEqual((await h.sendState(id)).release.map(({ attempt: n }) => n), [b.claim.fence.attempt]);
  await h.advance(2 * minute);
  const c = await attempt(h, id, { stop: 'mark' });
  assert.deepEqual(c.claim.release.map(({ attempt: n }) => n), [b.claim.fence.attempt]);
  assert.equal(await balanceOf(h, b.claim.fence), 0, 'the next reservation drained it');
  assert.deepEqual((await h.sendState(id)).release, [], 'and Mark took it off the list');

  // Drained by finish when no consumer comes.
  const other = await queued(h, mail, from, 'refused-finish');
  await h.quota('failNext', 'release');
  const d = await attempt(h, other, { result: { kind: 'try_later' } });
  assert.equal(await balanceOf(h, d.claim.fence), 1);
  await changeOwner(h);
  await h.advance(4 * minute);
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', other), { status: 'refused' });
  await h.advance(minute);
  await finished(h, other);
  assert.equal(await balanceOf(h, d.claim.fence), 0, 'finish released the listed fence');
}));

test('recordStoredResults: point lookup, record per fence, delete after the publish, back off otherwise', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'stored');
  assert.deepEqual(await h.sendRpc<StoredAnswer>('recordStoredResults', id), { status: 'none', recorded: 0 });
  const a = await attempt(h, id, { stop: 'authorize' });
  await storeResult(h, id, a.claim.fence, 'accepted', { messageId: 'stored' });
  await h.publishFailure(true);
  const start = await h.sends.now();
  assert.deepEqual(await h.sendRpc<StoredAnswer>('recordStoredResults', id), { status: 'retry', recorded: 0, next: start + minute });
  assert.deepEqual(await storedRows(h, id), [{ fence_epoch: a.claim.fence.epoch, fence_attempt: a.claim.fence.attempt, notify_after: start + minute, notify_failures: 1 }]);
  await h.advance(minute);
  assert.deepEqual(await h.sendRpc<StoredAnswer>('recordStoredResults', id), { status: 'retry', recorded: 0, next: start + 3 * minute });
  assert.equal((await storedRows(h, id))[0].notify_after, start + 3 * minute, 'the backoff doubles');
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['sent'], 'recorded, not yet published');
  await h.publishFailure(false);
  // The row is next due at its backoff.
  await h.advance(2 * minute);
  assert.deepEqual(await h.sendRpc<StoredAnswer>('recordStoredResults', id), { status: 'recorded', recorded: 1 });
  assert.deepEqual(await storedRows(h, id), []);

  // A row for a send this ready mailbox does not have is dropped.
  await storeResult(h, '01JZZZZZZZZZZZZZZZZZZZZZZZ', { epoch: 0, attempt: 1 }, 'try_later');
  assert.deepEqual(await h.sendRpc<StoredAnswer>('recordStoredResults', '01JZZZZZZZZZZZZZZZZZZZZZZZ'), { status: 'recorded', recorded: 1 });
}));

test('a restoring mailbox answers without recording: the claim waits and a stored result backs off past the restore', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'restoring');
  const a = await attempt(h, id, { stop: 'authorize' });
  await storeResult(h, id, a.claim.fence, 'accepted', { messageId: 'stored' });
  await h.blockLaterDelta(0);
  await h.restore();
  assert.equal((await h.sends.lifecycle())?.state, 'restoring');
  const now = await h.sends.now();
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'not_now', reason: 'restoring' });
  assert.deepEqual(await h.sendRpc<StoredAnswer>('recordStoredResults', id), { status: 'restoring', recorded: 0 });
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, a.claim.fence, { kind: 'try_later' }), { status: 'restoring' });
  const [row] = await storedRows(h, id);
  assert.equal(row.notify_after, now + 5 * minute);
  assert.equal(row.notify_failures, 0);
  await h.blockLaterDelta(Number.MAX_SAFE_INTEGER);
  await h.advance(15 * minute);
  await h.advance(15 * minute);
  assert.equal((await h.sends.lifecycle())?.state, 'ready');
  // The restore epilogue moved the drive row to now; its lookup recorded the result.
  await h.advance(minute);
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['sent']);
  assert.deepEqual(await storedRows(h, id), []);
}));

test('Mark: a failed publish answers stale and returns the recipients to pending', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'mark-publish');
  const claim = await h.sendRpc<ClaimAnswer>('claimSend', id);
  assert.equal(claim.status, 'claimed');
  if (claim.status !== 'claimed') return;
  await h.publishFailure(true);
  assert.deepEqual(await h.sendRpc<MarkAnswer>('markSend', id, claim.fence, [0], []), { status: 'stale' });
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['pending']);
  assert.deepEqual(await h.sendRpc<AuthorizeAnswer>('authorizeDispatch', id, claim.fence, [0], DAY_END), { status: 'stale' });
  await h.publishFailure(false);
  // The next claim, after the lease, lists the never-authorized fence for release.
  await h.advance(LEASE + SKEW);
  const next = await attempt(h, id, { stop: 'claim' });
  assert.deepEqual(next.claim.release, [claim.fence]);
}));

test('authorizeDispatch: once per fence, never in the last seconds of the lease, and quota_window before the reset', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'authorize');
  const a = await attempt(h, id, { stop: 'authorize' });
  assert.deepEqual(await h.sendRpc<AuthorizeAnswer>('authorizeDispatch', id, a.claim.fence, [0], DAY_END), { status: 'stale' }, 'one authorization per fence');
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['attempting'], 'an authorized recipient stays attempting');
  await h.advance(LEASE + SKEW);

  const b = await attempt(h, id, { stop: 'mark' });
  const leaseUntil = Number((await h.sendState(id)).dispatch?.lease_until);
  await h.advance(leaseUntil - await h.sends.now() - 10 * second - SKEW + 1);
  assert.deepEqual(await h.sendRpc<AuthorizeAnswer>('authorizeDispatch', id, b.claim.fence, [0], DAY_END), { status: 'stale' });
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['pending'], 'never authorized: back to pending');
  await h.advance(LEASE);

  const c = await attempt(h, id, { stop: 'mark' });
  const now = await h.sends.now();
  // The charge's quota day ends just inside the window: 10 s plus twice clockSkew.
  const window = await h.sendRpc<AuthorizeAnswer>('authorizeDispatch', id, c.claim.fence, [0], now + 10 * second + 2 * SKEW - 1);
  assert.deepEqual(window, { status: 'quota_window', retryAfter: now + 10 * second + 3 * SKEW - 1 });
  assert.equal((await h.sendState(id)).fences.at(-1)?.authorized, 0, 'no authorization was recorded');
  const retryAt = window.status === 'quota_window' ? window.retryAfter : 0;
  assert.deepEqual(await h.sendRpc<AbandonAnswer>('abandonClaim', id, c.claim.fence, retryAt), { status: 'ok' });
  const state = await h.sendState(id);
  assert.deepEqual(ledgerOf(state), ['pending']);
  assert.equal(state.dispatch?.next_attempt_at, retryAt, 'the next attempt waits for the reset plus clockSkew');
  assert.deepEqual(state.drive, [retryAt]);
  assert.equal(state.dispatch?.lease_epoch, null);
  assert.equal(await balanceOf(h, c.claim.fence), 0, 'the abandoned fence is released');
  await h.advance(retryAt - now);
  const d = await attempt(h, id, { stop: 'claim' });
  const at = await h.sends.now();
  assert.deepEqual(await h.sendRpc<AbandonAnswer>('abandonClaim', id, d.claim.fence, at), { status: 'ok' });
  assert.equal((await h.sendState(id)).dispatch?.next_attempt_at, at + minute, 'abandonClaim clamps its retry to at least a minute');
}));

test('crash-loop cap: five authorized attempts that expire without a report hold the send; it never fails', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'held');
  for (let round = 0; round < 5; round++) {
    await attempt(h, id, { stop: 'authorize' });
    await h.advance(LEASE + SKEW);
  }
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'not_now', reason: 'held' });
  const state = await h.sendState(id);
  assert.deepEqual(ledgerOf(state), ['attempting']);
  assert.equal(state.row?.state, 'sending');
  assert.equal((await mail.getSend(id)).state, 'sending');
  const now = await h.sends.now();
  assert.deepEqual(state.drive, [now + 24 * hour]);
  await h.advance(24 * hour);
  assert.deepEqual((await h.sendState(id)).drive, [now + 48 * hour], 'the drive row moves a day ahead each time');
  assert.ok((await h.sends.activeAlerts()).includes('send_held'));
}));

for (const source of ['deltas', 'a snapshot'] as const) {
  test(`the consumer state survives a restore from ${source}: ledger, fences, Mark sets, release list and counters`, () => withSend(async (h, mail, from) => {
    const id = await queued(h, mail, from, 'survives', TWO);
    await attempt(h, id, { stop: 'authorize', mark: [0] });
    await h.advance(LEASE + SKEW);
    await h.quota('failNext', 'release');
    await attempt(h, id, { result: { kind: 'try_later' } });
    // Every change is published before the restore.
    await h.advance(minute);
    if (source === 'a snapshot') assert.ok(await h.forceSnapshot());
    const before = core(await h.sendState(id));
    await h.restore();
    const after = core(await h.sendState(id));
    assert.deepEqual({ ...after, drive: [] }, { ...before, drive: [] });
    assert.ok(before.fences.length === 2 && before.marks.length === 3 && before.release.length === 1);
    assert.equal(before.dispatch?.refusals, 1);
  }));
}

test('late confirmation per fact: an acceptance stored for fence A after A reported ambiguous and B was rejected upgrades the recipient, also after cleanup', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'per-fact');
  const a = await attempt(h, id, { result: { kind: 'ambiguous', code: 'timeout' } });
  await h.advance(30 * minute);
  await attempt(h, id, { result: { kind: 'rejected', reason: 'rejected' } });
  await h.advance(minute);
  assert.deepEqual(ledgerOf(await finished(h, id)), ['failed:rejected']);
  await storeResult(h, id, a.claim.fence, 'accepted', { messageId: 'provider-a' });
  assert.deepEqual(await h.sendRpc<StoredAnswer>('recordStoredResults', id), { status: 'recorded', recorded: 1 });
  const late = await h.sendState(id);
  assert.deepEqual(ledgerOf(late), ['sent'], 'the accepted fact upgrades the fence\'s earlier ambiguous outcome');
  assert.equal(late.fences.find(fence => fence.attempt === a.claim.fence.attempt)?.outcome, 'accepted');
  assert.deepEqual(await storedRows(h, id), [], 'deleted only after the publish that covers the applied fact');
  assert.ok(late.flushed.flushed >= late.flushed.modseq);
  // An identical fact again changes nothing.
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, a.claim.fence, { kind: 'accepted', messageId: 'provider-a' }), { status: 'recorded' });
  assert.deepEqual(core(await h.sendState(id)), core(late));
}));

test('authorizeDispatch runs its sender statement in the work lane, right before the grant: an owner change while the lane waits refuses the call', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'auth-lane');
  const a = await attempt(h, id, { stop: 'mark' });
  await h.pauseSenderCheck();
  const answer = h.sendRpc<AuthorizeAnswer>('authorizeDispatch', id, a.claim.fence, [0], DAY_END);
  await h.senderCheckPaused();
  await changeOwner(h);
  await h.resumeSenderCheck();
  assert.deepEqual(await answer, { status: 'stale' });
  const state = await h.sendState(id);
  assert.equal(state.fences[0].authorized, 0, 'no authorization was recorded');
  assert.deepEqual(ledgerOf(state), ['failed:invalid_sender']);
}));

test('a release list longer than one page is drained before any reservation under a new fence, and the send goes out after recovery', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'overflow');
  await h.quota('failNext', 'release', 65);
  const abandoned: SendFence[] = [];
  for (let round = 0; round < 65; round++) {
    const claim = await h.sendRpc<ClaimAnswer>('claimSend', id);
    assert.equal(claim.status, 'claimed', `round ${round}`);
    if (claim.status !== 'claimed') return;
    abandoned.push(claim.fence);
    assert.deepEqual(await h.sendRpc<AbandonAnswer>('abandonClaim', id, claim.fence, 0), { status: 'ok' });
    await h.advance(minute);
  }
  assert.equal((await h.sendState(id)).release.length, 65, 'every failed release stayed listed');
  // More than a page is listed: the claim takes no lease and hands out the oldest page to release.
  const page = await h.sendRpc<ClaimAnswer>('claimSend', id);
  assert.deepEqual(page, { status: 'release', release: abandoned.slice(0, 64) });
  assert.equal((await h.sendState(id)).dispatch?.lease_epoch, null, 'no lease');
  await h.quota('release', scope(id), abandoned.slice(0, 64));
  assert.deepEqual(await h.sendRpc('acknowledgeReleases', id, abandoned.slice(0, 64)), { status: 'ok' });
  assert.deepEqual((await h.sendState(id)).release, abandoned.slice(64));
  const b = await attempt(h, id, { stop: 'authorize' });
  assert.deepEqual(b.claim.release, abandoned.slice(64), 'the rest fits in the reservation call');
  assert.deepEqual((await h.sendState(id)).release, []);
  // Every listed fence was released before, or in the same call ahead of, the first reservation under the new fence.
  const calls = await h.quota<{ method: string; fences: SendFence[] }[]>('calls');
  const first = calls.findIndex(call => call.method === 'reserve' && call.fences[0].attempt === b.claim.fence.attempt);
  const releasedBefore = calls.slice(0, first + 1).flatMap(call => call.method === 'release' ? call.fences : call.method === 'reserve' ? call.fences.slice(1) : []);
  for (const fence of abandoned) assert.ok(releasedBefore.some(entry => entry.attempt === fence.attempt), `fence ${fence.attempt} released first`);
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, b.claim.fence, { kind: 'accepted', messageId: 'm' }), { status: 'recorded' });
  await h.advance(minute);
  assert.deepEqual(ledgerOf(await finished(h, id)), ['sent']);
}));

test('finish releases a release list longer than one page in pages', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'finish-pages');
  await h.quota('failNext', 'release', 65);
  for (let round = 0; round < 65; round++) {
    const claim = await h.sendRpc<ClaimAnswer>('claimSend', id);
    if (claim.status !== 'claimed') return assert.fail(`round ${round}`);
    await h.sendRpc<AbandonAnswer>('abandonClaim', id, claim.fence, 0);
    await h.advance(minute);
  }
  await changeOwner(h);
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'refused' });
  const before = (await h.quota<{ method: string }[]>('calls')).length;
  await h.advance(minute);
  const done = await finished(h, id);
  assert.deepEqual(done.release, []);
  const pages = (await h.quota<{ method: string; fences: SendFence[] }[]>('calls')).slice(before).filter(({ method }) => method === 'release');
  assert.deepEqual(pages.map(({ fences }) => fences.length), [64, 1]);
}));

test('a successful immediate release takes the fence off the release list', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'release-now');
  const a = await attempt(h, id, { result: { kind: 'try_later' } });
  assert.equal(await balanceOf(h, a.claim.fence), 0);
  assert.deepEqual((await h.sendState(id)).release, []);
}));

test('getSend reports a late confirmation only once it is published', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'report-published');
  const a = await attempt(h, id, { stop: 'authorize' });
  await h.advance(LEASE + SKEW);
  await attempt(h, id, { result: { kind: 'rejected', reason: 'rejected' } });
  await h.advance(minute);
  await finished(h, id);
  assert.equal((await mail.getSend(id)).state, 'failed');
  await h.publishFailure(true);
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, a.claim.fence, { kind: 'accepted', messageId: null }), { status: 'unpublished' });
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['sent'], 'recorded locally');
  await assert.rejects(mail.getSend(id), (error: { problem?: { code?: string } }) => error.problem?.code === 'mailbox_restoring');
  await assert.rejects(mail.listSends({}), (error: { problem?: { code?: string } }) => error.problem?.code === 'mailbox_restoring');
  await h.publishFailure(false);
  const shown = await mail.getSend(id);
  assert.equal(shown.state, 'sent');
  assert.deepEqual(shown.recipients.map(({ state }) => state), ['sent']);
}));

test('send state: sent and suppressed recipients make a partial send; suppressed stays an accepted fact', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'mixed', TWO);
  const a = await attempt(h, id, { result: { kind: 'accepted', messageId: 'm', suppressed: [1] } });
  assert.deepEqual(a.record, { status: 'recorded' });
  await h.advance(minute);
  const done = await finished(h, id);
  assert.deepEqual(ledgerOf(done), ['sent', 'suppressed']);
  assert.equal(done.row?.state, 'partial');
  assert.equal(await balanceOf(h, a.claim.fence), 2, 'the accepted call keeps its charge');
  const shown = await mail.getSend(id);
  assert.equal(shown.state, 'partial');
  assert.deepEqual(shown.recipients.map(({ state }) => state), ['sent', 'suppressed']);
}));

test('a quota wait ends at the reset of the gate that refused the reservation; the provider\'s daily limit waits for the quota day', () => withSend(async (h, mail, from) => {
  const now = await h.sends.now();
  const monthEnd = now + 10 * 24 * hour;
  await h.quota('setDay', 'long-day', now + 20 * 24 * hour);
  // One monthly slot is left: a two-recipient send is refused by the monthly gate, a one-recipient send still reserves.
  await h.quota('setMonthly', 1, monthEnd);
  const two = await queued(h, mail, from, 'monthly-two', TWO);
  const claim = await h.sendRpc<ClaimAnswer>('claimSend', two);
  if (claim.status !== 'claimed') return assert.fail('claim');
  const refused = await h.quota<QuotaAnswer>('reserve', scope(two), claim.fence, [0, 1], claim.release, 0);
  assert.deepEqual(refused, { status: 'exhausted', resetAt: monthEnd });
  const delayed = await h.sendRpc<DelayAnswer>('delaySend', two, claim.fence, 'gate', monthEnd);
  assert.deepEqual(delayed, { status: 'delayed', until: monthEnd + SKEW });
  const one = await queued(h, mail, from, 'monthly-one');
  await attempt(h, one, { stop: 'claim' });
  await h.advance(2 * 24 * hour);
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', two), { status: 'not_now', reason: 'delayed' }, 'not woken at a daily reset');
  await h.quota('setMonthly', null, null);
  await h.advance(monthEnd + SKEW - await h.sends.now());
  const b = await attempt(h, two, { stop: 'authorize' });
  // The provider's own daily limit waits for the quota day's end.
  const providerDaily = await h.sendRpc<DelayAnswer>('delaySend', two, b.claim.fence, 'provider_daily');
  assert.deepEqual(providerDaily, { status: 'delayed', until: await h.quota<number>('resetAt') + SKEW });
  // A gate reset in the past or more than 32 days ahead is refused.
  const at = await h.sends.now();
  await assert.rejects(h.sendRpc('delaySend', two, b.claim.fence, 'gate', at - 1));
  await assert.rejects(h.sendRpc('delaySend', two, b.claim.fence, 'gate', at + 33 * 24 * hour));
}));

test('the stored-result page: a row that fails backs off alone and the others are recorded; a restoring mailbox defers every row', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'page', TWO);
  const a = await attempt(h, id, { stop: 'authorize', mark: [0] });
  await h.advance(LEASE + SKEW);
  const b = await attempt(h, id, { stop: 'authorize', mark: [1] });
  await storeResult(h, id, a.claim.fence, 'accepted', { messageId: 'a' });
  await storeResult(h, id, b.claim.fence, 'accepted', { messageId: 'b' });
  await h.failRecordOnce(a.claim.fence.attempt);
  const now = await h.sends.now();
  assert.deepEqual(await h.sendRpc<StoredAnswer>('recordStoredResults', id), { status: 'retry', recorded: 1, next: now + minute });
  assert.deepEqual(await storedRows(h, id), [{ fence_epoch: 0, fence_attempt: a.claim.fence.attempt, notify_after: now + minute, notify_failures: 1 }]);
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['pending', 'sent'], 'the later row was recorded');

  await storeResult(h, id, { epoch: 0, attempt: 9 }, 'try_later');
  await h.blockLaterDelta(0);
  await h.restore();
  const at = await h.sends.now();
  assert.deepEqual(await h.sendRpc<StoredAnswer>('recordStoredResults', id), { status: 'restoring', recorded: 0 });
  const rows = new Map((await storedRows(h, id)).map(row => [row.fence_attempt, row.notify_after]));
  assert.equal(rows.get(9), at + 5 * minute, 'every selected (due) row is deferred past the restore');
  assert.equal(rows.get(a.claim.fence.attempt), now + minute, 'a backed-off row keeps its own time');
}));

test('recordStoredResults checks the mailbox scope before any directory statement', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'scope');
  await h.directoryChange(`INSERT INTO send_results (workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt, kind, created_at, notify_after)
    VALUES (?, 'mailbox-b', ?, 0, 1, 'try_later', 0, 0)`, WS, id);
  const response = await h.sendRpcAs('mailbox-b', 'recordStoredResults', id);
  assert.equal(response.status, 500);
  await response.body?.cancel();
  assert.deepEqual(await h.directoryRows('SELECT notify_after, notify_failures FROM send_results WHERE mailbox_id = ?', 'mailbox-b'),
    [{ notify_after: 0, notify_failures: 0 }], 'the other mailbox\'s row is untouched');
}));

test('send_results refuses rows the mailbox would refuse', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'bounds');
  const insert = (kind: string, messageId: string | null, detail: string | null, suppressed = 0) => h.directoryChange(`INSERT INTO send_results
    (workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt, kind, message_id, detail, suppressed, created_at, notify_after)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 0, 0)`, WS, MB, id, Math.floor(Math.random() * 1e9) + 1, kind, messageId, detail, suppressed);
  for (const [name, row] of [
    ['a rejection reason with capitals', ['rejected', null, 'Bad_reason']],
    ['a reason starting with a digit', ['rejected', null, '1rejected']],
    ['a rejection with no reason', ['rejected', null, null]],
    ['an outage code with a space', ['outage', null, 'E BAD']],
    ['an outage with no code', ['outage', null, null]],
    ['a message id with a control character', ['accepted', 'id\u0001', null]],
    ['a message id over 998 bytes', ['accepted', 'x'.repeat(999), null]],
    ['a message id on a non-accepted result', ['try_later', 'id', null]],
    ['a suppressed index past 49', ['accepted', null, null, 2 ** 50]],
    ['a fractional suppressed mask', ['accepted', null, null, 1.5]],
    ['suppressed indexes on a non-accepted result', ['ambiguous', null, null, 1]],
  ] as [string, [string, string | null, string | null, number?]][]) {
    await assert.rejects(insert(...row), Error, name);
  }
  await insert('accepted', 'x'.repeat(998), null, 2 ** 50 - 1);
  await insert('ambiguous', null, 'E_INTERNAL_SERVER_ERROR');
  await insert('rejected', null, 'invalid_address');
}));

test('the claim lists a never-authorized fence whose recipients it takes back, and keeps an authorized one\'s charge', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'claim-release', TWO);
  const a = await attempt(h, id, { stop: 'authorize', mark: [0] });
  await h.advance(LEASE + SKEW);
  const b = await attempt(h, id, { stop: 'mark', mark: [1] });
  assert.deepEqual(b.claim.release, [], 'the authorized fence A is kept');
  assert.equal(await balanceOf(h, a.claim.fence), 1);
  await h.advance(LEASE + SKEW);
  const c = await attempt(h, id, { stop: 'claim' });
  assert.deepEqual(c.claim.release, [b.claim.fence], 'never-authorized fence B goes');
  assert.equal(await balanceOf(h, b.claim.fence), 0, 'and the next reservation released it');
  assert.equal(await balanceOf(h, a.claim.fence), 1);
}));

test('a failed stored-result lookup defers the enqueue and the claim until the stored acceptance is recorded', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'lookup');
  const a = await attempt(h, id, { stop: 'authorize' });
  await storeResult(h, id, a.claim.fence, 'accepted', { messageId: 'stored' });
  await h.directoryChange('ALTER TABLE send_results RENAME TO send_results_offline');
  const queuedBefore = (await h.sends.queue()).length;
  await h.advance(LEASE + SKEW);
  assert.equal((await h.sends.queue()).length, queuedBefore, 'no enqueue while the lookup fails');
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'not_now', reason: 'results' });
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['attempting']);
  await h.directoryChange('ALTER TABLE send_results_offline RENAME TO send_results');
  await h.advance(10 * minute);
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['sent'], 'recorded, never resent');
  assert.equal((await h.sends.queue()).length, queuedBefore);
}));

test('a held send releases its never-authorized charges without resuming', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'held-release');
  let last: SendFence | undefined;
  for (let round = 0; round < 5; round++) {
    last = (await attempt(h, id, { stop: 'mark' })).claim.fence;
    await h.advance(LEASE + SKEW);
  }
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'not_now', reason: 'held' });
  assert.deepEqual((await h.sendState(id)).release, [last]);
  assert.equal(await balanceOf(h, last!), 1);
  await h.advance(24 * hour);
  assert.equal(await balanceOf(h, last!), 0, 'the drive row released it');
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['attempting'], 'and did not resume the send');
}));

test('a restore that ends after a grace hold began extends the hold from its end', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'second-restore');
  await attempt(h, id, { stop: 'authorize' });
  await h.restore();
  await changeOwner(h);
  await h.advance(LEASE + SKEW);
  assert.deepEqual(await h.sendRpc<ClaimAnswer>('claimSend', id), { status: 'refused' });
  const first = Number((await h.sendState(id)).dispatch?.grace_until);
  // Published, then a second restore that ends after the first hold would have.
  await h.advance(minute);
  await h.restoreAfter(first - await h.sends.now() + minute);
  const restoredAt = Number((await h.sends.lifecycle())?.restoredAt);
  await h.advance(0);
  const held = await h.sendState(id);
  assert.deepEqual(ledgerOf(held), ['attempting'], 'still held');
  assert.equal(held.dispatch?.grace_until, restoredAt + LEASE);
  await h.advance(LEASE);
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['failed:invalid_sender']);
}));

test('try-later and outage results back off on separate counters', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'counters');
  await attempt(h, id, { result: { kind: 'try_later' } });
  await h.advance(minute);
  await attempt(h, id, { result: { kind: 'try_later' } });
  await h.advance(2 * minute);
  const at = await h.sends.now();
  await attempt(h, id, { result: { kind: 'outage', code: 'E_ACCOUNT_SUSPENDED' } });
  const state = await h.sendState(id);
  assert.equal(Number(state.dispatch?.next_attempt_at) - at, minute, 'the first outage waits one minute');
  assert.equal(state.dispatch?.refusals, 2);
  assert.equal(state.dispatch?.outages, 1);
}));

test('authorizeDispatch holds the work lane from its directory statement to the grant: an abandonClaim in between waits', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'auth-hold');
  const a = await attempt(h, id, { stop: 'mark' });
  await h.pauseSenderCheck('after');
  const answer = h.sendRpc<AuthorizeAnswer>('authorizeDispatch', id, a.claim.fence, [0], DAY_END);
  await h.senderCheckPaused();
  let abandoned = false;
  const abandon = h.sendRpc<AbandonAnswer>('abandonClaim', id, a.claim.fence, 0).then(value => { abandoned = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 200));
  const during = await h.sendState(id);
  assert.equal(abandoned, false, 'abandonClaim waits for the lane');
  assert.deepEqual(ledgerOf(during), ['attempting'], 'the fence is still pending');
  assert.equal(during.fences[0].outcome, null);
  await h.resumeSenderCheck();
  assert.deepEqual(await answer, { status: 'ok', remainingMs: 10 * second });
  // After the grant, abandonClaim is the missed-deadline path.
  assert.deepEqual(await abandon, { status: 'ok' });
}));

test('stored results are settled only when none remain: a full page of try-later rows does not let a claim reclaim before the 17th row\'s acceptance', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'page-full');
  const a = await attempt(h, id, { stop: 'authorize' });
  await h.advance(LEASE + SKEW);
  for (let n = 0; n < 16; n++) await storeResult(h, id, { epoch: 0, attempt: 100 + n }, 'try_later');
  await h.directoryChange(`INSERT INTO send_results (workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt, kind, message_id,
    created_at, notify_after) VALUES (?, ?, ?, ?, ?, 'accepted', 'late', 0, 1)`, WS, MB, id, a.claim.fence.epoch, a.claim.fence.attempt);
  const answers: string[] = [];
  for (let round = 0; round < 3; round++) answers.push((await h.sendRpc<ClaimAnswer>('claimSend', id)).status);
  assert.deepEqual(answers, ['not_now', 'refused', 'refused'], 'never claimed: the acceptance on the second page is recorded first');
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['sent']);
  assert.deepEqual(await storedRows(h, id), []);
}));

test('the drive row does not enqueue while a second page of stored results remains', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'page-drive');
  const a = await attempt(h, id, { stop: 'authorize' });
  for (let n = 0; n < 16; n++) await storeResult(h, id, { epoch: 0, attempt: 100 + n }, 'try_later');
  await h.directoryChange(`INSERT INTO send_results (workspace_id, mailbox_id, send_id, fence_epoch, fence_attempt, kind, message_id,
    created_at, notify_after) VALUES (?, ?, ?, ?, ?, 'accepted', 'late', 0, 1)`, WS, MB, id, a.claim.fence.epoch, a.claim.fence.attempt);
  const queuedBefore = (await h.sends.queue()).length;
  await h.advance(LEASE + SKEW);
  await h.advance(second);
  await h.advance(minute);
  assert.equal((await h.sends.queue()).length, queuedBefore, 'no extra enqueue');
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['sent']);
}));

test('a stored acceptance that cannot be applied is kept and backs off, never deleted', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'unapplied');
  const a = await attempt(h, id, { stop: 'mark' });
  // An unknown fence, and a known fence of this epoch with no authorization.
  await storeResult(h, id, { epoch: 0, attempt: 99 }, 'accepted', { messageId: 'unknown' });
  await storeResult(h, id, a.claim.fence, 'accepted', { messageId: 'unauthorized' });
  await storeResult(h, id, { epoch: 0, attempt: 98 }, 'try_later');
  const now = await h.sends.now();
  const answer = await h.sendRpc<StoredAnswer>('recordStoredResults', id);
  assert.equal(answer.status, 'retry');
  assert.deepEqual((await storedRows(h, id)).map(row => [row.fence_attempt, row.notify_after, row.notify_failures]).sort((x, y) => Number(x[0]) - Number(y[0])),
    [[a.claim.fence.attempt, now + minute, 1], [99, now + minute, 1]], 'both acceptances kept; the stale try-later row deleted');
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['attempting']);
}));

test('getThread reports the sent copy\'s send state only once published', () => withSend(async (h, mail, from) => {
  const id = await queued(h, mail, from, 'thread');
  const a = await attempt(h, id, { stop: 'authorize' });
  const sent = await mail.getSend(id);
  const [thread0] = (await mail.listThreads({ view: 'sent' })).items;
  const message = { threadId: thread0.id };
  await h.publishFailure(true);
  assert.deepEqual(await h.sendRpc<ReportAnswer>('recordResult', id, a.claim.fence, { kind: 'accepted', messageId: 'm' }), { status: 'unpublished' });
  await assert.rejects(mail.getThread(message.threadId), (error: { problem?: { code?: string } }) => error.problem?.code === 'mailbox_restoring');
  await h.publishFailure(false);
  const thread = await mail.getThread(message.threadId);
  assert.equal(thread.messages.find(({ id: messageId }) => messageId === sent.messageId)?.send?.state, 'sent');
}));
