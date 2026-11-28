import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { API_PREFIX, ROUTES } from '@kofra/mail-contract';
import type { LinkLocation, Operation } from '@kofra/mail-contract';
import { linkKek, LinkStorageStore, type LinkLocationUsage } from '@kofra/link-storage';
import { testDatabase } from '../../../../packages/link-storage/test/d1.ts';
import { ALL_OPS, fakeS3, READ_OPS, type FakeS3Options, type S3Op } from '../../../../packages/link-storage/test/fake-s3.ts';
import { handleMailApi, type LocalPrincipal, type MailApiEnvironment } from './server/mail-api.ts';

// Synthetic values only: a local fake S3 endpoint, never a real provider.
const origin = 'http://127.0.0.1:4178';
const host = 's3.storage-fixture.test';
const READ = { accessKeyId: 'FAKEREADKEY0001', secretAccessKey: 'fake-read-secret-value-0001' };
const WRITE = { accessKeyId: 'FAKEWRITEKEY002', secretAccessKey: 'fake-write-secret-value-0002' };
const READ2 = { accessKeyId: 'FAKEREADKEY0003', secretAccessKey: 'fake-read-secret-value-0003' };
const WRITE2 = { accessKeyId: 'FAKEWRITEKEY004', secretAccessKey: 'fake-write-secret-value-0004' };
const SECRETS = [READ, WRITE, READ2, WRITE2].map(({ secretAccessKey }) => secretAccessKey);
const KEK = JSON.stringify({ current: '1', keys: { 1: Buffer.alloc(32, 7).toString('base64') } });
const admin: LocalPrincipal = { userId: 'admin-user', name: 'Admin', workspaceId: 'workspace-a', role: 'admin',
  authTime: Date.now(), credentialEpoch: 1, csrfToken: 'fixture-csrf' };
const member: LocalPrincipal = { ...admin, userId: 'member-user', role: 'member' };
const staleAdmin: LocalPrincipal = { ...admin, authTime: Date.now() - 601_000 };
const location = { endpoint: `https://${host}`, region: 'auto', bucket: 'links', prefix: 'riaklo/', pathStyle: true, read: READ, write: WRITE };

function fixture(t: TestContext, options: { s3?: Partial<FakeS3Options>; env?: Partial<MailApiEnvironment>; usage?: LinkLocationUsage } = {}) {
  const db = testDatabase();
  const keys = {
    [READ.accessKeyId]: { secret: READ.secretAccessKey, ops: new Set<S3Op>(READ_OPS) },
    [WRITE.accessKeyId]: { secret: WRITE.secretAccessKey, ops: new Set<S3Op>(ALL_OPS) },
    [READ2.accessKeyId]: { secret: READ2.secretAccessKey, ops: new Set<S3Op>(READ_OPS) },
    [WRITE2.accessKeyId]: { secret: WRITE2.secretAccessKey, ops: new Set<S3Op>(ALL_OPS) },
  };
  const s3 = fakeS3({ host, bucket: 'links', keys, ...options.s3 });
  const sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    sent.push(request.url);
    return s3.fetch(request);
  });
  const logs: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { logs.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')); });
  }
  const limiter = { async limit() { return { success: true }; } };
  let user = admin;
  const env: MailApiEnvironment = {
    MAIL_LOCAL_API: 'on', MAIL_DEV_SESSION: { resolve: async () => user },
    MAIL_RATE_READS: limiter, MAIL_RATE_ADMIN_WRITES: limiter,
    DIRECTORY: db, MAILBOX: { getByName: () => { throw new Error('no mailbox call expected'); } },
    LINK_CRED_KEK: KEK, LINK_REFUSED_ZONES: JSON.stringify(['mail-suite.test', 'content-fixture.test']),
    ...(options.usage && { LINK_USAGE: options.usage }),
    ...options.env,
  };
  const seen: string[] = [];
  async function call(op: Operation, { params = {}, json, key }: { params?: Record<string, string>; json?: unknown; key?: string } = {}) {
    const { method, path } = ROUTES[op];
    const headers = new Headers({ origin, 'x-csrf-token': admin.csrfToken });
    if (json !== undefined) headers.set('content-type', 'application/json');
    if (key) headers.set('idempotency-key', key);
    const url = `${origin}${API_PREFIX}${path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(params[name] ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaa'))}`;
    const response = await handleMailApi(new Request(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }), env);
    const text = await response.text();
    seen.push(text, JSON.stringify([...response.headers]));
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }
  return { db, s3, sent, logs, env, call, seen, as(next: LocalPrincipal) { user = next; } };
}

function noSecrets(f: ReturnType<typeof fixture>) {
  const text = [...f.seen, ...f.logs, JSON.stringify(f.db.dump('link_storage_locations')), JSON.stringify(f.db.dump('directory_api_keys'))].join('\n');
  for (const secret of SECRETS) assert.ok(!text.includes(secret), 'a secret appears in a response, log line or stored row');
  for (const { accessKeyId } of [READ, WRITE, READ2, WRITE2]) assert.ok(!text.includes(accessKeyId), 'a full key id appears');
}

test('a non-admin cannot change the override, and admin writes need a recent sign-in', async (t) => {
  const f = fixture(t, { usage: { inUse: async () => false } });
  const created = await f.call('createLinkLocation', { json: location, key: 'create-1' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const before = JSON.stringify(f.db.dump('link_storage_locations'));
  const fetches = f.sent.length;
  for (const principal of [member, staleAdmin]) {
    f.as(principal);
    const expected = principal === member ? 'forbidden' : 'reauth_required';
    for (const [op, args] of [
      ['createLinkLocation', { json: location, key: 'create-2' }],
      ['rotateLinkLocationCredentials', { params: { locationId: id }, json: { read: READ2, write: WRITE2 } }],
      ['deleteLinkLocation', { params: { locationId: id } }],
    ] as const) {
      const response = await f.call(op, args);
      assert.deepEqual([response.status, response.body.code], [403, expected], `${principal.userId} ${op}`);
    }
  }
  f.as(member);
  assert.deepEqual((await f.call('listLinkLocations')).body.code, 'forbidden');
  f.as(staleAdmin);
  assert.equal((await f.call('listLinkLocations')).status, 200);
  assert.equal(JSON.stringify(f.db.dump('link_storage_locations')), before);
  assert.equal(f.sent.length, fetches);
  noSecrets(f);
});

test('an admin adds a private bucket; only the key ids\' last 4 characters come back', async (t) => {
  const f = fixture(t, { env: { LINK_LOCATIONS: JSON.stringify({ current: 'main', locations: { main: { ...location, read: undefined, write: undefined } } }) } });
  assert.deepEqual((await f.call('listLinkLocations')).body, { deployment: true, items: [] });
  const created = await f.call('createLinkLocation', { json: location, key: 'create-1' });
  assert.equal(created.status, 201);
  const body = created.body as LinkLocation;
  assert.match(body.id, /^[a-z2-7]{26}$/);
  assert.deepEqual({ ...body, id: 'id', createdAt: 'created' }, { id: 'id', endpoint: `https://${host}`, region: 'auto', bucket: 'links',
    prefix: 'riaklo/', pathStyle: true, current: true, readKeyIdLast4: '0001', writeKeyIdLast4: 'Y002', createdAt: 'created', rotatedAt: null });
  // A retry replays; the same key with other fields is refused.
  const retry = await f.call('createLinkLocation', { json: location, key: 'create-1' });
  assert.deepEqual([retry.status, retry.body], [201, body]);
  assert.equal((await f.call('createLinkLocation', { json: { ...location, bucket: 'other' }, key: 'create-1' })).body.code, 'idempotency_key_reused');
  assert.equal((await f.call('createLinkLocation', { json: { ...location, extra: true }, key: 'create-1' })).body.code, 'idempotency_key_reused');
  assert.equal((await f.call('createLinkLocation', { json: { ...location, read: { ...READ, extra: 1 } }, key: 'create-1' })).body.code, 'idempotency_key_reused');
  const listed = await f.call('listLinkLocations');
  assert.deepEqual(listed.body, { deployment: true, items: [body] });
  assert.equal(f.db.dump('link_storage_locations').length, 1);
  assert.equal(f.s3.objects.size, 0);
  noSecrets(f);
});

test('the save check refuses with a fixed code and stores nothing', async (t) => {
  const cases: [string, Partial<FakeS3Options>, Record<string, unknown>, string][] = [
    ['public bucket (read)', { anonymous: ['GetObject'] }, {}, 'public_bucket'],
    ['public bucket (list)', { anonymous: ['ListObjects'] }, {}, 'public_bucket'],
    ['redirect', { redirect: 307 }, {}, 'redirect'],
    ['missing multipart permission', { keys: { [READ.accessKeyId]: { secret: READ.secretAccessKey, ops: new Set<S3Op>(READ_OPS) },
      [WRITE.accessKeyId]: { secret: WRITE.secretAccessKey, ops: new Set<S3Op>(ALL_OPS.filter((op) => op !== 'CreateMultipart')) } } }, {}, 'multipart'],
    ['wrong secret', {}, { write: { ...WRITE, secretAccessKey: 'not-the-fake-secret' } }, 'auth'],
    ['refused host', {}, { endpoint: 'https://s3.mail-suite.test' }, 'endpoint'],
    ['IP literal', {}, { endpoint: 'https://169.254.169.254' }, 'endpoint'],
    ['private zone', {}, { endpoint: 'https://minio.internal' }, 'endpoint'],
    ['plain http', {}, { endpoint: `http://${host}` }, 'endpoint'],
    ['other port', {}, { endpoint: `https://${host}:9000` }, 'endpoint'],
  ];
  for (const [name, s3, change, reason] of cases) {
    await t.test(name, async (t) => {
      const f = fixture(t, { s3 });
      const response = await f.call('createLinkLocation', { json: { ...location, ...change }, key: 'create-1' });
      assert.deepEqual([response.status, response.body.code, response.body.reason], [422, 'storage_check_failed', reason]);
      assert.deepEqual(Object.keys(response.body).sort(), ['code', 'reason', 'requestId', 'status', 'title', 'type']);
      if (reason === 'endpoint') assert.equal(f.sent.length, 0);
      assert.equal(f.db.dump('link_storage_locations').length, 0);
      assert.equal(f.db.dump('directory_api_keys').length, 0);
      noSecrets(f);
    });
  }
});

test('a retry while the check runs answers idempotency_in_progress, and a failed check releases the key', async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  const s3 = f.s3;
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    if (first) { first = false; await gate; }
    return s3.fetch(request);
  });
  const pending = f.call('createLinkLocation', { json: location, key: 'create-1' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const busy = await f.call('createLinkLocation', { json: location, key: 'create-1' });
  assert.deepEqual([busy.status, busy.body.code, busy.body.retryAfterSeconds], [409, 'idempotency_in_progress', 1]);
  release();
  const done = await pending;
  assert.equal(done.status, 201);
  assert.deepEqual(await f.call('createLinkLocation', { json: location, key: 'create-1' }), { status: 201, body: done.body });
  // A check that fails leaves no key behind: the same key runs again.
  const g = fixture(t, { s3: { anonymous: ['GetObject'] } });
  assert.equal((await g.call('createLinkLocation', { json: location, key: 'create-2' })).body.reason, 'public_bucket');
  assert.equal(g.db.dump('directory_api_keys').length, 0);
  assert.equal((await g.call('createLinkLocation', { json: location, key: 'create-2' })).body.reason, 'public_bucket');
  // One key for both roles is refused before any request.
  const h = fixture(t);
  const same = await h.call('createLinkLocation', { json: { ...location, read: WRITE }, key: 'create-3' });
  assert.deepEqual([same.status, same.body.reason, h.sent.length], [422, 'read_key_writable', 0]);
  noSecrets(f);
});

test('credentials rotate in place, only after the new keys pass the check', async (t) => {
  const f = fixture(t);
  const { body: created } = await f.call('createLinkLocation', { json: location, key: 'create-1' });
  const bad = await f.call('rotateLinkLocationCredentials', { params: { locationId: created.id },
    json: { read: READ2, write: { ...WRITE2, secretAccessKey: 'not-the-fake-secret' } } });
  assert.deepEqual([bad.status, bad.body.reason], [422, 'auth']);
  const kek = (await linkKek(KEK))!;
  const store = new LinkStorageStore(f.db);
  assert.deepEqual((await store.credential(kek, admin.workspaceId, created.id, 'write'))!.reveal(), WRITE);
  const rotated = await f.call('rotateLinkLocationCredentials', { params: { locationId: created.id }, json: { read: READ2, write: WRITE2 } });
  assert.equal(rotated.status, 200);
  assert.deepEqual({ ...rotated.body, rotatedAt: null, readKeyIdLast4: '0001', writeKeyIdLast4: 'Y002' }, created);
  assert.deepEqual([rotated.body.readKeyIdLast4, rotated.body.writeKeyIdLast4, typeof rotated.body.rotatedAt], ['0003', 'Y004', 'string']);
  assert.deepEqual((await store.credential(kek, admin.workspaceId, created.id, 'read'))!.reveal(), READ2);
  assert.deepEqual((await store.credential(kek, admin.workspaceId, created.id, 'write'))!.reveal(), WRITE2);
  assert.deepEqual((await f.call('listLinkLocations')).body.items, [rotated.body]);
  assert.equal((await f.call('rotateLinkLocationCredentials', { params: { locationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbb' }, json: { read: READ2, write: WRITE2 } })).status, 404);
  assert.equal((await f.call('rotateLinkLocationCredentials', { params: { locationId: created.id }, json: { read: READ2, write: WRITE2, endpoint: 'x' } })).body.code, 'unknown_field');
  noSecrets(f);
});

test('deleting a location that still has live links is refused', async (t) => {
  let inUse = true;
  const asked: string[] = [];
  const f = fixture(t, { usage: { async inUse({ workspaceId, locationId }) { asked.push(`${workspaceId}/${locationId}`); return inUse; } } });
  const { body: created } = await f.call('createLinkLocation', { json: location, key: 'create-1' });
  const refused = await f.call('deleteLinkLocation', { params: { locationId: created.id } });
  assert.deepEqual([refused.status, refused.body.code], [409, 'location_in_use']);
  assert.deepEqual((await f.call('listLinkLocations')).body.items, [created]);
  inUse = false;
  assert.equal((await f.call('deleteLinkLocation', { params: { locationId: created.id } })).status, 204);
  assert.deepEqual((await f.call('listLinkLocations')).body.items, []);
  // DELETE answers 204 whether or not the location still exists (contract section 5), without asking the usage port again.
  assert.equal((await f.call('deleteLinkLocation', { params: { locationId: created.id } })).status, 204);
  assert.deepEqual(asked, [`${admin.workspaceId}/${created.id}`, `${admin.workspaceId}/${created.id}`]);
});

test('without its configuration, link storage fails closed', async (t) => {
  const f = fixture(t, { env: { LINK_CRED_KEK: undefined } });
  assert.deepEqual((await f.call('createLinkLocation', { json: location, key: 'create-1' })).body.code, 'feature_unavailable');
  const zones = fixture(t, { env: { LINK_REFUSED_ZONES: undefined } });
  assert.deepEqual((await zones.call('createLinkLocation', { json: location, key: 'create-1' })).body.code, 'feature_unavailable');
  // No usage port: a delete is refused, never assumed safe.
  const g = fixture(t);
  const { body: created } = await g.call('createLinkLocation', { json: location, key: 'create-1' });
  assert.deepEqual((await g.call('deleteLinkLocation', { params: { locationId: created.id } })).body.code, 'feature_unavailable');
  assert.equal(g.db.dump('link_storage_locations').length, 1);
  // A usage port that fails keeps the location.
  const h = fixture(t, { usage: { inUse: async () => { throw new Error(`usage failed ${WRITE.secretAccessKey}`); } } });
  const { body: kept } = await h.call('createLinkLocation', { json: location, key: 'create-1' });
  assert.equal((await h.call('deleteLinkLocation', { params: { locationId: kept.id } })).status, 503);
  assert.deepEqual((await h.call('listLinkLocations')).body.items, [kept]);
  noSecrets(h);
  assert.equal(f.sent.length + zones.sent.length, 0);
});

test('a network failure that mentions a secret never surfaces it', async (t) => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(`connect failed with ${WRITE.secretAccessKey}`); });
  const response = await f.call('createLinkLocation', { json: location, key: 'create-1' });
  assert.deepEqual([response.status, response.body.reason], [422, 'network']);
  noSecrets(f);
});
