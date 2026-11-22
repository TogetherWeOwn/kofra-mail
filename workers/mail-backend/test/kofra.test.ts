import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kofra } from '../src/kofra.ts';

const config = {
  KOFRA_S3_ENDPOINT: 'https://storage.example.test',
  KOFRA_S3_ACCESS_KEY_ID: 'fixture-access',
  KOFRA_S3_SECRET_ACCESS_KEY: 'fixture-signing',
};
const key = `raw/${'a'.repeat(64)}/01KBN8ZJ7G0000000000000000`;

test('Kofra S3 adapter signs a fixed bucket path and preserves bytes', async t => {
  const bytes = new Uint8Array([0x01, 0xff, 0x03]);
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

test('rejects a redirect without sending the signed request to its destination', async t => {
  const fake = t.mock.method(globalThis, 'fetch', async (request: Request) => {
    assert.equal(request.redirect, 'manual');
    return new Response(null, { status: 307, headers: { location: 'https://other.example.test/' } });
  });
  await assert.rejects(kofra(config, 'workspace').put(key, new Uint8Array(1)), /failed \(307\)/);
  assert.equal(fake.mock.callCount(), 1);
});

test('Kofra separates workspaces even for the same raw key', async t => {
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    paths.push(new URL(request.url).pathname);
    return new Response(null, { status: 200 });
  });
  await kofra(config, 'workspace').put(key, new Uint8Array(1));
  await kofra(config, 'other').put(key, new Uint8Array(1));
  assert.deepEqual(paths, [`/mail-workspace/${key}`, `/mail-other/${key}`]);
});

test('Kofra rejects unqualified raw keys, invalid workspace IDs and arbitrary paths', async t => {
  const fake = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  assert.throws(() => kofra(config, '../other'), /Invalid workspace storage ID/);
  assert.throws(() => kofra({ ...config, KOFRA_S3_ENDPOINT: 'http://storage.example.test' }, 'workspace'), /Invalid Kofra/);
  await assert.rejects(kofra(config, 'workspace').get('../other/file'), /Invalid mail object key/);
  await assert.rejects(kofra(config, 'workspace').get(key.slice(0, key.lastIndexOf('/'))), /Invalid mail object key/);
  assert.equal(fake.mock.callCount(), 0);
});
