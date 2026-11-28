import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse, type Request as LocalRequest } from 'miniflare';
import type { FixtureSendQuota } from './fixtures/send-quota-worker.ts';

const at = (s: string) => Date.parse(s);
const NOW = at('2026-11-30T14:59:00Z');
const TODAY = at('2026-11-30T15:00:00Z');
const DEC = at('2026-12-01T15:00:00Z');
const scope = (name: string, mailboxId = 'mb') => ({ workspaceId: 'ws', mailboxId,
  sendId: `01${createHash('sha256').update(name).digest('hex').slice(0, 24).toUpperCase()}` });
const fence = (attempt = 1, epoch = 0) => ({ epoch, attempt });
const gateAlert = (environment = 'test') => ({ source: 'mail:send_quota_gate_hit', key: `send_quota_gate:${environment}:2026-11-29`,
  title: 'A mail account quota gate was reached', environment, time: NOW });
type ObjectMethods = Pick<InstanceType<typeof FixtureSendQuota>, 'reserve' | 'confirm' | 'release' | 'resetAt' | 'setTime' | 'balances' |
  'retained' | 'runAlarm' | 'alarmDue'>;
const stub = (mf: Miniflare) => {
  const call = <K extends keyof ObjectMethods>(method: K) => async (...args: Parameters<ObjectMethods[K]>): Promise<Awaited<ReturnType<ObjectMethods[K]>>> => {
    const response = await mf.dispatchFetch('http://quota.test', { method: 'POST', body: JSON.stringify({ method, args }) });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<Awaited<ReturnType<ObjectMethods[K]>>>;
  };
  return { reserve: call('reserve'), confirm: call('confirm'), release: call('release'), resetAt: call('resetAt'),
    setTime: call('setTime'), balances: call('balances'), retained: call('retained'), runAlarm: call('runAlarm'), alarmDue: call('alarmDue') };
};
const entry = fileURLToPath(new NodeURL('./fixtures/send-quota-worker.ts', import.meta.url));
let bundle: ReturnType<typeof build> | undefined;

type AlertHandler = (body: unknown, idempotencyKey: string | null) => number | Promise<number>;
async function withQuota(run: (quota: ReturnType<typeof stub>, restart: (alert?: AlertHandler) => Promise<ReturnType<typeof stub>>, logs: string[]) => Promise<void>,
  { daily = '10', monthly = '100', now = NOW, persist = false, reset = '15:00', alert, autoAlarm = false, environment = 'test' }: {
    daily?: string; monthly?: string; now?: number; persist?: boolean; reset?: string; alert?: AlertHandler; autoAlarm?: boolean; environment?: string;
  } = {}) {
  const { outputFiles } = await (bundle ??= build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'] }));
  const directory = persist ? await mkdtemp('/var/tmp/velmora-riaklo-m3-6-quota-') : undefined;
  const logs: string[] = [];
  const start = (handler?: AlertHandler) => new Miniflare({
    handleStructuredLogs: ({ message }: { message: string }) => { logs.push(message); },
    modules: [{ type: 'ESModule', path: 'quota.mjs', contents: outputFiles![0].text }], compatibilityDate: '2026-06-25',
    durableObjects: { SEND_QUOTA: { className: 'FixtureSendQuota', useSQLite: true } },
    durableObjectsPersist: directory && join(directory, 'do'),
    bindings: { INITIAL_TIME: now, MAIL_SEND_DAILY_QUOTA: daily, MAIL_SEND_MONTHLY_CEILING: monthly, MAIL_SEND_DAILY_RESET_UTC: reset,
      AUTO_ALERT_ALARM: autoAlarm, MAIL_ENVIRONMENT: environment },
    ...(handler && { serviceBindings: { ALERTS: async (req: LocalRequest) =>
      new LocalResponse(null, { status: await handler(await req.json(), req.headers.get('idempotency-key')) }) } }),
  });
  let runtime = start(alert);
  try {
    await run(stub(runtime), async (restoredAlert = alert) => {
      await runtime.dispose();
      runtime = start(restoredAlert);
      await runtime.ready;
      return stub(runtime);
    }, logs);
  } finally {
    await runtime.dispose();
    if (directory) await rm(directory, { recursive: true });
  }
}

test('20 concurrent reservations never exceed the daily or monthly gate', async t => {
  for (const [label, limits, resetAt] of [
    ['daily', {}, TODAY], ['monthly', { daily: '100', monthly: '8' }, DEC],
  ] as const) await t.test(label, () => withQuota(async quota => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => quota.reserve(scope(`send-${i}`), fence(), [0, 1, 2], [], NOW + 10_000)));
    assert.equal(results.filter(r => r.status === 'ok').length, 2, 'only two whole reservations of three fit under eight');
    assert.deepEqual(results.filter(r => r.status !== 'ok'), Array(18).fill({ status: 'exhausted', resetAt }));
    assert.equal((await quota.reserve(scope('single'), fence(), [0, 1], [], NOW + 10_000)).status, 'ok', 'refusals did not claim partial slots');
    assert.deepEqual(await quota.reserve(scope('full'), fence(), [0], [], NOW + 10_000), { status: 'exhausted', resetAt });
  }, limits));
});

test('reservations, released fences and gate-alert deduplication survive a restart', () => withQuota(async (quota, restart, logs) => {
  const s = scope('restart');
  assert.equal((await quota.reserve(s, fence(), [0], [], NOW + 10_000)).status, 'ok');
  assert.equal((await quota.confirm(s, fence(), [0])).status, 'ok');
  await quota.release(s, [fence(2)]);
  assert.deepEqual(await quota.reserve(scope('blocked'), fence(), [0], [], NOW + 10_000), { status: 'exhausted', resetAt: TODAY });
  const reopened = await restart();
  assert.deepEqual(await reopened.reserve(scope('blocked'), fence(), [0], [], NOW + 10_000), { status: 'exhausted', resetAt: TODAY });
  assert.deepEqual(await reopened.reserve(s, fence(2), [0], [], NOW + 10_000), { status: 'stale' });
  await reopened.setTime(TODAY);
  assert.equal((await reopened.reserve(scope('tomorrow'), fence(), [0], [], TODAY + 10_000)).status, 'ok');
  assert.equal((await reopened.reserve(scope('tomorrow-blocked'), fence(), [0], [], TODAY + 10_000)).status, 'exhausted');
  assert.equal(logs.filter(line => line.includes('send_quota_gate_hit')).length, 2, 'one redacted alert per quota day, even after restart');
}, { daily: '2', persist: true }));

test('an unconfirmed reservation survives restart and blocks a competing claim', () => withQuota(async (quota, restart) => {
  const original = scope('provisional-restart');
  const expires = NOW + 10_000;
  assert.equal((await quota.reserve(original, fence(), [0], [], expires)).status, 'ok');
  const reopened = await restart();
  assert.deepEqual(await reopened.reserve(scope('competing-claim'), fence(), [0], [], expires),
    { status: 'exhausted', resetAt: TODAY });
  assert.equal((await reopened.confirm(original, fence(), [0])).status, 'ok');
}, { daily: '2', persist: true }));

test('confirmation moves the charge across a non-midnight daily reset and release finds it there', () => withQuota(async quota => {
  const s = scope('move');
  assert.deepEqual(await quota.reserve(s, fence(), [0], [], TODAY + 10_000), { status: 'ok', day: '2026-11-29', dayEnd: TODAY });
  await quota.setTime(TODAY);
  assert.deepEqual(await quota.confirm(s, fence(), [0]), { status: 'ok', day: '2026-11-30', dayEnd: DEC });
  assert.deepEqual((await quota.balances()).map(({ day, charges }) => ({ day, charges })), [{ day: '2026-11-30', charges: 1 }]);
  assert.deepEqual(await quota.reserve(scope('blocked'), fence(), [0], [], TODAY + 10_000), { status: 'exhausted', resetAt: DEC });
  await quota.release(s, [fence()]);
  await quota.release(s, [fence()]);
  assert.deepEqual(await quota.balances(), []);
  assert.deepEqual(await quota.confirm(s, fence(), [0]), { status: 'stale' });
}, { daily: '2', monthly: '1' }));

test('the monthly ceiling rolls over at the configured hour and minute on the first', () => {
  const cutoff = at('2026-12-01T03:45:00Z');
  const expires = cutoff + 10_000;
  return withQuota(async quota => {
    const november = scope('november');
    const december = scope('december');
    assert.equal(await quota.resetAt(), cutoff);
    assert.equal((await quota.reserve(november, fence(), [0], [], expires)).status, 'ok');
    assert.equal((await quota.confirm(november, fence(), [0])).status, 'ok');
    assert.deepEqual(await quota.reserve(december, fence(), [0], [], expires), { status: 'exhausted', resetAt: cutoff });
    await quota.setTime(cutoff);
    assert.equal((await quota.reserve(december, fence(), [0], [], expires)).status, 'ok');
    assert.deepEqual(await quota.reserve(scope('new-blocked'), fence(), [0], [], expires),
      { status: 'exhausted', resetAt: at('2027-01-01T03:45:00Z') });
  }, { now: cutoff - 1, reset: '03:45', monthly: '1' });
});

test('expired provisional charges free capacity and confirmation must reserve again', () => withQuota(async quota => {
  const s = scope('expired');
  const other = scope('new');
  assert.equal((await quota.reserve(s, fence(), [0], [], NOW + 1)).status, 'ok');
  await quota.setTime(NOW + 1);
  assert.equal((await quota.reserve(other, fence(), [0], [], NOW + 2)).status, 'ok');
  assert.deepEqual(await quota.confirm(s, fence(), [0]), { status: 'exhausted', resetAt: TODAY });
  await quota.setTime(NOW + 2);
  assert.equal((await quota.confirm(s, fence(), [0])).status, 'ok');
  await quota.setTime(NOW + 3);
  assert.equal((await quota.confirm(s, fence(), [0])).status, 'ok');
  assert.deepEqual(await quota.reserve(s, fence(), [0], [], NOW + 4), { status: 'ok', day: '2026-11-29', dayEnd: TODAY });
  assert.deepEqual(await quota.confirm(scope('never-reserved'), fence(), [0]), { status: 'stale' });
  assert.deepEqual((await quota.balances()).map(row => row.sendId), [s.sendId]);
}, { daily: '2' }));

test('a refusal still releases its list and tracks the newest fence across quota days', () => withQuota(async quota => {
  const s = scope('refused');
  assert.equal((await quota.reserve(s, fence(), [0], [], TODAY + 1)).status, 'ok');
  assert.equal((await quota.confirm(s, fence(), [0])).status, 'ok');
  assert.deepEqual(await quota.reserve(s, fence(2), [0, 1], [fence()], TODAY + 1), { status: 'exhausted', resetAt: TODAY });
  assert.deepEqual(await quota.balances(), []);
  await quota.setTime(TODAY);
  assert.deepEqual(await quota.reserve(s, fence(), [0], [], TODAY + 1), { status: 'stale' });
  assert.deepEqual(await quota.confirm(s, fence(2), [0]), { status: 'stale' }, 'refusal did not create a reservation');
  assert.equal((await quota.reserve(s, fence(3), [0], [], TODAY + 1)).status, 'ok');
  assert.deepEqual(await quota.reserve(s, fence(2), [0], [], TODAY + 1), { status: 'stale' });
}, { daily: '2' }));

test('resetAt follows the supplied hour and minute', () => withQuota(async quota => {
  const reset = at('2026-11-30T03:45:00Z');
  assert.equal(await quota.resetAt(), reset);
  await quota.setTime(reset);
  assert.equal(await quota.resetAt(), at('2026-12-01T03:45:00Z'));
}, { now: at('2026-11-30T03:44:59Z'), reset: '03:45' }));

test('missing monthly ceiling fails closed without inventing an allowance', () => withQuota(async quota => {
  await assert.rejects(quota.reserve(scope('config'), fence(), [0], [], NOW + 1), /Invalid send quota configuration/);
}, { monthly: '' }));

test('simultaneously full gates refuse until the monthly reset and name the monthly gate', () => withQuota(async (quota, _, logs) => {
  assert.equal((await quota.reserve(scope('both-fill'), fence(), [0], [], NOW + 1000)).status, 'ok');
  assert.deepEqual(await quota.reserve(scope('both-refused'), fence(), [0], [], NOW + 1000), { status: 'exhausted', resetAt: DEC });
  assert.equal(logs.filter(line => line.includes('send_quota_gate_hit') && line.includes("'monthly'")).length, 1);
}, { daily: '2', monthly: '1' }));

test('alarm submits only redacted gate alerts and marks them sent only after a 2xx', async () => {
  const deliveries: unknown[] = [];
  await withQuota(async (quota, restart) => {
    assert.equal((await quota.reserve(scope('alert-fill'), fence(), [0], [], NOW + 2000)).status, 'ok');
    for (const name of ['alert-refuse-first', 'alert-refuse-again']) {
      assert.equal((await quota.reserve(scope(name), fence(), [0], [], NOW + 2000)).status, 'exhausted');
    }
    assert.notEqual(await quota.alarmDue(), null, 'a durable refusal arms delivery');
    await quota.runAlarm();
    assert.equal(deliveries.length, 1);
    assert.equal((await quota.retained()).alerts[0].sent_at, null, 'a non-2xx cannot acknowledge delivery');
    assert.notEqual(await quota.alarmDue(), null, 'non-2xx keeps a retry scheduled');
    const reopened = await restart();
    await reopened.runAlarm();
    assert.deepEqual(deliveries, [gateAlert(), gateAlert()]);
    assert.equal((await reopened.retained()).alerts[0].sent_at, NOW);
    await reopened.runAlarm();
    assert.equal(deliveries.length, 2, 'already acknowledged alerts are not posted again');
  }, { daily: '2', persist: true, alert(body) { deliveries.push(body); return deliveries.length === 1 ? 503 : 204; } });
});

test('missing alert binding preserves the undelivered alert and the quota refusal', () => withQuota(async quota => {
  assert.equal((await quota.reserve(scope('missing-fill'), fence(), [0], [], NOW + 1000)).status, 'ok');
  assert.deepEqual(await quota.reserve(scope('missing-refuse'), fence(), [0], [], NOW + 1000), { status: 'exhausted', resetAt: TODAY });
  await quota.runAlarm();
  assert.equal((await quota.retained()).alerts[0].sent_at, null);
  assert.notEqual(await quota.alarmDue(), null);
}, { daily: '2' }));

test('a shared operator endpoint accepts both environments on the same quota day', async () => {
  const accepted = new Map<string, unknown>();
  for (const environment of ['staging', 'production']) {
    await withQuota(async quota => {
      assert.equal((await quota.reserve(scope('same-day'), fence(), [0], [], NOW + 1000)).status, 'exhausted');
      await quota.runAlarm();
      assert.equal((await quota.retained()).alerts[0].sent_at, NOW);
    }, { monthly: '0', environment, alert(body, key) {
      // Both simulations feed a single endpoint which deduplicates by the request header.
      assert.ok(key);
      if (!accepted.has(key)) accepted.set(key, body);
      return 204;
    } });
  }
  assert.equal(accepted.size, 2, 'the receiver did not deduplicate one environment into the other');
  assert.deepEqual([...accepted], ['staging', 'production'].map(environment => [gateAlert(environment).key, gateAlert(environment)]));
});

test('a hung quota alert request times out and a later alarm delivers the pending row', async () => {
  const hung = Promise.withResolvers<number>();
  let attempts = 0;
  await withQuota(async quota => {
    assert.equal((await quota.reserve(scope('hung-alert'), fence(), [0], [], NOW + 1000)).status, 'exhausted');
    const first = quota.runAlarm();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([first, new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('quota alarm did not return while the operator endpoint was hung')), 13_000);
      })]);
    } finally {
      clearTimeout(watchdog);
      hung.resolve(503); // Release the fake host handler if the test fails, or after the Worker aborts.
      await first;
    }
    assert.equal(attempts, 1);
    const pending = (await quota.retained()).alerts[0];
    assert.equal(pending.last_attempt_at, NOW);
    assert.equal(pending.sent_at, null);
    assert.notEqual(await quota.alarmDue(), null);
    const retryAt = NOW + 60_000;
    await quota.setTime(retryAt);
    await quota.runAlarm();
    const delivered = (await quota.retained()).alerts[0];
    assert.equal(attempts, 2);
    assert.equal(delivered.last_attempt_at, retryAt);
    assert.equal(delivered.sent_at, retryAt);
  }, { monthly: '0', alert: () => ++attempts === 1 ? hung.promise : 204 });
});

test('the storage alarm wakes again after a slow quota alert page outlasts its retry deadline', async () => {
  const hung = Promise.withResolvers<number>();
  const retried = Promise.withResolvers<unknown>();
  let firstPostAt: number | undefined;
  await withQuota(async quota => {
    assert.equal((await quota.reserve(scope('slow-alarm-page'), fence(), [0], [], NOW + 1000)).status, 'exhausted');
    const watchdog = setTimeout(() => retried.reject(new Error('No automatic quota retry after the slow alarm page')), 15_000);
    try {
      assert.deepEqual(await retried.promise, gateAlert());
    } finally {
      clearTimeout(watchdog);
      hung.resolve(503); // Unblock the local service binding so Miniflare can dispose.
    }
  }, { monthly: '0', autoAlarm: true, alert(body) {
    if (firstPostAt === undefined) {
      firstPostAt = performance.now();
      // The real delivery timeout (10 s) outlasts the fixture's storage alarm delay (250 ms).
      return hung.promise;
    }
    if (performance.now() - firstPostAt <= 250) retried.reject(new Error('The first alarm page did not outlast the retry delay'));
    else retried.resolve(body);
    return 204;
  } });
});

test('an invalid alert environment leaves the quota alert pending without posting', async () => {
  let posts = 0;
  await withQuota(async quota => {
    assert.equal((await quota.reserve(scope('invalid-environment'), fence(), [0], [], NOW + 1000)).status, 'exhausted');
    await quota.runAlarm();
    assert.equal((await quota.retained()).alerts[0].sent_at, null, 'invalid environment cannot acknowledge the alert');
    assert.notEqual(await quota.alarmDue(), null, 'the pending alert has a retry scheduled');
  }, { monthly: '0', environment: 'not an environment', alert: () => { posts++; return 204; } });
  assert.equal(posts, 0);
});

test('pruning removes only old month charges and retains confirmed charges in this and the previous month', () => withQuota(async quota => {
  for (const [name, clock] of [['old', '2026-10-10T16:00:00Z'], ['previous', '2026-11-10T16:00:00Z'], ['current', '2026-12-16T16:00:00Z']] as const) {
    await quota.setTime(at(clock));
    assert.equal((await quota.reserve(scope(name), fence(), [0], [], at(clock) + 1000)).status, 'ok');
    assert.equal((await quota.confirm(scope(name), fence(), [0])).status, 'ok');
  }
  assert.deepEqual((await quota.retained()).charges.map(row => row.sendId), [scope('previous').sendId, scope('current').sendId]);
  assert.deepEqual(await quota.confirm(scope('previous'), fence(), [0]), { status: 'stale' }, 'a retained charge cannot be confirmed after its fence ages out');
}));

test('confirmation rejects a prior-month charge beyond retention even if its prune page did not reach it', () => withQuota(async quota => {
  const january = at('2027-01-31T16:00:00Z');
  const march = at('2027-03-01T16:00:00Z');
  // The first scope sorts ahead of the target on the same month/expiry index.
  const page = { ...scope('month-prune-page'), sendId: '01000000000000000000000000' };
  const target = { ...scope('month-prune-target'), sendId: '01FFFFFFFFFFFFFFFFFFFFFFFF' };
  const recipients = Array.from({ length: 32 }, (_, i) => i);
  assert.equal((await quota.reserve(page, fence(), recipients, [], january + 1000)).status, 'ok');
  assert.equal((await quota.confirm(page, fence(), recipients)).status, 'ok');
  assert.equal((await quota.reserve(target, fence(), [0], [], january + 1000)).status, 'ok');
  assert.equal((await quota.confirm(target, fence(), [0])).status, 'ok');
  await quota.setTime(march); // 29 days, so the newest fence is still retained.
  assert.deepEqual(await quota.confirm(target, fence(), [0]), { status: 'stale' });
  const retained = await quota.retained();
  assert.ok(retained.newest.includes(target.sendId));
  assert.deepEqual(retained.charges, [{ sendId: target.sendId, day: '2027-01-31', expires_at: null }]);
}, { daily: '100', now: at('2027-01-31T16:00:00Z') }));

test('pruning expires old provisional records but keeps live and recently expired ones', () => withQuota(async quota => {
  const old = scope('expired-old');
  const recent = scope('expired-recent');
  const live = scope('provisional-live');
  await quota.reserve(old, fence(), [0], [], NOW + 1000);
  const now = NOW + 60 * 60_000 + 2000;
  await quota.setTime(now - 2000);
  await quota.reserve(recent, fence(), [0], [], now - 1000);
  await quota.reserve(live, fence(), [0], [], now + 1000);
  await quota.setTime(now);
  assert.deepEqual(await quota.confirm(old, fence(), [0]), { status: 'stale' });
  assert.deepEqual(new Set((await quota.retained()).charges.map(row => row.sendId)), new Set([live.sendId, recent.sendId]));
  assert.equal((await quota.confirm(recent, fence(), [0])).status, 'ok');
  assert.equal((await quota.confirm(live, fence(), [0])).status, 'ok');
}));

test('a confirm 61 minutes after expiry is stale even when the row remains behind the prune page', () => withQuota(async quota => {
  const earlier = Array.from({ length: 32 }, (_, i) => i);
  assert.equal((await quota.reserve(scope('earlier-expiry-page'), fence(), earlier, [], NOW + 1000)).status, 'ok');
  const target = scope('expiry-beyond-first-page');
  const expiry = NOW + 2000;
  assert.equal((await quota.reserve(target, fence(), [0], [], expiry)).status, 'ok');
  await quota.setTime(expiry + 61 * 60_000);
  assert.deepEqual(await quota.confirm(target, fence(), [0]), { status: 'stale' });
  assert.deepEqual((await quota.retained()).charges, [{ sendId: target.sendId, day: '2026-11-29', expires_at: expiry }],
    'the bounded prune did not reach the stale target');
}, { daily: '100' }));

const dayMs = 24 * 60 * 60_000;
test('an unsent gate alert survives three days without the binding and sends once it returns', () => withQuota(async (quota, restart) => {
  assert.equal((await quota.reserve(scope('pending-alert'), fence(), [0, 1], [], NOW + 1000)).status, 'exhausted');
  const restoredAt = NOW + 3 * dayMs;
  await quota.setTime(restoredAt);
  await quota.runAlarm();
  assert.deepEqual((await quota.retained()).alerts.map(row => row.sent_at), [null], 'the unbound alarm must not lose the unsent row');
  const deliveries: unknown[] = [];
  const reopened = await restart(body => { deliveries.push(body); return 204; });
  await reopened.setTime(restoredAt);
  await reopened.runAlarm();
  await reopened.runAlarm();
  assert.deepEqual(deliveries, [gateAlert()]);
  assert.deepEqual((await reopened.retained()).alerts.map(row => row.sent_at), [restoredAt]);
}, { daily: '2', persist: true }));

test('a persisted alarm wakes the reopened quota object without a manual alarm call', () => withQuota(async (quota, restart) => {
  assert.equal((await quota.reserve(scope('automatic-alarm'), fence(), [0, 1], [], NOW + 1000)).status, 'exhausted');
  const delivered = Promise.withResolvers<unknown>();
  await restart(body => { delivered.resolve(body); return 204; });
  const timeout = setTimeout(() => delivered.reject(new Error('No automatic quota alarm after restart')), 8000);
  try {
    assert.deepEqual(await delivered.promise, gateAlert());
  } finally { clearTimeout(timeout); }
}, { daily: '2', persist: true, autoAlarm: true }));

test('an acknowledged gate alert is pruned two days after delivery rather than creation', () => withQuota(async quota => {
  assert.equal((await quota.reserve(scope('delivered-alert'), fence(), [0, 1], [], NOW + 1000)).status, 'exhausted');
  const deliveredAt = NOW + dayMs;
  await quota.setTime(deliveredAt);
  await quota.runAlarm();
  await quota.setTime(deliveredAt + 2 * dayMs);
  await quota.release(scope('at-retention-cutoff'), []);
  assert.deepEqual((await quota.retained()).alerts.map(row => row.sent_at), [deliveredAt]);
  await quota.setTime(deliveredAt + 2 * dayMs + 1);
  await quota.release(scope('past-retention-cutoff'), []);
  assert.deepEqual((await quota.retained()).alerts, []);
}, { daily: '2', alert: () => 204 }));

test('an alarm page of rejected quota alerts does not starve a newer alert', async () => {
  const newest = '2026-12-31';
  const accepted: string[] = [];
  let attempted = 0;
  await withQuota(async quota => {
    // The configured zero ceiling creates one refusal per quota day without any provider calls.
    for (let i = 0; i <= 32; i++) {
      const clock = NOW + i * dayMs;
      await quota.setTime(clock);
      assert.equal((await quota.reserve(scope(`queued-alert-${i}`), fence(), [0], [], clock + 1000)).status, 'exhausted');
    }
    assert.equal((await quota.retained()).alerts.at(-1)?.day, newest);
    await quota.runAlarm();
    assert.equal(attempted, 32, 'one bounded delivery page');
    assert.deepEqual(accepted, []);
    await quota.setTime(NOW + 32 * dayMs + 60_000);
    await quota.runAlarm();
    assert.deepEqual(accepted, [`send_quota_gate:test:${newest}`], 'the second alarm reaches the new alert despite older failures');
    assert.equal(attempted, 64);
    assert.equal((await quota.retained()).alerts.filter(row => row.sent_at === null).length, 32, 'failed deliveries stay pending');
  }, { monthly: '0', alert(body) {
    attempted++;
    const { key } = body as { key: string };
    if (key !== `send_quota_gate:test:${newest}`) return 503;
    accepted.push(key);
    return 204;
  } });
});

test('pruning keeps fence rows observed again within 35 days', () => withQuota(async quota => {
  const day = 24 * 60 * 60_000;
  const old = scope('forget-fence');
  const fresh = scope('refresh-fence');
  for (const send of [old, fresh]) {
    await quota.reserve(send, fence(2), [0], [], NOW + 1000);
    await quota.release(send, [fence(1)]);
  }
  await quota.setTime(NOW + 34 * day);
  assert.deepEqual(await quota.reserve(fresh, fence(1), [0], [], NOW + 34 * day + 1000), { status: 'stale' });
  await quota.setTime(NOW + 36 * day);
  await quota.release(scope('prune-fences'), []);
  const retained = await quota.retained();
  assert.deepEqual(retained.newest, [fresh.sendId]);
  assert.deepEqual(retained.released, [fresh.sendId]);
}));

test('pruning uses a bounded page even when many fences age out at once', () => withQuota(async quota => {
  const sends = Array.from({ length: 40 }, (_, i) => scope(`old-page-${i}`));
  for (const send of sends) {
    await quota.reserve(send, fence(2), [0], [], NOW + 1000);
    await quota.release(send, [fence(1)]);
  }
  await quota.setTime(NOW + 36 * 24 * 60 * 60_000);
  await quota.release(scope('run-one-page'), []);
  const partial = await quota.retained();
  assert.equal(partial.newest.length, 8, 'only 32 rows in the first newest-fence page');
  assert.equal(partial.released.length, 8, 'only 32 rows in the first released-fence page');
  await quota.release(scope('run-next-page'), []);
  const remaining = await quota.retained();
  assert.deepEqual(remaining.newest, []);
  assert.deepEqual(remaining.released, []);
}));

test('rejects oversized or invalid input without touching quota state', async t => {
  const s = scope('input');
  const release = Array.from({ length: 65 }, (_, i) => fence(i + 2));
  for (const [name, attempt] of [
    ['reserve release list', (q: ReturnType<typeof stub>) => q.reserve(s, fence(), [0], release, NOW + 1000)],
    ['release fence list', (q: ReturnType<typeof stub>) => q.release(s, release)],
    ['invalid send id', (q: ReturnType<typeof stub>) => q.reserve({ ...s, sendId: 'not-a-send-id' }, fence(), [0], [], NOW + 1000)],
    ['workspace length', (q: ReturnType<typeof stub>) => q.reserve({ ...s, workspaceId: 'w'.repeat(59) }, fence(), [0], [], NOW + 1000)],
    ['mailbox length', (q: ReturnType<typeof stub>) => q.reserve({ ...s, mailboxId: 'm'.repeat(129) }, fence(), [0], [], NOW + 1000)],
    ['expiry upper bound', (q: ReturnType<typeof stub>) => q.reserve(s, fence(), [0], [], NOW + 8 * 60_000 + 1)],
  ] as const) await t.test(name, () => withQuota(async quota => {
    await assert.rejects(attempt(quota), /Invalid send quota request/);
    assert.deepEqual(await quota.retained(), { charges: [], newest: [], released: [], alerts: [] });
  }));
});

test('moved charges compete for the new daily gate after 20 concurrent reservations', () => withQuota(async quota => {
  const old = scope('old-provisional');
  assert.equal((await quota.reserve(old, fence(), [0, 1, 2, 3, 4, 5, 6, 7], [], TODAY + 1000)).status, 'ok');
  await quota.setTime(TODAY);
  const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => quota.reserve(scope(`after-reset-${i}`), fence(), [0], [], TODAY + 1000)));
  assert.equal(answers.filter(result => result.status === 'ok').length, 8);
  assert.deepEqual(await quota.confirm(old, fence(), [0, 1, 2, 3, 4, 5, 6, 7]), { status: 'exhausted', resetAt: DEC });
  const chargedToday = (await quota.balances()).filter(row => row.day === '2026-11-30');
  assert.equal(chargedToday.reduce((sum, row) => sum + row.charges, 0), 8);
}));

test('a release by fence cannot delete the same send id and fence from another mailbox', () => withQuota(async quota => {
  const a = scope('collision', 'mailbox-a');
  const b = scope('collision', 'mailbox-b');
  for (const s of [a, b]) assert.equal((await quota.reserve(s, fence(), [0], [], NOW + 1000)).status, 'ok');
  await quota.release(a, [fence()]);
  assert.deepEqual((await quota.balances()).map(row => row.mb), ['mailbox-b']);
  assert.equal((await quota.confirm(b, fence(), [0])).status, 'ok');
}));
