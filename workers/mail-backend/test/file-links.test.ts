import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import PostalMime from 'postal-mime';
import type { FileLink, LinkExpiry, MailService } from '../../../contracts/mail-api/src/index.ts';
import { locationFingerprint } from '../../../packages/link-storage/src/location.ts';
import type { SendLink, StoredFileLink } from '../src/file-links.ts';
import type { EmailCall } from './fixtures/send-consumer.ts';
import {
  DEPLOYMENT_LOCATION, LINK_HOST, startMailHttpFixture, WORKSPACE_LOCATION, WORKSPACE_LOCATION_ID, type FileLinkOptions,
} from './fixtures/mail-http.ts';

// Revocable file links (docs/m3-outbound-plan.md, M3-13 acceptance), against the
// real Mailbox objects, the real content Worker on the link host, the D1 routing
// table, and local fake S3 endpoints for the deployment's and a workspace's
// link locations. No real provider or credential is involved.
type Fixture = Awaited<ReturnType<typeof startMailHttpFixture>>;
type Links = NonNullable<Fixture['links']>;
const second = 1000, minute = 60 * second, hour = 60 * minute, day = 24 * hour;
const UNDO = 10 * second;
const WS = 'w1', MB = 'mailbox-a';
const OUTSIDE = 'friend@example.net', OTHER = 'other@example.com';
const sha = (bytes: Uint8Array | ArrayBuffer) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

async function withLinks(run: (h: Fixture, mail: MailService, from: string, links: Links) => Promise<void>,
  options: { fileLinks?: FileLinkOptions } & Omit<Parameters<typeof startMailHttpFixture>[0] & object, 'fileLinks'> = {}) {
  const fixture = await startMailHttpFixture({ send: true, ...options, fileLinks: options.fileLinks ?? {} });
  try {
    const mail = fixture.as('member');
    const { mailbox } = await mail.getSession();
    assert.ok(mailbox && fixture.links);
    await run(fixture, mail, mailbox.primaryAddress, fixture.links);
  } finally { await fixture.close(); }
}

type LinkInput = { linkUploadId: string; name: string; size: number; expiry: LinkExpiry; link: StoredFileLink };
let uploads = 0;
// A completed link upload's object in a location's fake bucket, in the form a draft attaches it.
async function linkFile(links: Links, bytes: Uint8Array<ArrayBuffer>, options: { name?: string; expiry?: LinkExpiry; kind?: 'deployment' | 'workspace' } = {}): Promise<LinkInput> {
  const kind = options.kind ?? 'deployment';
  const fields = kind === 'deployment' ? DEPLOYMENT_LOCATION : WORKSPACE_LOCATION;
  const key = `${fields.prefix}ws/${WS}/${MB}/upload-${++uploads}`;
  links.put(kind, key, bytes);
  return { linkUploadId: `upload-${uploads}`, name: options.name ?? `file-${uploads}.bin`, size: bytes.byteLength, expiry: options.expiry ?? 30,
    link: { location: { kind, id: kind === 'deployment' ? 'links' : WORKSPACE_LOCATION_ID }, key, fingerprint: await locationFingerprint(fields) } };
}
const bytesOf = (size: number, seed = 1) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) & 0xff);

// A draft with these links, sent; still in its undo window.
async function submit(h: Fixture, mail: MailService, from: string, files: LinkInput[], to: string[] = [OUTSIDE], token = crypto.randomUUID()) {
  const draft = await h.links!.control<{ id: string; revision: string }>('seedDraft', [{ from, to, links: files }]);
  return (await mail.sendDraft(draft.id, { idempotencyKey: `send-${token}`, ifMatch: draft.revision })).id;
}
// The links frozen in a send's record.
async function frozen(h: Fixture, id: string): Promise<SendLink[]> {
  const row = await h.sends.row(id);
  assert.ok(row);
  return (JSON.parse(row.record) as { links: SendLink[] }).links;
}
const path = (link: Pick<SendLink, 'token'>, action = '') => `/f/${link.token}${action}`;
const emailCalls = async (h: Fixture) => (await h.consumer<EmailCall[]>('emailCalls')).length + await h.sends.emailCalls();
const ledgerOf = (state: { ledger: { kind: string; state: string; reason: string | null }[] }) =>
  state.ledger.map(({ kind, state: s, reason }) => `${kind}:${s}${reason ? `:${reason}` : ''}`);

test('link upload create replays the same upload and Complete can be retried', () => withLinks(async (h, mail) => {
  const bytes = new Blob([bytesOf(700)]);
  const options = { idempotencyKey: 'link-upload-replay' };
  const input = { name: 'replay.bin', size: bytes.size };
  const upload = await mail.createLinkUpload(input, options);
  assert.equal(upload.state, 'uploading');
  assert.deepEqual(await mail.createLinkUpload(input, options), upload);
  await assert.rejects(mail.createLinkUpload({ ...input, size: 701 }, options), { code: 'idempotency_key_reused' });
  await mail.putLinkPart(upload.id, 1, { bytes });
  const completed = await mail.completeLinkUpload(upload.id);
  assert.equal(completed.state, 'complete');
  assert.deepEqual(await mail.completeLinkUpload(upload.id), completed);
  assert.deepEqual(await mail.getLinkUpload(upload.id), completed);
  assert.equal((await h.directoryRows('SELECT size FROM link_objects')).length, 1);
}, { fileLinks: { uploads: true } }));

test('a completed link upload belongs to one draft lineage until removal or draft deletion', () => withLinks(async (_h, mail, from) => {
  const bytes = new Blob([bytesOf(80)]);
  const upload = await mail.createLinkUpload({ name: 'owned.bin', size: bytes.size }, { idempotencyKey: 'link-upload-claim' });
  await mail.putLinkPart(upload.id, 1, { bytes });
  await mail.completeLinkUpload(upload.id);
  const body = { from, to: [{ email: OUTSIDE }], cc: [], bcc: [], subject: 'One lineage', body: 'Draft' };
  const attachment = { kind: 'file_link' as const, linkUploadId: upload.id, expiry: 7 };
  const make = (id: number) => mail.createDraft({ ...body, attachments: [attachment] }, { idempotencyKey: `draft-claim-${id}` });
  const first = await make(1);
  await assert.rejects(make(2), { code: 'upload_in_use' });
  await mail.replaceDraft(first.id, { ...body, attachments: [] }, { ifMatch: first.revision });
  const second = await make(2);
  await mail.deleteDraft(second.id, { ifMatch: second.revision });
  assert.equal((await make(3)).attachments[0].kind, 'file_link');
}, { fileLinks: { uploads: true } }));

const uploadOptions = { fileLinks: { uploads: true } };
async function realUpload(mail: MailService, key: string, bytes = new Blob([bytesOf(90)])) {
  const upload = await mail.createLinkUpload({ name: `${key}.bin`, size: bytes.size }, { idempotencyKey: key });
  await mail.putLinkPart(upload.id, 1, { bytes });
  return mail.completeLinkUpload(upload.id);
}
const bodyOf = (from: string) => ({ from, to: [{ email: OUTSIDE }], cc: [], bcc: [], subject: 'Files', body: 'Draft' });

test('link upload creation shares the mailbox idempotency-key scope', () => withLinks(async (_h, mail, from) => {
  const input = { name: 'keys.bin', size: 20 };
  const first = { idempotencyKey: 'used-by-link' }, second = { idempotencyKey: 'used-by-draft' };
  await mail.createLinkUpload(input, first);
  await assert.rejects(mail.createDraft({ ...bodyOf(from), attachments: [] }, first), { code: 'idempotency_key_reused' });
  await mail.createDraft({ ...bodyOf(from), attachments: [] }, second);
  await assert.rejects(mail.createLinkUpload(input, second), { code: 'idempotency_key_reused' });
}, uploadOptions));
async function realDraft(mail: MailService, from: string, id: string, expiry: LinkExpiry = 'never') {
  return mail.createDraft({ ...bodyOf(from), attachments: [{ kind: 'file_link', linkUploadId: id, expiry }] }, { idempotencyKey: `draft-${id}` });
}

test('streams two exact parts with UNSIGNED-PAYLOAD and recovers a completed object by HEAD', () => withLinks(async (_h, mail, _from, links) => {
  const part = 16 * 1024 * 1024;
  const first = Buffer.alloc(part, 81);
  const last = Buffer.alloc(9, 27);
  const upload = await mail.createLinkUpload({ name: 'two-parts.bin', size: part + last.length }, { idempotencyKey: 'link-two-parts' });
  assert.equal(upload.parts, 2);
  assert.equal(upload.partSize, part);
  await mail.putLinkPart(upload.id, 1, { bytes: new Blob([first]) });
  await mail.putLinkPart(upload.id, 2, { bytes: new Blob([last]) });
  const store = links.stores.workspace;
  assert.deepEqual(store.calls.filter(call => call.op === 'UploadPart').map(call => call.unsignedPayload), [true, true]);
  store.loseNextComplete();
  await assert.rejects(mail.completeLinkUpload(upload.id), { code: 'unavailable' });
  assert.equal((await mail.completeLinkUpload(upload.id)).state, 'complete');
  assert.equal(store.calls.filter(call => call.op === 'CompleteMultipart').length, 1);
  assert.equal(sha([...store.objects.values()][0]), createHash('sha256').update(first).update(last).digest('hex'));
}, uploadOptions));

test('multipart rejects another mailbox, wrong part size and a size lie, then accepts a resent failed part', () => withLinks(async (h, mail, _from, links) => {
  const upload = await mail.createLinkUpload({ name: 'size.bin', size: 90 }, { idempotencyKey: 'link-upload-parts' });
  const bytes = new Blob([bytesOf(90)]);
  await assert.rejects(h.as('other').putLinkPart(upload.id, 1, { bytes }), { code: 'not_found' });
  await assert.rejects(mail.putLinkPart(upload.id, 1, { bytes: bytes.slice(1) }), { code: 'invalid_request' });
  await assert.rejects(mail.putLinkPart(upload.id, 2, { bytes }), { code: 'invalid_request' });
  assert.equal(links.stores.workspace.calls.filter(row => row.op === 'UploadPart').length, 0);
  links.stores.workspace.fail('UploadPart');
  await assert.rejects(mail.putLinkPart(upload.id, 1, { bytes }), { code: 'unavailable' });
  await mail.putLinkPart(upload.id, 1, { bytes });
  const [parts] = links.stores.workspace.uploads.values();
  parts.set(1, bytesOf(89)); // A provider reports fewer bytes than the declared size.
  await assert.rejects(mail.completeLinkUpload(upload.id), { code: 'invalid_request' });
  await mail.putLinkPart(upload.id, 1, { bytes });
  assert.equal((await mail.completeLinkUpload(upload.id)).size, 90);
}, uploadOptions));

test('the part number is validated independently of its content length', () => withLinks(async (_h, mail, _from, links) => {
  const upload = await mail.createLinkUpload({ name: 'number.bin', size: 90 }, { idempotencyKey: 'link-upload-number' });
  // A normal non-final part would be exactly this length. Only the number is invalid.
  const bytes = new Blob([Buffer.alloc(upload.partSize)]);
  await assert.rejects(mail.putLinkPart(upload.id, upload.parts + 1, { bytes }), { code: 'invalid_request' });
  assert.equal(links.stores.workspace.calls.filter(call => call.op === 'UploadPart').length, 0);
}, uploadOptions));

test('the dedicated part limiter refuses a part without reaching storage', () => withLinks(async (h, mail, _from, links) => {
  const upload = await mail.createLinkUpload({ name: 'limited.bin', size: 5 }, { idempotencyKey: 'link-upload-limit' });
  await h.sends.rateCap('MAIL_RATE_LINK_PARTS', 0);
  await assert.rejects(mail.putLinkPart(upload.id, 1, { bytes: new Blob(['bytes']) }), { code: 'rate_limited' });
  assert.equal(links.stores.workspace.calls.filter(call => call.op === 'UploadPart').length, 0);
}, uploadOptions));

test('a registered link must still have a usable registry row after a rewind', () => withLinks(async (h, mail, from, links) => {
  const upload = await realUpload(mail, 'retiring-link');
  const draft = await realDraft(mail, from, upload.id);
  const send = await mail.sendDraft(draft.id, { idempotencyKey: 'send-retiring-link', ifMatch: draft.revision });
  const [link] = await frozen(h, send.id);
  await h.advance(UNDO);
  assert.equal((await links.fetch(path(link))).status, 200);
  // The mailbox consults the non-rewindable registry before opening a link even when
  // the mailbox's journal does not yet show the revocation that retired the object.
  await h.directoryChange("UPDATE link_objects SET state = 'retiring' WHERE id = ?", upload.id);
  assert.equal((await links.fetch(path(link))).status, 404);
}, uploadOptions));

test('an opted-in mailbox still reports file links off without configured storage', () => withLinks(async (_h, mail) => {
  assert.equal((await mail.getSession()).features.fileLinks, false);
  await assert.rejects(mail.createLinkUpload({ name: 'unconfigured.bin', size: 1 }, { idempotencyKey: 'link-no-storage' }), { code: 'feature_unavailable' });
}, { fileLinks: { uploads: true, deploymentOnly: true }, configureWorkers: worker => {
  const { LINK_LOCATIONS: _locations, LINK_WRITE_CREDENTIALS: _write, ...other } = worker.bindings ?? {};
  worker.bindings = other;
} }));

test('configured deployment storage works without a workspace override', () => withLinks(async (_h, mail, _from, links) => {
  assert.equal((await mail.getSession()).features.fileLinks, true);
  await realUpload(mail, 'deployment-upload');
  assert.equal(links.stores.deployment.objects.size, 1);
  assert.equal(links.stores.workspace.objects.size, 0);
}, { fileLinks: { uploads: true, deploymentOnly: true } }));

test('cron finds and aborts a lost upload id, removes abandoned objects and releases live bytes', () => withLinks(async (h, mail, _from, links) => {
  links.stores.workspace.loseNextUploadId();
  await assert.rejects(mail.createLinkUpload({ name: 'lost.bin', size: 100 }, { idempotencyKey: 'link-upload-lost' }), { code: 'idempotency_in_progress' });
  const ready = await realUpload(mail, 'abandoned');
  assert.equal(links.stores.workspace.uploads.size, 1);
  assert.equal(links.stores.workspace.objects.size, 1);
  await h.advance(7 * day + minute);
  await h.backendCron();
  assert.equal(links.stores.workspace.uploads.size, 0);
  assert.equal(links.stores.workspace.objects.size, 0);
  await assert.rejects(mail.getLinkUpload(ready.id), { code: 'not_found' });
  assert.deepEqual(await h.directoryRows('SELECT size FROM link_live_bytes'), [{ size: 0 }]);
}, uploadOptions));

test('undo keeps a real object and the restored draft sends; revocation deletes it and frees its location', () => withLinks(async (h, mail, from, links) => {
  const upload = await realUpload(mail, 'undo');
  const draft = await realDraft(mail, from, upload.id);
  const first = await mail.sendDraft(draft.id, { idempotencyKey: 'send-link-undo', ifMatch: draft.revision });
  await mail.undoSend(first.id, { idempotencyKey: 'undo-link-undo' });
  const restored = await mail.getDraft(draft.id);
  assert.equal(links.stores.workspace.objects.size, 1);
  const send = await mail.sendDraft(restored.id, { idempotencyKey: 'send-link-again', ifMatch: restored.revision });
  const [link] = await frozen(h, send.id);
  await h.advance(UNDO);
  assert.equal((await links.fetch(path(link, '/download'))).status, 200);
  await h.consumer('drain', WS, MB);
  await mail.revokeLink(link.id);
  await h.backendCron();
  assert.equal((await links.fetch(path(link, '/download'))).status, 404);
  assert.equal(links.stores.workspace.objects.size, 0);
  assert.equal((await h.as('admin').listLinkLocations()).items.length, 1);
  await h.as('admin').deleteLinkLocation(WORKSPACE_LOCATION_ID);
  assert.equal((await h.as('admin').listLinkLocations()).items.length, 0);
}, uploadOptions));

test('a missing uploaded object at release is a lost source and never reaches EMAIL', () => withLinks(async (h, mail, from, links) => {
  const upload = await realUpload(mail, 'missing');
  const draft = await realDraft(mail, from, upload.id);
  const send = await mail.sendDraft(draft.id, { idempotencyKey: 'send-link-missing', ifMatch: draft.revision });
  const [link] = await frozen(h, send.id);
  assert.ok(links.stores.workspace.objects.delete(link.key));
  await h.advance(UNDO);
  assert.equal((await mail.getSend(send.id)).state, 'failed');
  assert.deepEqual(ledgerOf(await h.sendState(send.id)), ['external:failed:delivery_error']);
  assert.equal(await emailCalls(h), 0);
}, uploadOptions));

test('test-only expiry sets the frozen lifetime and a published expiry deletes the object', () => withLinks(async (h, mail, from, links) => {
  const upload = await realUpload(mail, 'expiry');
  const draft = await realDraft(mail, from, upload.id, 7);
  const send = await mail.sendDraft(draft.id, { idempotencyKey: 'send-link-expiry', ifMatch: draft.revision });
  const [link] = await frozen(h, send.id);
  assert.equal(link.expiresAt, (await h.sends.row(send.id))!.undo_until + 120 * second);
  await h.advance(UNDO);
  await h.backendCron();
  await h.consumer('drain', WS, MB);
  assert.equal((await mail.getSend(send.id)).state, 'sent');
  assert.equal((await links.fetch(path(link, '/download'))).status, 200);
  await h.advance(120 * second);
  await h.backendCron();
  assert.equal((await links.fetch(path(link, '/download'))).status, 404);
  assert.equal(links.stores.workspace.objects.size, 0, JSON.stringify(await h.directoryRows('SELECT state, confirmed, sweep_at, delete_since FROM link_objects WHERE id = ?', upload.id)));
  assert.equal((await mail.listLinks({})).items[0].state, 'expired');
}, { ...uploadOptions, configureWorkers: worker => { worker.bindings = { ...worker.bindings, LINK_TEST_EXPIRY_SECONDS: '120' }; } }));

test('test-only expiry is refused in production', () => withLinks(async (h, mail, from) => {
  const upload = await realUpload(mail, 'production-expiry');
  const draft = await realDraft(mail, from, upload.id, 7);
  await assert.rejects(mail.sendDraft(draft.id, { idempotencyKey: 'send-expiry-prod', ifMatch: draft.revision }), { code: 'feature_unavailable' });
  assert.equal((await h.as('member').listSends({})).items.length, 0);
}, { ...uploadOptions, configureWorkers: worker => { worker.bindings = { ...worker.bindings, LINK_TEST_EXPIRY_SECONDS: '120', MAIL_ENVIRONMENT: 'production' }; } }));

test('a restore that rewinds an unpublished attach keeps the object registered and claimable', () => withLinks(async (h, mail, from, links) => {
  const upload = await realUpload(mail, 'rewind-attach');
  assert.ok(await h.forceSnapshot());
  await h.publishFailure(true);
  await realDraft(mail, from, upload.id);
  await h.publishFailure(false);
  await h.restore();
  assert.equal((await mail.listDrafts({})).items.length, 0);
  assert.equal((await h.directoryRows('SELECT state FROM link_objects WHERE id = ?', upload.id))[0]?.state, 'complete');
  const draft = await realDraft(mail, from, upload.id);
  assert.equal(draft.attachments[0].kind, 'file_link');
  assert.equal(links.stores.workspace.objects.size, 1);
}, uploadOptions));

test('a restore that rewinds an unpublished revoke never opens a link to deleted bytes', () => withLinks(async (h, mail, from, links) => {
  const draft = await realDraft(mail, from, (await realUpload(mail, 'rewind-revoke')).id);
  const send = await mail.sendDraft(draft.id, { idempotencyKey: 'send-after-rewind', ifMatch: draft.revision });
  const [link] = await frozen(h, send.id);
  await h.advance(UNDO);
  await h.consumer('drain', WS, MB);
  assert.ok(await h.forceSnapshot());
  await h.publishFailure(true);
  await assert.rejects(mail.revokeLink(link.id), { code: 'unavailable' });
  await h.backendCron();
  assert.equal(links.stores.workspace.objects.size, 1);
  await h.publishFailure(false);
  await h.restore();
  await h.advance(minute);
  assert.equal((await links.fetch(path(link, '/download'))).status, 200);
  await mail.revokeLink(link.id);
  await h.advance(minute);
  await h.backendCron();
  assert.equal(links.stores.workspace.objects.size, 0);
  await h.restore();
  assert.equal((await links.fetch(path(link, '/download'))).status, 404);
}, uploadOptions));

test('workspace byte caps hold across mailboxes and deletion refunds only live usage', () => withLinks(async (h, mail) => {
  const results = await Promise.allSettled([mail.createLinkUpload({ name: 'a.bin', size: 60 }, { idempotencyKey: 'cap-a' }),
    h.as('other').createLinkUpload({ name: 'b.bin', size: 60 }, { idempotencyKey: 'cap-b' })]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  const winner = results.findIndex(r => r.status === 'fulfilled');
  await assert.rejects(Promise.reject((results[1 - winner] as PromiseRejectedResult).reason), { code: 'limit_reached' });
  await (winner === 0 ? mail : h.as('other')).deleteLinkUpload((results[winner] as PromiseFulfilledResult<{ id: string }>).value.id);
  await h.advance(minute);
  await h.backendCron();
  await assert.rejects(mail.createLinkUpload({ name: 'c.bin', size: 85 }, { idempotencyKey: 'cap-c' }), { code: 'limit_reached' });
  assert.equal((await mail.createLinkUpload({ name: 'd.bin', size: 10 }, { idempotencyKey: 'cap-d' })).size, 10);
}, { ...uploadOptions, configureWorkers: worker => {
  worker.bindings = { ...worker.bindings, LINK_WORKSPACE_LIMITS: JSON.stringify({ [WS]: { liveBytes: 100, dailyBytes: 140 } }) };
} }));

test('a provider delete that fails for 24 hours alerts and keeps the workspace location in use', () => withLinks(async (h, mail, from, links) => {
  const draft = await realDraft(mail, from, (await realUpload(mail, 'delete-failed')).id);
  const send = await mail.sendDraft(draft.id, { idempotencyKey: 'send-delete-failed', ifMatch: draft.revision });
  const [link] = await frozen(h, send.id);
  await h.advance(UNDO);
  await mail.revokeLink(link.id);
  links.stores.workspace.fail('DeleteObject', 2);
  await h.backendCron();
  assert.equal(links.stores.workspace.objects.size, 1);
  await assert.rejects(h.as('admin').deleteLinkLocation(WORKSPACE_LOCATION_ID), { code: 'location_in_use' });
  await h.advance(day + minute);
  await h.backendCron();
  await h.backendCron();
  assert.ok((await links.alerts()).some(alert => alert.source === 'mail:delete_failed'));
}, uploadOptions));

test('the frozen link block is escaped in HTML and release replay builds identical bytes', () => withLinks(async (h, mail, from) => {
  const name = `quote <img> & ${String.fromCodePoint(0x202e)}.bin`;
  const bytes = new Blob([bytesOf(60)]);
  const upload = await mail.createLinkUpload({ name, size: bytes.size }, { idempotencyKey: 'link-mime-upload' });
  await mail.putLinkPart(upload.id, 1, { bytes });
  await mail.completeLinkUpload(upload.id);
  const draft = await realDraft(mail, from, upload.id);
  const send = await mail.sendDraft(draft.id, { idempotencyKey: 'send-link-mime', ifMatch: draft.revision });
  await h.sends.crashAfter('stored');
  await h.advance(UNDO);
  const first = (await h.sends.registration(send.id))!;
  const firstBytes = h.objects.get(`/mail-w1/${first.key}`)!;
  const parsed = await PostalMime.parse(firstBytes);
  assert.ok(/quote <img> & \.bin \(60 bytes\): https:\/\/files\.example\.test\/f\/[\w-]+ \(no expiry date\)/.test(parsed.text ?? ''), 'plain MIME includes the frozen link block');
  assert.ok(/<ul><li>quote &lt;img&gt; &amp; \.bin \(60 bytes\): <a href=/.test(parsed.html ?? ''), 'HTML MIME includes the escaped link list');
  assert.equal(/<img>|\p{Bidi_Control}/u.test(parsed.html ?? ''), false);
  await h.restore();
  assert.equal((await mail.getSend(send.id)).state, 'pending');
  await h.advance(UNDO);
  assert.equal((await mail.getSend(send.id)).state, 'sending');
  assert.deepEqual(await h.sends.registration(send.id), first);
  assert.deepEqual(h.objects.get(`/mail-w1/${first.key}`), firstBytes);
}, uploadOptions));

test('a sent file link routes by its token hash, serves its page and its bytes, and only the hash is stored', () => withLinks(async (h, mail, from, links) => {
  const bytes = bytesOf(70_000);
  const id = await submit(h, mail, from, [await linkFile(links, bytes, { name: 'Plan.pdf' })]);
  const [link] = await frozen(h, id);
  assert.match(link.token, /^[A-Za-z0-9_-]{21}[AQgw]$/, '128 random bits');
  assert.equal(link.host, LINK_HOST);
  // Before the release is published the link is not live and has no routing row.
  assert.equal((await links.fetch(path(link))).status, 404);
  await h.advance(UNDO);
  const rows = await h.directoryRows('SELECT * FROM file_links');
  assert.deepEqual(rows.map(row => [row.token_hash, row.link_id, row.workspace_id, row.mailbox_id, row.location_kind, row.location_id]),
    [[tokenHash(link.token), link.id, WS, MB, 'deployment', 'links']]);
  assert.ok(!JSON.stringify(rows).includes(link.token), 'the token itself is never stored in the routing table');
  const page = await links.fetch(path(link));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Plan\.pdf/);
  const file = await links.fetch(path(link, '/download'));
  assert.equal(file.status, 200);
  assert.equal(sha(await file.arrayBuffer()), sha(bytes));
  // The external recipient gets the link in the message.
  await h.consumer('drain', WS, MB);
  const [call] = await h.consumer<EmailCall[]>('emailCalls');
  assert.ok(call.text.includes(`https://${LINK_HOST}/f/${link.token}`));
  assert.equal((await mail.getSend(id)).state, 'sent');
}));

test('every request after a revocation, a deletion or expiresAt answers 404, and the list shows the link state', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(500)), await linkFile(links, bytesOf(600), { expiry: 1 }),
    await linkFile(links, bytesOf(700))]);
  const [revoked, expiring, deleted] = await frozen(h, id);
  assert.deepEqual((await mail.listLinks({})).items.map(link => link.state), ['pending', 'pending', 'pending'], 'not live before the release is published');
  await h.advance(UNDO);
  for (const link of [revoked, expiring, deleted]) assert.equal((await links.fetch(path(link))).status, 200);
  const answer = await mail.revokeLink(revoked.id);
  assert.deepEqual({ ...answer, createdAt: undefined }, { id: revoked.id, sendId: id, name: revoked.name, size: 500, url: `https://${LINK_HOST}/f/${revoked.token}`,
    createdAt: undefined, expiresAt: new Date(revoked.expiresAt!).toISOString(), state: 'revoked' } satisfies Omit<FileLink, 'createdAt'> & { createdAt: undefined });
  await mail.deleteLink(deleted.id);
  for (const link of [revoked, deleted]) {
    assert.equal((await links.fetch(path(link))).status, 404);
    assert.equal((await links.fetch(path(link, '/download'))).status, 404);
    assert.equal((await links.fetch(path(link, '/report'), { method: 'POST' })).status, 404);
  }
  // A revoke repeated, or of a deleted or unknown link, changes nothing.
  assert.equal((await mail.revokeLink(revoked.id)).state, 'revoked');
  await assert.rejects(mail.revokeLink(deleted.id), { code: 'not_found' });
  await assert.rejects(mail.revokeLink('aaaaaaaaaaaaaaaaaaaaaaaaaa'), { code: 'not_found' });
  await mail.deleteLink('aaaaaaaaaaaaaaaaaaaaaaaaaa');
  // expiresAt is dateAt + 1 day.
  const sendRow = (await h.sends.row(id))!;
  assert.equal(expiring.expiresAt, sendRow.undo_until + day);
  assert.equal((await links.fetch(path(expiring, '/download'))).status, 200);
  await h.advance(expiring.expiresAt! - await h.sends.now());
  assert.equal((await links.fetch(path(expiring))).status, 404);
  assert.equal((await links.fetch(path(expiring, '/download'))).status, 404);
  const listed = await mail.listLinks({});
  assert.deepEqual(listed.items.map(link => [link.id, link.state]).sort(), [[expiring.id, 'expired'], [revoked.id, 'revoked']].sort(),
    'a deleted link leaves the list');
  assert.equal(listed.nextCursor, null);
}));

test('a token reveals nothing: unknown, malformed, revoked and expired links answer the same 404', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(10)), await linkFile(links, bytesOf(10), { expiry: 1 })]);
  const [revoked, expired] = await frozen(h, id);
  await h.advance(UNDO);
  await mail.revokeLink(revoked.id);
  await h.advance(day);
  const unknown = `${'B'.repeat(21)}A`;
  const shape = async (target: string) => {
    const response = await links.fetch(target);
    const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== 'date'));
    return { status: response.status, headers, body: await response.text() };
  };
  const reference = await shape(`/f/${unknown}`);
  assert.equal(reference.status, 404);
  for (const target of [`/f/${unknown}/download`, '/f/not-a-token', `/f/${revoked.token}`, `/f/${revoked.token}/download`, `/f/${expired.token}`,
    `/f/${expired.token}/download`, `/f/${expired.token.slice(0, -1)}B`]) {
    assert.deepEqual(await shape(target), reference, target);
  }
  assert.ok(!reference.body.includes(revoked.token) && !reference.body.includes(expired.token));
  // A routing row can never open another link: the mailbox checks the hash against the frozen token.
  const live = (await frozen(h, await submit(h, mail, from, [await linkFile(links, bytesOf(10), { expiry: 'never' })])))[0];
  await h.advance(UNDO);
  assert.equal((await links.fetch(path(live))).status, 200);
  const forged = `${'D'.repeat(21)}A`;
  await h.directoryChange('UPDATE file_links SET token_hash = ? WHERE link_id = ?', tokenHash(forged), live.id);
  assert.deepEqual(await shape(`/f/${forged}`), reference);
  assert.deepEqual(await shape(`/f/${forged}/download`), reference);
}));

test('revokeLink answers only after the publish barrier; the revocation already stops downloads', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(100))]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  await h.publishFailure(true);
  await assert.rejects(mail.revokeLink(link.id), { code: 'unavailable' });
  assert.equal((await links.fetch(path(link, '/download'))).status, 404, 'the committed revocation is in force at once');
  await h.publishFailure(false);
  assert.equal((await mail.revokeLink(link.id)).state, 'revoked', 'the retry answers once a publish covers it');
  assert.equal((await links.fetch(path(link))).status, 404);
  // A deletion too: its retry answers 204 only once the deletion is published.
  await h.publishFailure(true);
  await assert.rejects(mail.deleteLink(link.id), { code: 'unavailable' });
  await assert.rejects(mail.deleteLink(link.id), { code: 'unavailable' }, 'a retry still waits for the publish');
  await h.publishFailure(false);
  await mail.deleteLink(link.id);
  assert.deepEqual((await mail.listLinks({})).items, []);
}));

test('a revocation survives a restore, from the snapshot and from a delta', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(100)), await linkFile(links, bytesOf(100)), await linkFile(links, bytesOf(100))]);
  const [early, late, kept] = await frozen(h, id);
  await h.advance(UNDO);
  await h.consumer('drain', WS, MB);
  await mail.revokeLink(early.id);
  assert.ok(await h.forceSnapshot());
  await mail.deleteLink(late.id);
  await h.restore();
  assert.equal((await links.fetch(path(early))).status, 404);
  assert.equal((await links.fetch(path(late))).status, 404);
  assert.equal((await links.fetch(path(kept, '/download'))).status, 200, 'a live link stays live');
  assert.deepEqual((await mail.listLinks({})).items.map(link => [link.id, link.state]).sort(), [[early.id, 'revoked'], [kept.id, 'live']].sort());
}));

test('the operator revokes a link by id or by token hash', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(100)), await linkFile(links, bytesOf(100))]);
  const [byId, byHash] = await frozen(h, id);
  await h.advance(UNDO);
  assert.equal(await links.control('operatorRevoke', [{ linkId: byId.id }]), 'revoked');
  assert.equal(await links.control('operatorRevoke', [{ tokenHash: tokenHash(byHash.token) }]), 'revoked');
  assert.equal(await links.control('operatorRevoke', [{ tokenHash: '0'.repeat(64) }]), 'not_found');
  for (const link of [byId, byHash]) assert.equal((await links.fetch(path(link))).status, 404);
  assert.deepEqual((await mail.listLinks({})).items.map(link => link.state), ['revoked', 'revoked']);
}));

test('ranged requests count their bytes, counters answer 429, and the total budget holds across hours', () => withLinks(async (h, mail, from, links) => {
  const size = 1000;
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(size))]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  // Budget: 2 times the size per hour, 3 times in total.
  const ranged = await links.fetch(path(link, '/download'), { headers: { range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  assert.equal((await links.fetch(path(link, '/download'), { headers: { range: 'bytes=100-' } })).status, 206, 'charged 900');
  assert.equal((await links.fetch(path(link, '/download'), { headers: { range: 'bytes=0-999' } })).status, 206, 'charged 1000: 2000 this hour');
  const refused = await links.fetch(path(link, '/download'), { headers: { range: 'bytes=0-0' } });
  assert.equal(refused.status, 429, 'one more byte is over the hourly budget');
  assert.equal(refused.headers.get('retry-after'), '3600');
  const limitedPage = await links.fetch(path(link));
  assert.equal(limitedPage.status, 429, 'the page says so too');
  assert.ok((await limitedPage.text()).includes(`<form method="post" action="/f/${link.token}/report"><button class="report" type="submit">Report abuse</button>`),
    'and still offers Report abuse');
  assert.equal((await links.fetch(path(link, '/report'), { method: 'POST' })).status, 200, 'a spent link can be reported');
  await h.advance(hour);
  assert.equal((await links.fetch(path(link, '/download'))).status, 200, 'a new hour: 3000 in total');
  assert.equal((await links.fetch(path(link, '/download'), { headers: { range: 'bytes=0-0' } })).status, 429, 'the total budget is spent');
}, { fileLinks: { hourlyFactor: 2, totalFactor: 3 } }));

test('concurrent downloads cannot exceed the byte budget', () => withLinks(async (h, mail, from, links) => {
  const size = 4096;
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(size))]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  const answers = await Promise.all(Array.from({ length: 12 }, async () => {
    const response = await links.fetch(path(link, '/download'));
    return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
  }));
  assert.deepEqual(answers.filter(({ status }) => status === 200).map(({ bytes }) => bytes), [size, size, size], 'exactly the budget is served');
  assert.equal(answers.filter(({ status }) => status === 429).length, 9);
}, { fileLinks: { hourlyFactor: 3, totalFactor: 3 } }));

test('Range resumes work, an If-Range mismatch serves the whole file, and a range past the end answers 416', () => withLinks(async (h, mail, from, links) => {
  const bytes = bytesOf(100_000, 7);
  const id = await submit(h, mail, from, [await linkFile(links, bytes)]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  const first = await links.fetch(path(link, '/download'), { headers: { range: 'bytes=0-39999' } });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), 'bytes 0-39999/100000');
  const etag = first.headers.get('etag');
  assert.equal(etag, `"${link.id}"`);
  const head = new Uint8Array(await first.arrayBuffer());
  const rest = await links.fetch(path(link, '/download'), { headers: { range: 'bytes=40000-', 'if-range': etag! } });
  assert.equal(rest.status, 206);
  assert.equal(rest.headers.get('content-length'), '60000');
  const tail = new Uint8Array(await rest.arrayBuffer());
  assert.equal(sha(Buffer.concat([head, tail])), sha(bytes), 'the resumed parts make the file');
  const capital = await links.fetch(path(link, '/download'), { headers: { range: 'Bytes=99990-' } });
  assert.equal(capital.status, 206, 'the range unit is case-insensitive');
  assert.deepEqual(new Uint8Array(await capital.arrayBuffer()), bytes.slice(-10));
  const suffix = await links.fetch(path(link, '/download'), { headers: { range: 'bytes=-10' } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), bytes.slice(-10));
  const stale = await links.fetch(path(link, '/download'), { headers: { range: 'bytes=40000-', 'if-range': '"other"' } });
  assert.equal(stale.status, 200);
  assert.equal((await stale.arrayBuffer()).byteLength, 100_000);
  const past = await links.fetch(path(link, '/download'), { headers: { range: 'bytes=100000-' } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), 'bytes */100000');
}));

test('download headers follow content-origin 3.4 whatever the provider returns', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(300), { name: 'report "final"; v2.html' })]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  for (const range of [undefined, 'bytes=10-19']) {
    const response = await links.fetch(path(link, '/download'), range ? { headers: { range } } : {});
    assert.equal(response.status, range ? 206 : 200);
    const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== 'date'));
    assert.deepEqual(headers, {
      'accept-ranges': 'bytes', 'cache-control': 'private, no-store',
      'content-disposition': `attachment; filename="report _final__ v2.html"; filename*=UTF-8''report%20%22final%22%3B%20v2.html`,
      'content-length': range ? '10' : '300', ...(range && { 'content-range': 'bytes 10-19/300' }),
      'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
      'content-type': 'application/octet-stream', etag: `"${link.id}"`, 'referrer-policy': 'no-referrer',
      'strict-transport-security': 'max-age=31536000; includeSubDomains', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow',
    });
    await response.arrayBuffer();
  }
}, { fileLinks: { objectHeaders: { 'content-type': 'text/html', 'content-disposition': 'inline', 'set-cookie': 'session=provider',
  'access-control-allow-origin': '*', 'cache-control': 'public, max-age=31536000', 'content-security-policy': 'default-src *', 'x-amz-meta-note': 'hello' } } }));

test('a provider answer of another length or range is never served, and nothing is charged for it', () => withLinks(async (h, mail, from, links) => {
  const file = await linkFile(links, bytesOf(1000));
  const id = await submit(h, mail, from, [file]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  links.put('deployment', file.link.key, bytesOf(999));
  assert.equal((await links.fetch(path(link, '/download'))).status, 502, 'a shorter object');
  assert.equal((await links.fetch(path(link, '/download'), { headers: { range: 'bytes=990-' } })).status, 502, 'another range');
  links.put('deployment', file.link.key, bytesOf(1000));
  // The budget (1 time the size) was not spent by the refused answers.
  assert.equal((await links.fetch(path(link, '/download'))).status, 200);
}, { fileLinks: { hourlyFactor: 1, totalFactor: 1 } }));

test('a workspace location serves with its own read key, and a repointed location is never read', () => withLinks(async (h, mail, from, links) => {
  const bytes = bytesOf(2048, 3);
  const id = await submit(h, mail, from, [await linkFile(links, bytes, { kind: 'workspace' })]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  const response = await links.fetch(path(link, '/download'));
  assert.equal(response.status, 200);
  assert.equal(sha(await response.arrayBuffer()), sha(bytes));
  assert.deepEqual(links.stores.workspace.calls.map(call => [call.op, call.signedBy]), [['GetObject', 'ws-reader-0001']], 'only the read key reads');
  await h.directoryChange("UPDATE link_storage_locations SET bucket = 'other-bucket' WHERE location_id = ?", WORKSPACE_LOCATION_ID);
  assert.equal((await links.fetch(path(link, '/download'))).status, 502, 'the location fingerprint no longer matches');
  assert.equal(links.stores.workspace.calls.length, 1, 'and nothing was read from it');
}));

test('a location with a routed link cannot be deleted, and release step 4b writes no reference to a location being deleted', () => withLinks(async (h, mail, from, links) => {
  const location = { workspaceId: WS, locationId: WORKSPACE_LOCATION_ID };
  assert.equal(await links.control('inUse', [location]), false);
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(64), { kind: 'workspace' })]);
  const [link] = await frozen(h, id);
  // While a delete checks usage, no new routing row may reference the location.
  await h.directoryChange("UPDATE link_storage_locations SET state = 'deleting', delete_claim = 'x', delete_claimed_at = ? WHERE location_id = ?",
    await h.sends.now(), WORKSPACE_LOCATION_ID);
  await h.advance(UNDO);
  assert.deepEqual(await h.directoryRows('SELECT link_id FROM file_links'), []);
  assert.deepEqual(await h.sends.queue(), [], 'nothing is enqueued before every link routes');
  assert.equal((await links.fetch(path(link))).status, 404);
  await h.directoryChange("UPDATE link_storage_locations SET state = 'active', delete_claim = NULL, delete_claimed_at = NULL WHERE location_id = ?",
    WORKSPACE_LOCATION_ID);
  const [due] = (await h.sendState(id)).drive;
  await h.advance(due - await h.sends.now());
  assert.equal((await links.fetch(path(link))).status, 200, 'the next drive run routes it');
  assert.equal((await h.sends.queue()).length, 1);
  assert.equal(await links.control('inUse', [location]), true);
  await assert.rejects(h.as('admin').deleteLinkLocation(WORKSPACE_LOCATION_ID), { code: 'location_in_use' });
  assert.deepEqual((await h.as('admin').listLinkLocations()).items.map(item => [item.id, item.state]), [[WORKSPACE_LOCATION_ID, 'active']]);
  // A revoked link's object stays until its lifecycle (M3-15b) deletes it, so the location stays in use.
  await mail.revokeLink(link.id);
  await assert.rejects(h.as('admin').deleteLinkLocation(WORKSPACE_LOCATION_ID), { code: 'location_in_use' });
}));

test('a location no link uses is deleted', () => withLinks(async h => {
  await h.as('admin').deleteLinkLocation(WORKSPACE_LOCATION_ID);
  assert.deepEqual((await h.as('admin').listLinkLocations()).items, []);
}));

test('the flood bucket runs before any lookup', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(100))]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  await links.floodCap(0);
  for (const [target, init] of [[path(link), {}], [path(link, '/download'), {}], [path(link, '/report'), { method: 'POST' }],
    ['/f/not-a-token', {}], [`/f/${'C'.repeat(21)}A`, {}]] as const) {
    const response = await links.fetch(target, { ...init, ip: '198.51.100.7' });
    assert.equal(response.status, 429, target);
    assert.equal(response.headers.get('retry-after'), '60');
  }
  assert.deepEqual(await links.control('lookups'), { lookups: 0, targets: 0 }, 'no routing lookup and no mailbox call');
  assert.deepEqual(new Set(await links.floodCalls()), new Set(['v4:198.51.100.7']), 'keyed by the client IP only');
  await links.floodCap(Infinity);
  assert.equal((await links.fetch(path(link))).status, 200);
  assert.deepEqual(await links.control('lookups'), { lookups: 1, targets: 1 });
}));

test('a report reaches the operator alert with the link id only, at most 10 per link', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(100))]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  const reported = await links.fetch(path(link, '/report'), { method: 'POST', body: 'why=spam' });
  assert.equal(reported.status, 200);
  assert.match(await reported.text(), /Report sent/);
  await h.backendCron();
  const alerts = await links.alerts();
  assert.deepEqual(alerts, [{ source: 'mail:link_reported', key: link.id, title: 'A file link was reported for abuse' }]);
  assert.ok(!JSON.stringify(alerts).includes(link.token) && !JSON.stringify(alerts).includes(tokenHash(link.token)));
  for (let n = 2; n <= 10; n++) assert.equal((await links.fetch(path(link, '/report'), { method: 'POST' })).status, 200, `report ${n}`);
  assert.equal((await links.fetch(path(link, '/report'), { method: 'POST' })).status, 429, 'the 11th report is refused');
  assert.deepEqual(await h.directoryRows('SELECT reports FROM file_links'), [{ reports: 10 }]);
  await h.backendCron();
  assert.equal((await links.alerts()).length, 1, 'one alert per link');
  assert.equal((await links.fetch(path(link), { method: 'POST' })).status, 405);
  assert.equal((await links.fetch(path(link, '/report'))).status, 405);
}));

test('no token or token hash appears in any log', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(100)), await linkFile(links, bytesOf(100))]);
  const [kept, revoked] = await frozen(h, id);
  await h.advance(UNDO);
  await h.consumer('drain', WS, MB);
  for (const link of [kept, revoked]) {
    await links.fetch(path(link));
    await (await links.fetch(path(link, '/download'), { headers: { range: 'bytes=0-9' } })).arrayBuffer();
    await links.fetch(path(link, '/report'), { method: 'POST' });
  }
  await mail.revokeLink(revoked.id);
  await links.fetch(path(revoked, '/download'));
  await links.control('operatorRevoke', [{ tokenHash: tokenHash(kept.token) }]);
  await links.fetch(path(kept));
  await h.backendCron();
  const logs = h.logs();
  assert.ok(logs.some(line => line.includes('"purpose":"link"')), 'link requests are logged');
  for (const link of [kept, revoked]) {
    for (const secret of [link.token, tokenHash(link.token), tokenHash(link.token).slice(0, 8)]) {
      assert.ok(!logs.some(line => line.includes(secret)), 'no token or hash in the logs');
    }
  }
}));

test('a send claimed after its links passed the floor ends link_expired with no EMAIL call, and the sender sees why', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(100), { expiry: 1 })]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  // Nothing claims it until less than an hour of the link's life is left.
  await h.advance(link.expiresAt! - hour + minute - await h.sends.now());
  await h.consumer('drain', WS, MB);
  assert.equal(await emailCalls(h), 0);
  assert.deepEqual((await h.sendState(id)).fences, [], 'the claim refused it: no lease and no attempt');
  const send = await mail.getSend(id);
  assert.equal(send.state, 'failed');
  assert.deepEqual(send.recipients, [{ email: OUTSIDE, state: 'failed', reason: 'link_expired' }]);
}));

test('a send claimed at or after its links expired ends link_expired with no EMAIL call', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(100), { expiry: 1 })]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  await h.advance(link.expiresAt! - await h.sends.now());
  assert.equal(await h.sends.now(), link.expiresAt, 'claimed exactly at expiresAt');
  await h.consumer('drain', WS, MB);
  assert.equal(await emailCalls(h), 0);
  assert.deepEqual((await h.sendState(id)).fences, [], 'the claim refused it');
  assert.deepEqual((await mail.getSend(id)).recipients, [{ email: OUTSIDE, state: 'failed', reason: 'link_expired' }]);
}));

test('the floor is checked again in authorizeDispatch, immediately before the EMAIL call', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(100), { expiry: 1 })]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  await h.advance(link.expiresAt! - hour - 2 * minute - await h.sends.now());
  const claim = await h.sendRpc<{ status: string; fence: { epoch: number; attempt: number }; recipients: { idx: number }[]; release: unknown[]; leaseUntil: number }>('claimSend', id);
  assert.equal(claim.status, 'claimed', 'two minutes above the floor');
  const scope = { workspaceId: WS, mailboxId: MB, sendId: id };
  const recipients = claim.recipients.map(({ idx }) => idx);
  assert.equal((await h.quota<{ status: string }>('reserve', scope, claim.fence, recipients, claim.release, claim.leaseUntil + 2 * minute)).status, 'ok');
  assert.deepEqual(await h.sendRpc('markSend', id, claim.fence, recipients, claim.release), { status: 'ok' });
  const confirmed = await h.quota<{ status: string; dayEnd: number }>('confirm', scope, claim.fence, recipients);
  await h.advance(3 * minute, 'clock-only');
  assert.deepEqual(await h.sendRpc('authorizeDispatch', id, claim.fence, recipients, confirmed.dayEnd), { status: 'stale' });
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['external:failed:link_expired']);
  assert.equal(await emailCalls(h), 0);
}));

test('an internal recipient below the floor at the handoff decision ends link_expired and receives nothing', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(100), { expiry: 1 })], [OTHER]);
  const [link] = await frozen(h, id);
  await h.box('member', 'setOutboxDown', true);
  await h.advance(UNDO);
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:pending'], 'the handoff waits for the outbox');
  await h.advance(link.expiresAt! - hour + minute - await h.sends.now());
  await h.box('member', 'setOutboxDown', false);
  const [due] = (await h.sendState(id)).drive;
  await h.advance(Math.max(0, due - await h.sends.now()));
  const [row] = await h.directoryRows('SELECT decision, reason FROM internal_handoffs');
  assert.deepEqual(row, { decision: 'rejected', reason: 'link_expired' });
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:failed:link_expired']);
  assert.deepEqual(await h.runDeliveries(), []);
  assert.deepEqual(await h.box('other', 'messageRows'), []);
  assert.equal((await mail.getSend(id)).recipients[0].reason, 'link_expired');
}));

test('the handoff floor is read at the decision, after the remote waits before it', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(100), { expiry: 1 })], [OTHER]);
  const [link] = await frozen(h, id);
  await h.sends.shortHandlerBudget();
  await h.box('member', 'pauseAt', 'handoff:decide');
  await h.advance(UNDO);
  await h.box('member', 'pausedAt', 'handoff:decide');
  // The run started a day above the floor; by its decision the link is below it.
  await h.advance(link.expiresAt! - 30 * minute - await h.sends.now(), 'clock-only');
  await h.box('member', 'resumeAt', 'handoff:decide');
  await h.sends.driveIdle();
  assert.deepEqual(await h.directoryRows('SELECT decision, reason FROM internal_handoffs'), [{ decision: 'rejected', reason: 'link_expired' }]);
  assert.equal(await h.directoryRows('SELECT 1 FROM deliveries').then(rows => rows.length), 0);
}));

test('an accepted handoff whose sent commit is lost and reruns below the floor is still delivered', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(100), { expiry: 1 })], [OTHER]);
  const [link] = await frozen(h, id);
  await h.box('member', 'crashAtHandoff', 'handoff:commit');
  await h.advance(UNDO);
  assert.deepEqual(await h.directoryRows('SELECT decision FROM internal_handoffs'), [{ decision: 'accepted' }]);
  assert.deepEqual(ledgerOf(await h.sendState(id)), ['internal:pending'], 'the sent commit was lost');
  await h.advance(link.expiresAt! - hour + minute - await h.sends.now());
  const state = await h.sendState(id);
  assert.deepEqual(ledgerOf(state), ['internal:sent'], 'the stored decision is followed, never re-decided');
  assert.equal(state.row?.state, 'sent');
  assert.equal((await h.runDeliveries()).length, 1);
  assert.equal((await h.box<unknown[]>('other', 'messageRows')).length, 1);
}));

test('the message carries one line per file link from the frozen record; a never-expiring link says so', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(5 * 1024 * 1024 + 1), { name: 'Video.mp4', expiry: 7 }),
    await linkFile(links, bytesOf(10), { name: 'Notes.txt', expiry: 'never' })]);
  const [video, notes] = await frozen(h, id);
  assert.equal(notes.expiresAt, null);
  await h.advance(UNDO);
  await h.consumer('drain', WS, MB);
  const [call] = await h.consumer<EmailCall[]>('emailCalls');
  const until = new Date(video.expiresAt!).toISOString().slice(0, 16).replace('T', ' ');
  assert.ok(call.text.includes(`Video.mp4 (5.0 MB): https://${LINK_HOST}/f/${video.token} (until ${until} UTC)`), call.text);
  assert.ok(call.text.includes(`Notes.txt (10 bytes): https://${LINK_HOST}/f/${notes.token} (no expiry date)`));
  assert.deepEqual(call.attachments, [], 'a file link is never attached');
  const sentCopy = (await mail.listThreads({ view: 'sent' })).items[0];
  const [message] = (await mail.getThread(sentCopy.id)).messages;
  assert.ok(message.text.includes(`https://${LINK_HOST}/f/${video.token}`), 'the sent copy carries the same lines');
  await h.advance(8 * day);
  assert.equal((await links.fetch(path(video))).status, 404);
  assert.equal((await links.fetch(path(notes))).status, 200, 'a never-expiring link stays live');
}));

test('release step 4b routes every link before the enqueue; an outage of the routing table waits', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(100))]);
  const [link] = await frozen(h, id);
  await links.control('routesDown', [true]);
  await h.advance(UNDO);
  assert.equal((await h.sendState(id)).row?.state, 'queued');
  assert.deepEqual(await h.sends.queue(), [], 'no dispatch before the link routes');
  assert.equal((await links.fetch(path(link))).status, 404);
  await links.control('routesDown', [false]);
  const [due] = (await h.sendState(id)).drive;
  await h.advance(due - await h.sends.now());
  assert.equal((await links.fetch(path(link))).status, 200);
  assert.equal((await h.sends.queue()).length, 1);
}));

test('drafts take a file link only with a valid expiry; a carried link keeps its upload; sendDraft needs a link host', () => withLinks(async (h, mail, from, links) => {
  const base = { from, to: [{ email: OUTSIDE }], cc: [], bcc: [], subject: 'S', body: 'B' };
  await assert.rejects(mail.createDraft({ ...base, attachments: [{ kind: 'file_link', linkUploadId: 'nope' }] }, { idempotencyKey: 'a' }), { code: 'not_found' });
  for (const expiry of [0, 3651, 1.5, 'forever', null]) {
    await assert.rejects(mail.createDraft({ ...base, attachments: [{ kind: 'file_link', linkUploadId: 'nope', expiry: expiry as LinkExpiry }] },
      { idempotencyKey: `e-${String(expiry)}` }), { code: 'invalid_request' }, String(expiry));
  }
  const tooMany = Array.from({ length: 33 }, (_, i) => ({ kind: 'file_link' as const, linkUploadId: `u${i}` }));
  await assert.rejects(mail.createDraft({ ...base, attachments: tooMany }, { idempotencyKey: 'many' }), { code: 'invalid_request' });
  const file = await linkFile(links, bytesOf(10), { expiry: 7 });
  const seeded = await links.control<{ id: string; revision: string }>('seedDraft', [{ from, to: [OUTSIDE], links: [file] }]);
  const draft = await mail.getDraft(seeded.id);
  assert.deepEqual(draft.attachments, [{ kind: 'file_link', linkUploadId: file.linkUploadId, name: file.name, size: 10, expiry: 7 }]);
  const replaced = await mail.replaceDraft(seeded.id, { ...base, attachments: [{ kind: 'file_link', linkUploadId: file.linkUploadId, expiry: 'never' }] },
    { ifMatch: draft.revision });
  assert.deepEqual(replaced.attachments, [{ kind: 'file_link', linkUploadId: file.linkUploadId, name: file.name, size: 10, expiry: 'never' }]);
  const sent = await mail.sendDraft(seeded.id, { idempotencyKey: 'send', ifMatch: replaced.revision });
  assert.equal((await frozen(h, sent.id))[0].expiresAt, null);
  assert.deepEqual((await mail.listLinks({})).items.map(link => link.state), ['pending']);
  // Undone: the draft comes back with its link, and the link never goes live.
  const restored = await mail.undoSend(sent.id, { idempotencyKey: 'undo' });
  assert.equal(restored.attachments[0].kind, 'file_link');
  assert.deepEqual((await mail.listLinks({})).items, []);
}));

test('without a link host only a draft with file links cannot be sent; every other draft sends', () => withLinks(async (h, mail, from, links) => {
  const seeded = await links.control<{ id: string; revision: string }>('seedDraft', [{ from, to: [OUTSIDE], links: [await linkFile(links, bytesOf(10))] }]);
  await assert.rejects(mail.sendDraft(seeded.id, { idempotencyKey: 'k', ifMatch: seeded.revision }), { code: 'feature_unavailable' });
  const plain = await mail.createDraft({ from, to: [{ email: OUTSIDE }], cc: [], bcc: [], subject: 'No links', body: 'Text only', attachments: [] },
    { idempotencyKey: 'plain' });
  const sent = await mail.sendDraft(plain.id, { idempotencyKey: 'plain-send', ifMatch: plain.revision });
  assert.equal(sent.state, 'pending');
  await h.advance(UNDO);
  await h.consumer('drain', WS, MB);
  assert.equal((await mail.getSend(sent.id)).state, 'sent', 'a deployment without links sends as before');
}, { configureWorkers: backend => { delete (backend.bindings as Record<string, unknown>).LINK_HOST; } }));

test('link uploads are not served yet and session features say so', () => withLinks(async (_h, mail) => {
  assert.equal((await mail.getSession()).features.fileLinks, false);
  await assert.rejects(mail.createLinkUpload({ name: 'a.bin', size: 1 }, { idempotencyKey: 'u' }), { code: 'feature_unavailable' });
  await assert.rejects(mail.getLinkUpload('u1'), { code: 'feature_unavailable' });
  await assert.rejects(mail.completeLinkUpload('u1'), { code: 'feature_unavailable' });
  await assert.rejects(mail.deleteLinkUpload('u1'), { code: 'feature_unavailable' });
}));

test('the flood bucket keys IPv6 clients by their /64 and IPv4 clients by address', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(10))]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  await links.floodCap(1);
  assert.equal((await links.fetch(path(link), { ip: '2001:db8:1:2::1' })).status, 200);
  assert.equal((await links.fetch(path(link), { ip: '2001:db8:1:2:ffff:ffff:ffff:fffe' })).status, 429, 'another address in the same /64 shares the bucket');
  assert.equal((await links.fetch(path(link), { ip: '2001:db8:1:3::1' })).status, 200, 'another /64 has its own');
  assert.equal((await links.fetch(path(link), { ip: '198.51.100.7' })).status, 200);
  assert.equal((await links.fetch(path(link), { ip: '198.51.100.8' })).status, 200, 'IPv4 by the whole address');
  assert.equal((await links.fetch(path(link), { ip: '::ffff:198.51.100.7' })).status, 429, 'a mapped IPv4 address is that address');
  assert.deepEqual(await links.floodCalls(), ['v6:2001:db8:1:2', 'v6:2001:db8:1:2', 'v6:2001:db8:1:3', 'v4:198.51.100.7', 'v4:198.51.100.8', 'v4:198.51.100.7']);
}));

test('a frozen key outside the location prefix, or with a dot segment, is never read', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(10)), await linkFile(links, bytesOf(10))]);
  const [outside, dotted] = await frozen(h, id);
  await h.advance(UNDO);
  // An object of the right size exists at each target, so only the key check stands between it and a download.
  links.put('deployment', 'elsewhere/secret', bytesOf(10));
  links.put('deployment', 'secret', bytesOf(10));
  await links.control('setKey', [id, 0, 'elsewhere/secret']);
  await links.control('setKey', [id, 1, 'files/../secret']);
  const before = links.stores.deployment.calls.length;
  assert.equal((await links.fetch(path(outside, '/download'))).status, 502, 'outside the prefix');
  assert.equal((await links.fetch(path(dotted, '/download'))).status, 502, 'a dot segment');
  assert.equal(links.stores.deployment.calls.length, before, 'nothing was read');
}));

test('a workspace location inside a refused zone is not read at serve time, and without the zones no workspace link is served', async () => {
  for (const refusedZones of [JSON.stringify(['mail.example', 'example.test']), null]) {
    await withLinks(async (h, mail, from, links) => {
      const id = await submit(h, mail, from, [await linkFile(links, bytesOf(10), { kind: 'workspace' }), await linkFile(links, bytesOf(10))]);
      const [workspace, deployment] = await frozen(h, id);
      await h.advance(UNDO);
      assert.equal((await links.fetch(path(workspace, '/download'))).status, 502, String(refusedZones));
      assert.equal(links.stores.workspace.calls.length, 0, 'nothing was read from the workspace location');
      assert.equal((await links.fetch(path(deployment, '/download'))).status, 200, 'the deployment location is the operator\'s own');
    }, { fileLinks: { refusedZones } });
  }
});

test('a report after the sent alert was pruned raises no second alert', () => withLinks(async (h, mail, from, links) => {
  const id = await submit(h, mail, from, [await linkFile(links, bytesOf(10), { expiry: 'never' })]);
  const [link] = await frozen(h, id);
  await h.advance(UNDO);
  for (let n = 1; n <= 10; n++) assert.equal((await links.fetch(path(link, '/report'), { method: 'POST' })).status, 200);
  await h.backendCron();
  const reported = async () => (await links.alerts()).filter(alert => alert.source === 'mail:link_reported');
  assert.equal((await reported()).length, 1);
  // The sent alert is pruned after the retention window.
  await h.advance(36 * day);
  await h.backendCron();
  assert.deepEqual(await h.directoryRows("SELECT key FROM mail_alerts WHERE key LIKE 'link_reported:%'"), [], 'the sent alert was pruned');
  assert.equal((await links.fetch(path(link, '/report'), { method: 'POST' })).status, 429, 'a refused report');
  await h.backendCron();
  assert.deepEqual(await h.directoryRows("SELECT key FROM mail_alerts WHERE key LIKE 'link_reported:%'"), []);
  assert.equal((await reported()).length, 1, 'no second alert');
}));
