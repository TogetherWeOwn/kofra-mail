import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
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
  assert.equal((await links.fetch(path(link))).status, 429, 'the page says so too');
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
  assert.deepEqual(new Set(await links.floodCalls()), new Set(['198.51.100.7']), 'keyed by the client IP only');
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

test('without a link host a draft with file links cannot be sent', () => withLinks(async (h, mail, from, links) => {
  const seeded = await links.control<{ id: string; revision: string }>('seedDraft', [{ from, to: [OUTSIDE], links: [await linkFile(links, bytesOf(10))] }]);
  await assert.rejects(mail.sendDraft(seeded.id, { idempotencyKey: 'k', ifMatch: seeded.revision }), { code: 'feature_unavailable' });
}, { configureWorkers: backend => { delete (backend.bindings as Record<string, unknown>).LINK_HOST; } }));

test('link uploads are not served yet and session features say so', () => withLinks(async (_h, mail) => {
  assert.equal((await mail.getSession()).features.fileLinks, false);
  await assert.rejects(mail.createLinkUpload({ name: 'a.bin', size: 1 }, { idempotencyKey: 'u' }), { code: 'feature_unavailable' });
  await assert.rejects(mail.getLinkUpload('u1'), { code: 'feature_unavailable' });
  await assert.rejects(mail.completeLinkUpload('u1'), { code: 'feature_unavailable' });
  await assert.rejects(mail.deleteLinkUpload('u1'), { code: 'feature_unavailable' });
}));
