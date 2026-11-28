import assert from 'node:assert/strict';
import test from 'node:test';
import { checkLinkLocation, linkEndpoint, locationFields, refusedZones, S3Credentials, type LinkLocationFields } from '../src/index.ts';
import { ALL_OPS, fakeS3, MULTIPART_OPS, READ_OPS, type FakeS3Options, type S3Op } from './fake-s3.ts';

// Synthetic values only; no real provider or credential.
const READ = { accessKeyId: 'FAKEREADKEY0001', secretAccessKey: 'fake-read-secret-value-0001' };
const WRITE = { accessKeyId: 'FAKEWRITEKEY002', secretAccessKey: 'fake-write-secret-value-0002' };
const host = 's3.storage-fixture.test';
const fields: LinkLocationFields = { endpoint: `https://${host}`, region: 'auto', bucket: 'links', prefix: 'riaklo/', pathStyle: true };
const credentials = { read: S3Credentials.from(READ)!, write: S3Credentials.from(WRITE)! };
const ownZones = ['mail-suite.test', 'content-fixture.test', 'kofra-fixture.test'];
const zones = refusedZones(ownZones);

function provider(overrides: Partial<FakeS3Options> = {}) {
  return fakeS3({
    host, bucket: 'links',
    keys: {
      [READ.accessKeyId]: { secret: READ.secretAccessKey, ops: new Set<S3Op>(READ_OPS) },
      [WRITE.accessKeyId]: { secret: WRITE.secretAccessKey, ops: new Set<S3Op>(ALL_OPS) },
    },
    ...overrides,
  });
}

test('a private bucket with both keys passes, signed, and leaves nothing behind', async () => {
  const s3 = provider();
  assert.deepEqual(await checkLinkLocation(fields, credentials, zones, { fetch: s3.fetch }), { ok: true });
  assert.deepEqual(s3.calls.map(({ op, signedBy, status }) => [op, signedBy, status]), [
    ['HeadBucket', WRITE.accessKeyId, 200], ['PutObject', WRITE.accessKeyId, 200], ['GetObject', READ.accessKeyId, 200],
    ['PutObject', READ.accessKeyId, 403], ['DeleteObject', READ.accessKeyId, 403], ['GetObject', null, 403], ['ListObjects', null, 403],
    ['CreateMultipart', WRITE.accessKeyId, 200], ['UploadPart', WRITE.accessKeyId, 200], ['ListParts', WRITE.accessKeyId, 200],
    ['CompleteMultipart', WRITE.accessKeyId, 200], ['DeleteObject', WRITE.accessKeyId, 204],
    ['CreateMultipart', WRITE.accessKeyId, 200], ['AbortMultipart', WRITE.accessKeyId, 204], ['DeleteObject', WRITE.accessKeyId, 204],
  ]);
  assert.ok(s3.calls.every(({ op, key }) => op === 'HeadBucket' || op === 'ListObjects' ? key === '' : key.startsWith('riaklo/link-probe-')));
  assert.equal(s3.objects.size, 0);
  assert.equal(s3.uploads.size, 0);
});

test('in a versioned bucket every probe version is deleted, not hidden behind a delete marker', async () => {
  const s3 = provider({ versioning: true });
  assert.deepEqual(await checkLinkLocation(fields, credentials, zones, { fetch: s3.fetch }), { ok: true });
  assert.deepEqual(s3.versions, []);
  assert.equal(s3.objects.size, 0);
  assert.ok(s3.calls.filter(({ op }) => op === 'DeleteObjectVersion').length >= 2);
  // A write key that may not delete versions fails, and leaves no probe it could have removed.
  const keys = { [READ.accessKeyId]: { secret: READ.secretAccessKey, ops: new Set<S3Op>(READ_OPS) },
    [WRITE.accessKeyId]: { secret: WRITE.secretAccessKey, ops: new Set<S3Op>(ALL_OPS.filter(op => op !== 'DeleteObjectVersion')) } };
  const limited = provider({ versioning: true, keys });
  assert.equal((await checkLinkLocation(fields, credentials, zones, { fetch: limited.fetch })).ok, false);
});

test('a read key that may write or delete, or is the write key, fails the check', async (t) => {
  for (const extra of ['PutObject', 'DeleteObject', 'DeleteObjectVersion'] as S3Op[]) {
    await t.test(extra, async () => {
      const keys = { [READ.accessKeyId]: { secret: READ.secretAccessKey, ops: new Set<S3Op>([...READ_OPS, extra]) },
        [WRITE.accessKeyId]: { secret: WRITE.secretAccessKey, ops: new Set<S3Op>(ALL_OPS) } };
      const s3 = provider({ versioning: extra === 'DeleteObjectVersion', keys });
      assert.deepEqual(await checkLinkLocation(fields, credentials, zones, { fetch: s3.fetch }), { ok: false, reason: 'read_key_writable' });
      assert.equal(s3.objects.size, 0);
    });
  }
  let sent = 0;
  const same = { read: credentials.write, write: credentials.write };
  assert.deepEqual(await checkLinkLocation(fields, same, zones, { fetch: async (r) => { sent++; return provider().fetch(r); } }),
    { ok: false, reason: 'read_key_writable' });
  assert.equal(sent, 0);
});

test('a virtual-hosted bucket is addressed under the endpoint', async () => {
  const s3 = provider({ pathStyle: false });
  assert.deepEqual(await checkLinkLocation({ ...fields, pathStyle: false }, credentials, zones, { fetch: s3.fetch }), { ok: true });
});

test('a public bucket fails the save check', async (t) => {
  for (const anonymous of [['GetObject'], ['ListObjects'], ['GetObject', 'ListObjects']] as S3Op[][]) {
    await t.test(anonymous.join('+'), async () => {
      const s3 = provider({ anonymous });
      assert.deepEqual(await checkLinkLocation(fields, credentials, zones, { fetch: s3.fetch }), { ok: false, reason: 'public_bucket' });
      // The probe is still cleaned up.
      assert.equal(s3.objects.size, 0);
    });
  }
});

test('refused hosts are refused before any request', async (t) => {
  const refused = [
    'http://s3.storage-fixture.test', 'https://localhost', 'https://storage.localhost', 'https://minio.internal', 'https://nas.local',
    'https://1.0.0.127.in-addr.arpa', 'https://kofra-acct.workers.dev', 'https://127.0.0.1', 'https://2130706433', 'https://0x7f000001',
    'https://[::1]', 'https://[fd00::1]', 'https://10.0.0.1', 'https://s3.storage-fixture.test:8443', 'https://s3.storage-fixture.test:443x',
    'https://user@s3.storage-fixture.test', 'https://:@s3.storage-fixture.test', 'https://s3.storage-fixture.test/bucket',
    'https://s3.storage-fixture.test/?x=1', 'https://s3.storage-fixture.test/#f', 'https://s3.storage-fixture.test.', 'https://single',
    'https://mail-suite.test', 'https://s3.mail-suite.test', 'https://content-fixture.test', 'https://S3.KOFRA-FIXTURE.TEST',
    ' https://s3.storage-fixture.test', 'https://s3.storage-fixture.test\\', 'https://s3.storage-fixture\t.test', `https://${'a'.repeat(600)}.test`,
  ];
  for (const endpoint of refused) {
    await t.test(endpoint.slice(0, 60), async () => {
      const s3 = provider();
      let sent = 0;
      const result = await checkLinkLocation({ ...fields, endpoint }, credentials, zones, { fetch: async (r) => { sent++; return s3.fetch(r); } });
      assert.deepEqual(result, { ok: false, reason: 'endpoint' });
      assert.equal(sent, 0);
    });
  }
  // A virtual-hosted bucket name that lands inside a refused zone.
  const nested = locationFields({ ...fields, endpoint: 'https://kofra-suite.test', bucket: 'mail', pathStyle: false }, refusedZones(['mail.kofra-suite.test']));
  assert.deepEqual(nested, { ok: false, field: '/endpoint', reason: 'endpoint' });
  // An invalid refused-zone configuration refuses everything (fail closed).
  assert.equal(refusedZones(['not a zone']), undefined);
  assert.equal(linkEndpoint(`https://${host}`, refusedZones(['not a zone'])), undefined);
  assert.deepEqual(await checkLinkLocation(fields, credentials, undefined, { fetch: provider().fetch }), { ok: false, reason: 'endpoint' });
  // An explicit :443 is the default port.
  assert.equal(linkEndpoint(`https://${host}:443`, zones), `https://${host}`);
});

test('a 3xx is an error and is never followed', async (t) => {
  for (const status of [301, 302, 303, 307, 308]) {
    await t.test(String(status), async () => {
      let sent = 0;
      const s3 = provider({ redirect: status });
      const result = await checkLinkLocation(fields, credentials, zones, { fetch: async (request) => {
        sent++;
        assert.equal(request.redirect, 'manual');
        return s3.fetch(request);
      } });
      assert.deepEqual(result, { ok: false, reason: 'redirect' });
      // The first request's redirect stops the check; only best-effort cleanup could follow, and there is none yet.
      assert.equal(sent, 1);
    });
  }
});

test('a missing multipart permission fails the save check with a fixed code', async (t) => {
  for (const missing of MULTIPART_OPS) {
    await t.test(missing, async () => {
      const write = { secret: WRITE.secretAccessKey, ops: new Set<S3Op>(ALL_OPS.filter(op => op !== missing)) };
      const limited = provider({ keys: { [READ.accessKeyId]: { secret: READ.secretAccessKey, ops: new Set<S3Op>(READ_OPS) }, [WRITE.accessKeyId]: write } });
      assert.deepEqual(await checkLinkLocation(fields, credentials, zones, { fetch: limited.fetch }), { ok: false, reason: 'multipart' });
      assert.equal(limited.objects.size, 0);
    });
  }
  await t.test('a 200 error document to Complete', async () => {
    const s3 = provider({ completeError: true });
    assert.deepEqual(await checkLinkLocation(fields, credentials, zones, { fetch: s3.fetch }), { ok: false, reason: 'multipart' });
    assert.equal(s3.uploads.size, 0);
  });
});

test('credential, bucket and network failures have their own codes', async () => {
  const wrongSecret = { ...credentials, write: S3Credentials.from({ ...WRITE, secretAccessKey: 'not-the-fake-secret' })! };
  assert.deepEqual(await checkLinkLocation(fields, wrongSecret, zones, { fetch: provider().fetch }), { ok: false, reason: 'auth' });
  const readless = provider({ keys: { [READ.accessKeyId]: { secret: READ.secretAccessKey, ops: new Set() },
    [WRITE.accessKeyId]: { secret: WRITE.secretAccessKey, ops: new Set(ALL_OPS) } } });
  assert.deepEqual(await checkLinkLocation(fields, credentials, zones, { fetch: readless.fetch }), { ok: false, reason: 'auth' });
  assert.equal(readless.objects.size, 0);
  assert.deepEqual(await checkLinkLocation({ ...fields, bucket: 'other-bucket' }, credentials, zones, { fetch: provider().fetch }),
    { ok: false, reason: 'bucket' });
  assert.deepEqual(await checkLinkLocation(fields, credentials, zones, { fetch: async () => { throw new TypeError('connect failed'); } }),
    { ok: false, reason: 'network' });
});

test('no credential reaches a log line, an answer, a thrown error or an anonymous request', async (t) => {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  }
  const seen: string[] = [];
  const answers: unknown[] = [];
  const cases: Partial<FakeS3Options>[] = [{}, { anonymous: ['GetObject'] }, { redirect: 302 }, { completeError: true }];
  for (const overrides of cases) {
    const s3 = provider(overrides);
    answers.push(await checkLinkLocation(fields, credentials, zones, { fetch: async (request) => {
      if (!request.headers.has('authorization')) seen.push([...request.headers].join());
      seen.push(request.url);
      return s3.fetch(request);
    } }));
  }
  answers.push(await checkLinkLocation(fields, credentials, zones, { fetch: async () => { throw new Error(`boom ${WRITE.secretAccessKey}`); } }));
  const text = JSON.stringify([answers, lines, seen, credentials, String(credentials.read)]);
  for (const secret of [READ.secretAccessKey, WRITE.secretAccessKey, READ.accessKeyId, WRITE.accessKeyId]) assert.ok(!text.includes(secret));
  assert.deepEqual(lines, []);
});

test('the check reasons are the contract\'s fixed reasons', async () => {
  const { STORAGE_CHECK_REASONS } = await import('../../../contracts/mail-api/src/errors.ts');
  const { LINK_CHECK_REASONS } = await import('../src/check.ts');
  assert.deepEqual([...LINK_CHECK_REASONS], [...STORAGE_CHECK_REASONS]);
});
