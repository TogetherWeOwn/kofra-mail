import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

let mf: Miniflare;
before(async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/content-lookup-worker.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'],
  });
  mf = new Miniflare({ workers: [{
    name: 'lookup', compatibilityDate: '2026-06-25',
    modules: [{ type: 'ESModule', path: 'lookup.mjs', contents: outputFiles[0].text }],
    bindings: { MAIL_BACKEND_ENABLED: 'on', MAIL_CONTENT_ENABLED: 'on' },
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
});
after(() => mf?.dispose());
async function call(...args: unknown[]) {
  const response = await mf.dispatchFetch('http://mail.example/', { method: 'POST', body: JSON.stringify(args) });
  assert.equal(response.status, 200);
  return response.json();
}

test('ContentLookup has exactly two own RPC methods and directly extends WorkerEntrypoint', async () => {
  assert.deepEqual(await call('surface'), { names: ['constructor', 'mailboxOwner', 'messageRecord'], direct: true });
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
