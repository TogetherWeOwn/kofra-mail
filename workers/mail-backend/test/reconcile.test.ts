import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { deliver, type AlertEvent, type MailboxOutcome } from '../src/deliver.ts';
import { MailAlerts } from '../src/mail-alerts.ts';
import { dailySendAlertKey } from '../src/send-alert-events.ts';
import { LEASE_MS, Outbox, RECONCILE_PAGE } from '../src/outbox.ts';
import { reconcile, RETENTION_MS } from '../src/reconcile.ts';
import { handleScheduled, type Env } from '../src/worker.ts';
import { migrateDirectory, seedDirectory } from './fixtures/directory-db.ts';

const mf = new Miniflare({ modules: true, script: 'export default {};', d1Databases: ['OUTBOX'] });
let db: D1Database;
let outbox: Outbox;
const id = (n: number) => `01KBN8ZJ7G${n.toString().padStart(16, '0')}`;
before(async () => {
  db = await mf.getD1Database('OUTBOX') as unknown as D1Database;
  await migrateDirectory(db);
  await seedDirectory(db, 'workspace', ['mailbox']);
  outbox = new Outbox(db);
});
beforeEach(async () => { await db.batch([db.prepare('DELETE FROM deliveries'), db.prepare('DELETE FROM mail_alerts')]); });
after(() => mf.dispose());

async function insert(n: number, createdAt = 100) {
  await outbox.insert({ id: id(n), workspaceId: 'workspace', envelopeFrom: 'sender@example.test', envelopeTo: 'box@example.test',
    mailboxId: 'mailbox', rawKey: `raw/${'a'.repeat(64)}`, authResults: null, createdAt });
}

function ports(now: number) {
  const alerts: AlertEvent[] = [];
  const queued: string[] = [];
  return { alerts, queued, outbox, now: () => now,
    send: async (deliveryId: string) => { queued.push(deliveryId); },
    alert: async (event: AlertEvent) => { alerts.push(event); },
    index: async (): Promise<MailboxOutcome> => 'indexed', release: async () => {},
  };
}

test('cron reads an indexed page bounded even when every row is due', async () => {
  for (let n = 0; n <= RECONCILE_PAGE; n++) await insert(n);
  const plans: string[] = [];
  const tracing = new Outbox({
    ...db,
    withSession: () => ({ prepare: (query: string) => { plans.push(query); return db.prepare(query); } }),
  } as unknown as D1Database);
  const due = await tracing.due(100);
  assert.equal(due.length, RECONCILE_PAGE);
  const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${plans[0]}`).bind(100, RECONCILE_PAGE).all<{ detail: string }>();
  assert.ok(results.some(row => /SEARCH .*deliveries_due/.test(row.detail)), JSON.stringify(results));
  assert.ok(!results.some(row => /SCAN|TEMP B-TREE/.test(row.detail)), JSON.stringify(results));
  const p = ports(100);
  await reconcile(p);
  assert.equal(p.queued.length, RECONCILE_PAGE);
  assert.equal((await outbox.get(id(RECONCILE_PAGE)))?.attempts, 0);
});

test('mailbox cursor and replay range use the workspace and mailbox index', async () => {
  const queries: string[] = [];
  const tracing = new Outbox({ withSession: () => ({ prepare: (query: string) => {
    queries.push(query);
    return db.prepare(query);
  } }) } as unknown as D1Database);
  await tracing.deliveryCursor('workspace', 'mailbox');
  await tracing.replayPage('workspace', 'mailbox', 0);
  for (const [i, query] of queries.entries()) {
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${query}`)
      .bind(...['workspace', 'mailbox', ...(i ? [0] : [])]).all<{ detail: string }>();
    const indexed = results.find(row => /SEARCH .*deliveries_mailbox_done/.test(row.detail));
    assert.ok(indexed, JSON.stringify(results));
    if (i === 1) assert.match(indexed.detail, /done_at\s*>\s*\?/);
    assert.ok(!results.some(row => /SCAN|TEMP B-TREE/.test(row.detail)), JSON.stringify(results));
  }
});

test('missing initial queue send is recovered; duplicate queue copies do not spend attempts', async () => {
  await insert(1);
  const p = ports(100);
  await reconcile(p);
  assert.deepEqual(p.queued, [id(1)]);
  const ack = Promise.withResolvers<void>();
  const indexing = Promise.withResolvers<void>();
  let calls = 0;
  let releases = 0;
  p.index = async () => { calls++; indexing.resolve(); await ack.promise; return 'indexed'; };
  p.release = async () => { assert.equal((await outbox.get(id(1)))?.state, 'done'); releases++; };
  const running = deliver(id(1), p, 'first');
  try {
    await Promise.race([indexing.promise, running]);
    const claimed = await outbox.get(id(1));
    assert.equal(claimed?.state, 'pending');
    assert.equal(claimed.attempts, 0);
    assert.equal(claimed.lease, 1);
    await deliver(id(1), p, 'distinct-queue-copy');
    assert.equal(calls, 1);
    assert.deepEqual(await outbox.get(id(1)), claimed);
  } finally {
    ack.resolve();
    await running;
  }
  assert.equal(releases, 1);
});

test('a stale lease cannot complete after a newer reservation, even for the same owner', async () => {
  await insert(2);
  const first = await outbox.claim(id(2), 100, 'owner');
  assert.equal(first?.lease, 1);
  assert.equal(first.attempts, 0);
  const p = ports(first.nextAttemptAt);
  await reconcile(p);
  assert.deepEqual(p.queued, [id(2)]);
  const current = await outbox.claim(id(2), first.nextAttemptAt, 'owner');
  assert.equal(current?.lease, 2);
  assert.equal(current.attempts, 0);
  assert.equal(await outbox.complete(id(2), first.lease, first.nextAttemptAt, 'owner'), false);
  assert.equal(await outbox.complete(id(2), current.lease, first.nextAttemptAt, 'distinct-owner'), false);
  assert.equal(await outbox.complete(id(2), current.lease, first.nextAttemptAt, 'owner'), true);
});

test('the eighth rejected message is terminal and alerted; failed raw holders are retained', async () => {
  await insert(3);
  let now = 100;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const p = ports(now);
    p.index = async () => 'rejected';
    p.release = async () => { assert.fail('failed delivery released'); };
    await deliver(id(3), p, 'poison');
    const row = await outbox.get(id(3));
    assert.equal(row?.attempts, attempt);
    assert.equal(row.retries, 0);
    if (attempt < 8) {
      assert.equal(row.state, 'pending');
      assert.equal(row.nextAttemptAt - now, Math.min(30, 2 ** (attempt - 1)) * 60_000);
      now = row.nextAttemptAt;
    }
  }
  assert.equal((await outbox.get(id(3)))?.state, 'failed');
  // The eighth rejection records its alert obligation in the same batch as the transition.
  assert.deepEqual((await db.prepare("SELECT key, source, sent_at AS sentAt FROM mail_alerts").all()).results,
    [{ key: `delivery_failed:${id(3)}`, source: 'mail:delivery_failed', sentAt: null }]);
  assert.deepEqual(await outbox.alertDue(), []);
  const p = ports(now);
  await reconcile(p);
  assert.deepEqual(p.queued, []);
});

test('the eighth rejection rolls back if its alert obligation cannot be written, and the delivery retries', async () => {
  await insert(10);
  await db.prepare('UPDATE deliveries SET attempts = 7 WHERE id = ?').bind(id(10)).run();
  const claim = await outbox.claim(id(10), 100, 'final-attempt');
  assert.ok(claim);
  await db.prepare("CREATE TRIGGER fixture_refuse_alert BEFORE INSERT ON mail_alerts BEGIN SELECT RAISE(ABORT, 'fixture refused alert'); END").run();
  try {
    await assert.rejects(outbox.reject(id(10), claim.lease, 'final-attempt', 100), /fixture refused alert/);
  } finally {
    await db.prepare('DROP TRIGGER fixture_refuse_alert').run();
  }
  const kept = await outbox.get(id(10));
  assert.deepEqual([kept?.state, kept?.attempts], ['pending', 7], 'the transition must roll back with the alert write');
  assert.deepEqual((await db.prepare('SELECT key FROM mail_alerts').all()).results, []);
  // The queue retries the same message; the claim resumes and the rejection now commits with its obligation.
  await outbox.reject(id(10), claim.lease, 'final-attempt', 100);
  assert.deepEqual([(await outbox.get(id(10)))?.state, (await outbox.get(id(10)))?.attempts], ['failed', 8]);
  assert.deepEqual((await db.prepare('SELECT key FROM mail_alerts').all()).results, [{ key: `delivery_failed:${id(10)}` }]);
});

test('a cron holding an older re-drive generation cannot stamp a later failure as alerted', async () => {
  await insert(9);
  await db.prepare("UPDATE deliveries SET state = 'failed', redrives = 1, alerted_at = NULL WHERE id = ?").bind(id(9)).run();
  await outbox.alerted(id(9), 0, 500);
  assert.equal((await db.prepare('SELECT alerted_at AS alertedAt FROM deliveries WHERE id = ?').bind(id(9)).first())?.alertedAt, null);
  await outbox.alerted(id(9), 1, 500);
  assert.equal((await db.prepare('SELECT alerted_at AS alertedAt FROM deliveries WHERE id = ?').bind(id(9)).first())?.alertedAt, 500);
});

test('an enabled send path rejects an unconfigured alert environment', async () => {
  const env = { MAIL_BACKEND_ENABLED: 'on', MAIL_SEND_ENABLED: 'on', DIRECTORY: db,
    DELIVERY_QUEUE_NAME: 'deliver', DEAD_LETTER_QUEUE_NAME: 'dlq' } as Env;
  await assert.rejects(handleScheduled({} as ScheduledController, env), /Invalid mail alert environment/);
});

test('a second cron cannot take a daily send alert during the first reservation', async () => {
  const now = Date.now();
  const outbox = new MailAlerts(db);
  await outbox.recordSend('test', 'send_outage', now);
  const key = dailySendAlertKey('test', 'send_outage', now);
  assert.equal(await outbox.reserveSend(key, now), true);
  assert.equal(await outbox.reserveSend(key, now), false);
  assert.equal(await outbox.reserveSend(key, now + 59_999), false);
  assert.equal(await outbox.reserveSend(key, now + 60_000), true);
});

test('a malformed daily send alert cannot pin the bounded outbox page', async () => {
  const now = Date.now();
  const seen: string[] = [];
  for (let i = 0; i < 12; i++) await db.prepare(`INSERT INTO mail_alerts (key, source, created_at)
    VALUES (?, 'mail:unknown', ?)`).bind(`send-event:invalid:${i}`, now - 1).run();
  await db.prepare("INSERT INTO mail_alerts (key, source, created_at) VALUES (?, 'mail:delivery_dlq', ?)")
    .bind(`delivery_dlq:${id(8)}`, now).run();
  const env = {
    MAIL_BACKEND_ENABLED: 'on', DIRECTORY: db, DELIVERY_QUEUE_NAME: 'deliver', DEAD_LETTER_QUEUE_NAME: 'dlq',
    ALERTS: { fetch: async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)).source);
      return new Response(null, { status: 204 });
    } },
  } as Env;
  await handleScheduled({} as ScheduledController, env);
  await handleScheduled({} as ScheduledController, env);
  assert.deepEqual(seen, ['mail:delivery_dlq']);
});

test('a late cron leases deliveries at run time rather than its stale scheduled time', async () => {
  await insert(8);
  const now = Date.now();
  await db.prepare('UPDATE deliveries SET next_attempt_at = ? WHERE id = ?').bind(now - 60_000, id(8)).run();
  const queued: string[] = [];
  const env = {
    MAIL_BACKEND_ENABLED: 'on', DIRECTORY: db, DELIVERY_QUEUE_NAME: 'deliver', DEAD_LETTER_QUEUE_NAME: 'dlq',
    DELIVER: { send: async (id: string) => { queued.push(id); } },
  } as unknown as Env;
  await handleScheduled({ scheduledTime: now - 3_600_000 } as ScheduledController, env);
  assert.deepEqual(queued, [id(8)]);
  assert.ok((await outbox.get(id(8)))!.nextAttemptAt > now);
});

test('scheduled terminal alerts persist until the bound service accepts the POST', async () => {
  await insert(8);
  await db.prepare("UPDATE deliveries SET state = 'failed' WHERE id = ?").bind(id(8)).run();
  const seen: unknown[] = [];
  const env = {
    MAIL_BACKEND_ENABLED: 'on', DIRECTORY: db, DELIVERY_QUEUE_NAME: 'deliver', DEAD_LETTER_QUEUE_NAME: 'dlq',
    ALERTS: { fetch: async (url: string, init: RequestInit) => {
      seen.push([new URL(url).pathname, init.method, JSON.parse(String(init.body))]);
      return new Response(null, { status: seen.length === 1 ? 503 : 202 });
    } },
  } as Env;
  const unsent = () => db.prepare("SELECT key FROM mail_alerts WHERE sent_at IS NULL AND key LIKE 'delivery_failed:%'").all();
  await handleScheduled({} as ScheduledController, env);
  // The obligation moved into the persisted alert queue; the refused POST left it unsent.
  assert.deepEqual(await outbox.alertDue(), []);
  assert.deepEqual((await unsent()).results, [{ key: `delivery_failed:${id(8)}` }]);
  await handleScheduled({} as ScheduledController, env);
  assert.deepEqual((await unsent()).results, []);
  await handleScheduled({} as ScheduledController, env);
  assert.deepEqual(seen, Array.from({ length: 2 }, () => ['/v1/alert', 'POST', {
    source: 'mail:delivery_failed', key: id(8), title: 'Mail delivery exhausted its retries',
  }]));
});

test('a broken queue moves the due row off the head with capped backoff and never fails it', async () => {
  await insert(4);
  let now = 100;
  for (let retry = 1; retry <= 10; retry++) {
    const p = ports(now);
    p.send = async deliveryId => { p.queued.push(deliveryId); throw new Error('queue unavailable'); };
    assert.deepEqual(await outbox.due(now), [{ id: id(4), lease: retry - 1, retries: retry - 1, redrives: 0 }]);
    await reconcile(p);
    assert.deepEqual(p.queued, [id(4)]);
    assert.deepEqual(await outbox.due(now), []);
    const row = await outbox.get(id(4));
    assert.equal(row?.state, 'pending');
    assert.equal(row.attempts, 0);
    assert.equal(row.lease, retry);
    assert.equal(row.retries, retry);
    assert.equal(row.nextAttemptAt - now, Math.min(30, 2 ** (retry - 1)) * 60_000);
    assert.deepEqual(p.alerts, []);
    now = row.nextAttemptAt;
  }
});

test('claiming the final reservation late leaves a full processing window', async () => {
  await insert(6);
  await db.prepare('UPDATE deliveries SET attempts = 7 WHERE id = ?').bind(id(6)).run();
  await reconcile(ports(100));
  const reserved = await outbox.get(id(6));
  assert.equal(reserved?.attempts, 7);
  const claimAt = reserved.nextAttemptAt - 1;
  const claim = await outbox.claim(id(6), claimAt, 'last-queue-copy');
  assert.equal(claim?.attempts, 7);
  assert.equal(claim.lease, reserved.lease);
  assert.equal(claim.nextAttemptAt, claimAt + LEASE_MS);
  const early = ports(claim.nextAttemptAt - 1);
  await reconcile(early);
  assert.deepEqual(early.queued, []);
  assert.equal(await outbox.claim(id(6), early.now(), 'distinct-copy'), null);
  assert.equal(await outbox.complete(id(6), claim.lease, early.now(), 'last-queue-copy'), true);
});

test('the same queue message can resume an active lease after a D1 completion failure', async () => {
  await insert(7);
  await db.prepare('UPDATE deliveries SET attempts = 7 WHERE id = ?').bind(id(7)).run();
  const p = ports(100);
  let calls = 0;
  p.index = async () => { calls++; return 'indexed'; };
  let fail = true;
  const transient = {
    ...p,
    outbox: {
      claim: outbox.claim.bind(outbox), get: outbox.get.bind(outbox),
      defer: outbox.defer.bind(outbox), reject: outbox.reject.bind(outbox),
      complete: async (...args: Parameters<Outbox['complete']>) => {
        if (fail) { fail = false; throw new Error('D1 completion unavailable'); }
        return outbox.complete(...args);
      },
    },
  };
  await assert.rejects(deliver(id(7), transient, 'original-queue-id'), /D1 completion unavailable/);
  const pending = await outbox.get(id(7));
  assert.equal(pending?.state, 'pending');
  await deliver(id(7), transient, 'independent-queue-id');
  assert.equal(calls, 1);
  assert.deepEqual(await outbox.get(id(7)), pending);
  await deliver(id(7), transient, 'original-queue-id');
  const done = await outbox.get(id(7));
  assert.equal(calls, 2);
  assert.equal(done?.state, 'done');
  assert.equal(done.attempts, 7);
  assert.equal(done.lease, pending.lease);
  assert.equal(done.nextAttemptAt, pending.nextAttemptAt);
});

test('completed rows are pruned only past retention and at or below a confirmed backup cursor, never by cron', async () => {
  await insert(5);
  await deliver(id(5), ports(200), 'complete');
  const doneAt = (await outbox.get(id(5)))!.doneAt!;
  // The cron no longer prunes deliveries at all.
  await reconcile(ports(doneAt + RETENTION_MS));
  assert.equal((await outbox.get(id(5)))?.state, 'done');
  // Covered but not past retention: kept.
  assert.equal(await outbox.pruneCovered('workspace', 'mailbox', doneAt - 1, doneAt), 0);
  // Past retention but not covered by the confirmed cursor: kept.
  assert.equal(await outbox.pruneCovered('workspace', 'mailbox', doneAt, doneAt - 1), 0);
  assert.equal((await outbox.get(id(5)))?.state, 'done');
  assert.equal(await outbox.pruneCovered('workspace', 'mailbox', doneAt, doneAt), 1);
  assert.equal(await outbox.get(id(5)), null);
});
