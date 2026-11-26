import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response } from 'miniflare';
import type { GenerationRow, HolderRow, ProvisionalLedger } from './fixtures/sweep-provisional.ts';

// The sweeper side of the send path (docs/m3-outbound-plan.md, section 2.4,
// release step 3): registerSend, releaseSend and the second delete.
const RETENTION = 35 * 24 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;
const digest = (digit: string) => digit.repeat(64);
const holders = { raw: 'send:scope:01JSEND0000000000000000000', index: 'message:scope:01JSEND0000000000000000000' };
const SEND = '01JSEND0000000000000000000';

let runtime: Miniflare;
let ledgers: { getByName(name: string): ProvisionalLedger };
let count = 0;

before(async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/sweep-provisional.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false });
  runtime = new Miniflare({ modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle.outputFiles[0].text }],
    compatibilityDate: '2025-06-01',
    durableObjects: { LEDGER: { className: 'ProvisionalLedger', useSQLite: true }, SWEEPER: { className: 'ProvisionalSweeper', useSQLite: true } },
    bindings: { MAIL_BACKEND_ENABLED: 'on', MAIL_SWEEP_ENABLED: 'off', KOFRA_S3_ENDPOINT: 'https://s3.invalid',
      KOFRA_S3_ACCESS_KEY_ID: 'fixture', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture' },
    serviceBindings: { ALARM_COMPLETE: () => new Response(null, { status: 204 }) },
    outboundService: () => new Response(null, { status: 204 }),
  });
  ledgers = await runtime.getDurableObjectNamespace('LEDGER') as unknown as typeof ledgers;
});
after(() => runtime.dispose());

const fresh = () => ledgers.getByName(`send-ledger-${++count}`);
const generation = async (ledger: ProvisionalLedger, key: string): Promise<GenerationRow | null> => JSON.parse(await ledger.generation(key));
const register = async (ledger: ProvisionalLedger, sendId: string, value: string, now: number, held = holders) =>
  JSON.parse(await ledger.registerSend('mailbox-a', sendId, value, held, now)) as { state: string; key?: string };
const states = (rows: HolderRow[]) => rows.map(({ holder, state }) => `${holder}=${state}`).sort();

// A digest whose only generation is unheld and past its grace at `due`.
async function unheld(ledger: ProvisionalLedger, value: string) {
  const old = await ledger.register('raw', value, 'delivery:1', 100);
  await ledger.release(old, 'delivery:1', 100);
  return { old, due: 100 + RETENTION };
}

for (const point of ['before the sweep', 'after retirement, delete unconfirmed', 'between the two deletes', 'after the row was dropped'] as const) {
  test(`registerSend interleaved with a sweep ${point} names a live generation that has both holders, never a retired one`, async () => {
    const ledger = fresh();
    const { old, due } = await unheld(ledger, digest('1'));
    if (point === 'after retirement, delete unconfirmed') await ledger.sweep(due, 'fail');
    if (point === 'between the two deletes') await ledger.sweep(due);
    if (point === 'after the row was dropped') { await ledger.sweep(due); await ledger.sweep(due + DAY); }
    const registered = await register(ledger, SEND, digest('1'), due + 1);
    assert.equal(registered.state, 'registered');
    const key = registered.key!;
    if (point === 'before the sweep') assert.equal(key, old, 'the live generation is reused');
    else assert.notEqual(key, old, 'a retired generation is never named; a new one is minted');
    assert.deepEqual(states(await ledger.holders(key)), [`${holders.index}=held`, `${holders.raw}=held`]);
    assert.equal((await generation(ledger, key))?.retry_at, null);
    assert.equal((await generation(ledger, key))?.holder_count, 2);
    // The registered generation survives every later sweep while held.
    await ledger.sweep(due + 2 * DAY + RETENTION);
    assert.equal((await generation(ledger, key))?.holder_count, 2);
  });
}

test('a repeated registerSend returns the same record and adds no holder; another digest is refused', async () => {
  const ledger = fresh();
  const first = await register(ledger, SEND, digest('2'), 100);
  assert.equal(first.state, 'registered');
  assert.deepEqual(await register(ledger, SEND, digest('2'), 200), first, 'a lost reply is recovered by calling again');
  assert.equal((await generation(ledger, first.key!))?.holder_count, 2);
  assert.deepEqual(await register(ledger, SEND, digest('3'), 300), { state: 'mismatch' });
  assert.deepEqual(await register(ledger, SEND, digest('2'), 300, { raw: 'send:scope:other', index: holders.index }), { state: 'mismatch' });
  assert.deepEqual(await ledger.holders(), (await ledger.holders(first.key!)), 'nothing was added for the other digest');
  assert.equal((await generation(ledger, first.key!))?.holder_count, 2);
  assert.deepEqual(JSON.parse(await ledger.registration('mailbox-a', SEND)),
    { digest: digest('2'), key: first.key, raw_holder: holders.raw, index_holder: holders.index, released: null });
  // The same send id in another mailbox is another registration.
  const other = JSON.parse(await ledger.registerSend('mailbox-b', SEND, digest('3'), { raw: 'send:b:x', index: 'message:b:x' }, 400));
  assert.equal(other.state, 'registered');
});

test('releaseSend tombstones the send holders, and a later registerSend adds nothing', async () => {
  const ledger = fresh();
  const { key } = await register(ledger, SEND, digest('4'), 100) as { key: string };
  await ledger.releaseSend('mailbox-a', SEND, 'raw', 200);
  assert.deepEqual(states(await ledger.holders(key)), [`${holders.index}=held`, `${holders.raw}=tombstone`],
    'raw keeps the committed copy\'s index holder');
  assert.equal((await generation(ledger, key))?.holder_count, 1);
  await ledger.hold(key, holders.raw, 210);
  assert.equal(await ledger.register('raw', digest('4'), holders.raw, 210), key);
  assert.equal((await generation(ledger, key))?.holder_count, 1, 'a tombstoned holder is never revived');
  assert.deepEqual(await register(ledger, SEND, digest('4'), 220), { state: 'released' });
  await ledger.releaseSend('mailbox-a', SEND, 'raw', 230);
  assert.equal((await generation(ledger, key))?.holder_count, 1, 'releaseSend is idempotent');

  // `all`, used when no index row was committed, releases both.
  const second = '01JSEND0000000000000000001';
  const both = { raw: `send:scope:${second}`, index: `message:scope:${second}` };
  const { key: other } = await register(ledger, second, digest('5'), 300, both) as { key: string };
  await ledger.releaseSend('mailbox-a', second, 'all', 400);
  assert.deepEqual(states(await ledger.holders(other)), [`${both.index}=tombstone`, `${both.raw}=tombstone`]);
  assert.deepEqual(await generation(ledger, other), { key: other, holder_count: 0, last_ref_at: 400, retry_at: null });
  assert.deepEqual(await register(ledger, second, digest('5'), 500, both), { state: 'released' });
  assert.equal((await generation(ledger, other))?.holder_count, 0);
  assert.deepEqual(await ledger.sweep(400 + RETENTION), [other], 'the unheld generation is swept after the grace');
  assert.deepEqual(await ledger.sweep(400 + RETENTION + DAY), [other]);
  assert.equal(await generation(ledger, other), null);
  assert.deepEqual(await ledger.holders(other), [], 'its tombstones went with it');
});

test('releaseSend before any registration leaves a tombstone, so an in-flight registerSend adds nothing', async () => {
  const ledger = fresh();
  await ledger.releaseSend('mailbox-a', SEND, 'all', 100);
  assert.deepEqual(JSON.parse(await ledger.registration('mailbox-a', SEND)),
    { digest: null, key: null, raw_holder: null, index_holder: null, released: 'all' });
  assert.deepEqual(await register(ledger, SEND, digest('6'), 200), { state: 'released' });
  assert.deepEqual(await ledger.holders(), []);
  assert.deepEqual(await ledger.candidates(200 + RETENTION), [], 'no generation was minted');
});

test('the second delete removes an object recreated between the two deletes, and only then drops the row', async () => {
  const ledger = fresh();
  const { old, due } = await unheld(ledger, digest('7'));
  await ledger.putObject(old);
  assert.deepEqual(await ledger.sweepStore(due), [old]);
  assert.equal(await ledger.hasObject(old), false);
  assert.equal(await ledger.deletedAt(old), due);
  assert.equal((await generation(ledger, old))?.retry_at, due + DAY, 'the row stays retired for the second delete');
  // A late PUT, started before the holders were released, lands now.
  await ledger.putObject(old);
  // During the 24 hours, every new hold for this digest lands on a new key.
  const registered = await register(ledger, SEND, digest('7'), due + 60_000);
  assert.equal(registered.state, 'registered');
  assert.notEqual(registered.key, old);
  assert.equal(await ledger.register('raw', digest('7'), 'delivery:2', due + 60_000), registered.key);
  assert.equal(await ledger.holdProvisional({ kind: 'raw', digest: digest('7') }, 'draft:scope:d:r', due + 60_000), registered.key);
  assert.match(await ledger.failure('hold', old, 'delivery:3', due + 60_000), /generation unavailable/);
  assert.deepEqual(await ledger.sweepStore(due + DAY - 1), []);
  assert.equal(await ledger.hasObject(old), true);
  assert.deepEqual(await ledger.sweepStore(due + DAY), [old]);
  assert.equal(await ledger.hasObject(old), false, 'the recreated object is gone after the second delete');
  assert.equal(await generation(ledger, old), null, 'and the ledger row is dropped only then');
  assert.equal((await generation(ledger, registered.key!))?.holder_count, 4);
});

test('a failed second delete keeps the row and retries with backoff', async () => {
  const ledger = fresh();
  const { old, due } = await unheld(ledger, digest('8'));
  await ledger.sweep(due);
  assert.deepEqual(await ledger.sweep(due + DAY, 'fail'), [old]);
  assert.ok((await generation(ledger, old))?.retry_at! > due + DAY);
  assert.equal(await ledger.deletedAt(old), due);
  assert.deepEqual(await ledger.sweep(due + 2 * DAY), [old]);
  assert.equal(await generation(ledger, old), null);
});

test('registerSend and releaseSend refuse malformed input before any write', async () => {
  const ledger = fresh();
  assert.match(await ledger.failure('registerSend' as never, 'mailbox-a', 'bad id!', digest('9'), holders, 100), /Invalid sweeper reference/);
  assert.match(await ledger.failure('registerSend' as never, 'mailbox-a', SEND, 'nothex', holders, 100), /Invalid mail object digest/);
  assert.match(await ledger.failure('registerSend' as never, 'mailbox-a', SEND, digest('9'), { raw: 'x', index: 'x' }, 100), /Invalid sweeper reference/);
  assert.match(await ledger.failure('releaseSend' as never, 'mailbox-a', SEND, 'some', 100), /Invalid sweeper reference/);
  assert.equal(await ledger.registration('mailbox-a', SEND), 'null');
});

test('the second delete is a day after the first DELETE was confirmed, not after the sweep started', async () => {
  const ledger = fresh();
  const { old, due } = await unheld(ledger, digest('a'));
  await ledger.sweepConfirmedLate(due, 5 * 60_000);
  assert.equal(await ledger.deletedAt(old), due + 5 * 60_000);
  assert.equal((await generation(ledger, old))?.retry_at, due + 5 * 60_000 + DAY);
  assert.deepEqual(await ledger.sweep(due + DAY), [], 'not yet a day after the confirmation');
  assert.deepEqual(await ledger.sweep(due + 5 * 60_000 + DAY), [old]);
  assert.equal(await generation(ledger, old), null);
});
