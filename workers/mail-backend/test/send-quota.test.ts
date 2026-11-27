import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { FixtureSendQuota } from './fixtures/send-quota-worker.ts';

const at = (s: string) => Date.parse(s);
const NOW = at('2026-11-30T14:59:00Z');
const TODAY = at('2026-11-30T15:00:00Z');
const DEC = at('2026-12-01T15:00:00Z');
const JAN = at('2027-01-01T15:00:00Z');
const scope = (sendId: string, mailboxId = 'mb') => ({ workspaceId: 'ws', mailboxId, sendId });
const fence = (attempt = 1, epoch = 0) => ({ epoch, attempt });
type ObjectMethods = Pick<InstanceType<typeof FixtureSendQuota>, 'reserve' | 'confirm' | 'release' | 'resetAt' | 'setTime' | 'balances'>;
const stub = (mf: Miniflare) => {
  const call = <K extends keyof ObjectMethods>(method: K) => async (...args: Parameters<ObjectMethods[K]>): Promise<Awaited<ReturnType<ObjectMethods[K]>>> => {
    const response = await mf.dispatchFetch('http://quota.test', { method: 'POST', body: JSON.stringify({ method, args }) });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<Awaited<ReturnType<ObjectMethods[K]>>>;
  };
  return { reserve: call('reserve'), confirm: call('confirm'), release: call('release'), resetAt: call('resetAt'),
    setTime: call('setTime'), balances: call('balances') };
};
const entry = fileURLToPath(new NodeURL('./fixtures/send-quota-worker.ts', import.meta.url));
let bundle: ReturnType<typeof build> | undefined;

async function withQuota(run: (quota: ReturnType<typeof stub>, restart: () => Promise<ReturnType<typeof stub>>, logs: string[]) => Promise<void>,
  { daily = '10', monthly = '100', now = NOW, persist = false, reset = '15:00' } = {}) {
  const { outputFiles } = await (bundle ??= build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'] }));
  const directory = persist ? await mkdtemp('/var/tmp/velmora-riaklo-m3-6-quota-') : undefined;
  const logs: string[] = [];
  const start = () => new Miniflare({
    handleStructuredLogs: ({ message }: { message: string }) => { logs.push(message); },
    modules: [{ type: 'ESModule', path: 'quota.mjs', contents: outputFiles![0].text }], compatibilityDate: '2026-06-25',
    durableObjects: { SEND_QUOTA: { className: 'FixtureSendQuota', useSQLite: true } },
    durableObjectsPersist: directory && join(directory, 'do'),
    bindings: { INITIAL_TIME: now, MAIL_SEND_DAILY_QUOTA: daily, MAIL_SEND_MONTHLY_CEILING: monthly, MAIL_SEND_DAILY_RESET_UTC: reset },
  });
  let runtime = start();
  try {
    await run(await stub(runtime), async () => {
      await runtime.dispose();
      runtime = start();
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

test('the configured non-midnight reset starts a new calendar month on the first', () => withQuota(async quota => {
  const s = scope('november');
  assert.equal(await quota.resetAt(), DEC);
  assert.equal((await quota.reserve(s, fence(), [0], [], DEC + 10_000)).status, 'ok');
  assert.equal((await quota.confirm(s, fence(), [0])).status, 'ok');
  assert.deepEqual(await quota.reserve(scope('old-blocked'), fence(), [0], [], DEC + 10_000), { status: 'exhausted', resetAt: DEC });
  await quota.setTime(DEC + 1);
  assert.equal((await quota.reserve(scope('december'), fence(), [0], [], DEC + 10_000)).status, 'ok');
  assert.deepEqual(await quota.reserve(scope('new-blocked'), fence(), [0], [], DEC + 10_000), { status: 'exhausted', resetAt: JAN });
}, { now: DEC - 1, monthly: '1' }));

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
