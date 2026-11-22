import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kofra } from '../src/kofra.ts';

const config = {
  KOFRA_S3_ENDPOINT: 'https://storage.example.test',
  KOFRA_S3_ACCESS_KEY_ID: 'fixture-access',
  KOFRA_S3_SECRET_ACCESS_KEY: 'fixture-signing',
  KOFRA_MAIL_BUCKET: 'local-bucket',
  KOFRA_MAIL_WORKSPACE_ID: 'workspace',
};
const key = `raw/${'a'.repeat(64)}`;

test('Kofra S3 adapter signs a fixed bucket path and preserves bytes', async t => {
  const bytes = new Uint8Array([0x01, 0xff, 0x03]);
  const fake = t.mock.method(globalThis, 'fetch', async (request: Request) => {
    assert.equal(request.url, `https://storage.example.test/local-bucket/${key}`);
    assert.equal(request.redirect, 'error');
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

test('Kofra adapter cannot cross workspace or reference arbitrary paths', async t => {
  const fake = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  assert.throws(() => kofra(config, 'other'), /unavailable for workspace/);
  assert.throws(() => kofra({ ...config, KOFRA_S3_ENDPOINT: 'http://storage.example.test' }, 'workspace'), /Invalid Kofra/);
  await assert.rejects(kofra(config, 'workspace').get('../other/file'), /Invalid mail object key/);
  assert.equal(fake.mock.callCount(), 0);
});
