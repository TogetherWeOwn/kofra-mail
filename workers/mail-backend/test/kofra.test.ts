import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { MAX_PARSED_PART_BYTES, MAX_RAW_BYTES } from '../src/bytes.ts';
import { kofra } from '../src/kofra.ts';
import { ObjectInvalidError, ObjectMissingError } from '../src/object-errors.ts';

const config = {
  KOFRA_S3_ENDPOINT: 'https://storage.example.test',
  KOFRA_S3_ACCESS_KEY_ID: 'fixture-access',
  KOFRA_S3_SECRET_ACCESS_KEY: 'fixture-signing',
};
const bytes = new Uint8Array([0x01, 0xff, 0x03]);
const digest = createHash('sha256').update(bytes).digest('hex');
const generation = '01KBN8ZJ7G0000000000000000';
const key = `raw/${digest}/${generation}`;
const keys = [key, `att/${digest}/${generation}`, `drafts/${digest}`];

test('Kofra S3 adapter signs a fixed bucket path and preserves bytes', async t => {
  const fake = t.mock.method(globalThis, 'fetch', async (request: Request) => {
    assert.equal(request.url, `https://storage.example.test/mail-workspace/${key}`);
    assert.equal(request.redirect, 'manual');
    assert.ok(request.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 '));
    if (request.method === 'PUT') {
      assert.deepEqual(new Uint8Array(await request.arrayBuffer()), bytes);
      return new Response(null, { status: 200 });
    }
    assert.equal(request.method, 'GET');
    return new Response(bytes, { headers: { 'content-length': '3' } });
  });
  const store = kofra(config, 'workspace');
  await store.put(key, bytes);
  assert.deepEqual(await store.get(key), bytes);
  assert.equal(fake.mock.callCount(), 2);
});

test('signs the SHA-256 of the outgoing PUT body for raw, attachment and draft keys', async t => {
  const fake = t.mock.method(globalThis, 'fetch', async (_request: Request) => new Response(null, { status: 200 }));
  const store = kofra(config, 'workspace');
  for (const objectKey of keys) await store.put(objectKey, bytes);

  assert.equal(fake.mock.callCount(), keys.length);
  for (const { arguments: [request] } of fake.mock.calls) {
    assert.ok(request instanceof Request);
    const body = Buffer.from(await request.arrayBuffer());
    assert.equal(request.headers.get('x-amz-content-sha256'), createHash('sha256').update(body).digest('hex'));
    const signedHeaders = request.headers.get('authorization')?.match(/\bSignedHeaders=([^,]+)/)?.[1].split(';');
    assert.ok(signedHeaders?.includes('x-amz-content-sha256'));
  }
});

test('rejects a PUT whose body digest differs from its object key without sending a request', async t => {
  const fake = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const store = kofra(config, 'workspace');
  for (const objectKey of keys) {
    await assert.rejects(store.put(objectKey, new Uint8Array(1)), /digest mismatch/i);
  }
  assert.equal(fake.mock.callCount(), 0);
});

test('rejects a PUT when storage returns BadDigest', async t => {
  const fake = t.mock.method(globalThis, 'fetch', async () =>
    new Response('<Error><Code>BadDigest</Code></Error>', { status: 400 }));
  await assert.rejects(kofra(config, 'workspace').put(key, bytes), /failed \(400\)/);
  assert.equal(fake.mock.callCount(), 1);
});

test('rejects a redirect without sending the signed request to its destination', async t => {
  const fake = t.mock.method(globalThis, 'fetch', async (request: Request) => {
    assert.equal(request.redirect, 'manual');
    return new Response(null, { status: 307, headers: { location: 'https://other.example.test/' } });
  });
  await assert.rejects(kofra(config, 'workspace').put(key, bytes), /failed \(307\)/);
  assert.equal(fake.mock.callCount(), 1);
});

test('Kofra separates workspaces even for the same raw key', async t => {
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    paths.push(new URL(request.url).pathname);
    return new Response(null, { status: 200 });
  });
  await kofra(config, 'workspace').put(key, bytes);
  await kofra(config, 'other').put(key, bytes);
  assert.deepEqual(paths, [`/mail-workspace/${key}`, `/mail-other/${key}`]);
});

test('classifies GET failures as missing, invalid, or transient', async t => {
  const cases = [
    ['NoSuchKey', () => new Response('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code></Error>', { status: 404 }), ObjectMissingError],
    ['NoSuchBucket', () => new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 }), Error],
    ['empty 404', () => new Response(null, { status: 404 }), Error],
    ['declared empty object', () => new Response(null, { headers: { 'content-length': '0' } }), ObjectInvalidError],
    ['declared over 25 MiB', () => new Response(null, { headers: { 'content-length': String(25 * 1024 * 1024 + 1) } }), ObjectInvalidError],
    ['missing content-length', () => new Response(bytes), Error],
  ] as const;
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 500 }));
  const store = kofra(config, 'workspace');
  for (const [label, response, errorType] of cases) {
    fetch.mock.mockImplementationOnce(async () => response());
    await assert.rejects(store.get(key), error => {
      assert.equal(Object.getPrototypeOf(error), errorType.prototype, label);
      return true;
    });
  }
});

test('only 204 and a verified NoSuchKey 404 confirm a signed generation DELETE', async t => {
  let status = 204;
  let body: string | null = null;
  const fake = t.mock.method(globalThis, 'fetch', async (request: Request) => {
    assert.equal(request.method, 'DELETE');
    assert.equal(request.url, `https://storage.example.test/mail-workspace/${key}`);
    assert.equal(request.redirect, 'manual');
    return new Response(body, { status });
  });
  const store = kofra(config, 'workspace');
  await store.deleteGeneration(key);
  status = 404;
  body = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code></Error>';
  await store.deleteGeneration(key);
  body = '<Error><Code>NoSuchBucket</Code></Error>';
  await assert.rejects(store.deleteGeneration(key), /failed \(404\)/);
  body = null;
  await assert.rejects(store.deleteGeneration(key), /failed \(404\)/);
  status = 200;
  await assert.rejects(store.deleteGeneration(key), /failed \(200\)/);
  await assert.rejects(store.deleteGeneration(`drafts/${'a'.repeat(64)}`), /Invalid mail generation/);
  assert.equal(fake.mock.callCount(), 5);
});

test('Kofra rejects unqualified raw keys, invalid workspace IDs and arbitrary paths', async t => {
  const fake = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  assert.throws(() => kofra(config, '../other'), /Invalid workspace storage ID/);
  assert.throws(() => kofra({ ...config, KOFRA_S3_ENDPOINT: 'http://storage.example.test' }, 'workspace'), /Invalid Kofra/);
  await assert.rejects(kofra(config, 'workspace').get('../other/file'), /Invalid mail object key/);
  await assert.rejects(kofra(config, 'workspace').get(key.slice(0, key.lastIndexOf('/'))), /Invalid mail object key/);
  assert.equal(fake.mock.callCount(), 0);
});

test('a streamed PUT of a parsed attachment is bounded by what a parse can produce, an upload by the raw cap', async t => {
  const fake = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const store = kofra(config, 'workspace');
  const attachment = `att/${digest}/${generation}`;
  const body = () => new ReadableStream<Uint8Array>();
  await assert.rejects(store.putStream(attachment, body(), MAX_PARSED_PART_BYTES + 1, digest), /Invalid attachment PUT/);
  await assert.rejects(store.putUpload(attachment, body(), MAX_RAW_BYTES + 1, digest, 60_000), /Invalid attachment PUT/);
  await assert.rejects(store.putStream(key, body(), 3, digest), /Invalid attachment PUT/);
  assert.equal(fake.mock.callCount(), 0);
  assert.equal(MAX_PARSED_PART_BYTES, 3 * MAX_RAW_BYTES + 1);
});
