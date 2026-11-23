import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response, type Request } from 'miniflare';
import type { AlarmPlumbing } from './fixtures/mailbox-alarm-plumbing.ts';
import { mailboxName } from '../src/worker.ts';

async function setup(t: TestContext) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/mailbox-alarm-plumbing.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false });
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const receiver = { status: 503 };
  const runtime = new Miniflare({ modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle.outputFiles[0].text }],
    compatibilityDate: '2025-06-01', durableObjects: {
      MAILBOX: { className: 'AlarmPlumbing', useSQLite: true }, SWEEPER: { className: 'UnusedSweeper', useSQLite: true },
    },
    bindings: { MAIL_BACKEND_ENABLED: 'on', MAIL_RECOVERY_ENABLED: 'off', KOFRA_S3_ENDPOINT: 'https://s3.invalid',
      KOFRA_S3_ACCESS_KEY_ID: 'fixture', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture' },
    r2Buckets: ['MAIL_STATE'], d1Databases: ['DIRECTORY'],
    serviceBindings: { ALERTS: async (request: Request) => {
      calls.push({ method: request.method, path: new URL(request.url).pathname, body: await request.json() });
      return new Response(null, { status: receiver.status });
    } },
  });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('DIRECTORY');
  for (const file of ['0001_directory.sql', '0002_outbox.sql', '0004_mailbox_replay.sql']) {
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    await db.batch(sql.replace(/^\s*--.*$/gm, '').split(/;\s*\n(?=\s*(?:CREATE |ALTER |$))/).filter(s => s.trim()).map(s => db.prepare(s)));
  }
  const boxes = await runtime.getDurableObjectNamespace('MAILBOX') as unknown as { getByName(name: string): AlarmPlumbing };
  return { box: boxes.getByName(mailboxName('workspace', 'mailbox')), calls, receiver };
}

test('stale snapshot alerts survive a failed POST, respect the cooldown and clear after publication', async t => {
  const { box, calls, receiver } = await setup(t);
  const key = await box.setup('ready');
  assert.ok(await box.run(true), 'snapshot upload failed');
  assert.deepEqual(calls.map(call => call.body), [{ source: 'mail:backup_stale', key, title: 'Mailbox backup is stale' }]);
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [['POST', '/v1/alert']]);
  const read = async () => JSON.parse(await box.obligations()) as Array<{ code: string; since: number; sent_at: number | null }>;
  const [pending] = await read();
  assert.equal(pending.code, 'backup_stale');
  assert.equal(pending.sent_at, null);
  assert.notEqual(await box.alarmAt(), null);
  receiver.status = 202;
  await box.run(true);
  const [delivered] = await read();
  assert.equal(delivered.since, pending.since);
  assert.ok(delivered.sent_at !== null && delivered.sent_at >= pending.since);
  await box.run(true);
  assert.equal(calls.length, 2);
  await box.run();
  assert.deepEqual(await read(), []);
  assert.equal(calls.length, 2);
});

for (const mode of ['missing', 'restoring'] as const) {
  test(`alerts for a ${mode} mailbox when recovery is disabled`, async t => {
    const { box, calls, receiver } = await setup(t);
    receiver.status = 202;
    const key = await box.setup(mode);
    await box.run();
    assert.deepEqual(calls.map(call => call.body), [{ source: 'mail:restore_blocked', key, title: 'Mailbox restore is blocked' }]);
    assert.notEqual(await box.alarmAt(), null);
  });
}
