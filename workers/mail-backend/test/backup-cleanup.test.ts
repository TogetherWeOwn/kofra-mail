import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { AlarmPlumbing } from './fixtures/mailbox-alarm-plumbing.ts';
import type { FixtureMailbox } from './fixtures/mailbox-worker.ts';
import type { MailboxManifest } from '../src/mailbox-recovery.ts';
import { mailboxName } from '../src/worker.ts';

async function setup(t: TestContext) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/mailbox-alarm-plumbing.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false });
  const runtime = new Miniflare({ modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle.outputFiles[0].text }],
    compatibilityDate: '2025-06-01', durableObjects: {
    MAILBOX: { className: 'AlarmPlumbing', useSQLite: true }, SWEEPER: { className: 'UnusedSweeper', useSQLite: true },
    TARGET: { className: 'FixtureMailbox', useSQLite: true }, SWEEP: { className: 'FixtureSweeper', useSQLite: true },
  }, bindings: { MAIL_BACKEND_ENABLED: 'on', MAIL_RECOVERY_ENABLED: 'on', KOFRA_S3_ENDPOINT: 'https://s3.invalid',
    KOFRA_S3_ACCESS_KEY_ID: 'fixture', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture' },
  r2Buckets: { MAIL_STATE: 'shared-state', STATE: 'shared-state', RAW: 'raw-fixture' }, d1Databases: ['DIRECTORY'] });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('DIRECTORY');
  for (const file of ['0001_directory.sql', '0002_outbox.sql', '0004_mailbox_replay.sql']) {
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    await db.batch(sql.replace(/^\s*--.*$/gm, '').split(/;\s*\n(?=\s*(?:CREATE |ALTER |$))/).filter(s => s.trim()).map(s => db.prepare(s)));
  }
  const sources = await runtime.getDurableObjectNamespace('MAILBOX') as unknown as { getByName(name: string): AlarmPlumbing };
  const targets = await runtime.getDurableObjectNamespace('TARGET') as unknown as { getByName(name: string): FixtureMailbox };
  const source = sources.getByName(mailboxName('workspace', 'mailbox'));
  return { source, restored: targets.getByName('restored'), bucket: await runtime.getR2Bucket('MAIL_STATE'),
    doId: await source.setup('ready') };
}

async function runWithPromptContinuation(source: AlarmPlumbing) {
  const before = Date.now();
  await source.run();
  const after = Date.now();
  const alarm = await source.alarmAt();
  assert.ok(alarm !== null && alarm >= before + 1000 && alarm <= after + 1000,
    'unfinished backup work must arm a one-second continuation');
}

test('cleanup keeps only live snapshot generations and safe deltas; restore still matches', async t => {
  const { source, restored, bucket, doId } = await setup(t);
  const prefix = `journal/${doId}/`;
  const manifest = async () => {
    const obj = await bucket.get(`${prefix}manifest.json`);
    assert.ok(obj);
    return await obj.json() as MailboxManifest;
  };
  const generation = (key: string) => key.slice(0, -'head.json'.length);
  const keys = async (scan: string) => (await bucket.list({ prefix: scan })).objects.map(obj => obj.key);
  await source.addLabel('first');
  await source.run();
  const first = (await manifest()).snapshot_key;
  assert.ok(first);
  assert.deepEqual(await keys(generation(first)), [generation(first) + '1.json', first]);
  await source.addLabel('second');
  await source.setSnapshotDeadline(0);
  await source.run();
  const second = (await manifest()).snapshot_key;
  assert.ok(second);
  assert.notEqual(second, first);
  assert.deepEqual(await keys(generation(first)), []);
  assert.deepEqual(await keys(generation(second)), [generation(second) + '1.json', second]);

  await source.addLabel('from-delta');
  await source.run();
  const current = await manifest();
  assert.equal(current.delta_keys.length, 1);
  const range = (seq: number) => `${String(seq).padStart(16, '0')}-${String(seq).padStart(16, '0')}.json`;
  const foreign = `${prefix}deltas/00000000-0000-4000-8000-000000000000/${range(current.last_seq + 1)}`;
  const future = `${prefix}deltas/${current.incarnation}/${range(current.last_seq + 1)}`;
  const obsolete = `${prefix}deltas/${current.incarnation}/${range(1)}`;
  for (const key of [foreign, future, obsolete]) await bucket.put(key, 'unused');
  // Without a snapshot switch nothing is superseded, so no listing runs.
  await source.run();
  assert.deepEqual(await keys(`${prefix}deltas/`), [foreign, current.delta_keys[0], future, obsolete].sort());
  // The next switch supersedes the published delta and sweeps the orphans,
  // keeping only this incarnation's not-yet-referenced range.
  await source.setSnapshotDeadline(0);
  await source.run();
  assert.deepEqual(await keys(`${prefix}deltas/`), [future]);
  const third = (await manifest()).snapshot_key;
  assert.ok(third && third !== second);
  assert.deepEqual(await keys(generation(second)), []);
  await restored.restoreBackup(doId, []);
  assert.deepEqual(JSON.parse(await restored.state()).labels, JSON.parse(await source.labels()));
});

test('cleanup lists only after a snapshot switch or while a listing is unfinished', async t => {
  const { source, bucket, doId } = await setup(t);
  await source.run(); // Publish the initial snapshot and finish its cleanup.
  const orphan = `journal/${doId}/snapshots/00000000-0000-4000-8000-000000000000/`;
  for (let i = 1; i <= 105; i++) await bucket.put(`${orphan}${i}.json`, 'unused');
  for (let i = 0; i < 2; i++) {
    await source.run();
    assert.equal(await source.listCalls(), 0, 'an alarm without a switch or cleanup cursor must not list');
  }
  assert.equal((await bucket.list({ prefix: orphan })).objects.length, 105);

  await source.setSnapshotDeadline(0);
  await runWithPromptContinuation(source);
  assert.ok(await source.listCalls() > 0, 'the snapshot switch starts cleanup');
  const remaining = (await bucket.list({ prefix: orphan })).objects.length;
  assert.ok(remaining >= 5 && remaining < 105, 'the switch deletes at most 100 artifacts');
  await source.run();
  assert.ok(await source.listCalls() > 0, 'cleanup resumes without another switch');
  assert.equal((await bucket.list({ prefix: orphan })).objects.length, 0);
  await source.run();
  assert.equal(await source.listCalls(), 0, 'completed cleanup does not leave a cursor');
});

test('losing the manifest and an uploaded page mid-snapshot republishes a complete snapshot', { timeout: 30_000 }, async t => {
  const { source, restored, bucket, doId } = await setup(t);
  const prefix = `journal/${doId}/`;
  const manifestKey = `${prefix}manifest.json`;
  const labelCount = 8193; // 128 full pages of 64 rows, plus a page for the final row.
  await source.seedLabels(labelCount);
  // Flush all deltas first so journal backlog cannot explain a prompt alarm.
  await source.setSnapshotDeadline(Date.now() + 60_000);
  await source.run();
  await source.run();
  const flushed = await bucket.get(manifestKey);
  assert.ok(flushed);
  assert.equal((await flushed.json() as MailboxManifest).last_seq, labelCount);
  await source.setSnapshotDeadline(0);
  await runWithPromptContinuation(source);
  const staged = (await bucket.list({ prefix: `${prefix}snapshots/` })).objects.map(obj => obj.key);
  assert.equal(staged.length, 128, 'the first alarm leaves a partially uploaded snapshot');
  const firstPage = staged.find(key => key.endsWith('/1.json'));
  assert.ok(firstPage);
  const previous = await bucket.get(manifestKey);
  assert.ok(previous);
  assert.equal((await previous.json() as MailboxManifest).snapshot_key, null);
  await bucket.delete([manifestKey, firstPage]);

  let recreated = await bucket.get(manifestKey);
  for (let i = 0; i < 4 && !recreated; i++) {
    await source.run();
    recreated = await bucket.get(manifestKey);
  }
  assert.ok(recreated, 'publication recreates the manifest');
  const { snapshot_key: headKey } = await recreated.json() as MailboxManifest;
  assert.ok(headKey);
  const head = await bucket.get(headKey);
  assert.ok(head);
  assert.equal((await head.json() as { pages: number }).pages, 129);
  const generation = headKey.slice(0, -'head.json'.length);
  const available = new Set((await bucket.list({ prefix: generation })).objects.map(obj => obj.key));
  const missing = Array.from({ length: 129 }, (_, i) => i + 1).filter(page => !available.has(`${generation}${page}.json`));
  assert.deepEqual(missing, [], 'the recreated snapshot contains every numbered page');
  assert.notEqual(`${generation}1.json`, firstPage, 'recovery uses a new snapshot generation');

  await restored.restoreBackup(doId, []);
  const expected = JSON.parse(await source.labels());
  assert.equal(expected.length, labelCount);
  assert.deepEqual(JSON.parse(await restored.labels()), expected);
});
