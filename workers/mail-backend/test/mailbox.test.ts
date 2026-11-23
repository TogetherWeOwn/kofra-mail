import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { TextEncoder, TextDecoder } from 'node:util';
import { build } from 'esbuild';
import { Miniflare, Response, type Request } from 'miniflare';
import { sha256 } from '../src/bytes.ts';
import type { JournalEvent } from '../src/mail-journal.ts';
import type { MailboxManifest } from '../src/mailbox-recovery.ts';
import { Outbox } from '../src/outbox.ts';
import type { AlarmMailbox, FixtureMailbox } from './fixtures/mailbox-worker.ts';

const mime = (header = '', messageId = 'first', body = 'Evidence for tomorrow') => new TextEncoder().encode(`${header}Message-ID: <${messageId}@example.test>\r\nFrom: sender@example.test\r\nTo: reader@example.test\r\nSubject: A report\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`);
let mf: Miniflare;
type Fixture = Pick<FixtureMailbox, 'ingest' | 'ingestError' | 'search' | 'label' | 'flags' | 'draft' | 'bayes' | 'flush' | 'replay' | 'replayError' | 'state' | 'wipe' |
  'publishBackup' | 'waitForManifest' | 'releaseManifest' | 'restoreBackup' | 'setting' | 'createBaseline' | 'publishOnce' | 'publishError' |
  'beginRestore' | 'advanceRestore' | 'restoreStepError' | 'restoreCursor' | 'rebuildSearch' | 'failNextSnapshotPage' | 'rawGetCount' | 'seedBayes'>;
const state = async (box: Fixture) => JSON.parse(await box.state()) as {
  modseq: number; messages: Record<string, unknown>[]; labels: unknown[]; drafts: unknown[]; bayes: unknown[]; settings: unknown[];
};
let api: { getByName(name: string): Fixture };
let alarmApi: { getByName(name: string): Pick<AlarmMailbox, 'setLabel' | 'saveDraft' | 'scheduledAt' | 'publishNow' |
  'wipe' | 'restoreState' | 'restoreFromBackup' | 'deliver'>; idFromName(name: string): { toString(): string } };
let db: D1Database;
const kofraRaw = new Map<string, Uint8Array<ArrayBuffer>>();
let raw: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
let journal: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
before(async () => {
  const compiled = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/mailbox-worker.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false });
  mf = new Miniflare({ modules: [{ type: 'ESModule', path: 'worker.mjs', contents: compiled.outputFiles[0].text }],
    compatibilityDate: '2025-06-01', durableObjects: {
      BOX: { className: 'FixtureMailbox', useSQLite: true }, MAILBOX: { className: 'AlarmMailbox', useSQLite: true },
    },
    r2Buckets: { RAW: 'raw', STATE: 'state', MAIL_STATE: 'state' }, d1Databases: ['DIRECTORY'],
    bindings: { MAIL_BACKEND_ENABLED: 'on', MAIL_RECOVERY_ENABLED: 'on', KOFRA_S3_ENDPOINT: 'https://object-store.example.test',
      KOFRA_S3_ACCESS_KEY_ID: 'fixture', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture' },
    outboundService: async (request: Request) => {
      const { pathname } = new URL(request.url);
      if (request.method === 'GET') {
        const bytes = kofraRaw.get(pathname);
        assert.ok(bytes, `Unexpected object GET: ${pathname}`);
        return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } });
      }
      assert.equal(request.method, 'PUT');
      assert.match(pathname, /\/drafts\/[a-f0-9]{64}$/);
      await request.arrayBuffer();
      return new Response(null, { status: 201 });
    },
  });
  api = await mf.getDurableObjectNamespace('BOX') as unknown as typeof api;
  alarmApi = await mf.getDurableObjectNamespace('MAILBOX') as unknown as typeof alarmApi;
  raw = await mf.getR2Bucket('RAW');
  journal = await mf.getR2Bucket('STATE');
  db = await mf.getD1Database('DIRECTORY') as unknown as D1Database;
  for (const name of ['0001_directory.sql', '0002_outbox.sql']) {
    const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    const statements = migration.split(/;\s*\n(?=\s*(?:CREATE |$))/).filter(s => s.trim());
    await db.batch(statements.map(s => db.prepare(s)));
  }
  await db.prepare("INSERT INTO mailboxes (id, workspace_id, user_id, primary_address) VALUES ('orchestrated', 'fixture', 'u1', 'reader@example.test')").run();
});
after(async () => { await mf?.dispose(); });

async function upload(bytes = mime()) {
  const key = `raw/${await sha256(bytes)}/${ids[0]}`;
  await raw.put(key, bytes);
  return key;
}

async function readArtifact(key: string) {
  const object = await journal.get(key);
  assert.ok(object, `missing ${key}`);
  return { etag: object.etag, bytes: Buffer.from(await object.arrayBuffer()) };
}

async function readManifest(scope: string) {
  const key = `journal/${scope}/manifest.json`;
  const artifact = await readArtifact(key);
  return { key, ...artifact, value: JSON.parse(artifact.bytes.toString()) as MailboxManifest };
}

async function deltaEvents(key: string) {
  const { bytes } = await readArtifact(key);
  const { rows } = JSON.parse(bytes.toString()) as { rows: Array<{ seq: number; event: string }> };
  return rows.map(({ seq, event }) => ({ seq, event: JSON.parse(event) as JournalEvent }));
}

const ids = ['01KBN8ZJ7G0000000000000000', '01KBN8ZJ7G0000000000000001', '01KBN8ZJ7G0000000000000002', '01KBN8ZJ7G0000000000000003'];

test('dedupes wire-header variants but preserves distinct bodies and Message-IDs in FTS5', async () => {
  const box = api.getByName('dedupe');
  const first = await upload();
  const second = await upload(mime('Received: by server.example.test\r\n'));
  const distinct = await upload(mime('', 'first', 'Evidence for next week'));
  const otherMessageId = await upload(mime('', 'second')); // only the Message-ID differs from first
  assert.notEqual(first, second);
  await box.ingest(ids[0], first);
  await box.ingest(ids[1], second);
  await box.ingest(ids[2], distinct);
  await box.ingest(ids[3], otherMessageId);
  assert.deepEqual((await box.search('tomorrow')).sort(), [ids[0], ids[3]]);
  assert.deepEqual(await box.search('week'), [ids[2]]);
  assert.deepEqual((await state(box)).messages.map(message => message.id), [ids[0], ids[2], ids[3]]);
});

test('a content hash mismatch cannot create an index entry', async () => {
  const box = api.getByName('corrupt');
  const wrongKey = `raw/${'0'.repeat(64)}/${ids[0]}`;
  await raw.put(wrongKey, mime());
  assert.match(await box.ingestError(ids[0], wrongKey), /digest mismatch/);
  assert.deepEqual(await box.search('tomorrow'), []);
});

test('can delete the mailbox DO contents and rebuild labels, flags, drafts and FTS from a flushed R2 journal', async () => {
  const box = api.getByName('recovery');
  await box.ingest(ids[0], await upload());
  await box.label('triage', 'Needs triage');
  await box.flags(ids[0], 3, ['triage']);
  await box.draft('d1', 'draft body');
  const first = await box.flush('restore-case');
  assert.ok(first);
  await box.flags(ids[0], 7, ['triage']);
  await box.bayes('report', 2, 5);
  const second = await box.flush('restore-case');
  assert.ok(second);
  assert.notEqual(first, second);
  const before = await state(box);
  assert.deepEqual(before.messages.map((m: Record<string, unknown>) => [m.flags, m.labels]), [[7, ['triage']]]);
  assert.equal(before.drafts.length, 1);
  const artifact = await journal.get(first);
  assert.ok(artifact);
  assert.doesNotMatch(await artifact.text(), /Evidence for tomorrow|draft body/);
  await box.wipe();
  assert.equal((await state(box)).messages.length, 0);
  await box.replay(first);
  await box.replay(second);
  await box.replay(second); // replay is idempotent
  assert.deepEqual(await state(box), before);
  assert.deepEqual(await box.search('tomorrow'), [ids[0]]);
});

test('publishes the manifest last and replays deliveries that finish during publication', async () => {
  const control = api.getByName('backup-control');
  const source = api.getByName('backup-source');
  const restored = api.getByName('backup-target');
  const first = await upload();
  const second = await upload(new TextEncoder().encode(new TextDecoder().decode(mime()).replace('tomorrow', 'next week')));
  const duplicate = await upload(mime('Received: by server.example.test\r\n'));
  for (const box of [source, control]) {
    await box.ingest(ids[0], first);
    await box.label('triage', 'Needs triage');
    await box.flags(ids[0], 7, ['triage']);
  }
  const publish = source.publishBackup('concurrent', 101, true);
  await source.waitForManifest();
  try {
    // Only the empty baseline is published until the snapshot manifest is written.
    const baseline = await journal.get('journal/concurrent/manifest.json');
    assert.equal((await baseline?.json() as { snapshot_key: string | null }).snapshot_key, null);
    for (const box of [source, control]) {
      await box.ingest(ids[1], second, 101);
      await box.ingest(ids[2], duplicate, 101);
    }
  } finally {
    await source.releaseManifest();
    await publish;
  }
  const manifest = await journal.get('journal/concurrent/manifest.json');
  assert.ok(manifest);
  const published = await manifest.json() as { last_seq: number; delivery_cursor: number };
  assert.equal(published.last_seq, 5); // the run also drains the changes made during the pause
  assert.equal(published.delivery_cursor, 101);
  await restored.restoreBackup('concurrent', [[ids[1], second, 101, 102], [ids[2], duplicate, 101, 103]]);
  assert.deepEqual(await state(restored), await state(control));
  assert.deepEqual(await restored.search('tomorrow'), [ids[0]]);
  assert.deepEqual(await restored.search('week'), [ids[1]]);
});

test('applies settings, drafts and flags from a snapshot and its manifest deltas', async () => {
  const source = api.getByName('delta-source');
  const target = api.getByName('delta-target');
  await source.ingest(ids[0], await upload());
  await source.draft('d1', 'first draft');
  await source.setting('filter', 'archive', '{"enabled":true}');
  assert.equal(await source.publishBackup('deltas', 100), true);
  await source.setting('send-as', 'identity', '{"enabled":true}');
  await source.flags(ids[0], 1, []);
  assert.equal(await source.publishBackup('deltas', 100), false);
  const artifact = await journal.get('journal/deltas/manifest.json');
  assert.ok(artifact);
  const manifest = await artifact.json() as { delta_keys: string[]; last_seq: number };
  assert.equal(manifest.delta_keys.length, 1);
  assert.equal(manifest.last_seq, 5);
  await target.restoreBackup('deltas', []);
  assert.deepEqual(await state(target), await state(source));
});

test('conditionally creates an empty baseline without replacing an existing manifest', async () => {
  const scope = 'baseline-create';
  const source = api.getByName('baseline-owner');
  const contender = api.getByName('baseline-contender');
  assert.equal(await source.createBaseline(scope), true);
  const baseline = await readManifest(scope);
  const { incarnation, ...empty } = baseline.value;
  assert.match(incarnation, /^[a-f0-9-]{36}$/);
  assert.deepEqual(empty, { version: 2, rev: 1, snapshot_key: null, delta_keys: [], last_seq: 0, delivery_cursor: 0, last_chain: '' });
  assert.equal(await contender.createBaseline(scope), false);
  assert.deepEqual(await readArtifact(baseline.key), { etag: baseline.etag, bytes: baseline.bytes });
});

test('a publisher with a foreign incarnation cannot change the takeover manifest', async () => {
  const scope = 'foreign-incarnation';
  const source = api.getByName('foreign-owner');
  const target = api.getByName('foreign-target');
  await source.label('kept', 'Kept');
  await source.publishBackup(scope, 0);
  const prior = await readManifest(scope);
  await target.restoreBackup(scope, []);
  const takeover = await readManifest(scope);
  assert.notEqual(takeover.value.incarnation, prior.value.incarnation);
  await source.label('late', 'Late');
  assert.match(await source.publishError(0), /owned by another incarnation/);
  assert.deepEqual(await readArtifact(takeover.key), { etag: takeover.etag, bytes: takeover.bytes });
});

test('a stale manifest ETag loses the takeover race without overwriting either incarnation’s deltas', { timeout: 10_000 }, async () => {
  const scope = 'stale-etag';
  const source = api.getByName('stale-owner');
  const target = api.getByName('stale-target');
  assert.equal(await source.createBaseline(scope), true);
  const prior = await readManifest(scope);
  await source.label('old', 'Old');
  const publish = source.publishError(0, true);
  // If publication returns or fails without pausing, fail instead of waiting for an unreachable gate.
  await Promise.race([source.waitForManifest(), publish.then(() => assert.fail('publisher did not pause before manifest PUT'))]);
  const staleKey = `journal/${scope}/deltas/${prior.value.incarnation}/0000000000000001-0000000000000001.json`;
  let staleDelta: Awaited<ReturnType<typeof readArtifact>>;
  let takeover: Awaited<ReturnType<typeof readManifest>>;
  try {
    staleDelta = await readArtifact(staleKey);
    await target.restoreBackup(scope, []);
    takeover = await readManifest(scope);
    assert.notEqual(takeover.value.incarnation, prior.value.incarnation);
  } finally {
    await source.releaseManifest();
  }
  assert.match(await publish, /manifest changed during publication/);
  assert.deepEqual(await readArtifact(takeover.key), { etag: takeover.etag, bytes: takeover.bytes });
  // Snapshot the restored empty state first, so the next event remains a referenced delta.
  await target.publishOnce(0);
  await target.label('new', 'New');
  await target.publishOnce(0);
  const current = (await readManifest(scope)).value;
  const freshKey = `journal/${scope}/deltas/${current.incarnation}/0000000000000001-0000000000000001.json`;
  assert.deepEqual(current.delta_keys, [freshKey]);
  assert.notEqual(freshKey, staleKey);
  assert.deepEqual(await readArtifact(staleKey), staleDelta);
  assert.deepEqual(await deltaEvents(staleKey), [{ seq: 1, event: { type: 'label', id: 'old', name: 'Old' } }]);
  assert.deepEqual(await deltaEvents(freshKey), [{ seq: 1, event: { type: 'label', id: 'new', name: 'New' } }]);
});

test('resumes snapshot and delta restore at the saved cursor after a page GET failure, then rebuilds search', async () => {
  const scope = 'resumable';
  const source = api.getByName('resumable-source');
  const target = api.getByName('resumable-target');
  const first = await upload();
  const second = await upload(mime('', 'second', 'Evidence for next week'));
  const third = await upload(mime('', 'third', 'Evidence for yesterday'));
  await source.label('triage', 'Needs triage');
  await source.ingest(ids[0], first);
  await source.flags(ids[0], 3, ['triage']);
  await source.draft('d1', 'original draft');
  await source.seedBayes(65); // Force a second snapshot page; the first contains the message.
  await source.publishBackup(scope, 100);
  await source.ingest(ids[1], second, 101);
  await source.publishOnce(100);
  await source.setting('send-as', 'identity', '{"enabled":true}');
  await source.flags(ids[0], 7, ['triage']);
  await source.publishOnce(100);
  await source.ingest(ids[2], third, 102);

  await target.beginRestore(scope);
  const cursor = async () => JSON.parse(await target.restoreCursor());
  const expectCursor = async (phase: string, page = 0, rowNo = 0, delta = 0, after = 0) => {
    assert.deepEqual(await cursor(), { phase, page, rowNo, delta, after });
  };
  const stepTo = async (...args: Parameters<typeof expectCursor>) => {
    await target.advanceRestore();
    await expectCursor(...args);
  };
  await expectCursor('reset');
  await stepTo('fence');
  await stepTo('takeover');
  await stepTo('snapshot');
  await stepTo('snapshot', 1, 64);
  const partial = await state(target);
  assert.deepEqual(partial.messages.map(message => [message.id, message.flags]), [[ids[0], 3]]);
  await target.failNextSnapshotPage('GET', 2);
  assert.match(await target.restoreStepError(), /Injected snapshot page GET failure/);
  await expectCursor('snapshot', 1, 64);
  assert.deepEqual(await state(target), partial);
  assert.equal(await target.rawGetCount(), 0);

  await stepTo('snapshot', 2, 71); // label, message, thread, draft, 65 Bayes rows, receipt, fingerprint
  await stepTo('deltas', 2, 71);
  await stepTo('deltas', 2, 71, 1);
  assert.deepEqual((await state(target)).messages.map(message => message.id), [ids[0], ids[1]]);
  await stepTo('deltas', 2, 71, 2);
  await stepTo('deliveries', 2, 71, 2, 100);
  assert.equal(await target.rawGetCount(), 0, 'snapshot and delta replay must not fetch MIME');
  assert.deepEqual(await target.search('tomorrow'), []);
  assert.deepEqual(await target.search('week'), []);

  const deliveries: Parameters<Fixture['advanceRestore']>[0] = [[ids[2], third, 102, 120]];
  await target.advanceRestore(deliveries);
  await expectCursor('deliveries', 2, 71, 2, 120);
  assert.equal(await target.advanceRestore(deliveries), 'ready');
  assert.deepEqual(await cursor(), { phase: 'ready' });
  assert.equal(await target.rawGetCount(), 1, 'only the delivery replay fetched MIME');
  await target.rebuildSearch();
  assert.equal(await target.rawGetCount(), 3, 'reindex fetched the snapshot and delta messages');
  assert.deepEqual(await state(target), await state(source));
  for (const [query, id] of [['tomorrow', ids[0]], ['week', ids[1]], ['yesterday', ids[2]]]) {
    assert.deepEqual(await target.search(query), [id]);
    assert.deepEqual(await target.search(query), await source.search(query));
  }
});

test('Mailbox.restoreFromBackup defers real delivery until the alarm finishes replay', async () => {
  const box = alarmApi.getByName(JSON.stringify(['fixture', 'orchestrated']));
  await box.setLabel('fixture', 'orchestrated', 'triage', 'Triage');
  await box.publishNow();
  const bytes = mime('', 'orchestrated');
  const id = '01KBN8ZJ7G0000000000000004';
  const rawKey = `raw/${await sha256(bytes)}/${id}`;
  kofraRaw.set(`/mail-fixture/${rawKey}`, bytes);
  await new Outbox(db).insert({ id, rawKey, workspaceId: 'fixture', mailboxId: 'orchestrated',
    envelopeFrom: 'sender@example.test', envelopeTo: 'reader@example.test', authResults: null, createdAt: 100 });

  await box.wipe();
  assert.equal(await box.restoreFromBackup('fixture', 'orchestrated'), 'restoring');
  assert.equal(await box.deliver(id), 'deferred');
  assert.deepEqual(JSON.parse(await box.restoreState()), { labels: [], messages: [] });
  await box.publishNow();
  assert.equal(await box.deliver(id), 'indexed');
  assert.deepEqual(JSON.parse(await box.restoreState()), {
    labels: [{ id: 'triage', name: 'Triage' }], messages: [{ id }],
  });
});

test('one scheduled alarm publishes a draft behind 65 unflushed events by the settings deadline', async () => {
  const workspace = 'workspace';
  const mailbox = 'draft-deadline';
  const name = JSON.stringify([workspace, mailbox]);
  const scope = alarmApi.idFromName(name).toString();
  const box = alarmApi.getByName(name);
  await box.setLabel(workspace, mailbox, 'label', 'Initial');
  await box.publishNow();
  assert.equal((await readManifest(scope)).value.last_seq, 1);
  for (let i = 0; i < 65; i++) await box.setLabel(workspace, mailbox, 'label', `Edit ${i}`);
  const draftAt = Date.now();
  const draft = new TextEncoder().encode('draft due at the next alarm');
  await box.saveDraft(workspace, mailbox, 'due', draft);
  const scheduled = await box.scheduledAt();
  // Run the pending alarm directly rather than sleeping on a real 45-second timer.
  await box.publishNow();
  const { value } = await readManifest(scope);
  assert.equal(value.last_seq, 67);
  const events = (await Promise.all(value.delta_keys.map(deltaEvents))).flat();
  const tail = events.at(-1);
  assert.ok(tail?.event.type === 'draft');
  assert.equal(tail.seq, 67);
  assert.equal(tail.event.id, 'due');
  assert.equal(tail.event.rawKey, `drafts/${await sha256(draft)}`);
  assert.ok(scheduled !== null && scheduled <= draftAt + 46_000, 'alarm must leave time to publish before the 60-second deadline');
});

test('publishes a settings delta made between bounded runs of an in-flight snapshot', async () => {
  const scope = 'settings-in-flight';
  const source = api.getByName('settings-source');
  await source.label('before', 'Before');
  await source.publishBackup(scope, 100);
  const previous = (await readManifest(scope)).value;
  // 257 snapshot pages mean the old snapshot stays live over two 128-page runs.
  // Pre-publish 65 events to leave room in the second run's delta budget for the setting.
  await source.seedBayes(65);
  await source.publishOnce(100);
  await source.seedBayes(16_319, 65);
  assert.deepEqual(JSON.parse(await source.publishOnce(100, true)), { more: true, snapshotError: null });
  const inFlight = (await readManifest(scope)).value;
  assert.equal(inFlight.snapshot_key, previous.snapshot_key);
  assert.equal(inFlight.last_seq, 8_258);

  await source.setting('filter', 'after-capture', '{"enabled":true}');
  assert.deepEqual(JSON.parse(await source.publishOnce(100)), { more: true, snapshotError: null });
  const withSetting = (await readManifest(scope)).value;
  assert.equal(withSetting.snapshot_key, previous.snapshot_key);
  assert.equal(withSetting.last_seq, 16_386);
  const settingKey = withSetting.delta_keys.at(-1);
  assert.ok(settingKey);
  assert.deepEqual(await deltaEvents(settingKey), [{ seq: 16_386,
    event: { type: 'setting', kind: 'filter', id: 'after-capture', definition: '{"enabled":true}' } }]);

  assert.deepEqual(JSON.parse(await source.publishOnce(100)), { more: false, snapshotError: null });
  const published = (await readManifest(scope)).value;
  assert.ok(published.snapshot_key);
  assert.notEqual(published.snapshot_key, previous.snapshot_key);
  const head = JSON.parse((await readArtifact(published.snapshot_key)).bytes.toString());
  assert.equal(head.seq, 16_385, 'snapshot must describe the original immutable capture');
  assert.equal(published.last_seq, 16_386);
  assert.deepEqual(published.delta_keys, [settingKey]);
});

test('continues to publish recoverable deltas when a snapshot page PUT fails', async () => {
  const scope = 'snapshot-put-failure';
  const source = api.getByName('snapshot-put-source');
  const target = api.getByName('snapshot-put-target');
  await source.label('old', 'Old');
  await source.publishBackup(scope, 100);
  const previous = (await readManifest(scope)).value;
  await source.setting('filter', 'recent', '{"enabled":true}');
  await source.failNextSnapshotPage('PUT', 1);
  const result = JSON.parse(await source.publishOnce(150, true));
  assert.equal(result.snapshotError, 'Injected snapshot page PUT failure');
  const published = (await readManifest(scope)).value;
  assert.equal(published.snapshot_key, previous.snapshot_key);
  assert.equal(published.delivery_cursor, 100);
  assert.equal(published.last_seq, 2);
  assert.equal(published.delta_keys.length, 1);
  await target.restoreBackup(scope, []);
  assert.deepEqual(await state(target), await state(source));
});

test('cannot replay a journal segment across a gap', async () => {
  const source = api.getByName('gap-source');
  await source.label('one', 'One');
  await source.flush('gap-case');
  await source.label('two', 'Two');
  const last = await source.flush('gap-case');
  assert.ok(last);
  const empty = api.getByName('gap-empty');
  assert.match(await empty.replayError(last), /journal gap/i);
  assert.deepEqual((await state(empty)).labels, []);
});

test('indexes a meeting invitation containing a calendar part', async () => {
  const box = api.getByName('meeting');
  const wire = new TextEncoder().encode([
    'Message-ID: <meeting@example.test>', 'Subject: Calendar invitation', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary=split', '', '--split', 'Content-Type: text/plain', '', 'Invitation',
    '--split', 'Content-Type: text/calendar; method=REQUEST', '',
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:one@example.test',
    'SUMMARY:Meeting', 'END:VEVENT', 'END:VCALENDAR', '--split--', '',
  ].join('\r\n'));
  assert.equal(await box.ingestError(ids[0], await upload(wire)), '');
  assert.deepEqual(await box.search('invitation'), [ids[0]]);
});

test('indexes text from HTML-only mail without indexing script or head contents', async () => {
  const box = api.getByName('html-only');
  const wire = new TextEncoder().encode([
    'Message-ID: <html@example.test>', 'Subject: Status', 'Content-Type: text/html; charset=utf-8', '',
    '<html><head><title>ignoretitle</title></head><body><p>visible</p><p>evid&#101;nce</p>',
    '<script>ignorescript</script></body></html>', '',
  ].join('\r\n'));
  await box.ingest(ids[0], await upload(wire));
  assert.deepEqual(await box.search('visible evidence'), [ids[0]]);
  assert.deepEqual(await box.search('ignorescript'), []);
  assert.deepEqual(await box.search('ignoretitle'), []);
});
