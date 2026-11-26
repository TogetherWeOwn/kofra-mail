import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { isMailApiError, LIMITS } from '../../../contracts/mail-api/src/index.ts';
import type { Draft, DraftInput } from '../../../contracts/mail-api/src/wire.ts';
import { startMailHttpFixture } from './fixtures/mail-http.ts';

const day = 86_400_000;
const PROVISIONAL_TTL = 7 * day;
const RETENTION_MS = 35 * day;

const key = (idempotencyKey: string) => ({ idempotencyKey });
const missingKey = {} as ReturnType<typeof key>;
const missingRevision = {} as { ifMatch: string };
const draftInput = (from: string, patch: Partial<DraftInput> = {}): DraftInput => ({
  from, to: [], cc: [], bcc: [], subject: '', body: '', attachments: [], ...patch,
});
const upload = (bytes: string | Uint8Array<ArrayBuffer> = 'example attachment') => ({ name: 'note.txt', type: 'text/plain', bytes: new Blob([bytes]) });
const ttl = LIMITS.uploadRetentionSeconds * 1000;
const uploadHolderFor = (holder: string, id: string) => holder.startsWith('upload:') && holder.endsWith(`:${id}`);

async function withMail(run: (fixture: Awaited<ReturnType<typeof startMailHttpFixture>>) => Promise<void>) {
  const fixture = await startMailHttpFixture({ draftsUploads: true });
  try { await run(fixture); }
  finally { await fixture.close(); }
}

test('case 11: keys replay labels, deleted drafts and uploads, but not changed bodies or failed results', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox, csrfToken } = await mail.getSession();
  assert.ok(mailbox);
  const request = (path: string, idempotencyKey: string, contentType: string, body: BodyInit) => fetch(`${h.origin}/api/v1${path}`, {
    method: 'POST', headers: { origin: h.origin, 'x-fixture-account': 'member', 'x-csrf-token': csrfToken,
      'idempotency-key': idempotencyKey, 'content-type': contentType }, body,
  });
  const label = { name: 'Personal' };
  const draft = draftInput(mailbox.primaryAddress);
  const labelResult = await mail.createLabel(label, key('label'));
  const draftResult = await mail.createDraft(draft, key('draft'));
  await mail.deleteDraft(draftResult.id);
  assert.deepEqual(await mail.createLabel(label, key('label')), labelResult);
  const draftReplay = await request('/drafts', 'draft', 'application/json', JSON.stringify(draft));
  assert.equal(draftReplay.status, 201);
  assert.equal(draftReplay.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(await draftReplay.json(), draftResult);
  assert.deepEqual((await mail.listDrafts({})).items, []);
  await assert.rejects(mail.createLabel(label, missingKey), (e) => isMailApiError(e, 'precondition_required'));
  await assert.rejects(mail.createDraft(draft, missingKey), (e) => isMailApiError(e, 'precondition_required'));
  await assert.rejects(mail.createLabel({ name: 'Different' }, key('label')), (e) => isMailApiError(e, 'idempotency_key_reused'));
  await assert.rejects(mail.createDraft({ ...draft, subject: 'Different' }, key('draft')), (e) => isMailApiError(e, 'idempotency_key_reused'));
  await assert.rejects(mail.createDraft({ ...draft, from: 'unavailable@example.test' }, key('retry')), (e) => isMailApiError(e, 'invalid_sender'));
  await mail.createDraft(draft, key('retry'));
  await assert.rejects(mail.createUpload(upload(), missingKey), (e) => isMailApiError(e, 'precondition_required'));
  const uploaded = await mail.createUpload(upload(), key('upload'));
  assert.deepEqual(await mail.createUpload(upload(), key('upload')), uploaded);
  await assert.rejects(mail.createUpload(upload('different'), key('upload')), (e) => isMailApiError(e, 'idempotency_key_reused'));
  await assert.rejects(mail.createUpload(upload(new Uint8Array(LIMITS.uploadBytes + 1)), key('upload')),
    (e) => isMailApiError(e, 'idempotency_key_reused'));
  assert.equal(uploaded.sha256, createHash('sha256').update('example attachment').digest('hex'));
  await mail.deleteUpload(uploaded.id);
  await assert.rejects(mail.createDraft(draftInput(mailbox.primaryAddress, {
    attachments: [{ kind: 'upload', uploadId: uploaded.id }],
  }), key('removed-upload')), (e) => isMailApiError(e, 'not_found'));
  const uploadReplay = await request('/uploads?name=note.txt', 'upload', 'text/plain', upload().bytes);
  assert.equal(uploadReplay.status, 201);
  assert.equal(uploadReplay.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(await uploadReplay.json(), uploaded);
  assert.equal(h.writes.filter(write => write.key.startsWith('att/')).length, 1);
}));

function pausedDraftRequest(h: Awaited<ReturnType<typeof startMailHttpFixture>>, input: DraftInput, csrfToken: string, idempotencyKey: string) {
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { sink = controller; controller.enqueue(encoded.subarray(0, 1)); } });
  const reading = h.watchBodyRead();
  const options: RequestInit & { duplex: 'half' } = {
    method: 'POST', duplex: 'half', body, signal: AbortSignal.timeout(5_000),
    headers: { origin: h.origin, 'x-fixture-account': 'member', 'x-fixture-watch-body': 'true', 'x-csrf-token': csrfToken,
      'idempotency-key': idempotencyKey, 'content-type': 'application/json' },
  };
  const response = fetch(`${h.origin}/api/v1/drafts`, options);
  return { reading: Promise.race([reading, response.then(() => assert.fail('draft answered before it read the body'))]), response,
    finish(complete: boolean) { if (complete) sink.enqueue(encoded.subarray(1)); sink.close(); } };
}

test('R1: a paused createDraft body reserves the same key before reading', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox, csrfToken } = await mail.getSession();
  assert.ok(mailbox);
  const input = draftInput(mailbox.primaryAddress);
  const first = pausedDraftRequest(h, input, csrfToken, 'draft-stream');
  try {
    await first.reading;
    await assert.rejects(mail.createDraft({ ...input, subject: 'Another tab' }, key('draft-stream')),
      e => isMailApiError(e, 'idempotency_in_progress'));
  } finally { first.finish(true); }
  const response = await first.response;
  assert.equal(response.status, 201);
  await response.arrayBuffer();
  assert.deepEqual((await mail.listDrafts({})).items.map(draft => draft.subject), ['']);
}));

test('R1: expired and interrupted JSON bodies cannot commit or strand their keys', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox, csrfToken } = await mail.getSession();
  assert.ok(mailbox);
  const input = draftInput(mailbox.primaryAddress);
  const expired = pausedDraftRequest(h, input, csrfToken, 'expired-body');
  try { await expired.reading; await h.expireUploadLease('expired-body'); }
  finally { expired.finish(true); }
  const late = await expired.response;
  assert.equal(late.status, 409);
  assert.equal((await late.json<{ code: string }>()).code, 'idempotency_in_progress');
  assert.equal(await h.hasIdempotency('expired-body'), false);
  const interrupted = pausedDraftRequest(h, input, csrfToken, 'interrupted-body');
  try { await interrupted.reading; }
  finally { interrupted.finish(false); }
  const bad = await interrupted.response;
  assert.equal(bad.status, 400);
  await bad.arrayBuffer();
  assert.equal(await h.hasIdempotency('interrupted-body'), false);
  assert.deepEqual((await mail.listDrafts({})).items, []);
  await mail.createDraft(input, key('expired-body'));
  await mail.createDraft(input, key('interrupted-body'));
  assert.equal((await mail.listDrafts({})).items.length, 2);
}));

test('R3: replaceDraft checks existence and revision before its semantic fields', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const input = draftInput(mailbox.primaryAddress);
  const saved = await mail.createDraft(input, key('draft'));
  const invalid = { ...input, extra: true };
  await assert.rejects(mail.replaceDraft(saved.id, invalid, { ifMatch: 'stale' }), e => isMailApiError(e, 'revision_mismatch'));
  await assert.rejects(mail.replaceDraft('missing', invalid, { ifMatch: saved.revision }), e => isMailApiError(e, 'not_found'));
  await assert.rejects(mail.replaceDraft(saved.id, invalid, { ifMatch: saved.revision }), e => isMailApiError(e, 'unknown_field'));
}));

test('R3: an oversized JSON request with a committed key compares before the cap error', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox, csrfToken } = await mail.getSession();
  assert.ok(mailbox);
  const input = draftInput(mailbox.primaryAddress);
  await mail.createDraft(input, key('draft'));
  const oversized = new Blob([JSON.stringify({ ...input, body: 'x'.repeat(6 * LIMITS.bodyBytes + 512 * 1024) })]);
  const request = (key: string) => fetch(`${h.origin}/api/v1/drafts`, { method: 'POST', body: oversized,
    headers: { origin: h.origin, 'x-fixture-account': 'member', 'x-csrf-token': csrfToken, 'idempotency-key': key, 'content-type': 'application/json' } });
  assert.equal((await request('draft')).status, 422);
  assert.equal((await request('fresh')).status, 413);
}));

test('R3: a committed upload key compares before rejecting an extra query field', () => withMail(async (h) => {
  const mail = h.as('member');
  const { csrfToken } = await mail.getSession();
  const source = upload();
  await mail.createUpload(source, key('upload'));
  const response = await fetch(`${h.origin}/api/v1/uploads?name=note.txt&extra=1`, { method: 'POST', body: source.bytes,
    headers: { origin: h.origin, 'x-fixture-account': 'member', 'x-csrf-token': csrfToken, 'idempotency-key': 'upload', 'content-type': source.type } });
  assert.equal(response.status, 422);
  assert.equal((await response.json<{ code: string }>()).code, 'idempotency_key_reused');
}));

test('a fresh invalid filename is rejected before the upload body finishes', () => withMail(async (h) => {
  const { csrfToken } = await h.as('member').getSession();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } });
  const options: RequestInit & { duplex: 'half' } = {
    method: 'POST', duplex: 'half', body, signal: AbortSignal.timeout(2_000),
    headers: { origin: h.origin, 'x-fixture-account': 'member', 'x-csrf-token': csrfToken,
      'idempotency-key': 'bad-name', 'content-type': 'application/octet-stream' },
  };
  const response = await fetch(`${h.origin}/api/v1/uploads?name=invalid%2Ffile`, options);
  assert.equal(response.status, 400);
  assert.equal((await response.json<{ code: string }>()).code, 'invalid_request');
  assert.deepEqual(h.writes, []);
}));

test('an upload whose key lease expires during the PUT cannot commit', () => withMail(async (h) => {
  const mail = h.as('member');
  const gate = h.pauseNextPut();
  const first = mail.createUpload(upload(), key('lease'));
  try {
    await Promise.race([gate.started, first.then(() => assert.fail('PUT did not reach the gate'))]);
    await h.expireUploadLease('lease');
  } finally { gate.release(); }
  await assert.rejects(first, e => isMailApiError(e, 'idempotency_in_progress'));
  assert.equal(await h.hasIdempotency('lease'), false);
  assert.equal(await h.eventCount('api_upload'), 0);
}));

test('an upload deadline frees staging even while the PUT remains stalled', () => withMail(async (h) => {
  const mail = h.as('member');
  const { csrfToken } = await mail.getSession();
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { sink = controller; controller.enqueue(new Uint8Array([1])); } });
  const reading = h.watchBodyRead();
  const gate = h.pauseNextPut();
  const options: RequestInit & { duplex: 'half' } = { method: 'POST', duplex: 'half', body, signal: AbortSignal.timeout(5_000),
    headers: { origin: h.origin, 'x-fixture-account': 'member', 'x-fixture-watch-body': 'true', 'x-csrf-token': csrfToken,
      'idempotency-key': 'stalled-put', 'content-type': 'text/plain' } };
  const first = fetch(`${h.origin}/api/v1/uploads?name=note.txt`, options);
  try {
    await Promise.race([reading, first.then(() => assert.fail('upload answered before reading the body'))]);
    await h.advance(5 * 60_000 - 750);
    sink.close();
    await Promise.race([gate.started, first.then(() => assert.fail('the PUT did not reach its gate'))]);
    const expired = await first;
    assert.ok(expired.status === 409 || expired.status === 503);
    await expired.arrayBuffer();
    assert.equal(await h.hasIdempotency('stalled-put'), false);
    const next = await mail.createUpload(upload(), key('stalled-put'));
    assert.ok(next.id);
    assert.equal(h.writes.length, 2);
  } finally { gate.release(); }
}));

test('case 12: only one tab replaces the stored draft revision', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const input = draftInput(mailbox.primaryAddress);
  const draft = await mail.createDraft(input, key('draft'));
  await assert.rejects(mail.replaceDraft(draft.id, input, missingRevision), (e) => isMailApiError(e, 'precondition_required'));
  const results = await Promise.allSettled(['one', 'two'].map(subject =>
    mail.replaceDraft(draft.id, { ...input, subject }, { ifMatch: draft.revision })));
  const winner = results.find(r => r.status === 'fulfilled');
  const loser = results.find(r => r.status === 'rejected');
  assert.ok(winner && loser);
  assert.notEqual(winner.value.revision, draft.revision);
  assert.ok(isMailApiError(loser.reason, 'revision_mismatch'));
  assert.deepEqual(await mail.getDraft(draft.id), winner.value);
  assert.equal(h.writes.length, 2);
  for (const { key: objectKey, holders } of h.writes) {
    assert.match(objectKey, /^raw\/[a-f0-9]{64}\/[A-Z0-9]{26}$/);
    assert.ok(holders.some(holder => holder.startsWith('draft:')), 'hold precedes PUT');
    assert.equal((await h.holderDetails(objectKey))[0]?.state, 'provisional');
    const bytes = h.objects.get(`/mail-w1/${objectKey}`);
    assert.ok(bytes);
    assert.equal(createHash('sha256').update(new Uint8Array(bytes)).digest('hex'), objectKey.split('/')[1]);
  }
  assert.notEqual(h.writes[0].key, h.writes[1].key);
  await mail.deleteDraft(draft.id, { ifMatch: winner.value.revision });
  await mail.deleteDraft(draft.id, { ifMatch: winner.value.revision });
  assert.deepEqual((await mail.listDrafts({})).items, []);
}));

test('case 15: an expired upload is unavailable unless a draft still refers to it', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  await assert.rejects(mail.createUpload(upload(new Uint8Array(LIMITS.uploadBytes + 1)), key('huge')),
    (e) => isMailApiError(e, 'payload_too_large'));
  const loose = await mail.createUpload(upload(), key('loose'));
  const retained = await mail.createUpload(upload(), key('retained'));
  const withUpload = (uploadId: string) => draftInput(mailbox.primaryAddress, { attachments: [{ kind: 'upload', uploadId }] });
  const [uploaded] = h.writes;
  assert.match(uploaded.key, new RegExp(`^att/${loose.sha256}/[A-Z0-9]{26}$`));
  assert.ok(uploaded.holders.some(holder => uploadHolderFor(holder, loose.id)), 'this upload holder precedes its PUT');
  assert.equal(new TextDecoder().decode(h.objects.get(`/mail-w1/${uploaded.key}`)), 'example attachment');
  assert.ok((await h.timers()).some(row => row.kind === 'upload_expiry' && row.ref === loose.id && row.due_at === Date.parse(loose.expiresAt)));
  const draft = await mail.createDraft(withUpload(retained.id), key('draft'));
  assert.ok(!(await h.timers()).some(row => row.kind === 'upload_expiry' && row.ref === retained.id));
  await h.advance(ttl);
  await h.advance(60_000); // The deletion must be published before releasing the object.
  assert.ok(!(await h.holders(uploaded.key)).some(holder => uploadHolderFor(holder, loose.id)));
  assert.ok((await h.holders(uploaded.key)).some(holder => uploadHolderFor(holder, retained.id)));
  await assert.rejects(mail.createDraft(withUpload(loose.id), key('expired')), (e) => isMailApiError(e, 'not_found'));
  assert.deepEqual((await mail.getDraft(draft.id)).attachments, draft.attachments);
  const edited = await mail.replaceDraft(draft.id, withUpload(retained.id), { ifMatch: draft.revision });
  assert.deepEqual(edited.attachments, draft.attachments);
  await mail.deleteDraft(edited.id);
  await h.advance(0);
  await assert.rejects(mail.createDraft(withUpload(retained.id), key('detached')), (e) => isMailApiError(e, 'not_found'));
}));

test('case 15: replacing a draft keeps a forwarded part after the source expires', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const source = await h.deliver({ from: { name: 'Sender', email: 'sender@example.test' }, to: [], subject: 'Forward', text: 'Example',
    attachments: [{ name: 'note.txt', type: 'text/plain', bytes: new Uint8Array([42]) }] });
  const { messages: [message] } = await mail.getThread(source.threadId);
  const [{ part, name, type, size }] = message.attachments;
  await mail.updateThreads({ ids: [source.threadId], set: { folder: 'trash' } });
  const input = draftInput(mailbox.primaryAddress, { forwardOf: source.messageId,
    attachments: [{ kind: 'message', messageId: source.messageId, part }] });
  const forward = await mail.createDraft(input, key('forward'));
  await h.advance(LIMITS.spamTrashRetentionDays * 86_400_000);
  await assert.rejects(mail.getThread(source.threadId), (e) => isMailApiError(e, 'not_found'));
  assert.equal(await h.purgeTrash(), 1);
  await assert.rejects(mail.createDraft(input, key('expired-source')), (e) => isMailApiError(e, 'not_found'));
  const edited = await mail.replaceDraft(forward.id, { ...input, subject: 'Edited' }, { ifMatch: forward.revision });
  assert.deepEqual(edited.attachments, [{ kind: 'message', messageId: source.messageId, part, name, type, size }]);
  const sourceKey = h.writes.find(write => write.key.startsWith('raw/'))?.key;
  assert.ok(sourceKey);
  const sourceHolders = await h.holders(sourceKey);
  assert.ok(sourceHolders.length && sourceHolders.every(holder => holder.startsWith('draft:')));
  assert.match(new TextDecoder().decode(h.objects.get(`/mail-w1/${sourceKey}`)), /\r\nKg==\r\n/);
}));

test('idem_expiry is scheduled for 24 hours and frees the key on the deadline', () => withMail(async (h) => {
  const mail = h.as('member');
  const label = await mail.createLabel({ name: 'First' }, key('once'));
  const [timer] = (await h.timers()).filter(row => row.kind === 'idem_expiry');
  assert.equal(timer?.ref, 'once');
  assert.equal(timer.due_at, h.startedAt + day);
  await h.advance(day - 1);
  assert.deepEqual(await mail.createLabel({ name: 'First' }, key('once')), label);
  await h.advance(1);
  assert.ok(!(await h.timers()).some(row => row.kind === 'idem_expiry' && row.ref === 'once'));
  const second = await mail.createLabel({ name: 'Second' }, key('once'));
  assert.notEqual(second.id, label.id);
}));

test('a published replace releases only the previous revision holders', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const uploaded = await mail.createUpload(upload(), key('file'));
  const input = draftInput(mailbox.primaryAddress, { attachments: [{ kind: 'upload', uploadId: uploaded.id }] });
  const draft = await mail.createDraft(input, key('draft'));
  await h.advance(60_000);
  const [, previous] = h.writes;
  const [oldHolder] = previous.holders;
  const next = await mail.replaceDraft(draft.id, { ...input, subject: 'Edited' }, { ifMatch: draft.revision });
  assert.deepEqual(await h.holders(previous.key), [oldHolder]);
  assert.equal((await h.pendingReleases()).length, 2);
  await h.releaseFailure(true);
  await h.advance(60_000);
  assert.deepEqual(await h.holders(previous.key), [oldHolder]);
  assert.equal((await h.pendingReleases()).length, 2);
  await h.releaseFailure(false);
  await h.advance(60_000, true);
  assert.deepEqual(await h.holders(previous.key), []);
  assert.deepEqual(await h.pendingReleases(), []);
  await h.advance(60_000);
  assert.equal((await h.acknowledgedReleases()).filter(row => row.holder === oldHolder).length, 2);
  assert.deepEqual(await mail.getDraft(next.id), next);
  const remaining = await h.holders(h.writes[0].key);
  assert.equal(remaining.length, 2);
  assert.ok(remaining.includes(h.writes[2].holders[0]) && remaining.some(holder => uploadHolderFor(holder, uploaded.id)));
}));

test('restore rebuilds the idempotency and upload timers from published state', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const unattached = await mail.createUpload(upload(), key('unattached'));
  const attached = await mail.createUpload(upload(), key('attached'));
  const input = draftInput(mailbox.primaryAddress, { attachments: [{ kind: 'upload', uploadId: attached.id }] });
  const original = await mail.createDraft(input, key('draft'));
  await h.advance(59_000);
  const [, , previous] = h.writes;
  const [holder] = previous.holders;
  await mail.replaceDraft(original.id, { ...input, subject: 'Not published' }, { ifMatch: original.revision });
  await h.publishFailure(true);
  await h.advance(60_000);
  assert.equal((await h.pendingReleases()).length, 2);
  const unpublished = h.writes.at(-1)!;
  const [unpublishedHold] = await h.holderDetails(unpublished.key);
  assert.equal(unpublishedHold.state, 'provisional');
  await h.publishFailure(false);
  const beforeRestore = (await h.confirmBatches()).length;
  await h.restore();
  assert.ok((await h.confirmBatches()).length > beforeRestore, 'delta replay reconfirms its holders');
  assert.equal((await h.holderDetails(previous.key))[0]?.state, 'held');
  await h.sweepAt(unpublishedHold.expires_at!);
  assert.equal((await h.holderDetails(unpublished.key))[0]?.state, 'expired');
  assert.equal((await h.holderDetails(previous.key))[0]?.state, 'held');
  assert.deepEqual(await mail.getDraft(original.id), original);
  assert.deepEqual(await mail.createDraft(input, key('draft')), original);
  assert.deepEqual(await mail.createUpload(upload(), key('attached')), attached);
  assert.deepEqual(await h.holders(previous.key), [holder]);
  assert.ok((await h.holders(h.writes[0].key)).includes(holder));
  assert.deepEqual((await h.timers()).filter(row => row.kind === 'upload_expiry').map(row => row.ref), [unattached.id]);
  assert.deepEqual((await h.timers()).filter(row => row.kind === 'idem_expiry').map(row => row.ref), ['attached', 'draft', 'unattached']);
}));

test('restore while uploads are switched off still rebuilds their expiry schedules', () => withMail(async (h) => {
  const mail = h.as('member');
  const uploaded = await mail.createUpload(upload(), key('upload'));
  await h.advance(60_000);
  await h.uploadSwitch(false);
  await assert.rejects(mail.createUpload(upload(), key('disabled')), (e) => isMailApiError(e, 'not_implemented'));
  await h.restore();
  const rows = await h.timers();
  assert.equal(rows.find(row => row.kind === 'upload_expiry')?.ref, uploaded.id);
  assert.equal(rows.find(row => row.kind === 'idem_expiry')?.ref, 'upload');
  await h.advance(ttl);
  assert.equal(await h.eventCount('api_upload_delete'), 0, 'disabled timer does not expire the upload');
  assert.equal(await h.hasIdempotency('upload'), true, 'the disabled outbound retry row is still parked');
  assert.ok((await h.timers()).some(row => row.kind === 'idem_expiry' && row.ref === 'upload'));
  await h.uploadSwitch(true);
  await h.advance(15 * 60_000);
  assert.equal(await h.eventCount('api_upload_delete'), 1, 'expiry resumes on the existing schedule');
  assert.equal(await h.hasIdempotency('upload'), false);
}));

test('R4: enabled label and draft retry rows still expire after uploads are switched off', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  await mail.createLabel({ name: 'Ordinary' }, key('ordinary-label'));
  await mail.createDraft(draftInput(mailbox.primaryAddress), key('ordinary-draft'));
  await h.advance(60_000);
  await h.uploadSwitch(false);
  await h.advance(day);
  assert.deepEqual(await Promise.all(['ordinary-label', 'ordinary-draft'].map(h.hasIdempotency)), [false, false]);
  assert.ok(!(await h.timers()).some(row => row.kind === 'idem_expiry' && row.ref.startsWith('ordinary-')));
}));

test('a rebuilt legacy retry row still expires after uploads are switched off', () => withMail(async (h) => {
  const mail = h.as('member');
  await h.uploadSwitch(false);
  const label = await h.seedLegacyLabel();
  await h.advance(60_000);
  await h.uploadSwitch(true);
  await h.restore();
  assert.deepEqual(await mail.createLabel({ name: 'Legacy' }, key('legacy')), label);
  assert.ok((await h.timers()).some(row => row.kind === 'idem_expiry' && row.ref === 'legacy'));
  await h.uploadSwitch(false);
  await h.advance(ttl);
  assert.equal(await h.hasIdempotency('legacy'), false);
  assert.ok(!(await h.timers()).some(row => row.kind === 'idem_expiry' && row.ref === 'legacy'));
}));

test('snapshot restores upload references before drafts and retains pending holder releases', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const linked = await mail.createUpload(upload(), key('linked'));
  const loose = await mail.createUpload(upload(), key('loose'));
  const input = draftInput(mailbox.primaryAddress, { attachments: [{ kind: 'upload', uploadId: linked.id }] });
  const original = await mail.createDraft(input, key('draft'));
  const edited = await mail.replaceDraft(original.id, { ...input, subject: 'In snapshot' }, { ifMatch: original.revision });
  await h.releaseFailure(true);
  await h.confirmFailure(true);
  assert.equal(await h.forceSnapshot(), true, 'manifest has a snapshot and no deltas');
  const pending = await h.pendingReleases();
  assert.equal(pending.length, 2);
  assert.ok((await h.confirmations()).length > 0);
  const editedKey = h.writes.at(-1)!.key;
  const [unconfirmed] = await h.holderDetails(editedKey);
  assert.ok(unconfirmed.expires_at);
  await h.sweepAt(unconfirmed.expires_at);
  assert.equal((await h.holderDetails(editedKey))[0]?.state, 'expired');
  await h.confirmFailure(false);
  await h.restore();
  assert.deepEqual(await h.confirmations(), []);
  assert.equal((await h.holderDetails(editedKey))[0]?.state, 'held');
  assert.deepEqual(await mail.getDraft(edited.id), edited);
  assert.deepEqual(await mail.createDraft(input, key('draft')), original);
  assert.deepEqual(await h.pendingReleases(), pending);
  assert.deepEqual((await h.timers()).filter(row => row.kind === 'upload_expiry').map(row => row.ref), [loose.id]);
  await h.releaseFailure(false);
  // A platform alarm can retry just after restore, before we advance the fixture clock.
  const retryAt = await h.releaseRetryAt();
  await h.advance(Math.max(60_000, (retryAt ?? 0) - h.startedAt));
  assert.deepEqual(await h.pendingReleases(), []);
  assert.deepEqual(await mail.getDraft(edited.id), edited);
}));

test('journal cleanup drains a 200-entry backlog in 64-entry minute batches', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const uploaded = await mail.createUpload(upload(), key('upload'));
  const input = draftInput(mailbox.primaryAddress, { attachments: [{ kind: 'upload', uploadId: uploaded.id }] });
  for (let i = 0; i < 100; i++) {
    const draft = await mail.createDraft(input, key(`draft-${i}`));
    await mail.deleteDraft(draft.id);
  }
  assert.equal((await h.pendingReleases()).length, 200);
  let now = Date.parse(uploaded.expiresAt) - ttl;
  for (const remaining of [136, 72, 8, 0]) {
    now += 60_000;
    await h.advance(60_000);
    assert.equal((await h.pendingReleases()).length, remaining);
    assert.equal((await h.acknowledgedReleases()).length, 200 - remaining);
    const lane = (await h.timers()).find(row => row.kind === 'journal_flush');
    assert.ok(lane);
    if (remaining) assert.ok(lane.due_at <= now + 60_000, 'backlog is armed within one minute');
    else assert.ok(lane.due_at > now + 60_000, 'normal deadline is restored after cleanup');
  }
}));

test('overlapping upload_expiry runs commit only one deletion and holder release', () => withMail(async (h) => {
  const mail = h.as('member');
  const uploaded = await mail.createUpload(upload(), key('upload'));
  await h.pauseExpiry('upload_expiry');
  await h.advance(ttl);
  assert.equal(await h.expiryStarts(), 1);
  await h.advance(301_000);
  assert.equal(await h.expiryStarts(), 2);
  await h.finishExpiry();
  assert.equal(await h.eventCount('api_upload_delete'), 1);
  await h.advance(60_000);
  assert.equal((await h.acknowledgedReleases()).filter(row => uploadHolderFor(row.holder, uploaded.id)).length, 1);
}));

test('a second expiry pause waits for its own handler', () => withMail(async (h) => {
  const mail = h.as('member');
  for (const [i, name] of ['First', 'Second'].entries()) {
    await mail.createLabel({ name }, key(`pause-${i}`));
    await h.pauseExpiry('idem_expiry');
    await h.advance(day);
    assert.equal(await h.eventCount('api_result_expire'), i, 'the current expiry remains paused');
    await h.finishExpiry();
    assert.equal(await h.eventCount('api_result_expire'), i + 1);
  }
}));

test('overlapping idem_expiry runs cannot delete the reused key or its timer', () => withMail(async (h) => {
  const mail = h.as('member');
  await mail.createLabel({ name: 'First' }, key('same'));
  await h.pauseExpiry('idem_expiry');
  await h.advance(ttl);
  assert.equal(await h.expiryStarts(), 1);
  await h.advance(301_000);
  assert.equal(await h.expiryStarts(), 2);
  const replacement = await mail.createLabel({ name: 'Second' }, key('same'));
  await h.finishExpiry();
  assert.equal(await h.eventCount('api_result_expire'), 1);
  assert.deepEqual(await mail.createLabel({ name: 'Second' }, key('same')), replacement);
  assert.ok((await h.timers()).some(row => row.kind === 'idem_expiry' && row.ref === 'same'));
}));

test('a stalled release does not lose sibling acknowledgements or starve later rows', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  for (let i = 0; i < 8; i++) {
    const draft = await mail.createDraft(draftInput(mailbox.primaryAddress, { subject: `Draft ${i}` }), key(`draft-${i}`));
    await mail.deleteDraft(draft.id);
  }
  const [, ...otherHolds] = h.writes.map(write => write.holders[0]);
  const stuck = h.writes[0].holders[0];
  await h.stallRelease(stuck);
  await h.advance(60_000);
  assert.equal((await h.pendingReleases()).length, 3, 'the first five independent successes were acknowledged');
  assert.equal((await h.acknowledgedReleases()).length, 5);
  await h.advance(60_500);
  assert.deepEqual((await h.pendingReleases()).map(row => row.holder), [stuck]);
  assert.deepEqual((await h.acknowledgedReleases()).map(row => row.holder).sort(), otherHolds.sort());
}));

test('stalled confirmation leaves time for a published release', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const draft = await mail.createDraft(draftInput(mailbox.primaryAddress), key('draft'));
  await mail.deleteDraft(draft.id);
  await h.stallConfirmation();
  await h.advance(60_000);
  assert.equal((await h.confirmations()).length, 1);
  assert.deepEqual(await h.pendingReleases(), []);
  assert.deepEqual(await h.holders(h.writes[0].key), []);
}));

test('the draft-only path defers old holders even when uploads are disabled', () => withMail(async (h) => {
  await h.uploadSwitch(false);
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const input = draftInput(mailbox.primaryAddress);
  const original = await mail.createDraft(input, key('draft'));
  const [{ key: rawKey, holders: [oldHolder] }] = h.writes;
  await mail.replaceDraft(original.id, { ...input, subject: 'Edited' }, { ifMatch: original.revision });
  assert.ok((await h.holders(rawKey)).includes(oldHolder));
  assert.ok((await h.pendingReleases()).some(row => row.holder === oldHolder));
  await h.advance(60_000);
  assert.ok(!(await h.holders(rawKey)).includes(oldHolder));
  assert.equal((await h.holderDetails(h.writes[1].key))[0]?.state, 'held');
}));

test('a crash after the draft PUT leaves a provisional holder that expires', () => withMail(async (h) => {
  const mail = h.as('member');
  assert.equal(await h.stageAndCrash(), true);
  assert.equal(h.writes.length, 1);
  const { key: objectKey } = h.writes[0];
  const [holder] = await h.holderDetails(objectKey);
  assert.equal(holder.state, 'provisional');
  assert.ok(holder.expires_at && holder.expires_at - Date.now() <= PROVISIONAL_TTL);
  assert.deepEqual((await mail.listDrafts({})).items, []);
  assert.deepEqual(await h.confirmations(), []);
  await h.sweepAt(holder.expires_at);
  assert.equal((await h.holderDetails(objectKey))[0]?.state, 'expired');
}));

for (const size of [66, 68] as const) {
  test(`R2: all ${size} holders from one delta are confirmed before a later delta can block restore`, () => withMail(async (h) => {
    const mail = h.as('member');
    const { mailbox } = await mail.getSession();
    assert.ok(mailbox);
    if (size === 68) await h.confirmFailure(true);
    const files = await Promise.all(['first', 'second'].map(name => mail.createUpload(upload(name), key(`upload-${name}`))));
    if (size === 66) { await h.advance(60_000); await h.confirmFailure(true); }
    for (let i = 0; i < 22; i++) await mail.createDraft(draftInput(mailbox.primaryAddress, { subject: `Draft ${i}`,
      attachments: files.map(file => ({ kind: 'upload', uploadId: file.id })) }), key(`draft-${i}`));
    await h.advance(60_000);
    assert.equal((await h.confirmations()).length, size);
    await mail.createLabel({ name: 'Later delta' }, key('later'));
    await h.advance(60_000);
    await h.blockLaterDelta(48);
    await h.confirmFailure(false);
    await h.restore();
    await assert.rejects(mail.listDrafts({}), e => isMailApiError(e, 'mailbox_restoring'));
    assert.deepEqual(await h.confirmations(), []);
    for (const { key } of h.writes) assert.ok((await h.holderDetails(key)).every(row => row.state === 'held'));
    assert.deepEqual((await h.confirmBatches()).slice(-2), [64, size - 64]);
  }));
}

test('R2: a confirmation that fails once is retried before restore can reach ready', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  await h.confirmFailure(true);
  const draft = await mail.createDraft(draftInput(mailbox.primaryAddress), key('draft'));
  await h.advance(60_000);
  await h.confirmFailure(false);
  await h.failNextConfirmation();
  await h.restore();
  await assert.rejects(mail.getDraft(draft.id), e => isMailApiError(e, 'mailbox_restoring'));
  assert.equal((await h.holderDetails(h.writes[0].key))[0]?.state, 'provisional');
  await h.advance(60_000);
  assert.deepEqual(await mail.getDraft(draft.id), draft);
  assert.equal((await h.holderDetails(h.writes[0].key))[0]?.state, 'held');
}));

test('R5: the deployed Mailbox prototype does not export the legacy draft writer', () => withMail(async (h) => {
  assert.equal(await h.exposesLegacyWriter(), false);
}));

test('a restore spanning multiple confirmation batches checks published holders without losing any', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  await h.confirmFailure(true);
  for (let i = 0; i < 70; i++) {
    await mail.createDraft(draftInput(mailbox.primaryAddress, { subject: `Draft ${i}` }), key(`draft-${i}`));
  }
  await h.advance(60_000);
  assert.equal((await h.confirmations()).length, 70);
  await h.confirmFailure(false);
  await h.restore();
  await h.advance(60_000);
  for (const { key: objectKey } of h.writes) assert.equal((await h.holderDetails(objectKey))[0]?.state, 'held');
  assert.deepEqual(await h.confirmations(), []);
  const batches = await h.confirmBatches();
  assert.ok(batches.length >= 2 && batches.every(size => size <= 64));
  assert.equal(batches.reduce((sum, size) => sum + size, 0), 70);
}));

test('a direct release before confirmation never resurrects the holder', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  await mail.createDraft(draftInput(mailbox.primaryAddress), key('draft'));
  const [{ key: objectKey, holders: [holder] }] = h.writes;
  assert.equal((await h.confirmations()).length, 1);
  await h.releaseHolder(objectKey, holder);
  await h.advance(60_000);
  assert.deepEqual(await h.holderDetails(objectKey), []);
  assert.deepEqual(await h.confirmations(), []);
  assert.deepEqual(await h.confirmBatches(), [1]);
}));

test('holders include each mailbox scope and the full sweeper bound is accepted', () => withMail(async (h) => {
  const draftIds: Draft[] = [];
  for (const principal of ['member', 'other', 'foreignAdmin'] as const) {
    const mail = h.as(principal);
    const { mailbox } = await mail.getSession();
    assert.ok(mailbox);
    draftIds.push(await mail.createDraft(draftInput(mailbox.primaryAddress), key('draft')));
  }
  const scopes = h.writes.map(({ holders: [holder] }, i) => {
    const [, scope, id, revision] = holder.split(':');
    assert.match(scope, /^[0-9a-f]{64}$/);
    assert.equal(id, draftIds[i].id);
    assert.equal(revision, draftIds[i].revision);
    return scope;
  });
  assert.equal(new Set(scopes).size, 3);
  const full = await h.persistMaximumHolder(h.writes[0].key);
  assert.equal(full.length, 256);
  assert.ok((await h.pendingReleases()).some(row => row.holder === full));
  await h.advance(60_000);
  assert.ok(!(await h.holders(h.writes[0].key)).includes(full));
}));

test('a lost generation does not block restore and is journalled as unusable only after ready', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const draft = await mail.createDraft(draftInput(mailbox.primaryAddress), key('draft'));
  const [{ key: objectKey }] = h.writes;
  await h.confirmFailure(true);
  await h.advance(60_000);
  const [holder] = await h.holderDetails(objectKey);
  assert.ok(holder.expires_at);
  await h.sweepAt(holder.expires_at);
  await h.sweepAt(holder.expires_at + RETENTION_MS);
  assert.deepEqual(await h.holderDetails(objectKey), []);
  await h.confirmFailure(false);
  await h.restore();
  assert.equal((await h.confirmations()).length, 1);
  assert.equal(await h.eventCount('api_source_lost'), 0);
  await h.alertFailure(true);
  await h.advance(60_000);
  assert.deepEqual(await h.confirmations(), []);
  assert.equal(await h.eventCount('api_source_lost'), 1);
  assert.deepEqual((await mail.listDrafts({})).items, []);
  await assert.rejects(mail.getDraft(draft.id), (e) => isMailApiError(e, 'unavailable'));
  assert.ok(!(await h.alerts()).includes('mail:holder_source_lost'));
  await mail.deleteDraft(draft.id);
  await h.alertFailure(false);
  await h.advance(15 * 60_000);
  assert.ok((await h.alerts()).includes('mail:holder_source_lost'), 'deletion does not discard a detected loss awaiting an alert');
}));

test('holder_confirm_stale alerts one hour after coverage and not on every retry', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  await mail.createDraft(draftInput(mailbox.primaryAddress), key('draft'));
  await h.confirmFailure(true);
  await h.advance(60_000);
  await h.advance(3_600_000 - 1);
  const stale = async () => (await h.alerts()).filter(code => code === 'mail:holder_confirm_stale').length;
  assert.equal(await stale(), 0);
  await h.advance(1);
  assert.equal(await stale(), 1);
  await h.advance(60_000);
  assert.equal(await stale(), 1);
}));

test('case 21: draft writes reject raw header controls before length or normalization', () => withMail(async (h) => {
  const mail = h.as('member');
  const { mailbox } = await mail.getSession();
  assert.ok(mailbox);
  const input = draftInput(mailbox.primaryAddress);
  const saved = await mail.createDraft(input, key('draft'));
  for (const control of ['\r', '\n', '\0']) {
    const large = 'x'.repeat(LIMITS.subjectBytes + LIMITS.displayNameBytes + LIMITS.addressBytes + 1) + control;
    for (const [field, patch] of [['/from', { from: large }], ['/subject', { subject: large }],
      ['/to/0/email', { to: [{ email: large }] }], ['/cc/0/name', { cc: [{ email: mailbox.primaryAddress, name: large }] }]] as const) {
      const invalid: DraftInput = { ...input, ...(patch as Partial<DraftInput>) };
      const faulty = (e: unknown) => isMailApiError(e, 'invalid_header') && e.problem.errors?.some(error => error.field === field);
      await assert.rejects(mail.createDraft(invalid, key('bad-header')), faulty);
      await assert.rejects(mail.replaceDraft(saved.id, invalid, { ifMatch: saved.revision }), faulty);
    }
  }
  assert.deepEqual(await mail.getDraft(saved.id), saved);
}));
