import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response, type Request } from 'miniflare';
import type { MailboxManifest } from '../src/mailbox-recovery.ts';
import { migrateDirectory, seedDirectory } from './fixtures/directory-db.ts';
import type { RecoveryMailbox } from './fixtures/recovery-worker.ts';

const workspace = 'workspace';
const mailboxes = ['a', 'b', 'c', 'd', 'e', 'transient', 'permanent', 'thread', 'missing', 'size', 'legacy', 'collected',
  'replay-missing', 'replay-ambiguous', 'retention', 'draft-only', 'alert-rotation', 'stuck',
  'prune-pages', 'prune-cursor', 'prune-uncovered', 'prune-covered', 'lost-watermark', 'restore-window', 'incomplete-backup',
  'redrive-failed', 'redrive-stuck', 'redrive-queued', 'bootstrap-fence', 'lost-manifest-put'];
const queue = 'recovery-delivery';
let mf: Miniflare;
let db: D1Database;
let state: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
let boxes: { idFromName(name: string): { toString(): string }; getByName(name: string): RecoveryMailbox };
let seq = 0;
const objects = new Map<string, ArrayBuffer>();
const unavailable = new Set<string>();
const missingBuckets = new Set<string>();
const failedReads = new Map<string, number>();
const alerts: Array<{ source: string; key: string; title: string }> = [];
const refusedAlerts: typeof alerts = [];
const refusedAlertKeys = new Set<string>();
const alarmEvents = new EventTarget();

function barrier() {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return { reached: reached.promise, release: release.resolve, async wait() {
    reached.resolve();
    await release.promise;
  } };
}
let completeGate: ReturnType<typeof barrier> | undefined;
let manifestPutGate: ReturnType<typeof barrier> | undefined;
let restoreFenceGate: ReturnType<typeof barrier> | undefined;
const pausedReads = new Map<string, ReturnType<typeof barrier>>();

before(async () => {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/recovery-worker.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false,
  });
  mf = new Miniflare({
    name: 'recovery-fixture', compatibilityDate: '2025-06-01',
    modules: [{ type: 'ESModule', path: 'recovery-fixture.mjs', contents: compiled.outputFiles[0].text }],
    bindings: {
      MAIL_BACKEND_ENABLED: 'on', MAIL_RECOVERY_ENABLED: 'on', DELIVERY_QUEUE_NAME: queue,
      DEAD_LETTER_QUEUE_NAME: 'recovery-dlq', KOFRA_S3_ENDPOINT: 'https://storage.example.test',
      KOFRA_S3_ACCESS_KEY_ID: 'fixture-access', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture-signing',
    },
    d1Databases: ['DIRECTORY'], r2Buckets: ['MAIL_STATE'], queueProducers: { DELIVER: queue },
    durableObjects: {
      MAILBOX: { className: 'RecoveryMailbox', useSQLite: true },
      SWEEPER: { className: 'RecoverySweeper', useSQLite: true },
    },
    serviceBindings: {
      RECOVERY_ADMIN: { name: 'recovery-fixture', entrypoint: 'MailAdmin' },
      RECOVERY_GATE: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === '/alarm-completed') {
          alarmEvents.dispatchEvent(new Event('alarm-completed'));
        } else {
          const gate = path === '/manifest-put' ? manifestPutGate : path === '/restore-fence' ? restoreFenceGate : completeGate;
          assert.ok(gate, `missing gate for ${path}`);
          await gate.wait();
        }
        return new Response(null, { status: 204 });
      },
      ALERTS: async (request: Request) => {
        const alert = await request.json() as typeof alerts[number];
        if (refusedAlertKeys.has(alert.key)) {
          refusedAlerts.push(alert);
          return new Response(null, { status: 503 });
        }
        alerts.push(alert);
        return new Response(null, { status: 204 });
      },
    },
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      if (url.origin !== 'https://storage.example.test') return new Response(null, { status: 403 });
      if (request.method === 'PUT') {
        objects.set(url.pathname, await request.arrayBuffer());
        return new Response(null, { status: 200 });
      }
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      if (unavailable.has(url.pathname)) {
        failedReads.set(url.pathname, (failedReads.get(url.pathname) ?? 0) + 1);
        return new Response(null, { status: 503 });
      }
      if (missingBuckets.has(url.pathname)) {
        return new Response('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code></Error>', { status: 404 });
      }
      await pausedReads.get(url.pathname)?.wait();
      const body = objects.get(url.pathname);
      return body ? new Response(body, { headers: { 'content-length': String(body.byteLength) } })
        // The bridge answers a missing key with an S3 NoSuchKey error document.
        : new Response('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    },
  });
  db = await mf.getD1Database('DIRECTORY') as unknown as D1Database;
  await migrateDirectory(db);
  await seedDirectory(db, workspace, mailboxes);
  boxes = await mf.getDurableObjectNamespace('MAILBOX') as unknown as typeof boxes;
  state = await mf.getR2Bucket('MAIL_STATE');
});
after(() => mf?.dispose());

const nameOf = (id: string) => JSON.stringify([workspace, id]);
const box = (id: string) => boxes.getByName(nameOf(id));
// Miniflare's RPC transport wraps returned objects in inspector proxies.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const manifestKey = (id: string) => `journal/${boxes.idFromName(nameOf(id))}/manifest.json`;
const objectPath = (rawKey: string) => `/mail-${workspace}/${rawKey}`;
const request = (path: string, options?: Parameters<Miniflare['dispatchFetch']>[1]) =>
  mf.dispatchFetch(`http://fixture.local${path}`, options);

async function ingest(mailbox: string, subject: string, mime = `\r\nBody of ${subject}\r\n`) {
  const raw = `Message-ID: <fixture-${++seq}@example.test>\r\nFrom: sender@example.test\r\nSubject: ${subject}\r\n${mime}`;
  const to = `${mailbox}@example.test`;
  const response = await request('/email', { method: 'POST', body: raw,
    headers: { 'x-to': to, 'content-length': String(Buffer.byteLength(raw)) } });
  assert.equal(response.status, 202, await response.text());
  const delivery = await db.prepare('SELECT id FROM deliveries WHERE envelope_to = ? ORDER BY rowid DESC LIMIT 1')
    .bind(to).first<{ id: string }>();
  assert.ok(delivery);
  return delivery.id;
}

async function delivery(id: string) {
  const row = await db.prepare('SELECT state, attempts, raw_key, next_attempt_at FROM deliveries WHERE id = ?').bind(id)
    .first<{ state: string; attempts: number; raw_key: string; next_attempt_at: number }>();
  assert.ok(row);
  return row;
}

async function consume(id: string, pause = false) {
  const response = await request(`/deliver?id=${id}&owner=queue-${++seq}${pause ? '&pause' : ''}`);
  assert.equal(response.status, 200);
  return await response.json() as { disposition: 'ack' | 'retry'; completed: boolean | null };
}

async function redrive(id: string) {
  const response = await request(`/redrive?id=${id}`);
  assert.equal(response.status, 200);
  return await response.json();
}

async function ingestDone(mailbox: string, subject: string) {
  const id = await ingest(mailbox, subject);
  assert.equal((await consume(id)).disposition, 'ack');
  assert.equal((await delivery(id)).state, 'done');
  return id;
}

async function ageCompleted(ids: string[], firstDoneAt: number) {
  const result = await db.prepare(`UPDATE deliveries SET done_at = ?1 + CAST(aged.key AS INTEGER),
    created_at = ?1 + CAST(aged.key AS INTEGER) FROM json_each(?2) AS aged
    WHERE deliveries.id = aged.value AND deliveries.state = 'done'`).bind(firstDoneAt, JSON.stringify(ids)).run();
  assert.equal(result.meta.changes, ids.length);
}

async function retainedDone(ids: string[]) {
  const { results } = await db.prepare(`SELECT id FROM deliveries WHERE id IN (SELECT value FROM json_each(?))
    AND state = 'done' ORDER BY done_at`).bind(JSON.stringify(ids)).all<{ id: string }>();
  return results.map(row => row.id);
}

const backupDoneAt = (mailbox: string) => db.prepare('SELECT backup_done_at FROM mailboxes WHERE workspace_id = ? AND id = ?')
  .bind(workspace, mailbox).first<number>('backup_done_at');
const agedDoneAt = () => Date.now() - 36 * 24 * 60 * 60 * 1000;

// Advance only the due timestamp rather than sleep through real queue backoff.
async function makeDue(id: string) {
  await db.prepare('UPDATE deliveries SET next_attempt_at = 0 WHERE id = ?').bind(id).run();
}

async function requeue(id: string) {
  await makeDue(id);
  assert.equal((await request('/scheduled')).status, 204);
  assert.equal((await consume(id)).disposition, 'ack');
  assert.equal((await delivery(id)).state, 'done');
}

async function advance(mailbox: string, until: (life: Awaited<ReturnType<RecoveryMailbox['lifecycle']>>) => boolean) {
  const target = box(mailbox);
  for (let i = 0; i < 100; i++) {
    const life = await target.lifecycle();
    if (until(life)) return;
    await target.runAlarm();
  }
  assert.fail(`Restore did not reach its checkpoint: ${JSON.stringify(await target.lifecycle())}`);
}

const untilReady = (mailbox: string) => advance(mailbox, life => life?.state === 'ready');

async function flush(mailbox: string) {
  const target = box(mailbox);
  for (let i = 0; i < 30; i++) {
    await target.runAlarm();
    const life = await target.lifecycle();
    if (life?.state === 'ready' && !life.upload && await target.isFlushed()) return;
  }
  assert.fail(`Mailbox did not flush: ${JSON.stringify(await target.lifecycle())}`);
}

async function readObject(key: string) {
  const object = await state.get(key);
  assert.ok(object, `Missing R2 object: ${key}`);
  return Buffer.from(await object.arrayBuffer());
}

async function captureBackup(mailbox: string) {
  const key = manifestKey(mailbox);
  const bytes = await readObject(key);
  const manifest = JSON.parse(bytes.toString()) as MailboxManifest;
  const artifacts = new Map<string, Buffer>();
  const snapshot = manifest.snapshot_key;
  assert.ok(snapshot, 'Expected a published snapshot');
  const head = await readObject(snapshot);
  artifacts.set(snapshot, head);
  const { pages } = JSON.parse(head.toString()) as { pages: number };
  assert.ok(pages > 0);
  for (let i = 1; i <= pages; i++) {
    const page = snapshot.replace(/head\.json$/, `${i}.json`);
    artifacts.set(page, await readObject(page));
  }
  for (const delta of manifest.delta_keys) artifacts.set(delta, await readObject(delta));
  return { key, bytes, manifest, artifacts, pages };
}

async function waitForBarrier(gate: ReturnType<typeof barrier>, operation: Promise<unknown>, label: string) {
  await Promise.race([gate.reached, operation.then(() => assert.fail(`${label} returned before reaching its barrier`)),
    new Promise<never>((_, reject) => AbortSignal.timeout(5_000).addEventListener('abort',
      () => reject(new Error(`${label} did not reach its barrier`)), { once: true }))]);
}

const limits = { timeout: 25_000 };

test('a bootstrap request survives the in-flight Outbox.bumpRecoveryEpoch call', limits, async () => {
  const mailbox = 'bootstrap-fence';
  const target = box(mailbox);
  const id = await ingestDone(mailbox, 'Retained during fence');
  await target.wipe();
  assert.equal(await target.restoreFromBackup(workspace, mailbox), 'restoring');
  await advance(mailbox, life => life?.state === 'restoring' && life.phase === 'fence');

  const gate = barrier();
  restoreFenceGate = gate;
  const run = target.runAlarmWithPausedFence();
  try {
    await waitForBarrier(gate, run, 'restore fence');
    await state.delete(manifestKey(mailbox));
    assert.equal(await target.restoreFromBackup(workspace, mailbox, true), 'restoring');
  } finally {
    gate.release();
    try { await run; }
    finally { restoreFenceGate = undefined; }
  }
  const life = await target.lifecycle();
  assert.ok(life?.state === 'restoring' && life.phase === 'takeover');
  assert.equal(life.bootstrap, true, 'the D1 fence must preserve the stored bootstrap request');
  await untilReady(mailbox);
  assert.deepEqual(plain((await target.dump()).messages).map(message => message.id), [id],
    'bootstrap indexed the retained message, rather than recording a skipped receipt');
  assert.ok(await state.head(manifestKey(mailbox)), 'bootstrap recreated the missing manifest');
});

test('a wiped mailbox cannot replace its backup before restore; old state and new delivery survive', limits, async () => {
  const mailbox = 'a';
  const target = box(mailbox);
  const old = await ingestDone(mailbox, 'First report');
  await target.setLabel(workspace, mailbox, 'triage', 'Needs triage');
  await target.setFlags(workspace, mailbox, old, 3, ['triage']);
  await target.saveDraft(workspace, mailbox, 'draft', Uint8Array.from(new TextEncoder().encode('Saved draft body')));
  await target.forceSnapshot();
  await flush(mailbox);
  await target.setLabel(workspace, mailbox, 'later', 'Later');
  await target.setFlags(workspace, mailbox, old, 7, ['triage', 'later']);
  const second = await ingestDone(mailbox, 'Older invoice');
  await flush(mailbox);
  const source = plain(await target.dump());
  assert.deepEqual(source.messages.find(row => row.id === old)?.flags, 7);
  assert.deepEqual(source.messages.find(row => row.id === old)?.labels, '["later","triage"]');
  const backup = await captureBackup(mailbox);
  assert.ok(backup.manifest.delta_keys.length > 0);

  await target.wipe();
  const incoming = await ingest(mailbox, 'Brand new');
  await consume(incoming);
  await target.runAlarm();
  assert.equal((await readObject(backup.key)).equals(backup.bytes), true, 'post-wipe delivery/alarm rewrote the last good manifest');
  const pending = await delivery(incoming);
  assert.deepEqual([pending.state, pending.attempts], ['pending', 0]);
  await target.restoreFromBackup(workspace, mailbox);
  await untilReady(mailbox);
  const manifest = JSON.parse((await readObject(backup.key)).toString()) as MailboxManifest;
  assert.deepEqual([manifest.snapshot_key, manifest.delta_keys, manifest.last_seq, manifest.delivery_cursor],
    [backup.manifest.snapshot_key, backup.manifest.delta_keys, backup.manifest.last_seq, backup.manifest.delivery_cursor]);
  for (const [key, bytes] of backup.artifacts) {
    assert.equal((await readObject(key)).equals(bytes), true, `restore overwrote ${key}`);
  }
  const durable = ({ messages, labels, drafts }: typeof source) => ({
    messages: messages.map(({ subject: _derived, ...message }) => message), labels, drafts,
  });
  assert.deepEqual(durable(plain(await target.dump())), durable(source));
  const draftBytes = objects.get(objectPath(source.drafts[0].raw_key));
  assert.ok(draftBytes);
  assert.equal(Buffer.from(draftBytes).toString(), 'Saved draft body');

  await requeue(incoming);
  await flush(mailbox);
  const restored = plain(await target.dump());
  assert.deepEqual({ ...restored, messages: restored.messages.filter(row => row.id !== incoming) }, source);
  assert.deepEqual(await target.search('report'), [old]);
  assert.deepEqual(await target.search('invoice'), [second]);
  assert.deepEqual(await target.search('new'), [incoming]);
});

test('a completion held across wipe and final replay read is fenced and re-driven', limits, async () => {
  const mailbox = 'b';
  const target = box(mailbox);
  const old = await ingestDone(mailbox, 'Before');
  await target.forceSnapshot();
  await flush(mailbox);
  const incoming = await ingest(mailbox, 'Paused');
  const gate = completeGate = barrier();
  const inFlight = consume(incoming, true);
  try {
    await waitForBarrier(gate, inFlight, 'Outbox.complete');
    assert.equal((await delivery(incoming)).state, 'pending');
    assert.deepEqual(await target.search('paused'), [incoming]);
    await target.wipe();
    await target.restoreFromBackup(workspace, mailbox);
    await untilReady(mailbox); // Includes the final empty replay page, with completion still paused.
    assert.deepEqual((await target.dump()).messages.map(row => row.id), [old]);
  } finally {
    gate.release();
  }
  const stale = await inFlight;
  completeGate = undefined;
  assert.deepEqual([stale.completed, (await delivery(incoming)).state], [false, 'pending']);
  await requeue(incoming);
  assert.deepEqual(await target.search('paused'), [incoming]);
  assert.deepEqual((await target.dump()).messages.map(row => row.id).sort(), [old, incoming].sort());
});

test('zero-budget restore persists snapshot and delta progress across re-kicks', limits, async () => {
  const mailbox = 'c';
  const target = box(mailbox);
  const ids = [await ingestDone(mailbox, 'Alpha'), await ingestDone(mailbox, 'Beta')];
  const label = (i: number) => `l${String(i).padStart(3, '0')}`;
  for (let i = 0; i < 150; i++) await target.setLabel(workspace, mailbox, label(i), `Label ${i}`);
  await target.forceSnapshot();
  await flush(mailbox);
  for (let i = 0; i < 70; i++) await target.setFlags(workspace, mailbox, ids[i % ids.length], i, [label(i)]);
  await flush(mailbox);
  const source = plain(await target.dump());
  const backup = await captureBackup(mailbox);
  assert.ok(backup.pages > 1 && backup.manifest.delta_keys.length > 1);

  await target.wipe();
  await target.restoreFromBackup(workspace, mailbox);
  assert.equal((await target.lifecycle())?.state, 'restoring', 'restore did not yield to its alarm');
  await advance(mailbox, life => life?.state === 'restoring' && life.phase === 'snapshot' && life.page === 1);
  const snapshotProgress = plain(await target.lifecycle());
  assert.ok(snapshotProgress?.state === 'restoring' && snapshotProgress.phase === 'snapshot' && snapshotProgress.rowNo > 0);
  await target.restoreFromBackup(workspace, mailbox);
  assert.deepEqual(plain(await target.lifecycle()), snapshotProgress);

  await advance(mailbox, life => life?.state === 'restoring' && life.phase === 'deltas' && life.delta === 1);
  const deltaProgress = plain(await target.lifecycle());
  await target.restoreFromBackup(workspace, mailbox);
  assert.deepEqual(plain(await target.lifecycle()), deltaProgress);
  await untilReady(mailbox);
  await flush(mailbox);
  assert.deepEqual(plain(await target.dump()), source);
  assert.deepEqual(await target.search('alpha'), [ids[0]]);
  assert.deepEqual(await target.search('beta'), [ids[1]]);
});

test('delivery at seven attempts is deferred unchanged during actual replay and indexes afterwards', limits, async () => {
  const mailbox = 'd';
  const target = box(mailbox);
  await ingestDone(mailbox, 'Snapshot');
  await target.forceSnapshot();
  await flush(mailbox);
  const replay = await ingestDone(mailbox, 'Retained'); // No alarm: replay must fetch this raw from Kofra.
  const incoming = await ingest(mailbox, 'While restoring');
  await db.prepare('UPDATE deliveries SET attempts = 7 WHERE id = ?').bind(incoming).run();
  await target.wipe();
  await target.restoreFromBackup(workspace, mailbox);
  await advance(mailbox, life => life?.state === 'restoring' && life.phase === 'deliveries');
  const gate = barrier();
  const path = objectPath((await delivery(replay)).raw_key);
  pausedReads.set(path, gate);
  const restoring = target.runAlarm();
  try {
    await waitForBarrier(gate, restoring, 'Restore raw replay');
    await consume(incoming);
  } finally {
    pausedReads.delete(path);
    gate.release();
  }
  await restoring;
  const pending = await delivery(incoming);
  assert.deepEqual([pending.state, pending.attempts], ['pending', 7]);
  await untilReady(mailbox);
  await requeue(incoming);
  assert.equal((await delivery(incoming)).attempts, 7);
  assert.deepEqual(await target.search('while'), [incoming]);
});

test('wipe before any backup alarm restores from the baseline and retained deliveries', limits, async () => {
  const mailbox = 'e';
  const target = box(mailbox);
  const incoming = await ingestDone(mailbox, 'Only message');
  const baseline = await state.get(manifestKey(mailbox));
  await target.wipe();
  assert.equal(await target.restoreError(workspace, mailbox), null);
  await untilReady(mailbox);
  const manifest = await baseline?.json() as MailboxManifest | undefined;
  assert.ok(manifest);
  assert.deepEqual([manifest.snapshot_key, manifest.delta_keys, manifest.last_seq, manifest.delivery_cursor], [null, [], 0, 0]);
  assert.deepEqual((await target.dump()).messages.map(row => row.id), [incoming]);
  assert.deepEqual(await target.search('only'), [incoming]);
});

test('G-H1: a successful mailbox alarm prunes a covered aged delivery, and restore keeps it', limits, async () => {
  const mailbox = 'retention';
  const target = box(mailbox);
  const key = manifestKey(mailbox);
  const id = await ingestDone(mailbox, 'Retained beyond cutoff');
  assert.deepEqual(await target.search('cutoff'), [id]);
  const baseline = await readObject(key);
  assert.equal((JSON.parse(baseline.toString()) as MailboxManifest).last_seq, 0);

  const doneAt = Date.now() - 36 * 24 * 60 * 60 * 1000;
  await db.prepare('UPDATE deliveries SET created_at = ?1, done_at = ?1 WHERE id = ?2').bind(doneAt, id).run();
  const retained = () => db.prepare('SELECT state FROM deliveries WHERE id = ?').bind(id).first<string>('state');
  const watermark = () => db.prepare('SELECT backup_done_at FROM mailboxes WHERE workspace_id = ? AND id = ?')
    .bind(workspace, mailbox).first<number>('backup_done_at');

  assert.equal((await request('/scheduled')).status, 204);
  assert.equal(await retained(), 'done', 'cron pruned the only replay record before publication');
  assert.equal(await watermark(), 0);
  assert.deepEqual(await readObject(key), baseline);

  const publishAlarm = async () => {
    const alarmCompleted = once(alarmEvents, 'alarm-completed', { signal: AbortSignal.timeout(5_000) });
    await Promise.all([target.expeditePublicationAlarm(), alarmCompleted]);
  };

  await target.failNextManifestPut();
  await publishAlarm();
  assert.equal(await target.refusedManifestPuts(), 1, 'the alarm attempted to publish the manifest');
  assert.deepEqual(await readObject(key), baseline, 'the failed PUT left the previous manifest live');
  assert.equal(await watermark(), 0, 'the watermark did not advance without a successful manifest commit');
  assert.equal((await request('/scheduled')).status, 204);
  assert.equal(await retained(), 'done', 'cron retained the only replay record after publication failed');

  await publishAlarm();
  const manifest = JSON.parse((await readObject(key)).toString()) as MailboxManifest;
  assert.ok(manifest.last_seq > 0 && manifest.delta_keys.length > 0, 'the alarm did not publish the delivery');
  assert.equal(await watermark(), doneAt);
  assert.equal(await retained(), null, 'the successful alarm pruned the covered delivery without a cron tick');
  await target.wipe();
  await target.restoreFromBackup(workspace, mailbox);
  await untilReady(mailbox);
  assert.deepEqual((await target.dump()).messages.map(row => row.id), [id]);
  await flush(mailbox);
  assert.deepEqual(await target.search('cutoff'), [id]);
});

test('mailbox pruning drains 150 aged deliveries in bounded pages and re-arms after the full page', limits, async () => {
  const mailbox = 'prune-pages';
  const target = box(mailbox);
  const aged: string[] = [];
  for (let i = 1; i <= 150; i++) aged.push(await ingestDone(mailbox, `Covered delivery ${i}`));
  const recent = await ingestDone(mailbox, 'Covered within retention');
  const old = agedDoneAt();
  await ageCompleted(aged, old);

  const before = Date.now();
  await target.runAlarm();
  const alarm = await target.alarmAt();
  const soon = alarm !== null && alarm >= before && alarm <= Date.now() + 1_100;
  const first = await retainedDone(aged);
  const recentAfterFirst = await retainedDone([recent]);
  const published = await readObject(manifestKey(mailbox));
  assert.equal((JSON.parse(published.toString()) as MailboxManifest).last_seq, 151);
  assert.equal(await target.isFlushed(), true, 'a pending journal must not be what re-armed the alarm');
  await target.runAlarm();
  const second = await retainedDone(aged);

  assert.deepEqual({ leftAfterFirst: first.length, leftAfterSecond: second.length, soon },
    { leftAfterFirst: 50, leftAfterSecond: 0, soon: true });
  assert.deepEqual(first, aged.slice(100), 'the first run pruned the 100 oldest rows');
  assert.deepEqual(recentAfterFirst, [recent]);
  assert.deepEqual(await retainedDone([recent]), [recent], 'covered but recent deliveries survive both runs');
  assert.deepEqual(await readObject(manifestKey(mailbox)), published, 'the continuation did not need a manifest rewrite');
});

test('mailbox pruning leaves an aged completion above the verified publication cursor', limits, async () => {
  const mailbox = 'prune-cursor';
  const target = box(mailbox);
  const covered = await ingestDone(mailbox, 'Covered before the alarm');
  const old = agedDoneAt();
  await ageCompleted([covered], old);
  const gate = manifestPutGate = barrier();
  await target.pauseNextManifestPut();
  const run = target.runAlarm();
  let late: string;
  try {
    await waitForBarrier(gate, run, 'backup manifest PUT');
    late = await ingestDone(mailbox, 'Completed after the cursor was read');
    await ageCompleted([late], old + 1);
  } finally {
    gate.release();
    await run;
    manifestPutGate = undefined;
  }

  assert.deepEqual({ cursor: await backupDoneAt(mailbox), covered: (await retainedDone([covered])).length,
    aboveCursor: (await retainedDone([late])).length }, { cursor: old, covered: 0, aboveCursor: 1 });
});

test('cron never prunes deliveries; a mailbox prunes only its own covered rows with one indexed seek', limits, async () => {
  const { Outbox, PRUNE_COVERED } = await import('../src/outbox.ts');
  const uncovered = 'prune-uncovered';
  const covered = 'prune-covered';
  const old = Date.now() - 36 * 24 * 60 * 60 * 1000;
  const uncoveredIds = Array.from({ length: 13 }, (_, i) => `uncovered-${String(i).padStart(2, '0')}`);
  const coveredIds = ['covered-first', 'covered-second'];
  const insert = (id: string, mailbox: string, done: number) => db.prepare(`INSERT INTO deliveries
    (id, workspace_id, envelope_from, envelope_to, resolved_mailbox_ids, group_post_ids, raw_key,
      state, attempts, next_attempt_at, created_at, done_at)
    VALUES (?1, ?2, 'sender@example.test', ?3, ?4, '[]', 'unused', 'done', 0, 0, ?5, ?5)`)
    .bind(id, workspace, `${mailbox}@example.test`, JSON.stringify([mailbox]), done);
  const retained = async () => (await db.prepare('SELECT id FROM deliveries WHERE envelope_to IN (?, ?) ORDER BY id')
    .bind(`${uncovered}@example.test`, `${covered}@example.test`).all<{ id: string }>()).results.map(row => row.id);
  await db.batch([
    ...uncoveredIds.map((id, i) => insert(id, uncovered, old - 20 + i)),
    ...coveredIds.map((id, i) => insert(id, covered, old + i)),
    // The former cron would consider the first covered row eligible.
    db.prepare('UPDATE mailboxes SET backup_done_at = ? WHERE workspace_id = ? AND id = ?').bind(old, workspace, covered),
  ]);
  try {
    assert.equal((await request('/scheduled')).status, 204);
    assert.deepEqual(await retained(), [...coveredIds, ...uncoveredIds], 'the cron must not prune deliveries');
    // The covered mailbox prunes up to its confirmed cursor; the other mailbox is untouched.
    assert.equal(await new Outbox(db).pruneCovered(workspace, covered, Date.now() - 35 * 24 * 60 * 60 * 1000, old), 1);
    assert.deepEqual(await retained(), ['covered-second', ...uncoveredIds]);
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${PRUNE_COVERED}`).bind(workspace, covered, old, 100)
      .all<{ detail: string }>();
    const plan = results.map(row => row.detail);
    assert.ok(plan.some(detail => /SEARCH deliveries USING (?:COVERING )?INDEX deliveries_mailbox_done \(workspace_id=\? AND <expr>=\? AND done_at[<=>]+\?\)/.test(detail)),
      plan.join('\n'));
    const accesses = plan.filter(detail => /^(SEARCH |SCAN |USE TEMP )/.test(detail));
    assert.equal(accesses.length, 2, plan.join('\n'));
    assert.ok(accesses.some(detail => /^SEARCH deliveries USING (?:COVERING )?INDEX sqlite_autoindex_deliveries_1 \(id=\?\)$/.test(detail)),
      plan.join('\n')); // Delete by primary key; the only eligible-row read is the mailbox index seek.
  } finally {
    await db.batch([
      db.prepare('DELETE FROM deliveries WHERE envelope_to IN (?, ?)').bind(`${uncovered}@example.test`, `${covered}@example.test`),
      db.prepare('UPDATE mailboxes SET backup_done_at = 0 WHERE workspace_id = ? AND id = ?').bind(workspace, covered),
    ]);
  }
});

test('entering the restore window freezes pruning even if the manifest disappears before takeover', limits, async () => {
  const mailbox = 'restore-window';
  const target = box(mailbox);
  const ids = [await ingestDone(mailbox, 'Restore first retained delivery'), await ingestDone(mailbox, 'Restore second retained delivery')];
  await flush(mailbox); // Establish a positive watermark while both deliveries are recent.
  const old = agedDoneAt();
  await ageCompleted(ids, old);
  assert.ok(Number(await backupDoneAt(mailbox)) >= old + 1);
  const key = manifestKey(mailbox);
  assert.ok(await state.head(key));
  await target.wipe();
  assert.equal(await target.restoreFromBackup(workspace, mailbox), 'restoring');
  assert.ok(await state.head(key), 'the manifest existed when restore began');
  const watermarkAtEntry = await backupDoneAt(mailbox);
  await state.delete(key);

  const window = [watermarkAtEntry === 0];
  // The confirmed-missing manifest at takeover holds the mailbox in `missing`.
  for (const step of ['fence', 'takeover', 'missing']) {
    assert.equal((await request('/scheduled')).status, 204);
    window.push(await backupDoneAt(mailbox) === 0);
    await target.runAlarm();
    const life = await target.lifecycle();
    assert.equal(life?.state === 'restoring' ? life.phase : life?.state, step);
    window.push(await backupDoneAt(mailbox) === 0);
  }
  assert.equal(await state.head(key), null, 'restore without bootstrap did not replace the lost manifest');
  const retained = await retainedDone(ids);
  assert.equal(await target.restoreFromBackup(workspace, mailbox, true), 'restoring');
  window.push(await backupDoneAt(mailbox) === 0);
  await untilReady(mailbox);
  const restored = (await target.dump()).messages.map(row => row.id);
  assert.deepEqual({ zeroThroughout: window, retained: ids.map(id => retained.includes(id)),
    restored: ids.map(id => restored.includes(id)), watermarkAfterBootstrap: await backupDoneAt(mailbox) }, {
    zeroThroughout: Array<boolean>(8).fill(true), retained: [true, true], restored: [true, true], watermarkAfterBootstrap: 0,
  });
});

test('backups lost before a covering publication keep the retained rows for bootstrap', limits, async () => {
  const mailbox = 'lost-watermark';
  const target = box(mailbox);
  const first = await ingestDone(mailbox, 'Retained first');
  const second = await ingestDone(mailbox, 'Retained second');
  const old = Date.now() - 36 * 24 * 60 * 60 * 1000;
  // Age the rows without breaking the strictly increasing per-mailbox completion cursor.
  await db.prepare(`UPDATE deliveries SET created_at = ?1, done_at = CASE id WHEN ?2 THEN ?1 - 1 ELSE ?1 END
    WHERE id IN (?2, ?3)`).bind(old, first, second).run();
  const watermark = () => db.prepare('SELECT backup_done_at FROM mailboxes WHERE workspace_id = ? AND id = ?')
    .bind(workspace, mailbox).first<number>('backup_done_at');
  // No publication has covered them yet: the retained rows are the only replay record.
  const key = manifestKey(mailbox);
  assert.ok(await state.head(key));

  await state.delete(key);
  await target.wipe();
  assert.equal(await target.restoreFromBackup(workspace, mailbox), 'missing');
  assert.equal((await target.lifecycle())?.state, 'missing');
  const missingWatermark = await watermark();
  assert.equal((await request('/scheduled')).status, 204);
  const retained = (await db.prepare('SELECT id FROM deliveries WHERE id IN (?, ?) AND state = ? ORDER BY id')
    .bind(first, second, 'done').all<{ id: string }>()).results.map(row => row.id);
  assert.equal(await state.head(key), null, 'cron did not bootstrap the missing mailbox');

  assert.equal(await target.restoreFromBackup(workspace, mailbox, true), 'restoring');
  await untilReady(mailbox);
  const restored = (await target.dump()).messages.map(row => row.id).sort();
  const expected = [first, second].sort();
  assert.deepEqual({ watermark: missingWatermark, retained, restored }, { watermark: 0, retained: expected, restored: expected });
});

test('a lost manifest clears coverage even when its replacement write fails', limits, async () => {
  const mailbox = 'lost-manifest-put';
  const target = box(mailbox);
  await ingestDone(mailbox, 'Coverage before loss');
  await flush(mailbox);
  const watermark = () => db.prepare('SELECT backup_done_at FROM mailboxes WHERE workspace_id = ? AND id = ?')
    .bind(workspace, mailbox).first<number>('backup_done_at');
  assert.ok((await watermark() ?? 0) > 0, 'the flush recorded coverage');
  const key = manifestKey(mailbox);
  await state.delete(key);
  const refusedBefore = await target.refusedManifestPuts();
  await target.failNextManifestPut();
  await target.runAlarm().catch(() => {});
  assert.deepEqual({ refused: await target.refusedManifestPuts() - refusedBefore, manifest: await state.head(key), watermark: await watermark() },
    { refused: 1, manifest: null, watermark: 0 });
});

test('an incomplete replacement backup clears coverage without pruning an aged delivery', limits, async () => {
  const mailbox = 'incomplete-backup';
  const target = box(mailbox);
  const id = await ingestDone(mailbox, 'Only replayable delivery');
  await flush(mailbox);
  const key = manifestKey(mailbox);
  assert.ok(await state.head(key), 'a backup was published before the loss');
  assert.ok(Number(await backupDoneAt(mailbox)) > 0, 'the published backup covered a delivery');
  await ageCompleted([id], agedDoneAt());
  await state.delete(key);

  await target.failSnapshotPuts(true);
  try {
    await target.runAlarm();
  } finally {
    await target.failSnapshotPuts(false);
  }
  assert.equal((await target.lifecycle())?.state, 'ready');
  assert.equal(await state.head(key), null, 'snapshot failure prevented publication of a replacement manifest');
  const watermark = await backupDoneAt(mailbox);
  const retained = await retainedDone([id]);

  await target.wipe();
  assert.equal(await target.restoreFromBackup(workspace, mailbox), 'missing');
  assert.equal(await target.restoreFromBackup(workspace, mailbox, true), 'restoring');
  await untilReady(mailbox);
  const restored = (await target.dump()).messages.map(row => row.id);
  assert.deepEqual({ watermark, retained, restored }, { watermark: 0, retained: [id], restored: [id] });
});

test('G-H2: loss of a published draft-only mailbox enters missing until explicitly bootstrapped', limits, async () => {
  const mailbox = 'draft-only';
  const target = box(mailbox);
  const key = manifestKey(mailbox);
  await target.saveDraft(workspace, mailbox, 'only-draft', Uint8Array.from(new TextEncoder().encode('Unsent draft')));
  await flush(mailbox);
  assert.deepEqual((await target.dump()).drafts.map(row => row.id), ['only-draft']);
  const manifest = JSON.parse((await readObject(key)).toString()) as MailboxManifest;
  assert.ok(manifest.last_seq > 0 && manifest.delta_keys.length > 0, 'the draft was not published');
  const deliveries = await db.prepare('SELECT count(*) AS count FROM deliveries WHERE envelope_to = ?')
    .bind(`${mailbox}@example.test`).first<number>('count');
  assert.equal(deliveries, 0);

  await state.delete(key);
  await target.wipe();
  assert.equal(await target.restoreFromBackup(workspace, mailbox), 'missing', 'lost backup was treated as a new mailbox');
  await target.runAlarm();
  assert.equal((await target.lifecycle())?.state, 'missing');
  assert.equal(await state.get(key), null, 'restore without bootstrap wrote a baseline');

  assert.equal(await target.restoreFromBackup(workspace, mailbox, true), 'restoring');
  await untilReady(mailbox);
  const restarted = JSON.parse((await readObject(key)).toString()) as MailboxManifest;
  assert.notEqual(restarted.incarnation, manifest.incarnation);
  assert.deepEqual((await target.dump()).drafts.map(row => row.id), []);
});

// A syntactically delimited message that exceeds the MIME parser's nesting bound.
function unparseableMime() {
  const depth = 258;
  const part = (i: number) => `Content-Type: multipart/mixed; boundary="level-${i}"\r\n\r\n`;
  return part(0) + Array.from({ length: depth }, (_, i) => `--level-${i}\r\n${part(i + 1)}`).join('')
    + `--level-${depth}\r\nContent-Type: text/plain\r\n\r\nBody\r\n`
    + Array.from({ length: depth + 1 }, (_, i) => `--level-${depth - i}--\r\n`).join('');
}

test('G-M4: twelve refused terminal alerts do not starve the thirteenth in bounded crons', limits, async () => {
  const ids: string[] = [];
  for (let i = 0; i < 13; i++) {
    const id = await ingest('alert-rotation', `Terminal delivery ${i}`, unparseableMime());
    await db.prepare('UPDATE deliveries SET attempts = 7 WHERE id = ?').bind(id).run();
    assert.equal((await consume(id)).disposition, 'ack');
    assert.equal((await delivery(id)).state, 'failed');
    ids.push(id);
  }
  // The terminal scan orders by ID; reject the first full page by key, not by request count.
  ids.sort();
  const refused = ids.slice(0, 12);
  const accepted = ids[12];
  refused.forEach(id => refusedAlertKeys.add(id));
  const delivered = () => alerts.filter(alert => ids.includes(alert.key));
  const cron = async () => {
    const before = refusedAlerts.length + delivered().length;
    assert.equal((await request('/scheduled')).status, 204);
    const requests = refusedAlerts.length + delivered().length - before;
    assert.ok(requests <= 12, `cron exceeded the alert page: ${requests} requests`);
  };
  try {
    const before = refusedAlerts.length;
    await cron();
    assert.deepEqual(refusedAlerts.slice(before).map(alert => alert.key), refused);
    assert.deepEqual(delivered(), []);
    await cron();
    await cron();
    assert.deepEqual(delivered(), [
      { source: 'mail:delivery_failed', key: accepted, title: 'Mail delivery exhausted its retries' },
    ], 'the thirteenth alert was not delivered exactly once while the first twelve stayed refused');
  } finally {
    refused.forEach(id => refusedAlertKeys.delete(id));
    // Drain this test's obligations before subsequent tests run their own crons.
    await cron();
  }
});

test('S-M3: the twelfth transient index failure raises one stuck alert and the delivery remains pending', limits, async () => {
  const id = await ingest('stuck', 'Persistent indexing outage');
  const path = objectPath((await delivery(id)).raw_key);
  const delivered = () => alerts.filter(alert => alert.key === id);
  unavailable.add(path);
  try {
    for (let retry = 1; retry <= 15; retry++) {
      await makeDue(id);
      assert.equal((await consume(id)).disposition, 'ack');
      const row = await delivery(id);
      assert.deepEqual([row.state, row.attempts, failedReads.get(path)], ['pending', 0, retry]);
      if (retry < 11) continue;
      await makeDue(id);
      assert.equal((await request('/scheduled')).status, 204);
      assert.deepEqual(delivered(), retry < 12 ? [] : [
        { source: 'mail:delivery_stuck', key: id, title: 'Mail delivery is still retrying' },
      ], `stuck alert count after ${retry} transient failures`);
    }
    assert.equal((await delivery(id)).state, 'pending');
  } finally {
    unavailable.delete(path);
  }
});

async function exhaustDelivery(id: string) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    await makeDue(id);
    assert.equal((await consume(id)).disposition, 'ack');
    const row = await delivery(id);
    assert.deepEqual([row.state, row.attempts], [attempt < 8 ? 'pending' : 'failed', attempt]);
  }
}

const obligation = (kind: 'failed' | 'stuck', id: string) => db.prepare('SELECT sent_at FROM mail_alerts WHERE key = ?')
  .bind(`delivery_${kind}:${id}`).first<{ sent_at: number | null }>();

test('MailAdmin re-drive starts a new alert generation; a repeat failure alerts again', limits, async () => {
  const id = await ingest('redrive-failed', 'Unparseable after re-drive', unparseableMime());
  // The first occurrence keeps the plain key; later re-drives append `:<generation>`.
  const sent = () => alerts.filter(alert => alert.key === id || alert.key.startsWith(`${id}:`)).map(alert => alert.source);
  await exhaustDelivery(id);
  assert.equal((await request('/scheduled')).status, 204);
  assert.deepEqual(sent(), ['mail:delivery_failed']);
  const original = await obligation('failed', id);
  assert.ok(original?.sent_at);

  // A refused transition leaves the delivery and its alert obligation unchanged.
  for (const [aborted, clause] of [
    ['delivery transition', "BEFORE UPDATE OF state ON deliveries WHEN OLD.state = 'failed' AND NEW.state = 'pending'"],
  ]) {
    await db.prepare(`CREATE TRIGGER fixture_refuse_redrive ${clause} BEGIN SELECT RAISE(ABORT, 'fixture refused re-drive'); END`).run();
    let failedStatus: number;
    try {
      failedStatus = (await request(`/redrive?id=${id}`)).status;
    } finally {
      await db.prepare('DROP TRIGGER fixture_refuse_redrive').run();
    }
    const afterFailure = await delivery(id);
    assert.deepEqual({ status: failedStatus, state: afterFailure.state, attempts: afterFailure.attempts,
      obligationUnchanged: (await obligation('failed', id))?.sent_at === original.sent_at }, {
      status: 500, state: 'failed', attempts: 8, obligationUnchanged: true,
    }, `re-drive must roll back if D1 refuses the ${aborted}`);
  }

  assert.equal(await redrive(id), true);
  assert.equal((await obligation('failed', id))?.sent_at, original.sent_at, 're-drive keeps the earlier obligation');
  await exhaustDelivery(id);
  assert.equal((await request('/scheduled')).status, 204);
  assert.equal((await request('/scheduled')).status, 204);
  assert.deepEqual(sent(), ['mail:delivery_failed', 'mail:delivery_failed']);
});

function alertKeys(kind: 'failed' | 'stuck', id: string) {
  return alerts.filter(alert => alert.source === `mail:delivery_${kind}` &&
    (alert.key === id || alert.key.startsWith(`${id}:`))).map(alert => alert.key);
}

const drainAlerts = async () => assert.equal((await request('/scheduled')).status, 204);

async function assertLaterAlertGenerations(kind: 'failed' | 'stuck', id: string,
  trigger: () => Promise<void>, redriveAgain: () => Promise<unknown>) {
  const keys = [id];
  for (const generation of [1, 2]) {
    await trigger();
    await drainAlerts();
    await drainAlerts();
    const key = `${id}:${generation}`;
    keys.push(key);
    assert.deepEqual(alertKeys(kind, id), keys, `generation ${generation} alerts exactly once with its own key`);
    assert.ok((await obligation(kind, key))?.sent_at, 'the generation has its own sent obligation');
    if (generation < 2) assert.equal(await redriveAgain(), true);
  }
}

test('a re-drive right after the eighth rejection, before any cron, still alerts both generations', limits, async () => {
  const id = await ingest('redrive-failed', 'Re-driven before the cron', unparseableMime());
  const sent = () => alerts.filter(alert => alert.key === id || alert.key.startsWith(`${id}:`)).map(alert => alert.key);
  await exhaustDelivery(id);
  // No cron has run since the delivery became failed.
  assert.equal(await redrive(id), true);
  await exhaustDelivery(id);
  assert.equal((await request('/scheduled')).status, 204);
  assert.equal((await request('/scheduled')).status, 204);
  assert.deepEqual(sent().sort(), [id, `${id}:1`].sort());
});

test('an unsent stuck alert survives re-drive and two later stuck generations get distinct keys', limits, async () => {
  const id = await ingest('redrive-stuck', 'Repeated transient outage');
  const path = objectPath((await delivery(id)).raw_key);
  const original = objects.get(path);
  assert.ok(original);
  const sent = () => alertKeys('stuck', id);
  const stall = async () => {
    const previous = sent();
    unavailable.add(path);
    try {
      for (let retry = 1; retry <= 12; retry++) {
        await makeDue(id);
        assert.equal((await consume(id)).disposition, 'ack');
        if (retry === 11) {
          await makeDue(id);
          assert.equal((await request('/scheduled')).status, 204);
          assert.deepEqual(sent(), previous, 'eleven new retries do not trigger a stuck alert');
        }
      }
      const row = await delivery(id);
      assert.deepEqual([row.state, row.attempts], ['pending', 0]);
      await makeDue(id);
      assert.equal((await request('/scheduled')).status, 204);
    } finally {
      unavailable.delete(path);
    }
  };
  const terminateAndRedrive = async () => {
    // Reach the terminal state required by MailAdmin via permanent raw-integrity failures.
    objects.set(path, Uint8Array.from(new TextEncoder().encode('Corrupted bytes')).buffer);
    try {
      await exhaustDelivery(id);
    } finally {
      objects.set(path, original);
    }
    return redrive(id);
  };
  refusedAlertKeys.add(id);
  try {
    await stall();
    assert.deepEqual(refusedAlerts.filter(alert => alert.key === id).map(alert => alert.source), ['mail:delivery_stuck']);
    assert.deepEqual(await obligation('stuck', id), { sent_at: null });
    assert.equal(await terminateAndRedrive(), true);
    assert.deepEqual(await obligation('stuck', id), { sent_at: null }, 're-drive keeps the earlier stuck obligation');
  } finally {
    refusedAlertKeys.delete(id);
  }
  await drainAlerts();
  await drainAlerts();
  assert.deepEqual(sent(), [id]);
  assert.ok((await obligation('stuck', id))?.sent_at);
  await assertLaterAlertGenerations('stuck', id, stall, terminateAndRedrive);
});

test('an unsent failed alert survives re-drive and two later failures get distinct keys', limits, async () => {
  const id = await ingest('redrive-queued', 'Queued terminal alert', unparseableMime());
  const sent = () => alertKeys('failed', id);
  await exhaustDelivery(id);
  refusedAlertKeys.add(id);
  try {
    assert.equal((await request('/scheduled')).status, 204);
    assert.equal(refusedAlerts.filter(alert => alert.key === id).length, 1);
    assert.deepEqual(await obligation('failed', id), { sent_at: null });
    assert.deepEqual(sent(), []);
  } finally {
    refusedAlertKeys.delete(id);
  }
  assert.equal(await redrive(id), true);
  assert.equal((await delivery(id)).state, 'pending');
  const pendingAfterRedrive = await obligation('failed', id);
  await drainAlerts();
  await drainAlerts();
  assert.deepEqual({ pendingAfterRedrive, delivered: sent() }, {
    pendingAfterRedrive: { sent_at: null }, delivered: [id],
  });
  assert.ok((await obligation('failed', id))?.sent_at);
  await assertLaterAlertGenerations('failed', id, () => exhaustDelivery(id), () => redrive(id));
});

test('transient indexing failures have capped backoff; eight permanent rejects alert once and allow admin re-drive', limits, async () => {
  const transient = await ingest('transient', 'Temporary outage');
  const path = objectPath((await delivery(transient)).raw_key);
  unavailable.add(path);
  const temporaryResults: Array<[string, number, boolean]> = [];
  try {
    const backoffs = [1, 2, 4, 8, 16, 30, 30, 30, 30, 30, 30];
    for (const minutes of backoffs) {
      await makeDue(transient);
      const start = Date.now();
      await consume(transient);
      const row = await delivery(transient);
      const delay = minutes * 60_000;
      temporaryResults.push([row.state, row.attempts,
        start + delay <= row.next_attempt_at && row.next_attempt_at <= Date.now() + delay]);
    }
  } finally {
    unavailable.delete(path);
  }

  const bad = await ingest('permanent', 'Unparseable', unparseableMime());
  const dispositions = [];
  for (let attempt = 1; attempt <= 8; attempt++) {
    await makeDue(bad);
    dispositions.push((await consume(bad)).disposition);
    const row = await delivery(bad);
    assert.deepEqual([row.state, row.attempts], [attempt < 8 ? 'pending' : 'failed', attempt]);
  }
  assert.equal((await request('/scheduled')).status, 204);
  assert.equal((await request('/scheduled')).status, 204);
  assert.deepEqual(alerts.filter(alert => alert.key === bad), [
    { source: 'mail:delivery_failed', key: bad, title: 'Mail delivery exhausted its retries' },
  ]);
  assert.deepEqual({ afterEleven: temporaryResults.at(-1), rawReadFailures: failedReads.get(path), permanentQueueResult: dispositions.at(-1) },
    { afterEleven: ['pending', 0, true], rawReadFailures: 11, permanentQueueResult: 'ack' });
  assert.ok(temporaryResults.every(result => result[0] === 'pending' && result[1] === 0 && result[2]),
    'transient failures changed attempts, status, or exponential backoff');
  assert.ok(dispositions.every(disposition => disposition === 'ack'));
  assert.ok(!alerts.some(alert => alert.key === transient));
  await requeue(transient);
  assert.deepEqual(await box('transient').search('temporary'), [transient]);

  assert.equal(await redrive(bad), true);
  const pending = await delivery(bad);
  assert.deepEqual([pending.state, pending.attempts], ['pending', 0]);
  assert.equal(await redrive(bad), false);
  assert.equal(await redrive(transient), false);
  // Raw is content-addressed: corrected MIME is a later delivery, not a replacement of the failed raw.
  const corrected = await ingestDone('permanent', 'Corrected delivery');
  assert.deepEqual(await box('permanent').search('corrected'), [corrected]);

  // Repairing a corrupt storage read permits the same delivery to index after re-drive.
  const repairable = await ingest('permanent', 'Repaired object');
  const repairPath = objectPath((await delivery(repairable)).raw_key);
  const original = objects.get(repairPath);
  assert.ok(original);
  objects.set(repairPath, Uint8Array.from(new TextEncoder().encode('Corrupted bytes')).buffer);
  for (let attempt = 0; attempt < 8; attempt++) {
    await makeDue(repairable);
    assert.equal((await consume(repairable)).disposition, 'ack');
  }
  assert.equal((await delivery(repairable)).state, 'failed');
  objects.set(repairPath, original);
  assert.equal(await redrive(repairable), true);
  assert.equal((await consume(repairable)).disposition, 'ack');
  const repaired = await delivery(repairable);
  assert.deepEqual([repaired.state, repaired.attempts], ['done', 0]);
  assert.deepEqual(await box('permanent').search('repaired'), [repairable]);
});

test('a replayed reply keeps its restored parent thread through background reindex', limits, async () => {
  const mailbox = 'thread';
  const target = box(mailbox);
  const parent = await ingest(mailbox, 'Quarterly numbers');
  const parentHeader = `<fixture-${seq}@example.test>`;
  assert.equal((await consume(parent)).disposition, 'ack');
  assert.equal((await delivery(parent)).state, 'done');
  await target.forceSnapshot();
  await flush(mailbox);
  const reply = await ingest(mailbox, 'Re: Quarterly numbers', `In-Reply-To: ${parentHeader}\r\nReferences: ${parentHeader}\r\n\r\nMy follow up\r\n`);
  assert.equal((await consume(reply)).disposition, 'ack');
  assert.equal((await delivery(reply)).state, 'done');
  const threads = async () => {
    const rows = plain(await target.dump()).messages;
    assert.equal(rows.length, 2);
    const parentRow = rows.find(row => row.id === parent);
    const replyRow = rows.find(row => row.id === reply);
    assert.ok(parentRow && replyRow);
    return [parentRow.thread_id, replyRow.thread_id];
  };
  const [threadId, replyThread] = await threads();
  assert.equal(threadId, replyThread, 'live index did not link the reply');
  await target.wipe();
  await target.restoreFromBackup(workspace, mailbox);
  await untilReady(mailbox);
  assert.deepEqual(await threads(), [threadId, threadId], 'restore split a reply from its parent thread');
  await flush(mailbox);
  assert.deepEqual(await target.search('follow'), [reply]);
  assert.deepEqual(await threads(), [threadId, threadId], 'reindex split a reply from its parent thread');
});

test('a ready mailbox can publish again after its manifest disappears', limits, async () => {
  const mailbox = 'missing';
  const target = box(mailbox);
  const first = await ingestDone(mailbox, 'First');
  await flush(mailbox);
  const key = manifestKey(mailbox);
  assert.ok(await state.get(key), 'expected a manifest before simulating its loss');
  await state.delete(key);
  assert.equal(await state.get(key), null);
  const second = await ingestDone(mailbox, 'Second');
  for (let i = 0; i < 3; i++) await target.runAlarm();
  assert.ok(await state.get(key), 'ready mailbox kept accepting mail but three publication runs left the manifest absent');

  await target.wipe();
  await target.restoreFromBackup(workspace, mailbox);
  // Check the rebuilt backup before retained outbox deliveries can fill gaps.
  await advance(mailbox, life => life?.state === 'restoring' && life.phase === 'deliveries');
  assert.deepEqual((await target.dump()).messages.map(row => row.id), [first, second].sort());
  await untilReady(mailbox);
});

test('an empty stored raw object spends the rejection budget', limits, async () => {
  const id = await ingest('size', 'Empty storage read');
  objects.set(objectPath((await delivery(id)).raw_key), new ArrayBuffer(0));
  for (let attempt = 1; attempt <= 8; attempt++) {
    await makeDue(id);
    assert.equal((await consume(id)).disposition, 'ack');
    const row = await delivery(id);
    assert.deepEqual([row.state, row.attempts], [attempt < 8 ? 'pending' : 'failed', attempt]);
  }
});

test('a legacy pending row at eight attempts records a terminal rejection', limits, async () => {
  const id = await ingest('legacy', 'Unparseable', unparseableMime());
  await db.prepare('UPDATE deliveries SET attempts = 8 WHERE id = ?').bind(id).run();
  const outcome = await consume(id);
  const row = await delivery(id);
  assert.deepEqual([outcome.disposition, row.state, row.attempts], ['ack', 'failed', 8]);
});

test('a retained completion for a collected duplicate is recorded as a receipt on restore', limits, async () => {
  const mailbox = 'collected';
  const target = box(mailbox);
  const original = await ingest(mailbox, 'Original', '\r\nSame body\r\n');
  const headerSeq = seq;
  assert.equal((await consume(original)).disposition, 'ack');
  assert.equal((await delivery(original)).state, 'done');
  await target.forceSnapshot();
  await flush(mailbox);
  seq = headerSeq - 1;
  const duplicate = await ingest(mailbox, 'Original', 'Received: by duplicate.example.test\r\n\r\nSame body\r\n');
  assert.equal((await consume(duplicate)).disposition, 'ack');
  const row = await delivery(duplicate);
  assert.equal(row.state, 'done');
  assert.deepEqual((await target.dump()).messages.map(message => message.id), [original]);
  // Model a collected generation while its completed row remains in the replay range.
  assert.ok(objects.delete(objectPath(row.raw_key)));
  await target.wipe();
  await target.restoreFromBackup(workspace, mailbox);
  await advance(mailbox, life => life?.state === 'restoring' && life.phase === 'deliveries');
  assert.equal(await target.hasReceipt(duplicate), false);
  await untilReady(mailbox);
  assert.equal(await target.hasReceipt(duplicate), true);
  assert.deepEqual((await target.dump()).messages.map(message => message.id), [original]);
});

test('S-L4: replay skips a NoSuchKey raw, indexes the next delivery, and alerts once', limits, async () => {
  const mailbox = 'replay-missing';
  const target = box(mailbox);
  const missing = await ingestDone(mailbox, 'Gone');
  const readable = await ingestDone(mailbox, 'Replayable');
  assert.ok(objects.delete(objectPath((await delivery(missing)).raw_key)));

  await target.wipe();
  await target.restoreFromBackup(workspace, mailbox);
  await advance(mailbox, life => life?.state === 'restoring' && life.phase === 'deliveries');
  assert.equal(await target.hasReceipt(missing), false);
  assert.deepEqual((await target.dump()).messages.map(row => row.id), []);
  await target.runAlarm();
  assert.equal(await target.hasReceipt(missing), true, 'NoSuchKey becomes a replay receipt');
  assert.deepEqual((await target.dump()).messages.map(row => row.id), [readable]);
  assert.deepEqual(plain(await target.search('Replayable')), [readable]);
  await untilReady(mailbox);

  const key = boxes.idFromName(nameOf(mailbox)).toString();
  const notices = () => alerts.filter(alert => alert.key === key && alert.source === 'mail:restore_skipped');
  const expected = [{ source: 'mail:restore_skipped', key, title: 'Mailbox restore skipped deliveries with missing mail' }];
  assert.deepEqual(notices(), expected, 'restore did not report its missing raw once');
  // Check beyond the cooldown as well: an uncleared skip would become active again.
  await target.expireRestoreSkippedCooldown();
  await target.runAlarm();
  await target.runAlarm();
  assert.deepEqual(notices(), expected, 'later alarms repeated the completed restore alert');
});

test('delivery replay waits on NoSuchBucket without recording a receipt', limits, async () => {
  const mailbox = 'replay-ambiguous';
  const target = box(mailbox);
  const id = await ingestDone(mailbox, 'Bucketretry');
  const path = objectPath((await delivery(id)).raw_key);
  await target.wipe();
  await target.restoreFromBackup(workspace, mailbox);
  await advance(mailbox, life => life?.state === 'restoring' && life.phase === 'deliveries');
  const before = await target.lifecycle();
  assert.ok(before?.state === 'restoring' && before.phase === 'deliveries');

  missingBuckets.add(path);
  try {
    await target.runAlarm();
    const blocked = await target.lifecycle();
    assert.ok(blocked?.state === 'restoring' && blocked.phase === 'deliveries');
    assert.equal(blocked.failures, before.failures + 1, 'the alarm attempted the GET and retained the failure');
    assert.equal(blocked.after, before.after, 'the failed delivery stays in the replay range');
    assert.equal(await target.hasReceipt(id), false);
  } finally {
    missingBuckets.delete(path);
  }

  await untilReady(mailbox);
  assert.deepEqual(plain(await target.search('Bucketretry')), [id]);
});
