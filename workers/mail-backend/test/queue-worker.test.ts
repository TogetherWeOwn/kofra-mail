import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response, type Request } from 'miniflare';
import { Outbox } from '../src/outbox.ts';
import { sha256 } from '../src/bytes.ts';
import { deltaRange, journalPrefix } from '../src/journal-backup.ts';
import type { MailboxManifest } from '../src/mailbox-recovery.ts';
import { migrateDirectory, seedDirectory } from './fixtures/directory-db.ts';
import type { QueueFixtureMailbox, QueueFixtureSweeper } from './fixtures/queue-worker.ts';

const raw = 'Message-ID: <integrated@example.test>\r\nFrom: sender@example.test\r\nSubject: Integration\r\n\r\nMail body\r\n';
type QueueReport = { id: string; queueId: string; attempts: number };

function completed<T>(promise: Promise<T>, event: string): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => {
    AbortSignal.timeout(5_000).addEventListener('abort', () => reject(new Error(`${event} did not complete`)), { once: true });
  })]);
}

test('workerd queues the ID and indexes accepted mail through the real mailbox and sweeper bindings', { timeout: 15_000 }, async t => {
  const compiled = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/queue-worker.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false });
  const delivery = Promise.withResolvers<string>();
  const alarm = Promise.withResolvers<void>();
  const swept = Promise.withResolvers<void>();
  const redelivered = Promise.withResolvers<QueueReport>();
  const completionFailure = Promise.withResolvers<QueueReport>();
  const permitRedelivery = Promise.withResolvers<void>();
  let simulateCompletionFailure = false;
  let redirect = false;
  const objects = new Map<string, ArrayBuffer>();
  const requests: string[] = [];
  const mf = new Miniflare({
    modules: [{ type: 'ESModule', path: 'queue-fixture.mjs', contents: compiled.outputFiles[0].text }], compatibilityDate: '2025-06-01',
    bindings: { MAIL_BACKEND_ENABLED: 'on', MAIL_SWEEP_ENABLED: 'on', DELIVERY_QUEUE_NAME: 'queue-fixture', DEAD_LETTER_QUEUE_NAME: 'dlq-fixture',
      KOFRA_S3_ENDPOINT: 'https://storage.example.test', KOFRA_S3_ACCESS_KEY_ID: 'fixture-access',
      KOFRA_S3_SECRET_ACCESS_KEY: 'fixture-signing' },
    d1Databases: ['DIRECTORY'], r2Buckets: ['MAIL_STATE'],
    durableObjects: { MAILBOX: { className: 'QueueFixtureMailbox', useSQLite: true }, SWEEPER: { className: 'QueueFixtureSweeper', useSQLite: true } },
    queueProducers: { DELIVER: 'queue-fixture' },
    queueConsumers: { 'queue-fixture': { maxBatchSize: 1, maxBatchTimeout: 0, deadLetterQueue: 'dlq-fixture' },
      'dlq-fixture': { maxBatchSize: 1 } },
    serviceBindings: { NOTIFY: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/alarm') {
        alarm.resolve();
      } else if (path === '/sweep') {
        swept.resolve();
      } else {
        const report = await request.json() as QueueReport;
        assert.ok(typeof report.id === 'string');
        if (path === '/before-queue' && simulateCompletionFailure) {
          if (report.attempts === 1) return new Response(null, { status: 202 });
          await permitRedelivery.promise;
        }
        if (path === '/after-queue') {
          if (!simulateCompletionFailure) delivery.resolve(report.id);
          else if (report.attempts === 1) completionFailure.resolve(report);
          else redelivered.resolve(report);
        }
      }
      return new Response(null, { status: 204 });
    } },
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.origin}`);
      if (url.origin !== 'https://storage.example.test' || !request.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 ')) {
        return new Response(null, { status: 403 });
      }
      if (request.method === 'PUT') {
        if (redirect) return new Response(null, { status: 307, headers: { location: 'https://redirect.example.test/' } });
        objects.set(url.pathname, await request.arrayBuffer());
        return new Response(null, { status: 200 });
      }
      if (request.method === 'DELETE') {
        assert.ok(objects.delete(url.pathname));
        return new Response(null, { status: 204 });
      }
      const body = objects.get(url.pathname);
      if (!body) return new Response(null, { status: 404 });
      return new Response(body, { headers: { 'content-length': body.byteLength.toString() } });
    },
  });
  try {
    const db = await mf.getD1Database('DIRECTORY') as unknown as D1Database;
    await migrateDirectory(db);
    await seedDirectory(db, 'workspace', ['reader']);
    const send = (body = raw) => mf.dispatchFetch('http://fixture.local/email', { method: 'POST', body,
      headers: { 'content-length': Buffer.byteLength(body).toString() } });
    const result = await send();
    assert.equal(result.status, 202, await result.text());
    const id = await completed(delivery.promise, 'Queue');
    const row = await new Outbox(db).get(id);
    assert.equal(row?.state, 'done');
    assert.equal(row.attempts, 0);
    assert.equal(row.lease, 1);
    assert.deepEqual(requests, ['PUT https://storage.example.test', 'GET https://storage.example.test']);
    const sweepBinding = await mf.getDurableObjectNamespace('SWEEPER') as unknown as {
      getByName(name: string): Pick<QueueFixtureSweeper, 'alarmTime' | 'seedExpired' | 'runArmedAlarmSoon'>;
    };
    const sweeper = sweepBinding.getByName('workspace');
    assert.ok(await sweeper.alarmTime());
    const stored = objects.get(`/mail-workspace/${row.rawKey}`);
    assert.ok(stored);
    assert.equal(new TextDecoder().decode(stored), raw);

    const mailboxNamespace = await mf.getDurableObjectNamespace('MAILBOX');
    const mailboxBinding = mailboxNamespace as unknown as {
      getByName(name: string): Pick<QueueFixtureMailbox, 'runArmedAlarmSoon' | 'alarmTime' | 'setFlags' | 'setLabel' | 'setSetting'>;
    };
    const mailboxId = row.mailboxIds[0];
    const name = JSON.stringify([row.workspaceId, mailboxId]);
    const mailbox = mailboxBinding.getByName(name);
    await t.test('a real alarm advances the baseline and flushes the delivery journal to R2', async () => {
      const state = await mf.getR2Bucket('MAIL_STATE');
      const prefix = journalPrefix(mailboxNamespace.idFromName(name).toString());
      const manifestKey = `${prefix}manifest.json`;
      const baseline = await (await state.get(manifestKey))?.json() as MailboxManifest | undefined;
      assert.ok(baseline);
      assert.equal(baseline.version, 2);
      assert.equal(baseline.snapshot_key, null);
      assert.equal(baseline.last_seq, 0);
      assert.deepEqual(baseline.delta_keys, []);
      await mailbox.runArmedAlarmSoon();
      await completed(alarm.promise, 'Journal alarm');
      const manifest = await (await state.get(manifestKey))?.json() as MailboxManifest | undefined;
      assert.ok(manifest);
      assert.equal(manifest.incarnation, baseline.incarnation);
      assert.equal(manifest.rev, baseline.rev + 1);
      assert.equal(manifest.last_seq, 1);
      assert.equal(manifest.delivery_cursor, 0);
      assert.deepEqual(manifest.delta_keys.map(key => deltaRange(prefix, key)),
        [{ incarnation: manifest.incarnation, from: 1, last: 1 }]);
      const flushed = await state.get(manifest.delta_keys[0]);
      assert.ok(flushed);
      assert.match(await flushed.text(), new RegExp(row.id));
    });

    await t.test('settings shorten the hourly flags deadline without moving the first settings deadline', async () => {
      const beginning = Date.now();
      await mailbox.setFlags(row.workspaceId, mailboxId, row.id, 1, []);
      const flagDeadline = await mailbox.alarmTime();
      // Allow 15 seconds for the alarm to publish before the one-hour deadline.
      const flagsDelay = (60 * 60 - 15) * 1000;
      assert.ok(flagDeadline && flagDeadline >= beginning + flagsDelay && flagDeadline <= Date.now() + flagsDelay);
      const settingsStart = Date.now();
      await mailbox.setLabel(row.workspaceId, mailboxId, 'triage', 'Triage');
      const settingsDeadline = await mailbox.alarmTime();
      const settingsDelay = (60 - 15) * 1000;
      assert.ok(settingsDeadline && settingsDeadline >= settingsStart + settingsDelay && settingsDeadline <= Date.now() + settingsDelay);
      // Make a reset observable even on a fast clock: the second RPC must be later.
      await setTimeout(10);
      assert.ok(Date.now() + settingsDelay > settingsDeadline);
      await mailbox.setSetting(row.workspaceId, mailboxId, 'send-as', 'identity', '{"enabled":true}');
      assert.equal(await mailbox.alarmTime(), settingsDeadline);
      await mailbox.setFlags(row.workspaceId, mailboxId, row.id, 2, []);
      assert.equal(await mailbox.alarmTime(), settingsDeadline);
    });

    await t.test('a real sweeper alarm deletes only the expired generation in its workspace bucket', async () => {
      const bytes = new Uint8Array(new TextEncoder().encode('expired fixture'));
      const stale = await sweeper.seedExpired(await sha256(bytes));
      const own = `/mail-workspace/${stale}`;
      const unrelated = `/mail-other/${stale}`;
      objects.set(own, bytes.buffer);
      objects.set(unrelated, bytes.buffer);
      requests.length = 0;
      await sweeper.runArmedAlarmSoon();
      await completed(swept.promise, 'Sweeper alarm');
      assert.deepEqual(requests, ['DELETE https://storage.example.test']);
      assert.equal(objects.has(own), false);
      assert.equal(objects.has(unrelated), true);
      assert.equal(objects.has(`/mail-workspace/${row.rawKey}`), true);
    });

    await t.test('the real queue redelivers the same message ID after a D1 completion failure', async () => {
      simulateCompletionFailure = true;
      const store = new Outbox(db);
      let first: QueueReport;
      try {
        const accepted = await send(raw.replace('integrated@', 'retried@'));
        assert.equal(accepted.status, 202, await accepted.text());
        first = await completed(completionFailure.promise, 'Injected D1 completion failure');
        const pending = await store.get(first.id);
        assert.equal(pending?.state, 'pending');
        assert.equal(pending.attempts, 7);
        assert.equal(pending.lease, 1);
      } finally {
        permitRedelivery.resolve();
      }
      const second = await completed(redelivered.promise, 'Queue redelivery');
      assert.deepEqual(second, { ...first, attempts: first.attempts + 1 });
      const done = await store.get(first.id);
      assert.equal(done?.state, 'done');
      assert.equal(done.attempts, 7);
      assert.equal(done.lease, 1);
      simulateCompletionFailure = false;
    });

    await t.test('workerd rejects an S3 redirect without contacting the destination', async () => {
      redirect = true;
      requests.length = 0;
      const failure = await send();
      assert.equal(failure.status, 500);
      assert.match(await failure.text(), /Kofra object PUT failed \(307\)/);
      assert.deepEqual(requests, ['PUT https://storage.example.test']);
      assert.deepEqual(await new Outbox(db).due(Date.now()), []);
    });
  } finally {
    await mf.dispose();
  }
});
