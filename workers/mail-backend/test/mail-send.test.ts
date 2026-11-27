import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { indexedAttachmentName } from '../../../contracts/mail-api/src/headers.ts';
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

// Runs the lane until restored messages are reindexed and the mailbox serves
// reads again. Send reads serve before reindexing; the Sent view waits for it.
async function settle(h: Fixture, mail: MailService) {
  for (let advances = 0; ; advances++) {
    try { await mail.listThreads({ view: 'sent' }); return; }
    catch (error) { if (!isMailApiError(error, 'mailbox_restoring')) throw error; }
    if (advances === 5) throw new Error('Mailbox did not settle after its restore');
    await h.advance(minute);
  }
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
    const [undo, alarm] = await Promise.allSettled([mail.undoSend(pending.id, key(`undo-${i}`)), h.advance(second)]);
    assert.equal(alarm.status, 'fulfilled', alarm.status === 'rejected' ? String(alarm.reason) : undefined);
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
// Fails instead of hanging when a bounded wait stops being bounded.
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}
// Polls `check` until it holds. The whole poll has one deadline, so a check
// that never settles fails the wait instead of blocking it.
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000) {
  let stopped = false;
  const poll = async () => {
    while (!stopped && !(await check())) await new Promise(resolve => setTimeout(resolve, 10));
  };
  try { await within(poll(), ms, `waiting for ${what}`); }
  finally { stopped = true; }
}

test('late PUT after release: an overtaken PUT lands after the send was cancelled and released; its object sits under an unheld ledger generation and is swept',
  () => withSend(async (h, mail, from) => {
    const { send: pending } = await send(mail, from, 'one');
    await h.sends.shortHandlerBudget();
    const put = h.pauseNextPut();
    let registration: Awaited<ReturnType<typeof h.sends.registration>>;
    // The paused PUT is released before the fixture closes, whatever fails.
    try {
      const running = h.advance(UNDO);
      await put.started;
      await running;
      registration = await h.sends.registration(pending.id);
      assert.ok(registration?.key);
      // The release commit was never published, so a restore rewinds it, and the user undoes the send.
      await h.restore();
      assert.equal((await mail.getSend(pending.id)).state, 'pending');
      await mail.undoSend(pending.id, key('undo'));
      // The stalled call still holds its ref in this isolate for one timer lease.
      await h.advance(DRIVE_BACKOFF + second);
      assert.equal((await h.sends.registration(pending.id))?.released, 'all');
      assert.deepEqual((await h.holderDetails(registration.key)).map(({ state }) => state), ['tombstone', 'tombstone']);
    } finally { put.release(); }
    assert.ok(registration?.key);
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
    const owner = next === 'finishes' ? h.as('newAdmin') : mail;
    let settled: Send;
    // The paused PUT is released before the fixture closes, whatever fails.
    try {
      const running = h.advance(UNDO);
      await put.started;
      await running;
      const { mailbox } = await mail.getSession();
      if (next === 'finishes') await h.as('admin').updateMailbox(mailbox!.id, { ownerUserId: (await owner.getSession()).user.id });
      await h.advance(10 * minute);
      // The short handler budget lets the alarm return while the next firing
      // still runs: wait until it has finished, or published and enqueued.
      if (next === 'finishes') await until(async () => (await h.sends.row(pending.id))?.finish_pending === 0, 'the finish');
      else await until(async () => (await h.sends.queue()).length === 1 && !!(await owner.getSend(pending.id)).messageId, 'the publish and enqueue');
      settled = await owner.getSend(pending.id);
      assert.equal(settled.state, next === 'finishes' ? 'failed' : 'sending');
    } finally { put.release(); }
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

test('undo with the limiter on: with the send bucket and other sends\' undo buckets exhausted, an undo in the window cancels and nothing goes out',
  () => withSend(async (h, mail, from) => {
    await h.sends.rateCap('MAIL_RATE_SENDS', 2);
    await h.sends.rateCap('MAIL_RATE_UNDO', 1);
    const { send: pending } = await send(mail, from, 'one');
    await send(mail, from, 'two');
    const third = await mail.createDraft(draftInput(from), key('draft-three'));
    await rejects(mail.sendDraft(third.id, { ...key('send-three'), ifMatch: third.revision }), 'rate_limited');
    // Exhaust the undo buckets of other send ids.
    for (const other of ['01JOTHER000000000000000001', '01JOTHER000000000000000002']) {
      await rejects(mail.undoSend(other, key(`undo-${other}`)), 'not_found');
      await rejects(mail.undoSend(other, key(`undo-${other}`)), 'rate_limited');
    }
    const draft = await mail.undoSend(pending.id, key('undo'));
    assert.equal(draft.id, pending.draftId);
    await h.advance(UNDO);
    assert.equal((await mail.getSend(pending.id)).state, 'cancelled');
    assert.deepEqual((await h.sends.queue()).filter(({ sendId }) => sendId === pending.id), []);
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
  let answer: Response;
  try { answer = await within(post(h, mail, `/drafts/${draft.id}/send`, 'send', draft.revision), 10 * second, 'the barrier'); }
  finally { await h.sends.resumePublish(); }
  assert.equal(answer.status, 409);
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

test('a barrier that times out after the publish holding the lane already covered its commit answers with the send', () => withSend(async (h, mail, from) => {
  const draft = await mail.createDraft(draftInput(from), key('draft'));
  await h.sends.shortBarrier(2 * second);
  await h.sends.holdPublishLane();
  const answer = post(h, mail, `/drafts/${draft.id}/send`, 'send', draft.revision);
  await until(async () => (await h.sends.ids()).length === 1, 'the send commit');
  // The publish ahead covers the send, then keeps the lane past the barrier's budget.
  let response: Response;
  try {
    await h.sends.coverHeld();
    response = await within(answer, 10 * second, 'the barrier');
  } finally { await h.sends.releaseHeld(); }
  assert.equal(response.status, 202);
  assert.equal((await response.json() as Send).state, 'pending');
}));

test('a finish run overtaken by a restore releases nothing: the restored pending send keeps its registration free and goes out after its fresh window',
  () => withSend(async (h, mail, from) => {
    const { send: pending } = await send(mail, from, 'one');
    // The undo commits, but its publish fails, so a restore loses it with its delta.
    await h.publishFailure(true);
    assert.equal((await post(h, mail, `/sends/${pending.id}/undo`, 'undo')).status, 409);
    await h.publishFailure(false);
    const terminalSeq = (await h.sends.row(pending.id))?.terminal_seq;
    assert.ok(terminalSeq);
    await h.sends.shortHandlerBudget();
    // The finish run of the cancelled send stops just before its publish.
    await h.sends.pausePublishThrough(terminalSeq);
    try {
      await h.advance(second);
      await h.sends.publishThroughPaused();
      await h.restore();
      const restored = await mail.getSend(pending.id);
      assert.equal(restored.state, 'pending', 'the restore lost the unpublished undo');
      assert.ok(restored.undoRemainingMs > 0, 'with a fresh window');
    } finally { await h.sends.resumePublishThrough(); }
    // The overtaken run now publishes through its old seq, which the restored journal reused.
    await h.sends.driveIdle();
    assert.equal(await h.sends.registration(pending.id), null, 'the overtaken run released nothing');
    assert.equal((await h.sends.row(pending.id))?.state, 'pending');
    // The short handler budget's real-time clock set the window a few milliseconds later.
    await h.advance(UNDO + second);
    await h.sends.driveIdle();
    assert.equal((await mail.getSend(pending.id)).state, 'sending');
    assert.ok((await h.sends.registration(pending.id))?.key, 'the restored send registered and stored its copy');
    assert.equal((await h.sends.queue()).length, 1);
  }));

const HELD_RECHECK = 15 * minute;
// The send path is switched off with a pending send, its undo window passes, and the path is switched on again.
async function heldWhileOff(h: Fixture, mail: MailService, from: string) {
  const { send: pending } = await send(mail, from, 'one');
  const dateAt = (JSON.parse((await h.sends.row(pending.id))!.record) as { dateAt: number }).dateAt;
  await h.sends.switchPath(false);
  await h.advance(UNDO);
  assert.equal((await h.sends.row(pending.id))?.state, 'pending');
  await rejects(mail.undoSend(pending.id, key('undo-off')), 'not_implemented');
  await h.sends.switchPath(true);
  await h.advance(HELD_RECHECK);
  const fresh = await mail.getSend(pending.id);
  assert.equal(fresh.state, 'pending', 'not released on the first firing with the path on');
  assert.equal(fresh.undoRemainingMs, UNDO, 'a fresh undo window from now');
  assert.ok(Date.parse(fresh.undoUntil) > Date.parse(pending.undoUntil));
  const row = await h.sends.row(pending.id);
  assert.equal(row?.undo_until, Date.parse(fresh.undoUntil));
  assert.equal((JSON.parse(row!.record) as { dateAt: number }).dateAt, dateAt, 'dateAt never moves');
  assert.equal((await h.sends.driver(pending.id))?.held, 0, 'the mark is cleared');
  assert.equal(await h.sends.registration(pending.id), null);
  assert.deepEqual(await h.sends.queue(), []);
  return { pending, fresh };
}

test('send path off: a held pending send gets a fresh undo window when the path is on again, and an undo in it cancels with nothing sent',
  () => withSend(async (h, mail, from) => {
    const { pending } = await heldWhileOff(h, mail, from);
    const draft = await mail.undoSend(pending.id, key('undo'));
    assert.equal(draft.id, pending.draftId);
    await h.advance(UNDO);
    await h.advance(DRIVE_BACKOFF);
    assert.equal((await mail.getSend(pending.id)).state, 'cancelled');
    assert.deepEqual(await h.sends.queue(), []);
    assert.deepEqual(await sentCopies(mail), []);
    assert.equal(await h.sends.emailCalls(), 0);
  }));

test('send path off: a held pending send that is not undone is released after its fresh window', () => withSend(async (h, mail, from) => {
  const { pending, fresh } = await heldWhileOff(h, mail, from);
  await h.advance(Date.parse(fresh.undoUntil) - Date.parse(pending.undoUntil) - HELD_RECHECK - second);
  assert.equal((await mail.getSend(pending.id)).state, 'pending', 'still inside the fresh window');
  await h.advance(second);
  assert.equal((await mail.getSend(pending.id)).state, 'sending');
  assert.deepEqual(await h.sends.queue(), [{ kind: 'dispatch', ws: 'w1', mb: 'mailbox-a', sendId: pending.id }]);
  assert.deepEqual((await sentCopies(mail)).map(({ send: item }) => item?.id), [pending.id]);
  assert.equal(await h.sends.emailCalls(), 0);
}));

test('undo of a send whose source the sweeper confirmed lost answers send_not_pending and commits nothing; release fails it with delivery_error',
  () => withSend(async (h, mail, from) => {
    await h.confirmFailure(true);
    const draft = await mail.createDraft(draftInput(from), key('draft'));
    await h.advance(minute);
    const [confirmation] = await h.confirmations();
    const pending = await mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision });
    // The sweeper deleted the revision's generation: its object is gone and confirm answers lost.
    h.objects.delete(objectPath(confirmation.object_key));
    await h.sends.forceLost(confirmation.holder);
    await h.confirmFailure(false);
    await h.forceSnapshot();
    const events = await h.eventCount('send_undo');
    for (const attempt of ['undo', 'undo']) await rejects(mail.undoSend(pending.id, key(attempt)), 'send_not_pending');
    assert.equal(await h.eventCount('send_undo'), events, 'the undo committed nothing');
    await rejects(mail.getDraft(draft.id), 'not_found');
    assert.equal((await mail.getSend(pending.id)).state, 'pending');
    await h.advance(UNDO);
    const failed = await mail.getSend(pending.id);
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })), [{ state: 'failed', reason: 'delivery_error' }]);
    assert.deepEqual(await h.sends.queue(), []);
    assert.deepEqual(await sentCopies(mail), []);
    assert.equal(await h.sends.emailCalls(), 0);
  }));

// A delivered message with one small attachment, kept inside its raw object, and a draft forwarding it.
async function forwardDraft(h: Fixture, mail: MailService, from: string) {
  const bytes = new TextEncoder().encode('forwarded file contents');
  const source = await h.deliver({ from: { name: 'Sender', email: 'sender@example.net' }, to: [{ name: '', email: from }], subject: 'Forward this',
    text: 'See attached', attachments: [{ name: 'notes.txt', type: 'text/plain', bytes }] });
  const { messages: [delivered] } = await mail.getThread(source.threadId);
  const attachment = { kind: 'message' as const, messageId: source.messageId, part: delivered.attachments[0].part };
  const draft = await mail.createDraft(draftInput(from, { forwardOf: source.messageId, attachments: [attachment] }), key('draft'));
  const pending = await mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision });
  return { bytes, attachment, pending };
}

test('a small forwarded part is fingerprinted when attached, frozen in the send record and released when its bytes match', () => withSend(async (h, mail, from) => {
  const { bytes, attachment, pending } = await forwardDraft(h, mail, from);
  const record = JSON.parse((await h.sends.row(pending.id))!.record) as { attachmentKeys: string[]; parts?: unknown };
  assert.match(record.attachmentKeys[0], /^raw\//, 'the part stays inside its source message');
  assert.deepEqual(record.parts, [{ messageId: attachment.messageId, part: attachment.part, digest: sha256(bytes.buffer as ArrayBuffer), size: bytes.byteLength }]);
  await h.advance(UNDO);
  assert.equal((await mail.getSend(pending.id)).state, 'sending');
  const [copy] = await sentCopies(mail);
  assert.deepEqual(copy.attachments.map(({ name, size }) => ({ name, size })), [{ name: 'notes.txt', size: bytes.byteLength }]);
}));

test('a forwarded part that no longer decodes to its frozen digest fails the send with delivery_error, an alert and no MIME', () => withSend(async (h, mail, from) => {
  const { pending } = await forwardDraft(h, mail, from);
  await h.sends.changePartDigest(pending.id);
  const builds = (await h.sends.builds()).length;
  await h.advance(UNDO);
  const failed = await mail.getSend(pending.id);
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })), [{ state: 'failed', reason: 'delivery_error' }]);
  assert.equal((await h.sends.builds()).length, builds, 'no MIME was built');
  assert.equal((await h.sends.registration(pending.id))?.key ?? null, null, 'nothing was registered or stored');
  assert.deepEqual(await h.sends.queue(), []);
  assert.deepEqual(await sentCopies(mail), []);
  await h.advance(minute);
  assert.ok((await h.alerts()).includes('mail:holder_source_lost'));
  assert.equal(await h.sends.emailCalls(), 0);
}));

test('an invariant breach followed by recovery leaves no breach row and no active alert', () => withSend(async (h, mail, from) => {
  const { send: pending } = await send(mail, from, 'one');
  await h.sends.dropBuilder(true);
  await h.advance(UNDO);
  assert.deepEqual(await h.sends.breaches(), [pending.id]);
  await h.advance(minute);
  assert.ok((await h.sends.activeAlerts()).includes('send_invariant'));
  await h.sends.dropBuilder(false);
  await h.advance(DRIVE_BACKOFF);
  assert.equal((await mail.getSend(pending.id)).state, 'sending');
  assert.deepEqual(await h.sends.breaches(), [], 'release step 3 passed, so the breach is over');
  await h.advance(minute);
  assert.ok(!(await h.sends.activeAlerts()).includes('send_invariant'), 'and its alert is no longer active');
}));

test('an undo resets the drive backoff: after failed publishes raised it, the cancelled send\'s finish is re-armed at the normal retry',
  () => withSend(async (h, mail, from) => {
    const draft = await mail.createDraft(draftInput(from), key('draft'));
    let elapsed = 0;
    const step = async (ms: number) => { await h.advance(ms); elapsed += ms; };
    await h.publishFailure(true);
    assert.equal((await post(h, mail, `/drafts/${draft.id}/send`, 'send', draft.revision)).status, 409);
    const [id] = await h.sends.ids();
    // Each firing fails its publish and doubles the backoff: 5, 10, then 20 minutes.
    await step(UNDO);
    await step(DRIVE_BACKOFF);
    await step(2 * DRIVE_BACKOFF);
    assert.ok((await h.sends.driver(id))!.backoff > 2 * DRIVE_BACKOFF);
    await h.publishFailure(false);
    await h.sends.releaseFailure(true);
    await mail.undoSend(id, key('undo'));
    // The finish publishes, then its release fails: the row waits for the normal retry.
    await step(second);
    const [row] = (await driveRows(h)).filter(({ ref }) => ref === id);
    assert.equal(row?.due_at, h.startedAt + elapsed + DRIVE_BACKOFF);
    await h.sends.releaseFailure(false);
    await step(DRIVE_BACKOFF);
    assert.deepEqual(await driveRows(h), [], 'the cancelled send finished at the normal retry');
    assert.equal((await mail.getSend(id)).state, 'cancelled');
  }));

test('sendDraft of a legacy drafts/ revision first stores it as a raw/ generation, then sends it', () => withSend(async (h, mail, from) => {
  const legacy = await h.sends.seedLegacyDraft({ version: 1,
    fields: { from, to: [{ email: 'friend@example.net' }], cc: [], bcc: [], subject: 'Legacy draft', body: 'Written before M3-2' } });
  assert.equal((await mail.getDraft(legacy.id)).revision, legacy.revision);
  const pending = await mail.sendDraft(legacy.id, { ...key('send'), ifMatch: legacy.revision });
  assert.equal(pending.state, 'pending');
  assert.equal(pending.draftId, legacy.id);
  const record = JSON.parse((await h.sends.row(pending.id))!.record) as { draft: { rawKey: string; holder: string } };
  assert.match(record.draft.rawKey, /^raw\/[0-9a-f]{64}\//);
  assert.notEqual(record.draft.holder, legacy.holder);
  await h.advance(UNDO);
  assert.equal((await mail.getSend(pending.id)).state, 'sending');
  assert.deepEqual((await sentCopies(mail)).map(({ subject }) => subject), ['Legacy draft']);
  assert.equal((await h.sends.queue()).length, 1);
  await h.advance(minute);
  assert.ok(!(await h.holderDetails(legacy.rawKey)).some(({ holder, state }) => holder === legacy.holder && state === 'held'),
    'the legacy revision\'s holder is released after the publish, like any replaced revision');
}));

test('a forwarded part whose decoded size differs from its indexed size is refused when attached', () => withSend(async (h, mail, from) => {
  const source = await h.deliver({ from: { name: 'Sender', email: 'sender@example.net' }, to: [{ name: '', email: from }], subject: 'Forward this',
    text: 'See attached', attachments: [{ name: 'notes.txt', type: 'text/plain', bytes: new TextEncoder().encode('forwarded file contents') }] });
  const { messages: [delivered] } = await mail.getThread(source.threadId);
  const { part } = delivered.attachments[0];
  await h.sends.changeAttachmentSize(source.messageId, part, 1);
  await rejects(mail.createDraft(draftInput(from, { attachments: [{ kind: 'message', messageId: source.messageId, part }] }), key('draft')), 'not_found');
}));

test('the synthetic "(N more attachments)" row of a message without its display mark cannot be forwarded', { timeout: 60_000 }, () => withSend(async (h, mail, from) => {
  const bytes = new TextEncoder().encode('tiny');
  const source = await h.deliver({ from: { name: 'Sender', email: 'sender@example.net' }, to: [{ name: '', email: from }], subject: 'Many files',
    text: 'Attached', attachments: Array.from({ length: 514 }, (_, i) => ({ name: `f${i}.txt`, type: 'text/plain', bytes })) });
  // Part 512 stands for the last three attachments; the parser decodes it as the 512th file alone.
  await h.sends.dropSyntheticMark(source.messageId);
  await rejects(mail.createDraft(draftInput(from, { attachments: [{ kind: 'message', messageId: source.messageId, part: 512 }] }), key('draft')),
    'not_found');
  const kept = await mail.createDraft(draftInput(from, { attachments: [{ kind: 'message', messageId: source.messageId, part: 511 }] }), key('kept'));
  assert.equal(kept.attachments.length, 1, 'a real part of the same message still attaches');
}));

test('a send whose frozen part size differs from the size it lays out fails with delivery_error instead of retrying forever', () => withSend(async (h, mail, from) => {
  const source = await h.deliver({ from: { name: 'Sender', email: 'sender@example.net' }, to: [{ name: '', email: from }], subject: 'Forward this',
    text: 'See attached', attachments: [{ name: 'notes.txt', type: 'text/plain', bytes: new TextEncoder().encode('forwarded file contents') }] });
  const { messages: [delivered] } = await mail.getThread(source.threadId);
  const draft = await h.sends.seedForwardDraft({ from, messageId: source.messageId, part: delivered.attachments[0].part, delta: 1,
    to: ['friend@example.net', 'other@example.com'] });
  const pending = await mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision });
  const builds = (await h.sends.builds()).length;
  await h.advance(UNDO);
  const failed = await mail.getSend(pending.id);
  assert.equal(failed.state, 'failed');
  // One external and one internal recipient, both failed with the same reason.
  assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })), Array(2).fill({ state: 'failed', reason: 'delivery_error' }));
  assert.equal((await h.sends.builds()).length, builds, 'no MIME was built');
  assert.deepEqual(await h.sends.queue(), []);
  await h.advance(minute);
  assert.ok((await h.alerts()).includes('mail:holder_source_lost'));
}));

test('converting a legacy draft does not shorten the undo window', () => withSend(async (h, mail, from) => {
  const legacy = await h.sends.seedLegacyDraft({ version: 1,
    fields: { from, to: [{ email: 'friend@example.net' }], cc: [], bcc: [], subject: 'Legacy draft', body: 'Written before M3-2' } });
  const put = h.pauseNextPut();
  let sending: Promise<Send> | undefined, moving: Promise<void> | undefined;
  try {
    sending = mail.sendDraft(legacy.id, { ...key('send'), ifMatch: legacy.revision });
    await within(put.started, 10 * second, 'the conversion PUT');
    // The conversion's storage takes two seconds.
    const before = await h.sends.now();
    moving = h.advance(2 * second);
    await until(async () => await h.sends.now() === before + 2 * second, 'the clock to move');
  } finally { put.release(); }
  const pending = await sending!;
  await moving;
  assert.equal(pending.undoRemainingMs, UNDO, 'the window starts once the send is committed');
}));

// 514 files where the last two are empty: the synthetic row for parts 512 to 514 then has the size of the real 512th file.
async function emptyTail(h: Fixture, from: string) {
  const files = Array.from({ length: 514 }, (_, i) => ({ name: `f${i}.txt`, type: 'text/plain', bytes: new TextEncoder().encode(i < 512 ? 'tiny' : '') }));
  const source = await h.deliver({ from: { name: 'Sender', email: 'sender@example.net' }, to: [{ name: '', email: from }], subject: 'Many files',
    text: 'Attached', attachments: files });
  await h.sends.dropSyntheticMark(source.messageId);
  return source;
}

test('the synthetic row cannot be forwarded even when its size matches the real file it covers', { timeout: 60_000 }, () => withSend(async (h, mail, from) => {
  const source = await emptyTail(h, from);
  await rejects(mail.createDraft(draftInput(from, { attachments: [{ kind: 'message', messageId: source.messageId, part: 512 }] }), key('draft')),
    'not_found');
}));

test('a send already fingerprinted on the synthetic row fails with delivery_error for internal and external recipients', { timeout: 60_000 },
  () => withSend(async (h, mail, from) => {
    const source = await emptyTail(h, from);
    const draft = await h.sends.seedForwardDraft({ from, messageId: source.messageId, part: 512, delta: 0,
      to: ['friend@example.net', 'other@example.com'] });
    const pending = await mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision });
    const builds = (await h.sends.builds()).length;
    await h.advance(UNDO);
    const failed = await mail.getSend(pending.id);
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.recipients.map(({ email, state, reason }) => ({ email, state, reason })), [
      { email: 'friend@example.net', state: 'failed', reason: 'delivery_error' },
      { email: 'other@example.com', state: 'failed', reason: 'delivery_error' },
    ]);
    assert.equal((await h.sends.builds()).length, builds, 'no MIME was built');
    assert.deepEqual(await h.sends.queue(), []);
    assert.deepEqual(await sentCopies(mail), []);
    await h.advance(minute);
    assert.ok((await h.alerts()).includes('mail:holder_source_lost'));
  }));

for (const corruption of ['changed', 'empty'] as const) {
  test(`a large forwarded part whose att/ object is ${corruption === 'changed' ? 'changed in place' : 'stored as zero bytes'} fails the send with delivery_error, an alert and no MIME`,
  { timeout: 60_000 }, () => withSend(async (h, mail, from) => {
    const large = new Uint8Array(300 * 1024).fill(65);
    const source = await h.deliver({ from: { name: 'Sender', email: 'sender@example.net' }, to: [{ name: '', email: from }], subject: 'Large file',
      text: 'Attached', attachments: [{ name: 'large.bin', type: 'application/octet-stream', bytes: large }] });
    const { messages: [delivered] } = await mail.getThread(source.threadId);
    const draft = await mail.createDraft(draftInput(from, { to: [{ email: 'friend@example.net' }, { email: 'other@example.com' }],
      attachments: [{ kind: 'message', messageId: source.messageId, part: delivered.attachments[0].part }] }), key('draft'));
    const pending = await mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision });
    const [partKey] = (JSON.parse((await h.sends.row(pending.id))!.record) as { attachmentKeys: string[] }).attachmentKeys;
    assert.match(partKey, /^att\//, 'a large part is its own content-addressed object');
    // The stored bytes are corrupted: same length and different content, or a declared empty body.
    h.objects.set(objectPath(partKey), corruption === 'changed' ? new Uint8Array(large.byteLength).fill(66).buffer : new ArrayBuffer(0));
    const builds = (await h.sends.builds()).length;
    await h.advance(UNDO);
    const failed = await mail.getSend(pending.id);
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })), Array(2).fill({ state: 'failed', reason: 'delivery_error' }));
    assert.equal((await h.sends.builds()).length, builds, 'no MIME was built');
    assert.equal((await h.sends.registration(pending.id))?.key ?? null, null, 'nothing was registered or stored');
    assert.deepEqual(await h.sends.queue(), []);
    assert.deepEqual(await sentCopies(mail), []);
    await h.advance(minute);
    assert.ok((await h.alerts()).includes('mail:holder_source_lost'));
    assert.equal(await h.sends.emailCalls(), 0);
  }));
}

test('a transient read failure of a large forwarded part still retries instead of failing the send', { timeout: 60_000 }, () => withSend(async (h, mail, from) => {
  const large = new Uint8Array(300 * 1024).fill(65);
  const source = await h.deliver({ from: { name: 'Sender', email: 'sender@example.net' }, to: [{ name: '', email: from }], subject: 'Large file',
    text: 'Attached', attachments: [{ name: 'large.bin', type: 'application/octet-stream', bytes: large }] });
  const { messages: [delivered] } = await mail.getThread(source.threadId);
  const draft = await mail.createDraft(draftInput(from, { attachments: [{ kind: 'message', messageId: source.messageId, part: delivered.attachments[0].part }] }),
    key('draft'));
  const pending = await mail.sendDraft(draft.id, { ...key('send'), ifMatch: draft.revision });
  const [partKey] = (JSON.parse((await h.sends.row(pending.id))!.record) as { attachmentKeys: string[] }).attachmentKeys;
  const stored = h.objects.get(objectPath(partKey))!;
  h.objects.delete(objectPath(partKey));
  await h.advance(UNDO);
  assert.equal((await h.sends.row(pending.id))?.state, 'releasing', 'a missing read retries');
  h.objects.set(objectPath(partKey), stored);
  await h.advance(DRIVE_BACKOFF);
  assert.equal((await mail.getSend(pending.id)).state, 'sending');
  assert.equal((await h.sends.queue()).length, 1);
}));

test('a small forwarded part whose source raw object is stored as zero bytes fails the send with delivery_error, an alert and no MIME',
  () => withSend(async (h, mail, from) => {
    const { pending } = await forwardDraft(h, mail, from);
    const [sourceKey] = (JSON.parse((await h.sends.row(pending.id))!.record) as { attachmentKeys: string[] }).attachmentKeys;
    assert.match(sourceKey, /^raw\//, 'the part stays inside its source message');
    // The object reader refuses a declared empty body as invalid, for good.
    h.objects.set(objectPath(sourceKey), new ArrayBuffer(0));
    const builds = (await h.sends.builds()).length;
    await h.advance(UNDO);
    const failed = await mail.getSend(pending.id);
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })), [{ state: 'failed', reason: 'delivery_error' }]);
    assert.equal((await h.sends.builds()).length, builds, 'no MIME was built');
    assert.deepEqual(await h.sends.queue(), []);
    await h.advance(minute);
    assert.ok((await h.alerts()).includes('mail:holder_source_lost'));
  }));

test('sendDraft answers 422 invalid_recipients for a local part holding "=?", and accepts a standalone "=" or "?"', () => withSend(async (h, mail, from) => {
  for (const [i, email] of ['=?utf-8?b?QQ==?=@example.com', 'a.=?x@example.com'].entries()) {
    const draft = await mail.createDraft(draftInput(from, { cc: [{ email }] }), key(`draft-encoded-${i}`));
    const response = await post(h, mail, `/drafts/${draft.id}/send`, `send-encoded-${i}`, draft.revision);
    assert.equal(response.status, 422);
    assert.equal(((await response.json()) as { code: string }).code, 'invalid_recipients');
  }
  assert.deepEqual(await h.sends.ids(), [], 'no send was accepted');
  const { send: pending } = await send(mail, from, 'plain', { to: [{ email: 'a=b@example.com' }, { email: 'c?d@example.com' }, { email: 'e?=f@example.com' }] });
  assert.equal(pending.state, 'pending');
  await h.advance(UNDO);
  assert.equal((await mail.getSend(pending.id)).state, 'sending');
}));

for (const [label, replyTo] of [
  ['a local part holding "=?"', { email: '=?utf-8?b?QQ==?=@example.com' }],
  ['an invalid address', { email: 'not an address' }],
  ['a control character in its name', { email: 'replies@example.com', name: 'Line\r\nBcc: x@example.net' }],
  ['a name over displayNameBytes', { email: 'replies@example.com', name: 'n'.repeat(4096) }],
] as const) {
  test(`sendDraft answers 422 invalid_header for /replyTo when the settings Reply-To has ${label}, and no send is accepted`, () => withSend(async (h, mail, from) => {
    await h.sends.setReplyTo([{ email: 'replies@example.com', name: 'Replies' }, replyTo]);
    const draft = await mail.createDraft(draftInput(from), key('draft'));
    const response = await post(h, mail, `/drafts/${draft.id}/send`, 'send', draft.revision);
    assert.equal(response.status, 422);
    const problem = await response.json() as { code: string; errors?: { field: string }[] };
    assert.equal(problem.code, 'invalid_header');
    assert.deepEqual(problem.errors?.map(({ field }) => field), ['/replyTo']);
    assert.deepEqual(await h.sends.ids(), [], 'no send was accepted');
    assert.equal((await mail.getDraft(draft.id)).revision, draft.revision, 'the draft is unchanged');
  }));
}

test('a small forwarded part whose source raw object is changed in place fails the send with delivery_error, an alert and no MIME',
  () => withSend(async (h, mail, from) => {
    const { pending } = await forwardDraft(h, mail, from);
    const [sourceKey] = (JSON.parse((await h.sends.row(pending.id))!.record) as { attachmentKeys: string[] }).attachmentKeys;
    assert.match(sourceKey, /^raw\//, 'the part stays inside its source message');
    // Same length, different bytes: the read succeeds, the digest does not match the key.
    const stored = h.objects.get(objectPath(sourceKey))!;
    h.objects.set(objectPath(sourceKey), new Uint8Array(stored.byteLength).fill(66).buffer);
    const builds = (await h.sends.builds()).length;
    await h.advance(UNDO);
    const failed = await mail.getSend(pending.id);
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })), [{ state: 'failed', reason: 'delivery_error' }]);
    assert.equal((await h.sends.builds()).length, builds, 'no MIME was built');
    assert.equal((await h.sends.registration(pending.id))?.key ?? null, null, 'nothing was registered or stored');
    assert.deepEqual(await h.sends.queue(), []);
    assert.deepEqual(await sentCopies(mail), []);
    await h.advance(minute);
    assert.ok((await h.alerts()).includes('mail:holder_source_lost'));
    assert.equal(await h.sends.emailCalls(), 0);
  }));

for (const corruption of ['changed', 'empty'] as const) {
  test(`a draft revision object ${corruption === 'changed' ? 'changed in place' : 'stored as zero bytes'} fails the send with delivery_error, an alert and no MIME`,
    () => withSend(async (h, mail, from) => {
      const { send: pending } = await send(mail, from, 'one', { to: [{ email: 'friend@example.net' }, { email: 'other@example.com' }] });
      const { draft: { rawKey } } = JSON.parse((await h.sends.row(pending.id))!.record) as { draft: { rawKey: string } };
      const stored = h.objects.get(objectPath(rawKey))!;
      h.objects.set(objectPath(rawKey), corruption === 'changed' ? new Uint8Array(stored.byteLength).fill(66).buffer : new ArrayBuffer(0));
      const builds = (await h.sends.builds()).length;
      await h.advance(UNDO);
      const failed = await mail.getSend(pending.id);
      assert.equal(failed.state, 'failed');
      assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })), Array(2).fill({ state: 'failed', reason: 'delivery_error' }));
      assert.equal((await h.sends.builds()).length, builds, 'no MIME was built');
      assert.equal((await h.sends.registration(pending.id))?.key ?? null, null, 'nothing was registered or stored');
      assert.deepEqual(await h.sends.queue(), []);
      assert.deepEqual(await sentCopies(mail), []);
      await h.advance(minute);
      assert.ok((await h.alerts()).includes('mail:holder_source_lost'));
      assert.equal(await h.sends.emailCalls(), 0);
    }));
}

for (const target of ['source', 'draft'] as const) {
  test(`a 503 reading ${target === 'source' ? 'a small forwarded part\'s source raw object' : 'the draft revision object'} still retries instead of failing the send`,
    () => withSend(async (h, mail, from) => {
      const { pending } = await forwardDraft(h, mail, from);
      const record = JSON.parse((await h.sends.row(pending.id))!.record) as { attachmentKeys: string[]; draft: { rawKey: string } };
      const path = objectPath(target === 'source' ? record.attachmentKeys[0] : record.draft.rawKey);
      h.failingReads.add(path);
      await h.advance(UNDO);
      await h.advance(DRIVE_BACKOFF);
      assert.equal((await h.sends.row(pending.id))?.state, 'releasing', 'a failed read retries');
      assert.equal((await mail.getSend(pending.id)).state, 'sending');
      assert.deepEqual(await h.sends.queue(), []);
      assert.ok(!(await h.alerts()).includes('mail:holder_source_lost'));
      h.failingReads.delete(path);
      await h.advance(2 * DRIVE_BACKOFF);
      assert.equal((await h.sends.row(pending.id))?.state, 'queued');
      assert.equal((await h.sends.queue()).length, 1);
    }));
}

test('sendDraft answers 422 invalid_header for /replyTo when the settings Reply-To is defined but not a list', () => withSend(async (h, mail, from) => {
  await h.sends.setReplyTo({ email: 'bad' });
  const draft = await mail.createDraft(draftInput(from), key('draft'));
  const response = await post(h, mail, `/drafts/${draft.id}/send`, 'send', draft.revision);
  assert.equal(response.status, 422);
  const problem = await response.json() as { code: string; errors?: { field: string }[] };
  assert.equal(problem.code, 'invalid_header');
  assert.deepEqual(problem.errors?.map(({ field }) => field), ['/replyTo']);
  assert.deepEqual(await h.sends.ids(), [], 'no send was accepted');
}));

test('only the first four settings Reply-To entries are used: an invalid fifth does not block the send', () => withSend(async (h, mail, from) => {
  const valid = [1, 2, 3, 4].map(i => ({ email: `replies${i}@example.com` }));
  await h.sends.setReplyTo([...valid, { email: '=?utf-8?b?QQ==?=@example.com' }]);
  const { send: pending } = await send(mail, from, 'one');
  assert.deepEqual((JSON.parse((await h.sends.row(pending.id))!.record) as { replyTo: unknown }).replyTo, valid);
}));

// Draft objects whose bytes match their content address but are not a draft this code can read.
const undecodable = (from: string) => [
  ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
  ['not JSON', new TextEncoder().encode('not a draft')],
  ['an unsupported version', new TextEncoder().encode(JSON.stringify({ version: 2, fields: draftInput(from) }))],
  ['attachments that are not a list', new TextEncoder().encode(JSON.stringify({ version: 1, fields: { ...draftInput(from), attachments: undefined }, attachments: 'x' }))],
  ['an attachment whose key is not an object key', new TextEncoder().encode(JSON.stringify({ version: 1, fields: { ...draftInput(from), attachments: undefined },
    attachments: [{ wire: { kind: 'upload', uploadId: 'u1', name: 'a.txt', type: 'text/plain', size: 1 }, key: 'att/not-a-key' }] }))],
  // Only `to` is missing: from, cc and bcc are valid, so the recipient check itself refuses it.
  ['no to list', new TextEncoder().encode(JSON.stringify({ version: 1, fields: { ...draftInput(from), attachments: undefined, to: undefined } }))],
  ['a cc that is not a list', new TextEncoder().encode(JSON.stringify({ version: 1, fields: { ...draftInput(from), attachments: undefined, cc: 'friend@example.net' } }))],
  ['a recipient without an email', new TextEncoder().encode(JSON.stringify({ version: 1, fields: { ...draftInput(from), attachments: undefined, to: [{ name: 'No Address' }] } }))],
  ['more recipients than recipientsPerMessage', new TextEncoder().encode(JSON.stringify({ version: 1, fields: { ...draftInput(from), attachments: undefined,
    to: Array.from({ length: 51 }, (_, i) => ({ email: `r${i}@example.net` })) } }))],
] as const;

for (const index of undecodable('').keys()) {
  test(`a digest-verified draft revision object with ${undecodable('').at(index)![0]} fails the send with delivery_error, an alert and no MIME`,
    () => withSend(async (h, mail, from) => {
      const [, bytes] = undecodable(from)[index];
      const { send: pending } = await send(mail, from, 'one', { to: [{ email: 'friend@example.net' }, { email: 'other@example.com' }] });
      const { draft: { rawKey } } = JSON.parse((await h.sends.row(pending.id))!.record) as { draft: { rawKey: string } };
      const [kind, , gen] = rawKey.split('/');
      const badKey = `${kind}/${sha256(bytes.buffer as ArrayBuffer)}/${gen}`;
      h.objects.set(objectPath(badKey), bytes.slice().buffer);
      await h.sends.setDraftKey(pending.id, badKey);
      const builds = (await h.sends.builds()).length;
      await h.advance(UNDO);
      const failed = await mail.getSend(pending.id);
      assert.equal(failed.state, 'failed');
      assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })), Array(2).fill({ state: 'failed', reason: 'delivery_error' }));
      assert.equal((await h.sends.builds()).length, builds, 'no MIME was built');
      assert.equal((await h.sends.registration(pending.id))?.key ?? null, null, 'nothing was registered or stored');
      assert.deepEqual(await h.sends.queue(), []);
      assert.deepEqual(await sentCopies(mail), []);
      await h.advance(minute);
      assert.ok((await h.alerts()).includes('mail:holder_source_lost'));
      assert.equal(await h.sends.emailCalls(), 0);
    }));
}

// The answers 25594d0 gave, before release learned to fail an undecodable draft.
test('getDraft, replaceDraft and sendDraft of a stored draft that does not decode answer as before', () => withSend(async (h, mail, from) => {
  const answers: string[] = [];
  for (const [i, draft] of [{ version: 2, fields: draftInput(from) }, { version: 1, fields: draftInput(from), attachments: 'x' }, 'not a draft'].entries()) {
    const legacy = await h.sends.seedLegacyDraft(draft);
    const { csrfToken } = await mail.getSession();
    const headers = { origin: h.origin, 'x-fixture-account': 'member', 'x-csrf-token': csrfToken };
    const read = await fetch(`${h.origin}/api/v1/drafts/${legacy.id}`, { headers });
    const replaced = await fetch(`${h.origin}/api/v1/drafts/${legacy.id}`, { method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': `replace-${i}`, 'if-match': legacy.revision },
      body: JSON.stringify(draftInput(from)) });
    const sent = await post(h, mail, `/drafts/${legacy.id}/send`, `send-${i}`, legacy.revision);
    for (const response of [read, replaced, sent]) answers.push(`${i} ${response.status} ${((await response.json()) as { code?: string }).code ?? ''}`);
  }
  assert.deepEqual(answers, ['0 503 unavailable', '0 503 unavailable', '0 503 unavailable', '1 503 unavailable', '1 200 ', '1 412 revision_mismatch',
    '2 503 unavailable', '2 503 unavailable', '2 503 unavailable']);
}));

// Rewrites a send's frozen draft revision as a digest-valid object with one change to its upload attachment.
async function sendChangedUpload(h: Fixture, mail: MailService, from: string, change: (wire: Record<string, unknown>) => void) {
  const uploaded = await mail.createUpload({ name: 'note.txt', type: 'text/plain', bytes: new Blob(['attachment']) }, key('upload'));
  const { send: pending } = await send(mail, from, 'one', { attachments: [{ kind: 'upload', uploadId: uploaded.id }] });
  const { draft: { rawKey } } = JSON.parse((await h.sends.row(pending.id))!.record) as { draft: { rawKey: string } };
  const draft = JSON.parse(new TextDecoder().decode(h.objects.get(objectPath(rawKey)))) as { attachments: { wire: Record<string, unknown> }[] };
  change(draft.attachments[0].wire);
  const bytes = new TextEncoder().encode(JSON.stringify(draft));
  const [kind, , gen] = rawKey.split('/');
  const changedKey = `${kind}/${sha256(bytes.buffer as ArrayBuffer)}/${gen}`;
  h.objects.set(objectPath(changedKey), bytes.slice().buffer);
  await h.sends.setDraftKey(pending.id, changedKey);
  return pending;
}

test('a digest-valid draft revision whose upload size differs from its att/ object fails the send with delivery_error, an alert and no MIME',
  () => withSend(async (h, mail, from) => {
    const pending = await sendChangedUpload(h, mail, from, wire => { wire.size = (wire.size as number) + 1; });
    const builds = (await h.sends.builds()).length;
    await h.advance(UNDO);
    const failed = await mail.getSend(pending.id);
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.recipients.map(({ state, reason }) => ({ state, reason })), [{ state: 'failed', reason: 'delivery_error' }]);
    assert.equal((await h.sends.registration(pending.id))?.key ?? null, null, 'nothing was registered or stored');
    assert.equal((await h.sends.builds()).length, builds, 'no MIME was built');
    assert.deepEqual(await h.sends.queue(), []);
    await h.advance(minute);
    assert.ok((await h.alerts()).includes('mail:holder_source_lost'));
    assert.equal(await h.sends.emailCalls(), 0);
  }));

for (const [label, name, type, sentName, sentType] of [
  ['an empty name and a type holding CR LF', '', 'text/plain\r\nX-Injected: 1', 'attachment', 'application/octet-stream'],
  ['a name indexed before names were cleaned', `a\tb/c\\${'x'.repeat(300)}`, 'text/plain', indexedAttachmentName(`a\tb/c\\${'x'.repeat(300)}`), 'text/plain'],
] as const) {
  test(`a stored file with ${label} is sent with a cleaned name and type, never failed`, () => withSend(async (h, mail, from) => {
    const pending = await sendChangedUpload(h, mail, from, wire => { wire.name = name; wire.type = type; });
    await h.advance(UNDO);
    assert.equal((await mail.getSend(pending.id)).state, 'sending');
    assert.equal((await h.sends.queue()).length, 1);
    const text = new TextDecoder().decode(h.objects.get(objectPath((await h.sends.registration(pending.id))!.key!)));
    assert.doesNotMatch(text, /^X-Injected/m);
    assert.match(text, new RegExp(`^Content-Type: ${sentType.replace('/', '\\/')}\r$`, 'm'));
    const [copy] = await sentCopies(mail);
    assert.deepEqual(copy.attachments.map(({ name: sent }) => sent), [sentName]);
  }));
}
