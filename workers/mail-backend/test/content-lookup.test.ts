import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { linkKek } from '../../../packages/link-storage/src/kek.ts';
import { S3Credentials } from '../../../packages/link-storage/src/credentials.ts';
import { LinkStorageStore, type LinkDatabase } from '../../../packages/link-storage/src/store.ts';

// Synthetic link storage keys (M3-15a): mail-content may receive only the read one.
const LINK_KEK = JSON.stringify({ current: '1', keys: { 1: Buffer.alloc(32, 5).toString('base64') } });
const LINK_READ = { accessKeyId: 'FAKEREADKEY0001', secretAccessKey: 'fake-read-secret-value-0001' };
const LINK_WRITE = { accessKeyId: 'FAKEWRITEKEY002', secretAccessKey: 'fake-write-secret-value-0002' };
const LINK_LOCATION = 'abcdefghijklmnopqrstuvwxyz';

let mf: Miniflare;
before(async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/content-lookup-worker.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'],
  });
  mf = new Miniflare({ workers: [{
    name: 'lookup', compatibilityDate: '2026-06-25',
    modules: [{ type: 'ESModule', path: 'lookup.mjs', contents: outputFiles[0].text }],
    bindings: { MAIL_BACKEND_ENABLED: 'on', MAIL_CONTENT_ENABLED: 'on', LINK_CRED_KEK: LINK_KEK },
    d1Databases: ['DIRECTORY'], durableObjects: { MAILBOX: { className: 'LookupMailbox', useSQLite: true } },
    serviceBindings: { MAIL_LOOKUP: { name: 'lookup', entrypoint: 'ContentLookup' } },
  }] });
  const db = await mf.getD1Database('DIRECTORY', 'lookup');
  const ddl = await readFile(new URL('../migrations/0001_directory.sql', import.meta.url), 'utf8');
  await db.prepare(ddl.match(/CREATE TABLE mailboxes \([\s\S]+?\n\);/)![0]).run();
  for (const mb of ['ready', 'restoring']) {
    await db.prepare("INSERT INTO mailboxes VALUES (?, 'w', ?, ?)").bind(mb, `owner-${mb}`, `${mb}@mail.example`).run();
  }
  await db.prepare("INSERT INTO mailboxes VALUES ('opaque-owner', 'w', 'account:member', 'opaque@mail.example')").run();
  const links = await readFile(new URL('../migrations/0010_link_storage.sql', import.meta.url), 'utf8');
  for (const statement of links.split(/;\s*\n/).filter(s => /CREATE/.test(s))) await db.prepare(statement).run();
  const store = new LinkStorageStore(db as unknown as LinkDatabase);
  await db.batch(await store.createStatements((await linkKek(LINK_KEK))!, 'w', LINK_LOCATION,
    { endpoint: 'https://s3.storage-fixture.test', region: 'auto', bucket: 'links', prefix: '', pathStyle: true },
    { read: S3Credentials.from(LINK_READ)!, write: S3Credentials.from(LINK_WRITE)! }, 1) as unknown as D1PreparedStatement[]);
});
after(() => mf?.dispose());
async function call(...args: unknown[]) {
  const response = await mf.dispatchFetch('http://mail.example/', { method: 'POST', body: JSON.stringify(args) });
  assert.equal(response.status, 200);
  return response.json();
}

test('ContentLookup has exactly three own RPC methods and directly extends WorkerEntrypoint', async () => {
  assert.deepEqual(await call('surface'), { names: ['constructor', 'linkReadCredential', 'mailboxOwner', 'messageRecord'], direct: true });
});
test('mail-content can receive only the read-only key of a workspace link location', async () => {
  const answer = await call('linkReadCredential', 'w', LINK_LOCATION);
  assert.deepEqual(answer, { value: LINK_READ });
  assert.ok(!JSON.stringify(answer).includes(LINK_WRITE.secretAccessKey));
  for (const args of [['other', LINK_LOCATION], ['w', 'bcdefghijklmnopqrstuvwxyza'], ['w', 'not-a-location'], ['W', LINK_LOCATION], [{}, LINK_LOCATION]]) {
    assert.deepEqual(await call('linkReadCredential', ...args), { value: null }, JSON.stringify(args));
  }
  // With the columns swapped, the read path refuses the write key instead of returning it.
  const db = await mf.getD1Database('DIRECTORY', 'lookup');
  await db.prepare('UPDATE link_storage_locations SET read_sealed = write_sealed, write_sealed = read_sealed').run();
  assert.deepEqual(await call('linkReadCredential', 'w', LINK_LOCATION), { value: null });
  await db.prepare('UPDATE link_storage_locations SET read_sealed = write_sealed, write_sealed = read_sealed').run();
  assert.deepEqual(await call('linkReadCredential', 'w', LINK_LOCATION), { value: LINK_READ });
});
test('MAIL_LOOKUP exposes only the named façade, not mailApi, deliver or another name', async () => {
  assert.deepEqual(await call('mailboxOwner', 'w', 'ready'), { value: 'owner-ready' });
  for (const name of ['mailApi', 'deliver', 'alarm', 'anythingElse']) {
    assert.deepEqual(await call(name, 'w', 'ready'), { refused: true }, name);
  }
  assert.deepEqual(await call('fetch', 'https://mail.example/'), { refused: true });
});
test('the opaque account subject need not have mailbox-ID syntax', async () => {
  assert.deepEqual(await call('mailboxOwner', 'w', 'opaque-owner'), { value: 'account:member' });
  await call('seed', 'opaque-owner', 'ready', Date.now() + 60 * 60 * 1000);
  const result = await call('messageRecord', 'w', 'opaque-owner', 'account:member', 'm') as { value?: { rawKey: string } };
  assert.equal(result.value?.rawKey, 'raw-key');
});
test('malformed workspace, mailbox, user and message values are refused', async () => {
  for (const [method, ...args] of [
    ['mailboxOwner', 'W', 'ready'], ['mailboxOwner', 'w', 123],
    ['messageRecord', 'w/other', 'ready', 'owner-ready', 'm'], ['messageRecord', 'w', 'ready\n', 'owner-ready', 'm'],
    ['messageRecord', 'w', 'ready', '', 'm'], ['messageRecord', 'w', 'ready', 'owner-ready', { id: 'm' }],
    ['messageRecord', 'w', 'ready', 'owner-ready', 'a/b'],
  ] as const) assert.deepEqual(await call(method, ...args), { value: null });
});
test('unknown scope and wrong owner create no mailbox Durable Object', async () => {
  const before = await mf.listDurableObjectIds('MAILBOX', 'lookup');
  for (const [ws, mb, sub] of [['w', 'missing', 'owner-ready'], ['other', 'ready', 'owner-ready'], ['w', 'ready', 'not-owner']]) {
    assert.deepEqual(await call('messageRecord', ws, mb, sub, 'm'), { value: null });
  }
  assert.deepEqual(await mf.listDurableObjectIds('MAILBOX', 'lookup'), before);
});
test('cold ready lookup projects primitives and does not modify storage or the alarm', async () => {
  await call('seed', 'ready', 'ready', Date.now() + 60 * 60 * 1000);
  const before = await call('snapshot', 'ready');
  const verdict = await call('verdict', 'ready');
  await call('evict', 'ready');
  assert.deepEqual(await call('messageRecord', 'w', 'ready', 'owner-ready', 'm'), {
    value: { rawKey: 'raw-key', attachments: [{ part: 1, objectKey: null }], verdict },
  });
  assert.deepEqual(await call('snapshot', 'ready'), before);
});
test('non-ready mailbox returns null without starting a restore', async () => {
  await call('seed', 'restoring', 'restoring', Date.now() + 60 * 60 * 1000);
  const before = await call('snapshot', 'restoring');
  assert.deepEqual(await call('messageRecord', 'w', 'restoring', 'owner-restoring', 'm'), { value: null });
  assert.deepEqual(await call('snapshot', 'restoring'), before);
});
test('expired messages are not returned even before the sweeper removes them', async () => {
  await call('expire', 'ready');
  assert.deepEqual(await call('messageRecord', 'w', 'ready', 'owner-ready', 'm'), { value: null });
});
