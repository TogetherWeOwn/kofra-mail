import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response, type Request } from 'miniflare';
import type { GenerationRow, ProvisionalLedger, ProvisionalSweeper } from './fixtures/sweep-provisional.ts';
import { holdThenConfirm } from './fixtures/sweeper-consumer.ts';
import type { Env } from '../src/worker.ts';

const TTL = 7 * 24 * 60 * 60_000;
const RETENTION = 35 * 24 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;
const digest = (digit: string) => digit.repeat(64);

let runtime: Miniflare;
let ledgers: { getByName(name: string): ProvisionalLedger };
let sweepers: { getByName(name: string): ProvisionalSweeper };
let alarmDone: PromiseWithResolvers<void>;
let ledgerCount = 0;
let sweeperCount = 0;
const deletes: string[] = [];

before(async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/sweep-provisional.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false });
  runtime = new Miniflare({ modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle.outputFiles[0].text }],
    compatibilityDate: '2025-06-01',
    durableObjects: { LEDGER: { className: 'ProvisionalLedger', useSQLite: true }, SWEEPER: { className: 'ProvisionalSweeper', useSQLite: true } },
    bindings: { MAIL_BACKEND_ENABLED: 'on', MAIL_SWEEP_ENABLED: 'off', KOFRA_S3_ENDPOINT: 'https://s3.invalid',
      KOFRA_S3_ACCESS_KEY_ID: 'fixture', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture' },
    serviceBindings: { ALARM_COMPLETE: () => { alarmDone.resolve(); return new Response(null, { status: 204 }); } },
    outboundService: (request: Request) => { deletes.push(`${request.method} ${new URL(request.url).pathname}`); return new Response(null, { status: 204 }); },
  });
  ledgers = await runtime.getDurableObjectNamespace('LEDGER') as unknown as typeof ledgers;
  sweepers = await runtime.getDurableObjectNamespace('SWEEPER') as unknown as typeof sweepers;
});
after(() => runtime.dispose());

const freshLedger = () => ledgers.getByName(`workspace-${++ledgerCount}`);
// The ledger's time arguments, by method; a wrapped ledger refuses a call earlier than the one before it.
const TIME_ARG = { confirm: 1, sweep: 0, holdProvisional: 2, release: 2 } as const;
function forwardOnly(ledger: ProvisionalLedger): ProvisionalLedger {
  let last = -Infinity;
  return new Proxy(ledger, { get(target, property) {
    const value = Reflect.get(target, property) as unknown;
    if (typeof value !== 'function' || !(property in TIME_ARG)) return value;
    return (...args: unknown[]) => {
      const at = args[TIME_ARG[property as keyof typeof TIME_ARG]] as number;
      assert.ok(at >= last, `${String(property)} at ${at} moves the clock back from ${last}`);
      last = at;
      return (value as (...values: unknown[]) => unknown).apply(target, args);
    };
  } });
}
const freshSweeper = () => sweepers.getByName(`workspace-${++sweeperCount}`);
const generation = async (ledger: ProvisionalLedger, key: string): Promise<GenerationRow | null> =>
  JSON.parse(await ledger.generation(key));

test('a provisional holder protects its generation until it expires, and the grace counts from the expiry', async () => {
  const ledger = freshLedger();
  const key = await ledger.holdProvisional({ kind: 'raw', digest: digest('a') }, 'draft:scope:d1:r1', 100);
  assert.match(key, /^raw\/a{64}\/[0-9A-Z]{26}$/);
  assert.deepEqual(await ledger.holders(key), [{ key, holder: 'draft:scope:d1:r1', state: 'provisional', expires_at: 100 + TTL }]);
  assert.equal((await generation(ledger, key))?.holder_count, 1);
  assert.equal(await ledger.nextSweepAt(), 100 + TTL, 'the expiry is the next wake-up of an otherwise idle ledger');

  assert.deepEqual(await ledger.sweep(100 + TTL - 1), []);
  assert.equal((await ledger.holders(key))[0].state, 'provisional');

  const expiredAt = 100 + TTL + 5;
  assert.deepEqual(await ledger.sweep(expiredAt), []);
  assert.deepEqual(await ledger.holders(key), [{ key, holder: 'draft:scope:d1:r1', state: 'expired', expires_at: null }]);
  assert.deepEqual(await generation(ledger, key), { key, holder_count: 0, last_ref_at: expiredAt, retry_at: null });
  assert.equal(await ledger.nextSweepAt(), expiredAt + RETENTION);

  assert.deepEqual(await ledger.sweep(expiredAt + RETENTION - 1), [], 'the grace starts at the expiry, not at the hold');
  assert.deepEqual(await ledger.sweep(expiredAt + RETENTION), [key]);
  assert.deepEqual(await ledger.sweep(expiredAt + RETENTION + DAY), [key], 'the second delete, a day after the first');
  assert.equal(await generation(ledger, key), null, 'the confirmed DELETE removes the retired generation');
  assert.deepEqual(await ledger.holders(key), [], 'and its expired holder row first');
});

test('holdProvisional by key takes only raw/ and att/ generation keys, and refuses retired generations', async () => {
  const ledger = freshLedger();
  const draft = `drafts/${digest('d')}`;
  assert.match(await ledger.failure('holdProvisional', { key: draft }, 'draft:scope:d1:r1', 100), /Invalid sweeper reference/,
    'legacy drafts/ keys get no new holders');
  assert.match(await ledger.failure('holdProvisional', { key: undefined }, 'draft:scope:d1:r1', 100), /Invalid sweeper reference/);
  assert.match(await ledger.failure('holdProvisional', { key: `raw/${digest('d')}` }, 'draft:scope:d1:r1', 100), /Invalid sweeper reference/);
  assert.deepEqual(await ledger.holders(), []);
  assert.equal(await generation(ledger, draft), null, 'a refused key creates no generation row');

  const key = await ledger.register('att', digest('e'), 'delivery:1', 100);
  assert.equal(await ledger.holdProvisional({ key }, 'upload:scope:u1', 100), key);
  assert.equal((await generation(ledger, key))?.holder_count, 2);
  await ledger.release(key, 'delivery:1', 100);
  await ledger.release(key, 'upload:scope:u1', 100);
  assert.deepEqual(await ledger.sweep(100 + RETENTION, 'fail'), [key]);
  assert.match(await ledger.failure('holdProvisional', { key }, 'upload:scope:u2', 200 + RETENTION), /generation unavailable/);
  const fresh = await ledger.holdProvisional({ kind: 'att', digest: digest('e') }, 'upload:scope:u2', 200 + RETENTION);
  assert.notEqual(fresh, key, 'a retired generation is never chosen');
  assert.deepEqual(await ledger.holders(key), []);
});

test('confirm answers held before expiry, rehold after expiry and lost after retirement', async () => {
  const ledger = freshLedger();
  const early = await ledger.holdProvisional({ kind: 'raw', digest: digest('1') }, 'draft:scope:early', 100);
  const late = await ledger.holdProvisional({ kind: 'raw', digest: digest('2') }, 'draft:scope:late', 100);
  const gone = await ledger.holdProvisional({ kind: 'raw', digest: digest('3') }, 'draft:scope:gone', 50);

  assert.deepEqual(await ledger.confirm([{ key: early, holder: 'draft:scope:early' }], 200), ['held']);
  assert.deepEqual(await ledger.holders(early), [{ key: early, holder: 'draft:scope:early', state: 'held', expires_at: null }]);

  // 'gone' expires first; its grace then ends before 'late' would be retired.
  assert.deepEqual(await ledger.sweep(50 + TTL), []);
  assert.deepEqual(await ledger.sweep(100 + TTL), []);
  assert.equal((await ledger.holders(late))[0].state, 'expired');
  assert.deepEqual(await ledger.sweep(50 + TTL + RETENTION, 'fail'), [gone], 'the DELETE outcome is unknown, so the row stays retired');
  assert.ok((await generation(ledger, gone))?.retry_at);

  const confirmedAt = 50 + TTL + RETENTION + 10;
  assert.deepEqual(await ledger.confirm([
    { key: early, holder: 'draft:scope:early' },
    { key: late, holder: 'draft:scope:late' },
    { key: gone, holder: 'draft:scope:gone' },
  ], confirmedAt), ['held', 'rehold', 'lost']);
  assert.deepEqual(await ledger.holders(late), [{ key: late, holder: 'draft:scope:late', state: 'held', expires_at: null }]);
  assert.deepEqual(await generation(ledger, late), { key: late, holder_count: 1, last_ref_at: confirmedAt, retry_at: null });
  assert.deepEqual(await ledger.holders(gone), [{ key: gone, holder: 'draft:scope:gone', state: 'expired', expires_at: null }],
    'a lost holder is not re-created on a retired generation');
  assert.equal((await generation(ledger, gone))?.holder_count, 0);
  assert.deepEqual(await ledger.sweep(confirmedAt + RETENTION), [gone], 'the reheld generation is kept');
});

test('confirm answers lost after the expired generation was deleted, and released while a released generation lives', async () => {
  const ledger = forwardOnly(freshLedger());
  const deleted = await ledger.holdProvisional({ kind: 'raw', digest: digest('d') }, 'draft:scope:gone', 100);
  await ledger.sweep(100 + TTL);
  assert.deepEqual(await ledger.sweep(100 + TTL + RETENTION), [deleted]);
  assert.deepEqual(await ledger.sweep(100 + TTL + RETENTION + DAY), [deleted], 'the second delete, a day after the first');
  assert.equal(await generation(ledger, deleted), null, 'the confirmed DELETE dropped the generation and its expired row');
  assert.deepEqual(await ledger.confirm([{ key: deleted, holder: 'draft:scope:gone' }], 200 + TTL + RETENTION + DAY), ['lost']);
  assert.deepEqual(await ledger.holders(), [], 'lost re-creates nothing');
  assert.equal(await generation(ledger, deleted), null);

  const live = await ledger.holdProvisional({ kind: 'att', digest: digest('e') }, 'upload:scope:u1', 300 + TTL + RETENTION + DAY);
  await ledger.release(live, 'upload:scope:u1', 310 + TTL + RETENTION + DAY);
  assert.deepEqual(await ledger.confirm([{ key: live, holder: 'upload:scope:u1' }], 320 + TTL + RETENTION + DAY), ['released']);
  assert.deepEqual(await ledger.holders(), []);

  const draft = `drafts/${digest('f')}`;
  assert.deepEqual(await ledger.confirm([{ key: draft, holder: 'draft:scope:legacy' }], 330 + TTL + RETENTION + DAY), ['released'],
    'a legacy drafts/ key is not a generation key');
});

test('release then confirm is a no-op that answers released', async () => {
  const ledger = freshLedger();
  const key = await ledger.holdProvisional({ kind: 'att', digest: digest('4') }, 'upload:scope:u1', 100);
  const heldKey = await ledger.holdProvisional({ kind: 'att', digest: digest('5') }, 'upload:scope:u2', 100);
  assert.deepEqual(await ledger.confirm([{ key: heldKey, holder: 'upload:scope:u2' }], 110), ['held']);
  await ledger.release(key, 'upload:scope:u1', 120);
  await ledger.release(heldKey, 'upload:scope:u2', 120);
  assert.deepEqual(await ledger.confirm([{ key, holder: 'upload:scope:u1' }, { key: heldKey, holder: 'upload:scope:u2' }], 130),
    ['released', 'released']);
  assert.deepEqual(await ledger.holders(), []);
  assert.deepEqual(await generation(ledger, key), { key, holder_count: 0, last_ref_at: 120, retry_at: null });
  assert.deepEqual(await generation(ledger, heldKey), { key: heldKey, holder_count: 0, last_ref_at: 120, retry_at: null });
});

test('a failed confirm, a successful release and a retried confirm leave no holder', async () => {
  const ledger = freshLedger();
  const key = await ledger.holdProvisional({ kind: 'raw', digest: digest('6') }, 'draft:scope:d1:r1', 100);
  assert.match(await ledger.failure('confirm', [{ key, holder: 'draft:scope:d1:r1' }, { key, holder: '' }], 110), /Invalid sweeper reference/);
  assert.equal((await ledger.holders(key))[0].state, 'provisional', 'a failed confirm changes nothing');
  await ledger.release(key, 'draft:scope:d1:r1', 120);
  assert.deepEqual(await ledger.confirm([{ key, holder: 'draft:scope:d1:r1' }], 130), ['released']);
  assert.deepEqual(await ledger.holders(), []);
  assert.equal((await generation(ledger, key))?.holder_count, 0);
});

test('a tombstone is never revived and is deleted with its generation', async () => {
  const ledger = freshLedger();
  const key = await ledger.register('raw', digest('7'), 'delivery:1', 100);
  await ledger.release(key, 'delivery:1', 100);
  await ledger.seedTombstone(key, 'send:scope:s1');
  const tombstone = [{ key, holder: 'send:scope:s1', state: 'tombstone', expires_at: null }];

  assert.match(await ledger.failure('holdProvisional', { key }, 'send:scope:s1', 110), /holder retired/);
  assert.match(await ledger.failure('holdProvisional', { kind: 'raw', digest: digest('7') }, 'send:scope:s1', 110), /holder retired/);
  await ledger.hold(key, 'send:scope:s1', 110);
  assert.equal(await ledger.register('raw', digest('7'), 'send:scope:s1', 110), key, 'a repeated hold is a no-op');
  assert.deepEqual(await ledger.confirm([{ key, holder: 'send:scope:s1' }], 110), ['released']);
  await ledger.release(key, 'send:scope:s1', 110);
  assert.deepEqual(await ledger.holders(key), tombstone, 'release keeps a tombstone');
  assert.deepEqual(await generation(ledger, key), { key, holder_count: 0, last_ref_at: 100, retry_at: null });

  assert.deepEqual(await ledger.sweep(100 + RETENTION), [key]);
  assert.deepEqual(await ledger.sweep(100 + RETENTION + DAY), [key], 'the second delete, a day after the first');
  assert.equal(await generation(ledger, key), null);
  assert.deepEqual(await ledger.holders(key), []);
});

test('confirm racing expiry: confirm first stays held, expiry first answers rehold', async () => {
  const ledger = freshLedger();
  const first = await ledger.holdProvisional({ kind: 'raw', digest: digest('8') }, 'draft:scope:a', 100);
  assert.deepEqual(await ledger.confirm([{ key: first, holder: 'draft:scope:a' }], 100 + TTL), ['held'],
    'a confirm that arrives at the expiry time but before the alarm keeps the holder');
  assert.deepEqual(await ledger.sweep(100 + TTL), []);
  assert.deepEqual(await ledger.holders(first), [{ key: first, holder: 'draft:scope:a', state: 'held', expires_at: null }]);
  assert.equal((await generation(ledger, first))?.holder_count, 1);

  const second = await ledger.holdProvisional({ kind: 'raw', digest: digest('9') }, 'draft:scope:b', 100);
  assert.deepEqual(await ledger.sweep(100 + TTL), []);
  assert.deepEqual(await ledger.confirm([{ key: second, holder: 'draft:scope:b' }], 100 + TTL + 1), ['rehold']);
  assert.deepEqual(await ledger.sweep(100 + TTL + 1), []);
  assert.deepEqual(await ledger.holders(second), [{ key: second, holder: 'draft:scope:b', state: 'held', expires_at: null }]);
  assert.equal((await generation(ledger, second))?.holder_count, 1);
  assert.deepEqual(await ledger.sweep(100 + TTL + 1 + RETENTION), [], 'both reheld generations are kept');
});

test('repeated calls are idempotent and a holder can be taken again after expiry', async () => {
  const ledger = freshLedger();
  const key = await ledger.holdProvisional({ kind: 'att', digest: digest('a') }, 'upload:scope:u1', 100);
  assert.equal(await ledger.holdProvisional({ kind: 'att', digest: digest('a') }, 'upload:scope:u1', 200), key);
  assert.deepEqual(await ledger.holders(key), [{ key, holder: 'upload:scope:u1', state: 'provisional', expires_at: 200 + TTL }],
    'a repeat moves the expiry');
  assert.equal((await generation(ledger, key))?.holder_count, 1);

  await ledger.sweep(200 + TTL);
  assert.equal((await ledger.holders(key))[0].state, 'expired');
  assert.equal(await ledger.holdProvisional({ key }, 'upload:scope:u1', 300 + TTL), key);
  assert.deepEqual(await ledger.holders(key), [{ key, holder: 'upload:scope:u1', state: 'provisional', expires_at: 300 + 2 * TTL }]);
  assert.equal((await generation(ledger, key))?.holder_count, 1);

  const entry = [{ key, holder: 'upload:scope:u1' }];
  assert.deepEqual(await ledger.confirm(entry, 400 + TTL), ['held']);
  assert.deepEqual(await ledger.confirm(entry, 500 + TTL), ['held']);
  assert.equal(await ledger.holdProvisional({ key }, 'upload:scope:u1', 600 + TTL), key);
  assert.deepEqual(await ledger.holders(key), [{ key, holder: 'upload:scope:u1', state: 'held', expires_at: null }],
    'holdProvisional never weakens a held holder');
  assert.equal((await generation(ledger, key))?.holder_count, 1);
  assert.deepEqual(await ledger.confirm([], 700 + TTL), []);
});

test('hold and register make an existing provisional or expired holder held', async () => {
  const ledger = freshLedger();
  const key = await ledger.holdProvisional({ kind: 'raw', digest: digest('b') }, 'draft:scope:p', 100);
  await ledger.holdProvisional({ key }, 'draft:scope:e', 50);
  await ledger.sweep(50 + TTL);
  assert.deepEqual((await ledger.holders(key)).map(row => row.state), ['expired', 'provisional']);
  assert.equal((await generation(ledger, key))?.holder_count, 1);
  await ledger.hold(key, 'draft:scope:e', 60 + TTL);
  assert.equal(await ledger.register('raw', digest('b'), 'draft:scope:p', 60 + TTL), key);
  assert.deepEqual(await ledger.holders(key), [
    { key, holder: 'draft:scope:e', state: 'held', expires_at: null },
    { key, holder: 'draft:scope:p', state: 'held', expires_at: null },
  ]);
  assert.equal((await generation(ledger, key))?.holder_count, 2);
  await ledger.sweep(200 + TTL);
  assert.equal((await generation(ledger, key))?.holder_count, 2, 'no expiry applies to a held holder');
});

test('confirm batches are bounded at 64 entries', async () => {
  const ledger = freshLedger();
  const key = await ledger.holdProvisional({ kind: 'raw', digest: digest('c') }, 'draft:scope:0', 100);
  const entries = Array.from({ length: 65 }, (_, i) => ({ key, holder: `draft:scope:${i}` }));
  assert.match(await ledger.failure('confirm', entries, 110), /at most 64/);
  assert.equal((await ledger.holders(key))[0].state, 'provisional');
  const answers = await ledger.confirm(entries.slice(0, 64), 110);
  assert.equal(answers.length, 64);
  assert.deepEqual(answers, ['held', ...Array(63).fill('released')]);
  assert.deepEqual(await ledger.holders(key), [{ key, holder: 'draft:scope:0', state: 'held', expires_at: null }],
    'absent holders are never created by confirm');
  assert.match(await ledger.failure('confirm', [{ key: 'not/a/key', holder: 'draft:scope:0' }], 110), /Invalid sweeper reference/);
});

test('expiry runs in bounded batches and keeps the next wake-up due', async () => {
  const ledger = freshLedger();
  const key = await ledger.holdProvisional({ kind: 'raw', digest: digest('f') }, 'draft:scope:000', 100);
  for (let i = 1; i < 70; i++) await ledger.holdProvisional({ key }, `draft:scope:${String(i).padStart(3, '0')}`, 100);
  assert.equal((await generation(ledger, key))?.holder_count, 70);
  await ledger.sweep(100 + TTL);
  assert.equal((await ledger.holders(key)).filter(row => row.state === 'expired').length, 64);
  assert.equal(await ledger.nextSweepAt(), 100 + TTL, 'the remaining expiries keep the ledger due');
  await ledger.sweep(101 + TTL);
  assert.equal((await ledger.holders(key)).filter(row => row.state === 'expired').length, 70);
  assert.deepEqual(await generation(ledger, key), { key, holder_count: 0, last_ref_at: 101 + TTL, retry_at: null });
});

test('release deletes a holder in any state except tombstone and counts only held and provisional', async () => {
  const ledger = freshLedger();
  const key = await ledger.holdProvisional({ kind: 'att', digest: digest('0') }, 'upload:scope:p', 100);
  await ledger.holdProvisional({ key }, 'upload:scope:e', 50);
  await ledger.hold(key, 'upload:scope:h', 100);
  await ledger.sweep(50 + TTL);
  assert.equal((await generation(ledger, key))?.holder_count, 2);
  await ledger.release(key, 'upload:scope:e', 60 + TTL);
  assert.deepEqual(await generation(ledger, key), { key, holder_count: 2, last_ref_at: 50 + TTL, retry_at: null },
    'an expired holder no longer counts');
  await ledger.release(key, 'upload:scope:p', 70 + TTL);
  await ledger.release(key, 'upload:scope:h', 80 + TTL);
  assert.deepEqual(await generation(ledger, key), { key, holder_count: 0, last_ref_at: 80 + TTL, retry_at: null });
  assert.deepEqual(await ledger.holders(key), []);
});

test('nextSweepAt takes the earliest of retention, retry and provisional expiry', async () => {
  const ledger = freshLedger();
  const released = await ledger.register('raw', digest('1'), 'delivery:1', 100);
  await ledger.release(released, 'delivery:1', 100);
  assert.equal(await ledger.nextSweepAt(), 100 + RETENTION);
  await ledger.holdProvisional({ kind: 'raw', digest: digest('2') }, 'draft:scope:x', 200);
  assert.equal(await ledger.nextSweepAt(), 200 + TTL);
  await ledger.holdProvisional({ kind: 'raw', digest: digest('3') }, 'draft:scope:y', 150);
  assert.equal(await ledger.nextSweepAt(), 150 + TTL);
  assert.ok((await ledger.expiryIndexPlan(150 + TTL)).some(step => /USING (COVERING )?INDEX provisional_expiry/.test(step)),
    'expiry reads the partial index');
});

test('nextSweepAt takes the earlier of an unconfirmed DELETE retry and a provisional expiry, in both orders', async () => {
  for (const offset of [-1_000, 1_000]) {
    const ledger = freshLedger();
    const key = await ledger.register('raw', digest('1'), 'delivery:1', 100);
    await ledger.release(key, 'delivery:1', 100);
    assert.deepEqual(await ledger.sweep(100 + RETENTION, 'fail'), [key]);
    const retry = (await generation(ledger, key))!.retry_at!;
    assert.equal(retry, 100 + RETENTION + 60_000);
    const held = await ledger.holdProvisional({ kind: 'raw', digest: digest('2') }, 'draft:scope:x', retry - TTL + offset);
    const expiry = retry + offset;
    assert.equal(await ledger.nextSweepAt(), Math.min(retry, expiry), `offset ${offset}`);
    const first = Math.min(retry, expiry);
    assert.deepEqual(await ledger.sweep(first, 'fail'), offset < 0 ? [] : [key], 'the earlier deadline is the one that is due');
    assert.equal((await ledger.holders(held))[0].state, offset < 0 ? 'expired' : 'provisional');
    assert.equal(await ledger.nextSweepAt(), offset < 0 ? retry : expiry);
  }
});

test('a ledger written by the previous schema migrates its holders to held', async () => {
  const ledger = freshLedger();
  const key = `raw/${digest('a')}/01JZ0000000000000000000000`;
  await ledger.seedLegacy(key, ['delivery:1', 'message:scope:1'], 100);
  assert.deepEqual(await ledger.holderColumns(), ['key', 'holder', 'state', 'expires_at']);
  assert.deepEqual(await ledger.holders(key), [
    { key, holder: 'delivery:1', state: 'held', expires_at: null },
    { key, holder: 'message:scope:1', state: 'held', expires_at: null },
  ]);
  assert.deepEqual(await ledger.holderColumns(), await freshLedger().holderColumns(), 'migrated and new ledgers share one schema');
  assert.deepEqual(await ledger.confirm([{ key, holder: 'delivery:1' }], 110), ['held']);
  assert.equal(await ledger.register('raw', digest('a'), 'delivery:2', 120), key, 'the live legacy generation is chosen');
  assert.equal(await ledger.holdProvisional({ key }, 'draft:scope:d1:r1', 120), key);
  assert.equal((await generation(ledger, key))?.holder_count, 4);
  for (const holder of ['delivery:1', 'message:scope:1', 'delivery:2', 'draft:scope:d1:r1']) await ledger.release(key, holder, 130);
  assert.deepEqual(await generation(ledger, key), { key, holder_count: 0, last_ref_at: 130, retry_at: null });
  assert.equal(await ledger.nextSweepAt(), 130 + RETENTION);
  assert.deepEqual(await ledger.sweep(130 + RETENTION), [key]);
});

async function untilAlarm(box: ProvisionalSweeper, start: () => Promise<unknown>) {
  alarmDone = Promise.withResolvers();
  await start();
  const timer = setTimeout(() => alarmDone.reject(new Error('Sweeper alarm did not run')), 5_000);
  try { await alarmDone.promise; } finally { clearTimeout(timer); }
  return box;
}

for (const mode of ['on', 'off'] as const) {
  test(`an idle ledger plus one holdProvisional arms an alarm at its expiry (deletes ${mode})`, { timeout: 15_000 }, async () => {
    const box = freshSweeper();
    if (mode === 'on') await box.enableSweeping();
    assert.equal(await box.alarmAt(), null);
    const started = Date.now();
    const key = await box.holdProvisional({ kind: 'raw', digest: digest('a') }, 'draft:scope:d1:r1');
    const finished = Date.now();
    const armed = await box.alarmAt();
    assert.ok(armed !== null && armed >= started + TTL && armed <= finished + TTL, `alarm ${armed} is at the expiry`);
    assert.equal(armed, await box.nextSweep());

    await box.holdProvisional({ kind: 'raw', digest: digest('b') }, 'draft:scope:d2:r1');
    assert.equal(await box.alarmAt(), armed, 'a later expiry never moves the alarm later');

    await untilAlarm(box, () => box.bringExpiryForward());
    const [first] = await box.holders();
    const wake = await box.alarmAt();
    if (mode === 'on') {
      assert.equal(first.state, 'expired', 'the alarm expires the due holder');
      const generation = await box.generation(key);
      assert.equal(generation?.holder_count, 0);
      assert.ok(wake !== null && wake <= generation!.last_ref_at + RETENTION, 'the ledger stays armed for the next deadline');
    } else {
      assert.equal(first.state, 'provisional', 'while deletes are off the alarm only re-arms');
      assert.ok(wake !== null && wake >= Date.now() + DAY - 5_000, 'the off recheck keeps a daily wake-up');
    }
    assert.ok(!deletes.some(path => path.includes(key)), 'no DELETE for a protected generation');
  });
}

test('confirm through the Durable Object returns the ledger answers', async () => {
  const box = freshSweeper();
  const key = await box.holdProvisional({ kind: 'att', digest: digest('c') }, 'upload:scope:u1');
  assert.deepEqual(await box.confirm([{ key, holder: 'upload:scope:u1' }, { key, holder: 'upload:scope:u2' }]), ['held', 'released']);
  assert.deepEqual(await box.holders(), [{ key, holder: 'upload:scope:u1', state: 'held', expires_at: null }]);
});

test('a consumer typed against Env reaches holdProvisional and confirm through the binding', async () => {
  const name = `workspace-${++sweeperCount}`;
  const { key, answers } = await holdThenConfirm({ SWEEPER: sweepers as unknown as Env['SWEEPER'] }, name, digest('9'), 'draft:scope:typed');
  assert.deepEqual(answers, ['held']);
  assert.deepEqual(await sweepers.getByName(name).holders(), [{ key, holder: 'draft:scope:typed', state: 'held', expires_at: null }]);
});

for (const mode of ['on', 'off'] as const) {
  test(`holdProvisional on a ledger with an overdue generation and no alarm arms the earlier deadline (deletes ${mode})`,
    { timeout: 15_000 }, async () => {
    const box = freshSweeper();
    if (mode === 'on') await box.enableSweeping();
    const overdue = await box.seedOverdue(digest('3'));
    assert.equal(await box.alarmAt(), null, 'the seeded ledger has no wake-up');
    const started = Date.now();
    const hold = () => box.holdProvisional({ kind: 'raw', digest: digest('4') }, 'draft:scope:d1:r1');
    if (mode === 'on') {
      // The overdue retention deadline is earlier than the expiry, so the alarm fires at once and sweeps it.
      await untilAlarm(box, hold);
      assert.ok(deletes.some(path => path.endsWith(`/${overdue}`)), 'the overdue generation was swept');
      // Its row stays retired until the second delete, a day later, which is earlier than the expiry.
      const retired = await box.generation(overdue);
      assert.ok(retired?.retry_at);
      const [holder] = await box.holders();
      assert.equal(holder.state, 'provisional');
      assert.ok(retired.retry_at < holder.expires_at!);
      assert.equal(await box.alarmAt(), retired.retry_at, 'then the second delete is the next wake-up');
    } else {
      await hold();
      const finished = Date.now();
      const armed = await box.alarmAt();
      assert.ok(armed !== null && armed >= started + DAY && armed <= finished + DAY, 'the off-mode daily floor, before the expiry');
      assert.ok(!deletes.some(path => path.endsWith(`/${overdue}`)));
    }
  });
}
