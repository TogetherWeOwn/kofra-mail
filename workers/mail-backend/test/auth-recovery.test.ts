import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { TextEncoder } from 'node:util';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { sha256 } from '../src/bytes.ts';
import type { IndexPlumbing } from './fixtures/index-plumbing.ts';

async function startIndex(t: TestContext) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/index-plumbing.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false });
  const runtime = new Miniflare({ modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle.outputFiles[0].text }],
    compatibilityDate: '2025-06-01', durableObjects: { BOX: { className: 'IndexPlumbing', useSQLite: true }, SWEEP: { className: 'FixtureSweeper', useSQLite: true } },
    r2Buckets: ['RAW', 'STATE'] });
  t.after(() => runtime.dispose());
  const boxes = await runtime.getDurableObjectNamespace('BOX') as unknown as { getByName(name: string): IndexPlumbing };
  const raw = await runtime.getR2Bucket('RAW');
  const state = await runtime.getR2Bucket('STATE');
  return { runtime, boxes, raw, state };
}

test('stores the authentication verdict in the message, journal and snapshot and preserves it on restore', async t => {
  const { runtime, boxes, raw, state } = await startIndex(t);
  const source = boxes.getByName('source');
  const restored = boxes.getByName('target');
  const id = '01KBN8ZJ7G0000000000000000';
  const results = 'mx.example; dmarc=pass header.from=example.test';
  const bytes = new TextEncoder().encode(`From: sender@example.test\r\nAuthentication-Results: ${results}\r\n\r\nbody`);
  // Register the generation with the fixture sweeper, as ingress does, so restore can hold it.
  const sweeps = await runtime.getDurableObjectNamespace('SWEEP') as unknown as {
    getByName(name: string): { register(kind: 'raw', digest: string, holder: string): Promise<string>; release(key: string, holder: string): Promise<void> };
  };
  const ledger = sweeps.getByName('workspace');
  const key = await ledger.register('raw', await sha256(bytes), 'fixture:upload');
  await raw.put(key, bytes);
  await ledger.release(key, 'fixture:upload');
  assert.equal(await source.indexRaw(id, key, results), 'indexed');
  assert.equal(JSON.parse(await source.state()).messages[0].auth, 'pass');
  const events = JSON.parse(await source.journalEvents()) as Array<{ type: string; auth?: string }>;
  assert.equal(events.find(event => event.type === 'message')?.auth, 'pass');
  await source.publishBackup('auth', 0, false, true);
  const manifest = await state.get('journal/auth/manifest.json');
  assert.ok(manifest);
  const { snapshot_key } = await manifest.json() as { snapshot_key: string };
  const page = await state.get(snapshot_key.replace(/head\.json$/, '1.json'));
  assert.ok(page);
  const rows = await page.json() as Array<{ kind: string; value: string }>;
  const message = rows.find(row => row.kind === 'message');
  assert.ok(message);
  assert.equal(JSON.parse(message.value).auth, 'pass');
  await restored.restoreBackup('auth', []);
  assert.deepEqual(JSON.parse(await restored.state()), JSON.parse(await source.state()));
  assert.equal(JSON.parse(await restored.state()).messages[0].auth, 'pass');
});

for (const [description, fromHeaders] of [
  ['two addresses in one From field', 'From: sender@example.test, other@elsewhere.test'],
  ['two From fields', 'From: sender@example.test\r\nFrom: other@example.test'],
]) {
  test(`ingest stores DMARC pass as unaligned for ${description}`, async t => {
    const { boxes, raw } = await startIndex(t);
    const box = boxes.getByName('source');
    const id = '01KBN8ZJ7G0000000000000000';
    const results = 'mx.example; dmarc=pass header.from=example.test';
    const bytes = new TextEncoder().encode(`${fromHeaders}\r\nAuthentication-Results: ${results}\r\n\r\nbody`);
    const key = `raw/${await sha256(bytes)}/${id}`;
    await raw.put(key, bytes);

    assert.equal(await box.indexRaw(id, key, results), 'indexed');
    assert.equal(JSON.parse(await box.state()).messages[0].auth, 'unaligned');
  });
}
