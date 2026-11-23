import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Miniflare } from 'miniflare';
import { RETENTION_MS } from '../src/reconcile.ts';
import { migrateDirectory } from './fixtures/directory-db.ts';
import { handleQueue, handleScheduled, type Env } from '../src/worker.ts';

const deliveryId = '01KBN8ZJ7G0000000000000000';
const queueName = 'dlq-fixture';
const expected = (key: string) => ['POST', '/v1/alert', {
  source: 'mail:delivery_dlq', key, title: 'Mail delivery dead-lettered',
}];

async function setup(t: TestContext) {
  const runtime = new Miniflare({ modules: true, script: 'export default {};', d1Databases: ['DIRECTORY'] });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('DIRECTORY') as unknown as D1Database;
  await migrateDirectory(db);
  const calls: unknown[] = [];
  const receiver = { status: 503, refused: new Set<string>() };
  const env = {
    MAIL_BACKEND_ENABLED: 'on', DIRECTORY: db, DELIVERY_QUEUE_NAME: 'deliver-fixture', DEAD_LETTER_QUEUE_NAME: queueName,
    ALERTS: { fetch: async (url: string, init: RequestInit) => {
      const event = JSON.parse(String(init.body));
      calls.push([init.method, new URL(url).pathname, event]);
      return new Response(null, { status: receiver.refused.has(event.key) ? 503 : receiver.status });
    } },
  } as Env;
  async function enqueue(body: unknown, id = 'queue-id') {
    const outcomes = { ack: 0, retry: 0 };
    const message = { id, body, ack: () => outcomes.ack++, retry: () => outcomes.retry++ };
    await handleQueue({ queue: queueName, messages: [message] } as unknown as MessageBatch<unknown>, env);
    return outcomes;
  }
  const cron = () => handleScheduled({} as ScheduledController, env);
  const row = (key: string) => db.prepare('SELECT source, created_at, sent_at FROM mail_alerts WHERE key = ?')
    .bind(key).first<{ source: string; created_at: number; sent_at: number | null }>();
  return { db, env, enqueue, cron, calls, receiver, row };
}

test('DLQ alerts recover after more failed receiver calls than queue retries', async t => {
  const { db, enqueue, cron, calls, receiver, row } = await setup(t);
  assert.deepEqual(await enqueue(deliveryId), { ack: 1, retry: 0 });
  assert.deepEqual(calls, [], 'the queue does not send to the receiver');
  const key = `delivery_dlq:${deliveryId}`;
  const inserted = await row(key);
  assert.ok(inserted);
  assert.equal(inserted.source, 'mail:delivery_dlq');
  assert.equal(inserted.sent_at, null);
  assert.deepEqual(await enqueue(deliveryId, 'duplicate-message-id'), { ack: 1, retry: 0 });
  for (let i = 0; i < 12; i++) await cron();
  assert.deepEqual(calls, Array.from({ length: 12 }, () => expected(deliveryId)));
  const deferred = await row(key);
  // A refused alert stays unsent and moves behind newer ones.
  assert.ok(deferred && deferred.sent_at === null && deferred.created_at >= inserted.created_at);
  assert.deepEqual({ ...deferred, created_at: inserted.created_at }, inserted);
  receiver.status = 202;
  await cron();
  const sent = await row(key);
  assert.ok(sent && sent.sent_at !== null && sent.sent_at >= inserted.created_at);
  await cron();
  assert.equal(calls.length, 13);
  assert.deepEqual(calls[12], expected(deliveryId));
  assert.deepEqual(await row(key), sent);
  await db.prepare('UPDATE mail_alerts SET sent_at = ? WHERE key = ?').bind(Date.now() - RETENTION_MS - 1000, key).run();
  await cron();
  assert.equal(await row(key), null);
  assert.equal(calls.length, 13);
});

test('twelve refused DLQ alerts do not starve a newer alert', async t => {
  const { db, enqueue, cron, calls, receiver, row } = await setup(t);
  const ids = Array.from({ length: 13 }, (_, n) => `01KBN8ZJ7G${String(n).padStart(16, '0')}`);
  const refused = ids.slice(0, 12);
  const newer = ids[12];
  receiver.status = 202;
  for (const [offset, id] of ids.entries()) {
    assert.deepEqual(await enqueue(id), { ack: 1, retry: 0 });
    // Separate the original timestamps regardless of queue and cron clock granularity.
    await db.prepare('UPDATE mail_alerts SET created_at = ? WHERE key = ?').bind(100 + offset, `delivery_dlq:${id}`).run();
  }
  for (const id of refused) receiver.refused.add(id);

  await cron();
  assert.deepEqual(calls, refused.map(expected));
  await cron();
  assert.equal((await row(`delivery_dlq:${newer}`))?.sent_at != null, true, 'the 13th alert is sent by the second cron');
  assert.deepEqual(calls[12], expected(newer));
  for (const id of refused) assert.equal((await row(`delivery_dlq:${id}`))?.sent_at, null);
});

test('malformed DLQ bodies are deduped by queue id and alerted without their body or id', async t => {
  const { enqueue, cron, calls, receiver, row } = await setup(t);
  const key = 'delivery_dlq:invalid:msg-1';
  assert.deepEqual(await enqueue({ malformed: 'not an id' }, 'msg-1'), { ack: 1, retry: 0 });
  assert.equal((await row(key))?.sent_at, null);
  assert.deepEqual(await enqueue(['other invalid body'], 'msg-1'), { ack: 1, retry: 0 });
  receiver.status = 202;
  await cron();
  assert.deepEqual(calls, [expected('invalid-delivery')]);
  assert.ok((await row(key))?.sent_at);
});

test('a failed DLQ insert retries the queue message without posting', async t => {
  const { db, enqueue, calls } = await setup(t);
  await db.prepare('DROP TABLE mail_alerts').run();
  assert.deepEqual(await enqueue(deliveryId), { ack: 0, retry: 1 });
  assert.deepEqual(calls, []);
});

test('the cron unsent read uses the partial index with no full scan and is bounded oldest first', async t => {
  const { db, env, cron, calls, receiver } = await setup(t);
  const queries: Array<{ text: string; args: unknown[] }> = [];
  const trace = (text: string) => {
    const statement = db.prepare(text);
    if (!/^\s*SELECT\b/i.test(text) || !text.includes('FROM mail_alerts')) return statement;
    return { bind: (...args: unknown[]) => {
      queries.push({ text, args });
      return statement.bind(...args);
    } };
  };
  env.DIRECTORY = { prepare: trace, withSession: () => ({ prepare: trace }) } as unknown as D1Database;
  const ids = Array.from({ length: 40 }, (_, n) => `01KBN8ZJ7G${String(n).padStart(16, '0')}`);
  for (const [n, id] of [...ids.entries()].reverse()) {
    await db.prepare('INSERT INTO mail_alerts VALUES (?, ?, ?, NULL)').bind(`delivery_dlq:${id}`, 'mail:delivery_dlq', 100 + n).run();
  }
  receiver.status = 202;
  await cron();
  assert.equal(queries.length, 1);
  const { text, args } = queries[0];
  const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${text}`).bind(...args).all<{ detail: string }>();
  assert.ok(results.some(row => /SEARCH .*mail_alerts_unsent/.test(row.detail)), JSON.stringify(results));
  assert.ok(!results.some(row => /SCAN|TEMP B-TREE/.test(row.detail)), JSON.stringify(results));
  assert.ok(calls.length > 0 && calls.length < ids.length);
  assert.deepEqual(calls, ids.slice(0, calls.length).map(expected));
});
