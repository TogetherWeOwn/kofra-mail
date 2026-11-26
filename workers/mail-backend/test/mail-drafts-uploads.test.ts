import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { isMailApiError, LIMITS } from '../../../contracts/mail-api/src/index.ts';
import type { DraftInput } from '../../../contracts/mail-api/src/wire.ts';
import { startMailHttpFixture } from './fixtures/mail-http.ts';

const key = (idempotencyKey: string) => ({ idempotencyKey });
const missingKey = {} as ReturnType<typeof key>;
const missingRevision = {} as { ifMatch: string };
const draftInput = (from: string, patch: Partial<DraftInput> = {}): DraftInput => ({
  from, to: [], cc: [], bcc: [], subject: '', body: '', attachments: [], ...patch,
});
const upload = (bytes: string | Uint8Array<ArrayBuffer> = 'example attachment') => ({ name: 'note.txt', type: 'text/plain', bytes: new Blob([bytes]) });
const ttl = LIMITS.uploadRetentionSeconds * 1000;

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
    assert.match(objectKey, /^drafts\/[a-f0-9]{64}$/);
    assert.ok(holders.some(holder => holder.startsWith('draft:')), 'hold precedes PUT');
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
  assert.ok(uploaded.holders.some(holder => holder.startsWith('upload:')), 'hold precedes PUT');
  assert.equal(new TextDecoder().decode(h.objects.get(`/mail-w1/${uploaded.key}`)), 'example attachment');
  assert.ok((await h.timers()).some(row => row.kind === 'upload_expiry' && row.ref === loose.id && row.due_at === Date.parse(loose.expiresAt)));
  const draft = await mail.createDraft(withUpload(retained.id), key('draft'));
  assert.ok(!(await h.timers()).some(row => row.kind === 'upload_expiry' && row.ref === retained.id));
  await h.advance(ttl);
  await h.advance(60_000); // The deletion must be published before releasing the object.
  assert.ok(!(await h.holders(uploaded.key)).includes(`upload:${loose.id}`));
  assert.ok((await h.holders(uploaded.key)).includes(`upload:${retained.id}`));
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
  await h.advance(ttl - 1);
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
  assert.deepEqual(await h.holders(h.writes[0].key), [h.writes[2].holders[0], `upload:${uploaded.id}`]);
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
  await h.publishFailure(false);
  await h.restore();
  assert.deepEqual(await mail.getDraft(original.id), original);
  assert.deepEqual(await mail.createDraft(input, key('draft')), original);
  assert.deepEqual(await mail.createUpload(upload(), key('attached')), attached);
  assert.deepEqual(await h.holders(previous.key), [holder]);
  assert.ok((await h.holders(h.writes[0].key)).includes(holder));
  assert.deepEqual((await h.timers()).filter(row => row.kind === 'upload_expiry').map(row => row.ref), [unattached.id]);
  assert.deepEqual((await h.timers()).filter(row => row.kind === 'idem_expiry').map(row => row.ref), ['attached', 'draft', 'unattached']);
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
  for (const remaining of [136, 72, 8, 0]) {
    await h.advance(60_000);
    assert.equal((await h.pendingReleases()).length, remaining);
    assert.equal((await h.acknowledgedReleases()).length, 200 - remaining);
  }
  const lane = (await h.timers()).find(row => row.kind === 'journal_flush');
  assert.ok(lane && lane.due_at > Date.parse(uploaded.expiresAt) - ttl + 5 * 60_000, 'normal deadline is restored after cleanup');
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
  assert.equal((await h.acknowledgedReleases()).filter(row => row.holder === `upload:${uploaded.id}`).length, 1);
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
