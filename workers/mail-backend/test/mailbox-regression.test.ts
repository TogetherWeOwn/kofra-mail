import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { TextEncoder } from 'node:util';
import { build } from 'esbuild';
import { Miniflare, Response, type Request } from 'miniflare';
import type { JournalEvent, JournalRow } from '../src/mail-journal.ts';
import type { Lifecycle, MailboxManifest } from '../src/mailbox-recovery.ts';
import { mailboxName } from '../src/worker.ts';
import type { RegressionMailbox } from './fixtures/mailbox-regression-worker.ts';

const scope = ['workspace', 'mailbox'] as const;
const id = '01KBN8ZJ7G0000000000000000';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const message = new TextEncoder().encode('From: sender@example.test\r\nSubject: Reindex me\r\n\r\nFixture body\r\n');
const rawKey = `raw/${sha256(message)}/${id}`;
const workerdTest = { timeout: 15_000 };

async function setup(t: TestContext, getRaw?: (path: string) => Response | Promise<Response>,
  onAlert?: (source: unknown) => Promise<void>) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/mailbox-regression-worker.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false });
  const alerts: unknown[] = [];
  const runtime = new Miniflare({ modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle.outputFiles[0].text }],
    compatibilityDate: '2025-06-01', durableObjects: { MAILBOX: { className: 'RegressionMailbox', useSQLite: true } },
    bindings: { MAIL_BACKEND_ENABLED: 'on', MAIL_RECOVERY_ENABLED: 'on', KOFRA_S3_ENDPOINT: 'https://object-store.example.test',
      KOFRA_S3_ACCESS_KEY_ID: 'fixture', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture' },
    r2Buckets: ['MAIL_STATE'], d1Databases: ['DIRECTORY'],
    serviceBindings: { ALERTS: async (request: Request) => {
      const body = await request.json() as { source: unknown };
      alerts.push(body.source);
      await onAlert?.(body.source);
      return new Response(null, { status: 202 });
    } },
    outboundService: async (request: Request) => {
      const { pathname } = new URL(request.url);
      if (request.method === 'GET') {
        assert.ok(getRaw, 'unexpected mail object GET');
        return getRaw(pathname);
      }
      assert.equal(request.method, 'PUT');
      assert.match(pathname, /\/drafts\/[a-f0-9]{64}$/);
      await request.arrayBuffer();
      return new Response(null, { status: 201 });
    },
  });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('DIRECTORY');
  for (const file of ['0001_directory.sql', '0002_outbox.sql']) {
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    await db.batch(sql.split(/;\s*\n(?=\s*(?:CREATE |$))/).filter(s => s.trim()).map(s => db.prepare(s)));
  }
  const boxes = await runtime.getDurableObjectNamespace('MAILBOX');
  const objectId = boxes.idFromName(mailboxName(...scope));
  const box = boxes.get(objectId) as unknown as RegressionMailbox;
  const journal = await runtime.getR2Bucket('MAIL_STATE');
  const manifestKey = `journal/${objectId}/manifest.json`;
  const manifest = async () => {
    const object = await journal.get(manifestKey);
    assert.ok(object, 'mailbox manifest is missing');
    const body = await object.text();
    return { etag: object.etag, body, value: JSON.parse(body) as MailboxManifest };
  };
  const lifecycle = async () => JSON.parse(await box.lifecycle()) as Lifecycle;
  const pending = async () => JSON.parse(await box.journal()) as { modseq: number; flushed: number };
  return { box, db, journal, manifest, manifestKey, alerts, lifecycle, pending };
}

async function runScheduled(box: RegressionMailbox) {
  await box.expediteScheduledAlarm();
  await box.waitForScheduledRun();
}

async function whilePaused<T>(run: Promise<void>, entered: Promise<T>, release: () => Promise<void> | void,
  check: (point: T) => Promise<void>) {
  try {
    const point = await Promise.race([entered, run.then(() => assert.fail('mailbox alarm did not reach the I/O gate'))]);
    await check(point);
  } finally {
    await release();
    await run;
  }
}

test('G-M1: a draft is in the live manifest while the first snapshot page PUT is paused', workerdTest, async t => {
  const { box, journal, manifest } = await setup(t);
  await box.prepare({ snapshotDue: true });
  const draft = new TextEncoder().encode('unsent fixture message');
  await box.saveDraft(...scope, 'draft-1', draft);
  await box.pauseNextIo('first snapshot page PUT');

  await whilePaused(box.run(), box.waitForIo(), () => box.resumeIo(), async pageKey => {
    assert.equal(await journal.head(pageKey), null, 'the paused snapshot page has not been uploaded');
    const { value } = await manifest();
    assert.equal(value.snapshot_key, null, 'the snapshot has not been installed');
    assert.equal(value.last_seq, 1, 'the live manifest must already cover the draft');
    assert.equal(value.delta_keys.length, 1);
    const delta = await journal.get(value.delta_keys[0]);
    assert.ok(delta, 'the live manifest references a stored delta');
    const { rows } = JSON.parse(await delta.text()) as { rows: JournalRow[] };
    assert.equal(rows.length, 1);
    const event = JSON.parse(rows[0].event) as JournalEvent;
    assert.equal(rows[0].seq, 1);
    assert.ok(event.type === 'draft');
    assert.equal(event.id, 'draft-1');
    assert.equal(event.rawKey, `drafts/${sha256(draft)}`);
  });
  assert.notEqual((await manifest()).value.snapshot_key, null, 'the snapshot finished after the gate opened');
});

test('S-M1 Mailbox: an alarm fired while disabled keeps a wake-up and publishes after re-enable', workerdTest, async t => {
  const { box, manifest, pending } = await setup(t);
  await box.prepare();
  await box.setLabel(...scope, 'scheduled', 'Scheduled');
  const baseline = await manifest();
  await box.setBackendEnabled(false);
  await box.expediteScheduledAlarm();
  await box.waitForScheduledRun();

  assert.deepEqual(await manifest(), baseline, 'the disabled alarm did not publish');
  assert.deepEqual(await pending(), { modseq: 1, flushed: 0 });
  assert.notEqual(await box.alarmAt(), null, 'the disabled alarm must leave a scheduled wake-up');
  await box.setBackendEnabled(true);
  await box.expediteScheduledAlarm();
  await box.waitForScheduledRun();
  assert.equal((await manifest()).value.last_seq, 1);
  assert.deepEqual(await pending(), { modseq: 1, flushed: 1 });
});

test('S-M2: an edit during a failed publication run schedules retry within about 45 seconds', workerdTest, async t => {
  const { box, lifecycle, pending } = await setup(t);
  await box.prepare({ failures: 8 });
  await box.pauseNextIo('failed manifest GET');
  await whilePaused(box.run(), box.waitForIo(), () => box.resumeIo(), async () => {
    await box.setLabel(...scope, 'during-failure', 'During failure');
    assert.deepEqual(await pending(), { modseq: 1, flushed: 0 });
  });

  const life = await lifecycle();
  assert.ok(life.state === 'ready');
  assert.equal(life.failures, 9, 'publication really failed');
  const alarm = await box.alarmAt();
  assert.ok(alarm !== null);
  const seconds = Math.round((alarm - Date.now()) / 1000);
  assert.ok(seconds <= 47, `next alarm delay ${seconds} s exceeds 47 s`);
});

test('S-M2: a reindex failure does not increase publication failures', workerdTest, async t => {
  let gets = 0;
  const { box, lifecycle, manifest } = await setup(t, path => {
    assert.ok(path.endsWith(`/${rawKey}`));
    gets++;
    return new Response(null, { status: 503 });
  });
  await box.prepare();
  await box.seedUnindexed(id, rawKey);
  await box.setLabel(...scope, 'publishable', 'Publishable');
  await box.run();

  assert.equal(gets, 1, 'the alarm tried and failed to reindex the message');
  assert.equal((await manifest()).value.last_seq, 1, 'publication succeeded');
  const life = await lifecycle();
  assert.ok(life.state === 'ready');
  assert.equal(life.failures, 0, 'the reindex failure must not count as a publication failure');
  const now = Date.now();
  const retryAt = life.reindexRetryAt ?? 0;
  assert.ok(retryAt > now, 'the failed reindex must have its own future retry');
  const next = await box.alarmAt();
  assert.ok(next !== null && next <= retryAt, 'the next alarm must wake by the reindex retry deadline');
});

test('S-L1: explicit bootstrap unblocks a restoring mailbox stuck at takeover without a manifest', workerdTest, async t => {
  const { box, journal, manifest, manifestKey, lifecycle } = await setup(t);
  await box.prepare();
  const beforeWipe = await manifest();
  await box.wipe();
  assert.equal(await box.restoreFromBackup(...scope), 'restoring');
  await journal.delete(manifestKey);
  await box.run();
  // A confirmed-missing manifest holds the mailbox in `missing`, never a silent bootstrap.
  assert.equal((await lifecycle()).state, 'missing');
  assert.equal(await journal.head(manifestKey), null);
  assert.equal(await box.restoreFromBackup(...scope), 'missing');

  assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
  await box.run();
  assert.equal((await lifecycle()).state, 'ready', 'explicit bootstrap must recover the mailbox');
  const restored = await manifest();
  assert.notEqual(restored.value.incarnation, beforeWipe.value.incarnation);
  assert.equal(restored.value.last_seq, 0);
});

async function retainDelivery(db: Awaited<ReturnType<typeof setup>>['db']) {
  await db.prepare(`INSERT INTO deliveries (id, workspace_id, envelope_from, envelope_to, resolved_mailbox_ids,
    group_post_ids, raw_key, state, attempts, next_attempt_at, created_at, done_at)
    VALUES (?, ?, 'sender@example.test', 'recipient@example.test', ?, '[]', ?, 'done', 1, 0, 1, 2)`)
    .bind(id, scope[0], JSON.stringify([scope[1]]), rawKey).run();
}

function readRetainedMessage(path: string) {
  assert.ok(path.endsWith(`/${rawKey}`));
  return new Response(message, { headers: { 'content-length': String(message.byteLength) } });
}

test('the restore fence preserves bootstrap requested while its D1 work is paused', workerdTest, async t => {
  const { box, journal, manifestKey, lifecycle } = await setup(t);
  await box.prepare();
  await box.wipe();
  assert.equal(await box.restoreFromBackup(...scope), 'restoring');
  await box.pauseNextIo('restore fence');

  await whilePaused(box.runThroughFence(), box.waitForIo(), () => box.resumeIo(), async () => {
    const before = await lifecycle();
    assert.ok(before.state === 'restoring' && before.phase === 'fence');
    assert.equal(before.bootstrap, false);
    await journal.delete(manifestKey);
    assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
    const requested = await lifecycle();
    assert.ok(requested.state === 'restoring' && requested.bootstrap);
  });

  const after = await lifecycle();
  assert.ok(after.state === 'restoring' && after.phase === 'takeover');
  assert.equal(after.bootstrap, true, 'the fence must not overwrite the stored bootstrap request');
  await box.run();
  assert.equal((await lifecycle()).state, 'ready');
  assert.ok(await journal.head(manifestKey), 'bootstrap created the missing manifest');
});

test('explicit bootstrap requested during a missing alarm gets an immediate wake-up', workerdTest, async t => {
  const alertEntered = Promise.withResolvers<void>();
  const releaseAlert = Promise.withResolvers<void>();
  const { box, db, lifecycle } = await setup(t, readRetainedMessage, async source => {
    assert.equal(source, 'mail:restore_blocked');
    alertEntered.resolve();
    await releaseAlert.promise;
  });
  await retainDelivery(db);
  assert.equal(await box.restoreFromBackup(...scope), 'missing');
  await whilePaused(box.run(), alertEntered.promise, () => releaseAlert.resolve(), async () => {
    assert.equal((await lifecycle()).state, 'missing');
    await box.expectIgnoredAlarm();
    assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
    // Consume armSoon's first callback while the original alarm is still blocked.
    // Only the original run's final re-arm can now wake the real handler below.
    await box.waitForIgnoredAlarm();
    assert.equal(await box.alarmAt(), null);
    await box.allowNextScheduledRun();
  });

  const delay = await box.scheduledAlarmDelay();
  assert.ok(delay !== null, 'the original alarm must schedule the recovery wake-up');
  assert.ok(delay <= 2000, `next alarm delay ${Math.round(delay / 1000)} s exceeds 2 s`);
  await box.waitForScheduledRun();
  assert.equal((await lifecycle()).state, 'ready');
  assert.deepEqual(JSON.parse(JSON.stringify(await box.deliveredIds())), [id]);
});

for (const missing of [true, false]) {
  const reason = missing ? 'a confirmed absent manifest' : 'a transient manifest read failure';
  test(`restore snapshot handles ${reason}`, workerdTest, async t => {
    const { box, db, journal, manifestKey, lifecycle } = await setup(t, readRetainedMessage);
    await box.prepare();
    await retainDelivery(db);
    await box.wipe();
    assert.equal(await box.restoreFromBackup(...scope), 'restoring');
    // Skip the takeover read and the read that verifies the new incarnation.
    await box.pauseNextIo(missing ? 'manifest GET' : 'failed manifest GET', 2);
    await whilePaused(box.run(), box.waitForIo(), () => box.resumeIo(), async key => {
      assert.equal(key, manifestKey);
      const life = await lifecycle();
      assert.ok(life.state === 'restoring' && life.phase === 'snapshot');
      if (missing) await journal.delete(manifestKey);
    });

    const life = await lifecycle();
    if (missing) {
      assert.equal(life.state, 'missing');
      assert.equal(life.failures, 0);
      assert.equal(await box.restoreFromBackup(...scope), 'missing');
      assert.equal(await journal.head(manifestKey), null, 'normal restore must not recreate the manifest');
      assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
    } else {
      assert.ok(life.state === 'restoring' && life.phase === 'snapshot');
      assert.equal(life.failures, 1);
    }
    await box.run();
    assert.equal((await lifecycle()).state, 'ready');
    assert.deepEqual(JSON.parse(JSON.stringify(await box.deliveredIds())), [id]);
  });
}

test('a manifest confirmed absent at the read that verifies takeover moves the mailbox to missing', workerdTest, async t => {
  const { box, db, journal, manifestKey, lifecycle } = await setup(t, readRetainedMessage);
  await box.prepare();
  await retainDelivery(db);
  await box.wipe();
  assert.equal(await box.restoreFromBackup(...scope), 'restoring');
  // Skip the takeover read; pause the read that verifies the takeover write.
  await box.pauseNextIo('manifest GET', 1);
  await whilePaused(box.run(), box.waitForIo(), () => box.resumeIo(), async key => {
    assert.equal(key, manifestKey);
    const life = await lifecycle();
    assert.ok(life.state === 'restoring' && life.phase === 'takeover');
    await journal.delete(manifestKey);
  });
  const life = await lifecycle();
  assert.deepEqual({ state: life.state, failures: life.state === 'restoring' || life.state === 'missing' ? life.failures : null },
    { state: 'missing', failures: 0 });
  assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
  await box.run();
  assert.equal((await lifecycle()).state, 'ready');
  assert.deepEqual(JSON.parse(JSON.stringify(await box.deliveredIds())), [id]);
});

for (const skip of [0, 1]) {
  const read = skip === 0 ? 'the first takeover read' : 'the read that verifies takeover';
  test(`bootstrap requested during ${read} recovers a missing manifest`, workerdTest, async t => {
    const { box, db, journal, manifestKey, lifecycle } = await setup(t, readRetainedMessage);
    await box.prepare();
    await retainDelivery(db);
    await box.wipe();
    assert.equal(await box.restoreFromBackup(...scope), 'restoring');
    if (skip === 0) await journal.delete(manifestKey);

    await box.pauseNextIo('manifest GET', skip);
    await whilePaused(box.run(), box.waitForIo(), () => box.resumeIo(), async key => {
      assert.equal(key, manifestKey);
      const life = await lifecycle();
      assert.ok(life.state === 'restoring' && life.phase === 'takeover');
      if (skip === 1) await journal.delete(manifestKey);
      assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
    });

    // A restart after a confirmed-missing manifest ends its slice with backoff.
    for (let i = 0; i < 3 && (await lifecycle()).state !== 'ready'; i++) await box.run();
    assert.equal((await lifecycle()).state, 'ready');
    assert.deepEqual(JSON.parse(JSON.stringify(await box.deliveredIds())), [id]);
  });
}

test('an approved bootstrap survives a manifest lost again at the read that verifies its baseline', workerdTest, async t => {
  const { box, db, journal, manifestKey, lifecycle } = await setup(t, readRetainedMessage);
  await box.prepare();
  await retainDelivery(db);
  await box.wipe();
  assert.equal(await box.restoreFromBackup(...scope), 'restoring');
  await journal.delete(manifestKey);
  await box.run();
  assert.equal((await lifecycle()).state, 'missing');
  assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
  // Skip takeover's first read (absent, so it creates a baseline); pause the read
  // that verifies the baseline and remove the manifest again.
  await box.pauseNextIo('manifest GET', 1);
  await whilePaused(box.run().catch(() => {}), box.waitForIo(), () => box.resumeIo(), async key => {
    assert.equal(key, manifestKey);
    await journal.delete(manifestKey);
  });
  const life = await lifecycle();
  assert.deepEqual({ state: life.state, bootstrap: life.state === 'restoring' ? life.bootstrap : null },
    { state: 'restoring', bootstrap: true }, 'the approval must not be dropped by a move to missing');
  await box.run();
  assert.equal((await lifecycle()).state, 'ready');
  assert.deepEqual(JSON.parse(JSON.stringify(await box.deliveredIds())), [id]);
});

test('a bootstrap approved during the snapshot phase is honoured once the manifest is confirmed missing', workerdTest, async t => {
  const { box, db, journal, manifestKey, lifecycle } = await setup(t, readRetainedMessage);
  await box.prepare();
  await retainDelivery(db);
  await box.wipe();
  assert.equal(await box.restoreFromBackup(...scope), 'restoring');
  // Skip the takeover read and its verifying read; pause the snapshot phase's read.
  await box.pauseNextIo('manifest GET', 2);
  await whilePaused(box.run(), box.waitForIo(), () => box.resumeIo(), async key => {
    assert.equal(key, manifestKey);
    const life = await lifecycle();
    assert.ok(life.state === 'restoring' && life.phase === 'snapshot');
    assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
    await journal.delete(manifestKey);
  });
  for (let i = 0; i < 3 && (await lifecycle()).state !== 'ready'; i++) await box.run();
  assert.equal((await lifecycle()).state, 'ready', 'one bootstrap request must be enough');
  assert.deepEqual(JSON.parse(JSON.stringify(await box.deliveredIds())), [id]);
});

test('a manifest that keeps vanishing under an approved bootstrap backs off and raises restore_blocked', workerdTest, async t => {
  const { box, db, journal, manifestKey, lifecycle, alerts } = await setup(t, readRetainedMessage);
  await box.prepare();
  await retainDelivery(db);
  await box.wipe();
  assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
  for (let round = 1; round <= 3; round++) {
    // Skip takeover's reads (one more once takeover must recreate the baseline);
    // delete the manifest at the snapshot phase's read.
    await box.pauseNextIo('manifest GET', round === 1 ? 2 : 3);
    await whilePaused(box.run(), box.waitForIo(), () => box.resumeIo(), async key => {
      assert.equal(key, manifestKey);
      await journal.delete(manifestKey);
    });
    const life = await lifecycle();
    assert.deepEqual(life.state === 'restoring' ? { phase: life.phase, bootstrap: life.bootstrap, restarts: life.restarts } : life,
      { phase: 'reset', bootstrap: true, restarts: round }, 'a restart ends the slice instead of looping');
    const at = await box.alarmAt();
    assert.ok(at !== null && at >= Date.now() + 5_000 * 2 ** (round - 1) - 1_000, `restart ${round} backs off`);
  }
  assert.ok(alerts.includes('mail:restore_blocked'), 'repeated restarts must not keep restore_blocked silent');
  await box.run();
  assert.equal((await lifecycle()).state, 'ready');
  assert.deepEqual(JSON.parse(JSON.stringify(await box.deliveredIds())), [id]);
});

test('an approved bootstrap clears a committed delta after deltas-phase manifest loss', workerdTest, async t => {
  const { box, db, journal, manifestKey, lifecycle, pending } = await setup(t, readRetainedMessage);
  await box.prepare();
  await box.setLabel(...scope, 'partial', 'Partial');
  await box.run();
  await retainDelivery(db);
  await box.wipe();
  assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
  // Skip takeover's two reads, the snapshot read, and the first delta read.
  await box.pauseNextIo('manifest GET', 4);
  await whilePaused(box.run(), box.waitForIo(), () => box.resumeIo(), async key => {
    assert.equal(key, manifestKey);
    const life = await lifecycle();
    assert.ok(life.state === 'restoring' && life.phase === 'deltas' && life.delta === 1);
    assert.deepEqual(JSON.parse(await box.labels()), [{ id: 'partial', name: 'Partial' }]);
    assert.equal((await pending()).modseq, 1);
    await journal.delete(manifestKey);
  });
  await box.pauseNextIo('manifest GET');
  await whilePaused(box.run(), box.waitForIo(), () => box.resumeIo(), async key => {
    assert.equal(key, manifestKey);
    const life = await lifecycle();
    assert.ok(life.state === 'restoring' && life.phase === 'takeover' && life.restarts === 1);
    assert.deepEqual(JSON.parse(await box.labels()), [], 'partial restore rows must be cleared');
    assert.deepEqual(await pending(), { modseq: 0, flushed: 0 }, 'the cursor must reset before retained deliveries are replayed');
  });
  for (let i = 0; i < 3 && (await lifecycle()).state !== 'ready'; i++) await box.run();
  assert.equal((await lifecycle()).state, 'ready');
  assert.ok(await journal.head(manifestKey), 'the bootstrap recreated the manifest');
  assert.deepEqual(JSON.parse(await box.labels()), []);
  assert.deepEqual(JSON.parse(JSON.stringify(await box.deliveredIds())), [id]);
});

test('client calls during a restart backoff do not pull the restore alarm forward', workerdTest, async t => {
  const { box, db, journal, manifestKey, lifecycle } = await setup(t, readRetainedMessage);
  await box.prepare();
  await retainDelivery(db);
  await box.wipe();
  assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
  await box.pauseNextIo('manifest GET', 2);
  await whilePaused(box.run(), box.waitForIo(), () => box.resumeIo(), async () => {
    await journal.delete(manifestKey);
  });
  const life = await lifecycle();
  assert.ok(life.state === 'restoring' && life.restarts === 1);
  const before = await box.alarmAt();
  assert.ok(before !== null && before >= Date.now() + 3_000, 'the restart armed a backoff');
  await box.setLabel(...scope, 'during-backoff', 'During backoff').catch(() => {});
  assert.equal(await box.alarmAt(), before, 'a client call must not cancel the restart backoff');
});

test('a client call replaces a lost alarm for a restoring mailbox', workerdTest, async t => {
  const { box, db, lifecycle } = await setup(t, readRetainedMessage);
  await box.prepare();
  await retainDelivery(db);
  await box.wipe();
  assert.equal(await box.restoreFromBackup(...scope), 'restoring');
  await box.dropAlarm();
  assert.equal(await box.alarmAt(), null);
  await box.expectIgnoredAlarm();
  assert.equal(await box.setLabelError(...scope, 'lost-alarm', 'Lost alarm'), 'Mailbox not ready; retry');
  assert.deepEqual(JSON.parse(await box.labels()), [], 'the rejected edit must not write a label');
  assert.equal((await lifecycle()).state, 'restoring');
  await Promise.race([box.waitForIgnoredAlarm(), new Promise((_, reject) =>
    setTimeout(() => reject(new Error('no alarm replaced the lost one')), 2_000))]);
});

test('S-L2: the first edit in an alarm after over two idle hours does not trigger a stale alert', workerdTest, async t => {
  const getStarted = Promise.withResolvers<void>();
  const releaseGet = Promise.withResolvers<void>();
  const { box, pending, alerts } = await setup(t, async path => {
    assert.ok(path.endsWith(`/${rawKey}`));
    getStarted.resolve();
    await releaseGet.promise;
    return new Response(message, { headers: { 'content-length': String(message.byteLength) } });
  });
  await box.prepare({ idleForMs: 2 * 60 * 60_000 + 60_000 });
  await box.seedUnindexed(id, rawKey);

  // Reindex runs after publication checked the manifest and found nothing due.
  await whilePaused(box.run(), getStarted.promise, () => releaseGet.resolve(), async () => {
    assert.deepEqual(await pending(), { modseq: 0, flushed: 0 });
    await box.setLabel(...scope, 'fresh', 'Fresh');
  });
  assert.deepEqual(await pending(), { modseq: 1, flushed: 0 }, 'the edit arrived after this alarm published');
  assert.deepEqual(alerts, [], 'a fresh edit in an idle mailbox must not emit backup_stale');
});

test('S-L3: a same-incarnation remote manifest ahead of a rewound journal causes BackupConflict without modification', workerdTest, async t => {
  const { box, manifest, pending } = await setup(t);
  await box.prepare();
  const baseline = await manifest();
  await box.setLabel(...scope, 'old-first', 'Old first');
  await box.setLabel(...scope, 'old-second', 'Old second');
  await box.run();
  const ahead = await manifest();
  assert.equal(ahead.value.incarnation, baseline.value.incarnation);
  assert.notEqual(ahead.etag, baseline.etag);
  assert.equal(ahead.value.last_seq, 2);
  await box.rewindToBaseline();
  await box.setLabel(...scope, 'new-first', 'New first');
  assert.deepEqual(await pending(), { modseq: 1, flushed: 0 });

  assert.equal(await box.publishConflicts(), true, 'publication must throw BackupConflict rather than adopt future history');
  assert.deepEqual(await manifest(), ahead, 'the remote manifest ETag and bytes must remain identical');
  assert.deepEqual(await pending(), { modseq: 1, flushed: 0 });
});

test('a rewound mailbox that passes the published sequence cannot extend the divergent history', workerdTest, async t => {
  const { box, journal, manifest, lifecycle, pending, alerts } = await setup(t);
  await box.prepare();
  await box.setLabel(...scope, 'old-first', 'Old first');
  await box.setLabel(...scope, 'old-second', 'Old second');
  await box.run();
  const published = await manifest();
  assert.equal(published.value.last_seq, 2);

  await box.rewindToBaseline();
  await box.setLabel(...scope, 'new-first', 'New first');
  await box.setLabel(...scope, 'new-second', 'New second');
  await box.setLabel(...scope, 'new-third', 'New third');
  await box.run();
  await box.run();

  const live = await manifest();
  const labels: string[] = [];
  for (const key of live.value.delta_keys) {
    const delta = await journal.get(key);
    assert.ok(delta, 'a live delta is missing');
    const { rows } = JSON.parse(await delta.text()) as { rows: JournalRow[] };
    for (const row of rows) {
      const event = JSON.parse(row.event) as JournalEvent;
      assert.equal(event.type, 'label');
      labels.push(event.id);
    }
  }
  const life = await lifecycle();
  assert.deepEqual({ labels, ...await pending(), lastSeq: live.value.last_seq,
    etagUnchanged: live.etag === published.etag, bytesUnchanged: live.body === published.body,
    conflict: life.state === 'ready' && 'conflict' in life && Boolean(life.conflict), alerts }, {
    labels: ['old-first', 'old-second'], modseq: 3, flushed: 0, lastSeq: 2,
    etagUnchanged: true, bytesUnchanged: true, conflict: true, alerts: ['mail:backup_conflict'],
  });
});

for (const trailingEdit of [false, true]) {
  test(`same-tip divergence blocks ${trailingEdit ? 'publication of a new tail' : 'adoption without new events'}`, workerdTest, async t => {
    const { box, journal, manifest, lifecycle, pending, alerts } = await setup(t);
    await box.prepare();
    await box.setLabel(...scope, 'a', 'A');
    await box.setLabel(...scope, 'b', 'B');
    await runScheduled(box);
    const published = await manifest();
    assert.equal(published.value.last_seq, 2);

    await box.rewindToBaseline();
    await box.setLabel(...scope, 'x', 'X');
    await box.setLabel(...scope, 'b', 'B');
    if (trailingEdit) await box.setLabel(...scope, 'c', 'C');
    await runScheduled(box);
    await runScheduled(box); // A retry must not emit a second conflict alert.

    const live = await manifest();
    const backedUp: string[] = [];
    for (const key of live.value.delta_keys) {
      const delta = await journal.get(key);
      assert.ok(delta, 'a live delta is missing');
      const { rows } = JSON.parse(await delta.text()) as { rows: JournalRow[] };
      for (const row of rows) {
        const event = JSON.parse(row.event) as JournalEvent;
        assert.ok(event.type === 'label');
        backedUp.push(event.id);
      }
    }
    const life = await lifecycle();
    assert.deepEqual({ backedUp, ...await pending(), lastSeq: live.value.last_seq,
      etagUnchanged: live.etag === published.etag, bytesUnchanged: live.body === published.body,
      conflict: life.state === 'ready' && Boolean(life.conflict), alerts }, {
      backedUp: ['a', 'b'], modseq: trailingEdit ? 3 : 2, flushed: 0, lastSeq: 2,
      etagUnchanged: true, bytesUnchanged: true, conflict: true, alerts: ['mail:backup_conflict'],
    });
  });
}

async function seedCrowdedHistory(box: RegressionMailbox, journal: Awaited<ReturnType<Miniflare['getR2Bucket']>>,
  manifestKey: string, baseline: MailboxManifest, count: number) {
  const history = await box.seedPublishedEdits(count);
  const prefix = `${manifestKey.slice(0, -'manifest.json'.length)}deltas/${baseline.incarnation}/`;
  // The old deltas are synthetic references; publication need not fetch them.
  const delta_keys = Array.from({ length: count }, (_, i) => {
    const seq = String(i + 1).padStart(16, '0');
    return `${prefix}${seq}-${seq}.json`;
  });
  await journal.put(manifestKey, JSON.stringify({ ...baseline, rev: 2, delta_keys, last_seq: count, ...history }));
}

test('a crowded manifest already covers the new draft while the first compaction page PUT is paused', workerdTest, async t => {
  const { box, journal, manifest, manifestKey } = await setup(t);
  await box.prepare();
  const count = 19_999;
  await seedCrowdedHistory(box, journal, manifestKey, (await manifest()).value, count);
  const draft = new TextEncoder().encode('draft due before compaction');
  await box.saveDraft(...scope, 'crowded-draft', draft);
  await box.pauseNextIo('first snapshot page PUT');

  await whilePaused(runScheduled(box), box.waitForIo(), () => box.resumeIo(), async pageKey => {
    assert.equal(await journal.head(pageKey), null, 'the paused compaction page is not uploaded');
    const { value } = await manifest();
    assert.equal(value.snapshot_key, null, 'the compaction has not switched the snapshot');
    assert.equal(value.last_seq, count + 1, 'the live manifest must already cover the draft sequence');
    assert.equal(value.delta_keys.length, count + 1);
    const delta = await journal.get(value.delta_keys.at(-1)!);
    assert.ok(delta, 'the live manifest references the draft delta');
    const { rows } = JSON.parse(await delta.text()) as { rows: JournalRow[] };
    assert.equal(rows.length, 1);
    assert.equal(rows[0].seq, count + 1);
    const event = JSON.parse(rows[0].event) as JournalEvent;
    assert.ok(event.type === 'draft');
    assert.equal(event.id, 'crowded-draft');
    assert.equal(event.rawKey, `drafts/${sha256(draft)}`);
  });
  assert.ok((await manifest()).value.snapshot_key, 'compaction switched the snapshot after the gate opened');
});

test('a crowded manifest switches to a snapshot before the regular snapshot deadline', workerdTest, async t => {
  const { box, journal, manifest, manifestKey, lifecycle, pending } = await setup(t);
  await box.prepare();
  const { value: baseline } = await manifest();
  const count = 20_000;
  await seedCrowdedHistory(box, journal, manifestKey, baseline, count);
  await box.setLabel(...scope, 'one-more', 'One more');
  await box.run();
  await box.run();

  const { value: compacted } = await manifest();
  const life = await lifecycle();
  assert.deepEqual({ snapshot: compacted.snapshot_key !== null, deltas: compacted.delta_keys.length,
    rev: compacted.rev, lastSeq: compacted.last_seq, ...await pending(), failures: life.state === 'ready' ? life.failures : null }, {
    // rev 3 commits the due delta before snapshot I/O; rev 4 is the compacting switch.
    snapshot: true, deltas: 0, rev: 4, lastSeq: count + 1, modseq: count + 1, flushed: count + 1, failures: 0,
  });
  assert.ok(compacted.snapshot_key);
  const head = await journal.get(compacted.snapshot_key);
  assert.ok(head, 'the compacted manifest references a stored snapshot');
  const snapshot = JSON.parse(await head.text()) as { seq: number };
  assert.equal(snapshot.seq, count + 1);

  // The synthetic deltas do not exist in R2: only the published snapshot can recover these labels.
  await box.wipe();
  assert.equal(await box.restoreFromBackup(...scope), 'restoring');
  for (let i = 0; i < 3 && (await lifecycle()).state === 'restoring'; i++) await box.run();
  assert.equal((await lifecycle()).state, 'ready');
  assert.deepEqual(JSON.parse(await box.labels()), [{ id: 'one-more', name: 'One more' }, { id: 'seed', name: 'Seed' }]);
});

test('adopting a manifest restarts an unswitched upload whose page was removed', workerdTest, async t => {
  const { box, journal, manifest, manifestKey, lifecycle } = await setup(t);
  await box.prepare({ snapshotDue: true });
  await box.setLabel(...scope, 'first', 'First');
  await box.setLabel(...scope, 'second', 'Second');
  const wanted = JSON.parse(await box.labels()) as unknown;
  await box.failNextSnapshotSwitch();
  await runScheduled(box);

  const staged = await lifecycle();
  assert.ok(staged.state === 'ready' && staged.upload?.done, 'an upload was staged but not switched');
  const oldKey = staged.upload.key;
  const lostPage = oldKey.replace(/head\.json$/, '1.json');
  assert.ok(await journal.head(lostPage), 'the old generation uploaded its first page');
  const published = await manifest();
  assert.equal(published.value.snapshot_key, null);
  assert.equal(published.value.last_seq, 2);

  // Model a rewind to the staged upload after a later same-incarnation manifest
  // was written and its cleanup removed the old page. Its journal tip is identical.
  await journal.put(manifestKey, JSON.stringify({ ...published.value, rev: published.value.rev + 1 }));
  const adopted = await manifest();
  assert.notEqual(adopted.etag, staged.etag);
  await journal.delete(lostPage);
  await runScheduled(box);

  const switched = (await manifest()).value;
  assert.ok(switched.snapshot_key, 'the upload switched after adoption');
  assert.equal(switched.rev, adopted.value.rev + 1);
  assert.notEqual(switched.snapshot_key, oldKey, 'adoption must restart under a new snapshot generation');
  assert.ok(await journal.head(switched.snapshot_key.replace(/head\.json$/, '1.json')));
  assert.equal(await journal.head(oldKey), null, 'cleanup retired the old generation');
  assert.equal(switched.delta_keys.length, 0, 'restore must use the new snapshot, not the old deltas');

  await box.wipe();
  assert.equal(await box.restoreFromBackup(...scope), 'restoring');
  await box.run();
  assert.equal((await lifecycle()).state, 'ready');
  assert.deepEqual(JSON.parse(await box.labels()), wanted);
});

test('advancing a restore resets consecutive failures and never alerts restore_blocked', workerdTest, async t => {
  const deliveries = Array.from({ length: 6 }, (_, i) => {
    const id = String(i + 1).padStart(26, '0');
    const bytes = new TextEncoder().encode(`From: sender@example.test\r\nSubject: delivery ${i + 1}\r\n\r\nBody ${i + 1}\r\n`);
    return { id, bytes, rawKey: `raw/${sha256(bytes)}/${id}`, doneAt: i + 1 };
  });
  let readable = 0;
  let checkpoint = Promise.withResolvers<void>();
  let release = Promise.withResolvers<void>();
  const { box, db, lifecycle, alerts } = await setup(t, async path => {
    const delivery = deliveries.find(row => path.endsWith(`/${row.rawKey}`));
    assert.ok(delivery, 'replay requested an unexpected raw object');
    if (delivery.doneAt > readable) {
      checkpoint.resolve();
      await release.promise;
      return new Response(null, { status: 503 });
    }
    return new Response(delivery.bytes, { headers: { 'content-length': String(delivery.bytes.byteLength) } });
  });
  await box.prepare();
  await db.batch(deliveries.map(({ id, rawKey, doneAt }) => db.prepare(`INSERT INTO deliveries
    (id, workspace_id, envelope_from, envelope_to, resolved_mailbox_ids, group_post_ids,
     raw_key, state, attempts, next_attempt_at, created_at, done_at)
    VALUES (?, ?, 'sender@example.test', 'mailbox@example.test', ?, '[]', ?, 'done', 0, 0, 0, ?)`)
    .bind(id, scope[0], JSON.stringify([scope[1]]), rawKey, doneAt)));
  await box.wipe();
  assert.equal(await box.restoreFromBackup(...scope), 'restoring');

  const progress: Array<{ after: number; advancedFailures: number; failedReadCount: number }> = [];
  for (readable = 1; readable < deliveries.length; readable++) {
    checkpoint = Promise.withResolvers<void>();
    release = Promise.withResolvers<void>();
    let advancedFailures = -1;
    await whilePaused(box.run(), checkpoint.promise, () => release.resolve(), async () => {
      const advancing = await lifecycle();
      assert.ok(advancing.state === 'restoring' && advancing.phase === 'deliveries');
      assert.equal(advancing.after, readable, 'the previous raw object was successfully replayed');
      advancedFailures = advancing.failures;
    });
    const life = await lifecycle();
    assert.ok(life.state === 'restoring' && life.phase === 'deliveries');
    progress.push({ after: life.after, advancedFailures, failedReadCount: life.failures });
  }
  const duringRestore = [...alerts];
  await box.run();
  assert.equal((await lifecycle()).state, 'ready');
  assert.deepEqual(Array.from(await box.deliveredIds()), deliveries.map(row => row.id));
  assert.deepEqual({ progress, alerts: duringRestore }, {
    progress: deliveries.slice(0, -1).map(({ doneAt }) => ({ after: doneAt, advancedFailures: 0, failedReadCount: 1 })),
    alerts: [],
  });
});

test('a failed cleanup scan after a snapshot switch wakes within a minute and retries', workerdTest, async t => {
  const { box, journal, manifest, manifestKey } = await setup(t);
  await box.prepare({ snapshotDue: true });
  const obsolete = `${manifestKey.slice(0, -'manifest.json'.length)}snapshots/00000000-0000-0000-0000-000000000001/head.json`;
  await journal.put(obsolete, '{}');
  await box.setLabel(...scope, 'snapshot-edit', 'Snapshot edit');
  await box.failNextCleanupList();
  await runScheduled(box);

  const switched = await manifest();
  assert.ok(switched.value.snapshot_key, 'publication completed despite the cleanup error');
  assert.equal(await box.failedCleanupLists(), 1);
  assert.ok(await journal.head(obsolete), 'the failed scan did not clean the obsolete object');
  const alarm = await box.alarmAt();
  const remaining = alarm === null ? null : Math.round((alarm - Date.now()) / 1000);
  await runScheduled(box);
  assert.deepEqual(await manifest(), switched, 'there was no second snapshot switch');
  assert.ok(await journal.head(switched.value.snapshot_key), 'cleanup preserved the live snapshot');
  assert.deepEqual({ rearmedWithinMinute: remaining !== null && remaining > 0 && remaining <= 61,
    obsoleteRemoved: await journal.head(obsolete) === null }, {
    rearmedWithinMinute: true, obsoleteRemoved: true,
  });
});
