import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { isMailApiError, type MailService } from '../../../contracts/mail-api/src/index.ts';
import type { DraftInput, Send } from '../../../contracts/mail-api/src/wire.ts';
import { startMailHttpFixture } from './fixtures/mail-http.ts';

// The send state machine from `pending` to the published release and its
// enqueue (docs/m3-outbound-plan.md, section 3, M3-3), against the backend
// over HTTP in local workerd, with fake SEND and EMAIL bindings.
type Fixture = Awaited<ReturnType<typeof startMailHttpFixture>>;
const second = 1000, minute = 60 * second, day = 24 * 60 * minute;
const RETENTION_MS = 35 * day;
const UNDO = 10 * second;
const DRIVE_BACKOFF = 5 * minute;
const key = (idempotencyKey: string) => ({ idempotencyKey });
const draftInput = (from: string, patch: Partial<DraftInput> = {}): DraftInput => ({
  from, to: [{ email: 'friend@example.net', name: 'A Friend' }], cc: [], bcc: [], subject: 'Hello', body: 'Body text', attachments: [], ...patch,
});
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error) => isMailApiError(error, code as never));

async function withSend(run: (h: Fixture, mail: MailService, from: string) => Promise<void>) {
  const fixture = await startMailHttpFixture({ send: true });
  try {
    const mail = fixture.as('member');
    const { mailbox } = await mail.getSession();
    assert.ok(mailbox);
    await run(fixture, mail, mailbox.primaryAddress);
  } finally { await fixture.close(); }
}

async function send(mail: MailService, from: string, token: string, patch: Partial<DraftInput> = {}) {
  const draft = await mail.createDraft(draftInput(from, patch), key(`draft-${token}`));
  return { draft, send: await mail.sendDraft(draft.id, { ...key(`send-${token}`), ifMatch: draft.revision }) };
}

async function sentCopies(mail: MailService) {
  const threads = await mail.listThreads({ view: 'sent' });
  return (await Promise.all(threads.items.map(({ id }) => mail.getThread(id)))).flatMap(({ messages }) => messages);
}

// A raw API write, to see the status and the Retry-After header.
async function post(h: Fixture, mail: MailService, path: string, idempotencyKey: string, ifMatch?: string) {
  const { csrfToken } = await mail.getSession();
  return fetch(`${h.origin}/api/v1${path}`, { method: 'POST', headers: {
    origin: h.origin, 'x-fixture-account': 'member', 'x-csrf-token': csrfToken, 'idempotency-key': idempotencyKey,
    ...(ifMatch ? { 'if-match': ifMatch } : {}) } });
}

const driveRows = async (h: Fixture) => (await h.timers()).filter(({ kind }) => kind === 'send_drive');
const sha256 = (bytes: ArrayBuffer) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');

test('release waits for the send to be published: no registration, PUT or enqueue, and a restore leaves no registration', () => withSend(async (h, mail, from) => {
  const draft = await mail.createDraft(draftInput(from), key('draft'));
  await h.advance(minute); // The draft itself is published.
  await h.publishFailure(true);
  const response = await post(h, mail, `/drafts/${draft.id}/send`, 'send', draft.revision);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('retry-after'), '1');
  assert.equal(((await response.json()) as { code: string }).code, 'idempotency_in_progress');
  const [id] = await h.sends.ids();
  assert.deepEqual((await mail.listSends({})).items, [], 'an unpublished send is not listed');
  await rejects(mail.getSend(id), 'not_found');
  const pending = { id };
  const puts = h.writes.length;
  await h.advance(UNDO);
  await h.advance(DRIVE_BACKOFF);
  assert.equal(await h.sends.registration(pending.id), null);
  assert.equal(h.writes.length, puts, 'no sent copy was stored');
  assert.deepEqual(await h.sends.queue(), []);
  assert.equal((await h.sends.row(pending.id))?.state, 'pending');
  await h.publishFailure(false);
  await h.restore();
  await rejects(mail.getSend(pending.id), 'not_found');
  assert.equal(await h.sends.registration(pending.id), null);
  assert.equal((await mail.getDraft(draft.id)).revision, draft.revision, 'the unpublished send never happened');
  assert.equal(await h.sends.emailCalls(), 0);
}));

test('barrier: while the publish fails sendDraft and undoSend answer 409 with Retry-After, and same-key retries recover the original result', () => withSend(async (h, mail, from) => {
  const draft = await mail.createDraft(draftInput(from), key('draft'));
  await h.publishFailure(true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const failed = await post(h, mail, `/drafts/${draft.id}/send`, 'send', draft.revision);
    assert.equal(failed.status, 409);
    assert.equal(failed.headers.get('retry-after'), '1');
  }
  await h.advance(UNDO + DRIVE_BACKOFF);
  assert.deepEqual(await h.sends.queue(), [], 'no queue message while the publish fails');
  await h.publishFailure(false);
  const recovered = await post(h, mail, `/drafts/${draft.id}/send`, 'send', draft.revision);
  assert.equal(recovered.status, 202);
  assert.equal(recovered.headers.get('idempotency-replayed'), 'true');
  const sent = await recovered.json() as Send;
  assert.equal(sent.draftId, draft.id);
  assert.equal((await mail.listSends({})).items.length, 1, 'one send for one key');

  const other = await send(mail, from, 'other');
  await h.publishFailure(true);
  const undo = await post(h, mail, `/sends/${other.send.id}/undo`, 'undo');
  assert.equal(undo.status, 409);
  assert.equal(undo.headers.get('retry-after'), '1');
  await h.advance(DRIVE_BACKOFF);
  assert.deepEqual((await h.sends.queue()).filter(({ sendId }) => sendId === other.send.id), []);
  await h.publishFailure(false);
  const restored = await mail.undoSend(other.send.id, key('undo'));
  assert.equal(restored.id, other.draft.id);
  assert.equal((await mail.getSend(other.send.id)).state, 'cancelled');
  assert.equal(await h.sends.emailCalls(), 0);
}));

test('lost response: same-key retries of sendDraft and undoSend return the action, never 404 or 412, and no second send', () => withSend(async (h, mail, from) => {
  const { draft, send: first } = await send(mail, from, 'one');
  const options = { ...key('send-one'), ifMatch: draft.revision };
  const retried = await mail.sendDraft(draft.id, options);
  assert.equal(retried.id, first.id);
  assert.equal(retried.state, 'pending');
  assert.equal((await mail.listSends({})).items.length, 1);
  const undone = await mail.undoSend(first.id, key('undo'));
  const edited = await mail.replaceDraft(undone.id, draftInput(from, { subject: 'Edited after undo' }), { ifMatch: undone.revision });
  assert.deepEqual(await mail.undoSend(first.id, key('undo')), undone, 'the retry returns the draft the undo restored');
  const late = await mail.sendDraft(draft.id, options);
  assert.equal(late.id, first.id);
  assert.equal(late.state, 'cancelled');
  assert.equal((await mail.getDraft(draft.id)).revision, edited.revision);
  await h.advance(UNDO);
  assert.deepEqual(await h.sends.queue(), []);
}));

for (const change of ['owner', 'alias'] as const) {
  test(`${change === 'owner' ? 'an owner change' : 'an alias removal'} during the undo window ends the send failed with invalid_sender, with no queue message, EMAIL call or sent copy`,
    () => withSend(async (h, mail, primary) => {
      const admin = h.as('admin');
      const { mailbox } = await mail.getSession();
      let from = primary;
      if (change === 'alias') {
        from = (await admin.createAlias({ mailboxId: mailbox!.id, address: 'sales@example.com', sendAs: true }, key('alias'))).address;
        await h.sends.activateAlias(from);
      }
      const { send: pending } = await send(mail, from, 'one', {
        to: [{ email: 'friend@example.net' }], cc: [{ email: 'colleague@example.org' }], bcc: [{ email: 'hidden@example.net' }] });
      const reader = change === 'owner' ? h.as('newAdmin') : mail;
      if (change === 'owner') await admin.updateMailbox(mailbox!.id, { ownerUserId: (await reader.getSession()).user.id });
      else await admin.deleteAlias(from);
      await h.advance(UNDO);
      const failed = await reader.getSend(pending.id);
      assert.equal(failed.state, 'failed');
      assert.equal(failed.messageId, undefined);
      assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })),
        Array(3).fill({ state: 'failed', reason: 'invalid_sender' }));
      assert.deepEqual(await h.sends.queue(), []);
      assert.equal(await h.sends.emailCalls(), 0);
      assert.deepEqual((await reader.listThreads({ view: 'sent' })).items, []);
      // Cleanup has run: no drive row, and the reported failure stays.
      assert.deepEqual(await driveRows(h), []);
      assert.equal((await h.sends.row(pending.id))?.finish_pending, 0);
      assert.equal((await h.sends.registration(pending.id))?.released, 'all');
      await h.advance(minute);
      assert.deepEqual((await reader.getSend(pending.id)).recipients.map(({ state, reason }) => ({ state, reason })),
        Array(3).fill({ state: 'failed', reason: 'invalid_sender' }), 'also after cleanup');
    }));
}

test('two sends in one undo window, one undone: only the other is released and enqueued', () => withSend(async (h, mail, from) => {
  const kept = await send(mail, from, 'kept');
  const undone = await send(mail, from, 'undone');
  await mail.undoSend(undone.send.id, key('undo'));
  await h.advance(UNDO);
  assert.deepEqual(await h.sends.queue(), [{ kind: 'dispatch', ws: 'w1', mb: 'mailbox-a', sendId: kept.send.id }]);
  const released = await mail.getSend(kept.send.id);
  assert.equal(released.state, 'sending');
  assert.ok(released.messageId);
  assert.equal((await mail.getSend(undone.send.id)).state, 'cancelled');
  assert.deepEqual((await sentCopies(mail)).map(({ send }) => send?.id), [kept.send.id]);
  assert.equal((await h.sends.registration(undone.send.id))?.key, null, 'the undone send never registered');
  assert.equal((await h.sends.registration(undone.send.id))?.released, 'all');
  await rejects(mail.undoSend(kept.send.id, key('late')), 'send_not_pending');
  assert.equal(await h.sends.emailCalls(), 0);
}));

for (const step of ['released', 'stored', 'queued', 'enqueued'] as const) {
  test(`a crash after release step "${step}" still ends with exactly one sent copy and at least one queue message`, () => withSend(async (h, mail, from) => {
    await h.sends.crashAfter(step);
    const { send: pending } = await send(mail, from, 'one');
    await h.advance(UNDO);
    await h.advance(DRIVE_BACKOFF);
    const queued = await h.sends.queue();
    assert.ok(queued.length >= 1 && queued.every(({ sendId }) => sendId === pending.id));
    const copies = await sentCopies(mail);
    assert.equal(copies.length, 1);
    assert.equal(copies[0].send?.id, pending.id);
    assert.equal(copies[0].sent, true);
    const registration = await h.sends.registration(pending.id);
    assert.ok(registration?.key);
    assert.equal([...h.objects.keys()].filter(path => path.includes(`/${registration.key!.split('/').slice(0, 2).join('/')}/`)).length, 1);
    assert.equal((await mail.getSend(pending.id)).messageId, copies[0].id);
  }));
}

// Runs the lane until restored messages are reindexed and the mailbox serves reads again.
async function settle(h: Fixture, mail: MailService) {
  for (let i = 0; i < 5; i++) {
    try { await mail.listSends({}); return; }
    catch (error) { if (!isMailApiError(error, 'mailbox_restoring')) throw error; }
    await h.advance(minute);
  }
  throw new Error('Mailbox did not settle after its restore');
}

test('restore matrix: a restore in each driven state releases every accepted send, never an undone one, and re-drives after an epilogue crash',
  { timeout: 120_000 }, () => withSend(async (h, mail, primary) => {
    const admin = h.as('admin');
    const alias = (await admin.createAlias({ mailboxId: (await mail.getSession()).mailbox!.id, address: 'sales@example.com', sendAs: true },
      key('alias'))).address;
    await h.sends.activateAlias(alias);
    // releasing (release step 1 committed, then a crash) and queued (released and published).
    const both = [await send(mail, primary, 'one'), await send(mail, primary, 'two')];
    await h.sends.crashAfter('released');
    await h.advance(UNDO);
    // The crash hits whichever drive row ran first; the other released.
    const states = await Promise.all(both.map(async ({ send: item }) => (await h.sends.row(item.id))?.state));
    assert.deepEqual([...states].sort(), ['queued', 'releasing']);
    const releasing = both[states.indexOf('releasing')];
    const queued = both[states.indexOf('queued')];
    await h.advance(minute); // The lane publishes the releasing commit.
    // cancelled, just after undoSend answered; and a terminal send with finish_pending.
    const cancelled = await send(mail, primary, 'cancelled');
    await mail.undoSend(cancelled.send.id, key('undo-cancelled'));
    const failing = await send(mail, alias, 'failing');
    await admin.deleteAlias(alias);
    await h.sends.releaseFailure(true);
    await h.advance(UNDO);
    assert.equal((await h.sends.row(failing.send.id))?.state, 'failed');
    assert.equal((await h.sends.row(failing.send.id))?.finish_pending, 1, 'its cleanup could not release');
    assert.equal((await h.sends.row(cancelled.send.id))?.finish_pending, 1);
    await h.sends.releaseFailure(false);
    // pending, just after sendDraft answered.
    const pending = await send(mail, primary, 'pending');
    const all = [pending, releasing, queued, cancelled, failing];

    await h.sends.failNextEpilogue();
    await h.restore();
    // The epilogue crashed in the transaction that sets the mailbox ready; the restore retries it.
    await rejects(mail.getSend(pending.send.id), 'mailbox_restoring');
    assert.deepEqual(await driveRows(h), []);
    await h.advance(5 * second);
    const rows = await driveRows(h);
    for (const { send: item } of all) assert.ok(rows.some(({ ref }) => ref === item.id), 'every unfinished send has its drive row');
    await settle(h, mail);
    for (let i = 0; i < 3; i++) await h.advance(DRIVE_BACKOFF);
    const accepted = [pending, releasing, queued];
    for (const { send: item } of accepted) assert.equal((await mail.getSend(item.id)).state, 'sending');
    assert.equal((await mail.getSend(cancelled.send.id)).state, 'cancelled');
    assert.equal((await mail.getSend(failing.send.id)).state, 'failed');
    assert.equal((await h.sends.row(failing.send.id))?.finish_pending, 0, 'the restored cleanup finished');
    assert.equal((await h.sends.row(cancelled.send.id))?.finish_pending, 0);
    assert.deepEqual((await driveRows(h)).map(({ ref }) => ref).sort(), accepted.map(({ send: item }) => item.id).sort());
    const copies = await sentCopies(mail);
    assert.deepEqual(copies.map(({ send: item }) => item?.id).sort(), accepted.map(({ send: item }) => item.id).sort(), 'one sent copy each, in Sent');
    const enqueued = new Set((await h.sends.queue()).map(({ sendId }) => sendId));
    assert.ok(accepted.every(({ send: item }) => enqueued.has(item.id)));
    assert.ok(!enqueued.has(cancelled.send.id) && !enqueued.has(failing.send.id), 'the undone and failed sends were never released');
    assert.deepEqual((await mail.listDrafts({})).items.map(({ id }) => id), [cancelled.draft.id], 'released drafts do not reappear; the undone one does');
    assert.equal(await h.sends.emailCalls(), 0);
  }));

test('a restore right after sendDraft answered gives the pending send a fresh undo window, then releases it', () => withSend(async (h, mail, from) => {
  const { draft, send: pending } = await send(mail, from, 'one');
  await h.advance(UNDO - second);
  await h.restore();
  const restored = await mail.getSend(pending.id);
  assert.equal(restored.state, 'pending');
  assert.ok(Date.parse(restored.undoUntil) > Date.parse(pending.undoUntil));
  assert.equal(restored.undoRemainingMs, UNDO);
  await rejects(mail.getDraft(draft.id), 'not_found');
  await h.advance(UNDO);
  assert.equal((await mail.getSend(pending.id)).state, 'sending');
  assert.equal((await h.sends.queue()).length, 1);
}));

test('a restore right after undoSend answered keeps the send cancelled and the draft restored', () => withSend(async (h, mail, from) => {
  const { send: pending } = await send(mail, from, 'one');
  const draft = await mail.undoSend(pending.id, key('undo'));
  await h.restore();
  assert.equal((await mail.getSend(pending.id)).state, 'cancelled');
  assert.equal((await mail.getDraft(draft.id)).revision, draft.revision);
  await h.advance(UNDO);
  assert.deepEqual(await h.sends.queue(), []);
  assert.deepEqual(await driveRows(h), [], 'the cancelled send finished after the restore');
  assert.deepEqual(await mail.undoSend(pending.id, key('undo')), draft, 'the published idempotency result survives the restore');
}));

test('an undo lost to a restore is retried in the fresh window and nothing goes out', () => withSend(async (h, mail, from) => {
  const { send: pending } = await send(mail, from, 'one');
  await h.publishFailure(true);
  const undo = await post(h, mail, `/sends/${pending.id}/undo`, 'undo');
  assert.equal(undo.status, 409);
  await h.advance(UNDO + second);
  await h.publishFailure(false);
  await h.restore();
  const restored = await mail.getSend(pending.id);
  assert.equal(restored.state, 'pending', 'the unpublished undo was lost with its delta');
  assert.ok(restored.undoRemainingMs > 0, 'past its old undoUntil, the send has a fresh window');
  const draft = await mail.undoSend(pending.id, key('undo'));
  assert.equal(draft.id, pending.draftId);
  await h.advance(UNDO);
  await h.advance(DRIVE_BACKOFF);
  assert.equal((await mail.getSend(pending.id)).state, 'cancelled');
  assert.deepEqual(await h.sends.queue(), []);
  assert.equal(await h.sends.emailCalls(), 0);
}));

test('concurrent barriers: sends committing and releasing at once in one mailbox all publish without a manifest conflict', () => withSend(async (h, mail, from) => {
  const first = await send(mail, from, 'first');
  const drafts = await Promise.all(['a', 'b', 'c'].map(token => mail.createDraft(draftInput(from, { subject: token }), key(`draft-${token}`))));
  await h.advance(UNDO - second);
  const [sends] = await Promise.all([
    Promise.all(drafts.map((draft, i) => mail.sendDraft(draft.id, { ...key(`send-${i}`), ifMatch: draft.revision }))),
    h.advance(second),
  ]);
  assert.equal(sends.length, 3);
  assert.ok(sends.every(({ state }) => state === 'pending'));
  assert.equal((await mail.getSend(first.send.id)).state, 'sending');
  await h.advance(UNDO);
  for (const item of sends) assert.equal((await mail.getSend(item.id)).state, 'sending');
  const life = await h.sends.lifecycle();
  assert.equal(life?.conflict, undefined, 'no publish raced the manifest ETag');
  assert.ok(!(await h.alerts()).includes('mail:backup_conflict'));
  assert.equal((await h.sends.queue()).length, 4);
}));

test('undo racing the alarm: either cancelled with no queue message, or released with undo answering send_not_pending', () => withSend(async (h, mail, from) => {
  const outcomes = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const { send: pending } = await send(mail, from, `race-${i}`);
    await h.advance(UNDO - second);
    const [undo] = await Promise.allSettled([mail.undoSend(pending.id, key(`undo-${i}`)), h.advance(second)]);
    await h.advance(DRIVE_BACKOFF);
    const state = (await mail.getSend(pending.id)).state;
    const enqueued = (await h.sends.queue()).some(({ sendId }) => sendId === pending.id);
    if (undo.status === 'fulfilled') {
      assert.equal(state, 'cancelled');
      assert.equal(enqueued, false);
      assert.equal((await h.sends.registration(pending.id))?.key, null);
      outcomes.add('cancelled');
    } else {
      assert.ok(isMailApiError(undo.reason, 'send_not_pending'));
      assert.equal(state, 'sending');
      assert.equal(enqueued, true);
      outcomes.add('released');
    }
  }
  assert.ok(outcomes.size >= 1);
}));

const objectPath = (key: string) => `/mail-w1/${key}`;
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test('late PUT after release: an overtaken PUT lands after the send was cancelled and released; its object sits under an unheld ledger generation and is swept',
  () => withSend(async (h, mail, from) => {
    const { send: pending } = await send(mail, from, 'one');
    await h.sends.shortHandlerBudget();
    const put = h.pauseNextPut();
    const running = h.advance(UNDO);
    await put.started;
    await running;
    const registration = await h.sends.registration(pending.id);
    assert.ok(registration?.key);
    // The release commit was never published, so a restore rewinds it, and the user undoes the send.
    await h.restore();
    assert.equal((await mail.getSend(pending.id)).state, 'pending');
    await mail.undoSend(pending.id, key('undo'));
    // The stalled call still holds its ref in this isolate for one timer lease.
    await h.advance(DRIVE_BACKOFF + second);
    assert.equal((await h.sends.registration(pending.id))?.released, 'all');
    assert.deepEqual((await h.holderDetails(registration.key)).map(({ state }) => state), ['tombstone', 'tombstone']);
    put.release();
    await until(() => h.objects.has(objectPath(registration.key!)), 'the late PUT');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await mail.getSend(pending.id)).state, 'cancelled');
    assert.deepEqual(await sentCopies(mail), [], 'the overtaken run committed nothing');
    assert.deepEqual(await h.sends.queue(), []);
    // No object without a ledger row: the generation exists, unheld, and is swept after its grace.
    const generation = await h.sends.generation(registration.key);
    assert.equal(generation?.holder_count, 0);
    assert.equal(generation?.retry_at, null);
    const due = Date.now() + RETENTION_MS + day;
    await h.sweepAt(due);
    assert.equal(h.objects.has(objectPath(registration.key)), false);
    assert.ok((await h.sends.generation(registration.key))?.deleted_at, 'the row stays until the second delete');
    await h.sweepAt(due + day);
    assert.equal(await h.sends.generation(registration.key), null);
  }));

for (const next of ['finishes', 'releases'] as const) {
  test(`overtaken handler: a release stalled 10 minutes in its PUT commits nothing after the next firing ${next} the send`, () => withSend(async (h, mail, from) => {
    const { send: pending } = await send(mail, from, 'one');
    await h.sends.shortHandlerBudget();
    const put = h.pauseNextPut();
    const running = h.advance(UNDO);
    await put.started;
    await running;
    const { mailbox } = await mail.getSession();
    const owner = next === 'finishes' ? h.as('newAdmin') : mail;
    if (next === 'finishes') await h.as('admin').updateMailbox(mailbox!.id, { ownerUserId: (await owner.getSession()).user.id });
    await h.advance(10 * minute);
    const settled = await owner.getSend(pending.id);
    assert.equal(settled.state, next === 'finishes' ? 'failed' : 'sending');
    put.release();
    const registration = await h.sends.registration(pending.id);
    await until(() => h.objects.has(objectPath(registration!.key!)), 'the stalled PUT');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(await owner.getSend(pending.id), settled, 'the stalled handler changed nothing');
    assert.equal(await h.eventCount('send_queued'), next === 'finishes' ? 0 : 1);
    if (next === 'finishes') {
      assert.deepEqual(await driveRows(h), [], 'the finished send keeps no drive row');
      assert.equal((await h.sends.row(pending.id))?.finish_pending, 0);
      assert.deepEqual(await h.sends.queue(), []);
    } else {
      assert.equal((await sentCopies(mail)).length, 1);
      assert.equal((await h.sends.queue()).length, 1);
      assert.equal((await driveRows(h)).length, 1);
    }
  }));
}

test('frozen inputs: a rerun of release after a restore rewound it builds the same bytes and key, with the Reply-To, name and builder changed in between',
  () => withSend(async (h, mail, from) => {
    const { send: pending } = await send(mail, from, 'one');
    await h.sends.crashAfter('stored');
    await h.advance(UNDO);
    const first = await h.sends.registration(pending.id);
    assert.ok(first?.key && first.digest);
    const bytes = h.objects.get(objectPath(first.key))!;
    assert.equal(sha256(bytes), first.digest);
    await h.restore();
    assert.equal((await mail.getSend(pending.id)).state, 'pending', 'the restore rewound the unpublished release');
    const { mailbox } = await mail.getSession();
    await h.as('admin').updateMailbox(mailbox!.id, { displayName: 'Renamed Owner' });
    await h.sends.setReplyTo([{ email: 'replies@example.com', name: 'Replies' }]);
    await h.sends.bumpBuilder();
    await h.advance(UNDO);
    assert.equal((await mail.getSend(pending.id)).state, 'sending');
    assert.deepEqual(await h.sends.registration(pending.id), first, 'the same digest and key');
    assert.equal(sha256(h.objects.get(objectPath(first.key))!), first.digest, 'the same bytes');
    const builds = await h.sends.builds();
    assert.deepEqual(builds.slice(-2).map(({ version }) => version), [1, 1], 'both runs used the frozen builder version');
    // A send made after the changes freezes the new inputs.
    const { send: later } = await send(mail, from, 'later');
    await h.advance(UNDO);
    assert.equal((await h.sends.builds()).at(-1)?.version, 2);
    const text = new TextDecoder().decode(h.objects.get(objectPath((await h.sends.registration(later.id))!.key!)));
    assert.match(text, /^From: "Renamed Owner" </m);
    assert.match(text, /^Reply-To: "Replies" <replies@example\.com>/m);
    assert.doesNotMatch(new TextDecoder().decode(bytes), /Renamed Owner|Reply-To/);
  }));

test('a source the sweeper confirmed lost fails the send at release with delivery_error for every recipient, internal and external', () => withSend(async (h, mail, from) => {
  await h.confirmFailure(true);
  const draft = await mail.createDraft(draftInput(from, { to: [{ email: 'friend@example.net' }, { email: 'other@example.com' }] }), key('draft'));
  await h.advance(minute);
  const [confirmation] = await h.confirmations();
  assert.ok(confirmation.holder.startsWith('draft:'));
  const pending = await mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision });
  assert.ok((await h.confirmations()).length >= 1, 'the send keeps the pending confirmation');
  // The sweeper retired and deleted the revision's generation: its object is gone and confirm answers lost.
  h.objects.delete(objectPath(confirmation.object_key));
  await h.sends.forceLost(confirmation.holder);
  await h.confirmFailure(false);
  await h.forceSnapshot();
  await h.advance(UNDO);
  const failed = await mail.getSend(pending.id);
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })), Array(2).fill({ state: 'failed', reason: 'delivery_error' }));
  assert.deepEqual(await h.sends.queue(), []);
  assert.deepEqual(await sentCopies(mail), []);
  await h.advance(minute);
  assert.ok((await h.alerts()).includes('mail:holder_source_lost'));
}));

test('a transient source read failure never fails the send; release retries until the object reads again', () => withSend(async (h, mail, from) => {
  const { draft, send: pending } = await send(mail, from, 'one');
  const [path] = [...h.objects.keys()].filter(item => item.includes('/raw/'));
  const stored = h.objects.get(path)!;
  h.objects.delete(path);
  await h.advance(UNDO);
  await h.advance(DRIVE_BACKOFF);
  assert.equal((await h.sends.row(pending.id))?.state, 'releasing');
  assert.equal((await mail.getSend(pending.id)).state, 'sending');
  h.objects.set(path, stored);
  await h.advance(2 * DRIVE_BACKOFF);
  assert.equal((await mail.getSend(pending.id)).state, 'sending');
  assert.equal((await h.sends.row(pending.id))?.state, 'queued');
  assert.equal((await h.sends.queue()).length, 1);
  void draft;
}));

test('pending confirmations of the draft revision and its uploads survive sendDraft and confirm after its publish', () => withSend(async (h, mail, from) => {
  await h.confirmFailure(true);
  const uploaded = await mail.createUpload({ name: 'note.txt', type: 'text/plain', bytes: new Blob(['attachment']) }, key('upload'));
  const draft = await mail.createDraft(draftInput(from, { attachments: [{ kind: 'upload', uploadId: uploaded.id }] }), key('draft'));
  await h.advance(minute);
  const before = await h.confirmations();
  assert.equal(before.length, 3, 'the upload holder, and the draft holder on the revision and the upload');
  await mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision });
  assert.deepEqual(await h.confirmations(), before);
  await h.confirmFailure(false);
  await h.advance(minute);
  assert.deepEqual(await h.confirmations(), []);
  for (const { object_key: objectKey, holder } of before) {
    assert.deepEqual((await h.holderDetails(objectKey)).filter(row => row.holder === holder).map(({ state }) => state), ['held']);
  }
  // The send keeps its upload referenced: it does not expire while the send is unfinished.
  await h.advance(25 * 60 * minute);
  const reused = await mail.createDraft(draftInput(from, { attachments: [{ kind: 'upload', uploadId: uploaded.id }] }), key('reuse'));
  assert.equal(reused.attachments.length, 1);
}));

test('the send keeps a forwarded part\'s holder through release, builds it through the MIME port, and releases it only after its finish is published',
  { timeout: 60_000 }, () => withSend(async (h, mail, from) => {
    const part = new TextEncoder().encode('forwarded file contents');
    const source = await h.deliver({ from: { name: 'Sender', email: 'sender@example.net' }, to: [{ name: '', email: from }], subject: 'Forward this',
      text: 'See attached', attachments: [{ name: 'notes.txt', type: 'text/plain', bytes: part }] });
    const { messages: [delivered] } = await mail.getThread(source.threadId);
    const attachment = { kind: 'message' as const, messageId: source.messageId, part: delivered.attachments[0].part };
    const admin = h.as('admin');
    const alias = (await admin.createAlias({ mailboxId: (await mail.getSession()).mailbox!.id, address: 'sales@example.com', sendAs: true },
      key('alias'))).address;
    await h.sends.activateAlias(alias);
    const kept = await mail.createDraft(draftInput(from, { forwardOf: source.messageId, attachments: [attachment] }), key('kept'));
    const failing = await mail.createDraft(draftInput(alias, { forwardOf: source.messageId, attachments: [attachment] }), key('failing'));
    await mail.updateThreads({ ids: [source.threadId], set: { folder: 'trash' } });
    await h.advance(30 * day);
    await h.purgeTrash();
    const sendKept = await mail.sendDraft(kept.id, { ...key('send-kept'), ifMatch: kept.revision });
    const sendFailing = await mail.sendDraft(failing.id, { ...key('send-failing'), ifMatch: failing.revision });
    const [sourceKey] = (JSON.parse((await h.sends.row(sendKept.id))!.record) as { attachmentKeys: string[] }).attachmentKeys;
    assert.match(sourceKey, /^raw\//, 'a small forwarded part stays inside its source message');
    const holdersOf = async () => (await h.holderDetails(sourceKey)).filter(({ state }) => state === 'held').map(({ holder }) => holder);
    assert.ok(!(await holdersOf()).some(holder => holder.startsWith('message:')), 'the source message released its holder');
    assert.equal((await holdersOf()).filter(holder => holder.startsWith('draft:')).length, 2);
    await admin.deleteAlias(alias);
    const builds = (await h.sends.builds()).length;
    await h.advance(UNDO);
    assert.deepEqual((await h.sends.builds()).slice(builds), [{ version: 1, parts: [part.byteLength] }], 'the release read the part through the port');
    assert.equal((await mail.getSend(sendKept.id)).state, 'sending');
    assert.equal((await mail.getSend(sendFailing.id)).state, 'failed');
    const [copy] = await sentCopies(mail);
    assert.deepEqual(copy.attachments.map(({ name, size }) => ({ name, size })), [{ name: 'notes.txt', size: part.byteLength }]);
    await h.advance(minute);
    const remaining = await holdersOf();
    const holderOf = (draftId: string) => remaining.find(holder => holder.includes(`:${draftId}:`));
    assert.ok(holderOf(kept.id), 'the released, unfinished send keeps the part');
    assert.equal(holderOf(failing.id), undefined, 'the finished send released it after its publish');
  }));

test('undo with the limiter on: with the send bucket and other sends\' undo buckets exhausted, an undo in the window cancels and nothing goes out', {
  skip: 'pending R1 (request rate limits): the gateway limiter and its fake bindings are not on main yet; finish after a rebase onto R1',
}, () => withSend(async (h, mail, from) => {
  const { send: pending } = await send(mail, from, 'one');
  // After R1: exhaust this mailbox's send bucket and the undo buckets of other send ids here.
  await mail.undoSend(pending.id, key('undo'));
  await h.advance(UNDO);
  assert.equal((await mail.getSend(pending.id)).state, 'cancelled');
  assert.deepEqual(await h.sends.queue(), []);
  assert.equal(await h.sends.emailCalls(), 0);
}));

test('after a restore, undo works at once while restored messages still wait for reindexing', () => withSend(async (h, mail, from) => {
  const { send: released } = await send(mail, from, 'released');
  await h.advance(UNDO);
  assert.equal((await mail.getSend(released.id)).state, 'sending');
  const { send: pending } = await send(mail, from, 'pending');
  await h.restore();
  await rejects(mail.listThreads({ view: 'sent' }), 'mailbox_restoring');
  assert.equal((await mail.getSend(pending.id)).state, 'pending');
  const draft = await mail.undoSend(pending.id, key('undo'));
  assert.equal(draft.id, pending.draftId);
  assert.equal((await mail.getSend(pending.id)).state, 'cancelled');
}));

test('a send with an empty uploaded file is released and enqueued', () => withSend(async (h, mail, from) => {
  const empty = await mail.createUpload({ name: 'empty.txt', type: 'text/plain', bytes: new Blob([]) }, key('empty'));
  assert.equal(empty.size, 0);
  const { send: pending } = await send(mail, from, 'one', { attachments: [{ kind: 'upload', uploadId: empty.id }] });
  await h.advance(UNDO);
  assert.equal((await mail.getSend(pending.id)).state, 'sending');
  assert.equal((await h.sends.queue()).length, 1);
  const [copy] = await sentCopies(mail);
  assert.deepEqual(copy.attachments.map(({ name, size }) => ({ name, size })), [{ name: 'empty.txt', size: 0 }]);
}));

test('same-key replays wait only for their own publish, not for later unrelated changes', () => withSend(async (h, mail, from) => {
  const { draft, send: pending } = await send(mail, from, 'one');
  const other = await send(mail, from, 'two');
  const undone = await mail.undoSend(other.send.id, key('undo'));
  await h.publishFailure(true);
  // An unrelated change that cannot be published while the outage lasts.
  await mail.createLabel({ name: 'Unpublished' }, key('label'));
  const replay = await mail.sendDraft(draft.id, { ...key('send-one'), ifMatch: draft.revision });
  assert.equal(replay.id, pending.id);
  assert.deepEqual(await mail.undoSend(other.send.id, key('undo')), undone);
  await h.publishFailure(false);
}));

test('a barrier behind a stalled publish answers 409 within its budget, and the retry returns the send', () => withSend(async (h, mail, from) => {
  const draft = await mail.createDraft(draftInput(from), key('draft'));
  await h.sends.shortBarrier();
  await h.sends.stallPublish();
  const lane = h.advance(minute); // The backup lane starts publishing the draft and stalls in its write.
  await h.sends.publishStalled();
  const started = Date.now();
  const answer = await post(h, mail, `/drafts/${draft.id}/send`, 'send', draft.revision);
  assert.equal(answer.status, 409);
  assert.ok(Date.now() - started < 10 * second, 'the answer does not wait for the stalled write');
  await h.sends.resumePublish();
  await lane;
  const sent = await mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision });
  assert.equal(sent.state, 'pending');
  assert.equal((await mail.listSends({})).items.length, 1);
}));

test('an undo followed by a resend of the restored draft attributes a lost source to the resend, which fails with delivery_error', () => withSend(async (h, mail, from) => {
  await h.confirmFailure(true);
  const draft = await mail.createDraft(draftInput(from), key('draft'));
  await h.advance(minute);
  const [confirmation] = await h.confirmations();
  const first = await mail.sendDraft(draft.id, { ...key('send-a'), ifMatch: draft.revision });
  const restored = await mail.undoSend(first.id, key('undo'));
  const resend = await mail.sendDraft(restored.id, { ...key('send-b'), ifMatch: restored.revision });
  h.objects.delete(objectPath(confirmation.object_key));
  await h.sends.forceLost(confirmation.holder);
  await h.confirmFailure(false);
  await h.forceSnapshot();
  await h.advance(UNDO);
  assert.equal((await mail.getSend(first.id)).state, 'cancelled');
  const failed = await mail.getSend(resend.id);
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })), [{ state: 'failed', reason: 'delivery_error' }]);
}));

test('the stand-in builder keeps every stored header line under 998 octets', () => withSend(async (h, mail, from) => {
  const to = Array.from({ length: 20 }, (_, i) => ({ email: `person${i}@example.net`, name: `${'Långt namn '.repeat(20)}${i}` }));
  const { send: pending } = await send(mail, from, 'long', { subject: 'S'.repeat(998), to });
  await h.advance(UNDO);
  const text = new TextDecoder().decode(h.objects.get(objectPath((await h.sends.registration(pending.id))!.key!)));
  const lines = text.split('\r\n');
  assert.ok(lines.every(line => new TextEncoder().encode(line).byteLength <= 998), 'no line over 998 octets');
  const [copy] = await sentCopies(mail);
  assert.equal(copy.subject, 'S'.repeat(998));
  assert.equal(copy.to.length, 20);
  assert.equal(copy.to[19].name, `${'Långt namn '.repeat(20)}19`);
}));

test('a send reports pending until its release commit is published', () => withSend(async (h, mail, from) => {
  const { send: pending } = await send(mail, from, 'one');
  await h.sends.crashAfter('released');
  await h.advance(UNDO);
  assert.equal((await h.sends.row(pending.id))?.state, 'releasing');
  assert.equal((await mail.getSend(pending.id)).state, 'pending', 'a restore could still rewind the release');
  await h.advance(minute);
  assert.equal((await mail.getSend(pending.id)).state, 'sending');
}));

test('a deploy without the frozen builder version holds the send as an invariant breach instead of failing it', () => withSend(async (h, mail, from) => {
  const { send: pending } = await send(mail, from, 'one');
  await h.sends.dropBuilder(true);
  await h.advance(UNDO);
  assert.equal((await h.sends.row(pending.id))?.state, 'releasing');
  assert.equal(await h.sends.registration(pending.id), null, 'nothing is registered or stored');
  await h.advance(minute);
  assert.ok((await h.alerts()).includes('mail:send_invariant'));
  await h.sends.dropBuilder(false);
  await h.advance(DRIVE_BACKOFF);
  assert.equal((await mail.getSend(pending.id)).state, 'sending');
}));

test('a barrier queued behind a publish that covers its commit answers with the send, not 409', () => withSend(async (h, mail, from) => {
  const draft = await mail.createDraft(draftInput(from), key('draft'));
  await h.sends.stallPublish();
  const lane = h.advance(minute); // The backup lane holds the publish lane, stalled in its first write.
  await h.sends.publishStalled();
  const answer = post(h, mail, `/drafts/${draft.id}/send`, 'send', draft.revision);
  await until(async () => (await h.sends.ids()).length === 1, 'the send commit');
  // The lane's publish continues through the new commit before the queued barrier runs.
  await h.sends.resumePublish();
  const response = await answer;
  assert.equal(response.status, 202);
  await lane;
}));

test('the mailbox state moves when a publish makes a send visible', () => withSend(async (h, mail, from) => {
  const draft = await mail.createDraft(draftInput(from), key('draft'));
  await h.publishFailure(true);
  assert.equal((await post(h, mail, `/drafts/${draft.id}/send`, 'send', draft.revision)).status, 409);
  const hidden = await mail.listSends({});
  assert.deepEqual(hidden.items, []);
  await h.publishFailure(false);
  await h.forceSnapshot(); // The backup lane publishes; nothing else changes.
  const shown = await mail.listSends({});
  assert.equal(shown.items.length, 1);
  assert.notEqual(shown.state, hidden.state);
  assert.equal((await mail.getSession()).state, shown.state);
}));
