import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response, type Request } from 'miniflare';
import type { TimerMailbox } from './fixtures/mailbox-timers.ts';
import { migrateDirectory, seedDirectory } from './fixtures/directory-db.ts';
import { mailboxName } from '../src/worker.ts';

type Row = { due_at: number; kind: string; ref: string };
type Fired = { label: string; kind: string; ref: string; now: number };
const scope = ['workspace', 'mailbox'] as const;
const RETRY_MS = 60_000;

async function setup(t: TestContext) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/mailbox-timers.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false });
  const alerts: unknown[] = [];
  const alertGate: { entered?: PromiseWithResolvers<void>; release?: PromiseWithResolvers<void> } = {};
  const runtime = new Miniflare({ modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle.outputFiles[0].text }],
    compatibilityDate: '2025-06-01', durableObjects: {
      MAILBOX: { className: 'TimerMailbox', useSQLite: true }, SWEEPER: { className: 'UnusedSweeper', useSQLite: true },
    },
    bindings: { MAIL_BACKEND_ENABLED: 'on', MAIL_RECOVERY_ENABLED: 'on', KOFRA_S3_ENDPOINT: 'https://s3.invalid',
      KOFRA_S3_ACCESS_KEY_ID: 'fixture', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture' },
    r2Buckets: ['MAIL_STATE'], d1Databases: ['DIRECTORY'],
    serviceBindings: { ALERTS: async (request: Request) => {
      alerts.push(await request.json());
      alertGate.entered?.resolve();
      await alertGate.release?.promise;
      return new Response(null, { status: 202 });
    } },
  });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('DIRECTORY') as unknown as D1Database;
  await migrateDirectory(db);
  await seedDirectory(db, scope[0], [scope[1]]);
  const boxes = await runtime.getDurableObjectNamespace('MAILBOX') as unknown as { getByName(name: string): TimerMailbox };
  const stub = () => boxes.getByName(mailboxName(...scope));
  const box = stub();
  const bucket = await runtime.getR2Bucket('MAIL_STATE');
  return {
    box, stub, alerts, alertGate, bucket,
    rows: async (target = box) => JSON.parse(await target.rows()) as Row[],
    fired: async (target = box) => JSON.parse(await target.fired()) as Fired[],
    lifecycle: async (target = box) => JSON.parse(await target.lifecycle()) as { state: string; phase?: string },
  };
}

const lane = (rows: Row[]) => rows.find(row => row.kind === 'journal_flush' && row.ref === 'lane');

test('two timers of different kinds both fire in one alarm', async t => {
  const { box, rows, fired } = await setup(t);
  await box.setup('ready');
  const due = Date.now() - 1;
  await box.schedule('test_a', 'one', due);
  await box.schedule('test_b', 'two', due);
  await box.run('first');
  assert.deepEqual((await fired()).map(({ label, kind, ref }) => [label, kind, ref]),
    [['first', 'test_a', 'one'], ['first', 'test_b', 'two']]);
  assert.deepEqual(await rows(), []);
  assert.equal(await box.alarmAt(), null, 'no row left, so no wake-up');
});

test('the journal_flush row and another kind share one alarm, each at its own deadline', async t => {
  const { box, rows, fired, bucket } = await setup(t);
  const id = await box.setup('ready');
  const before = Date.now();
  await box.setLabel(...scope, 'edit', 'Edit');
  const flush = lane(await rows());
  assert.ok(flush, 'an edit schedules the journal_flush row');
  assert.ok(flush.due_at >= before + 45_000 && flush.due_at <= Date.now() + 45_000, 'the settings recovery point less the publish budget');
  await box.schedule('test_a', 'later', flush.due_at + 1_000);
  assert.equal(await box.alarmAt(), flush.due_at, 'the alarm is the earliest row');
  assert.equal(lane(await rows())?.due_at, flush.due_at);

  // Both rows are due: one alarm runs the journal lane and the other kind.
  await box.setClockOffset(flush.due_at + 1_000 - Date.now());
  await box.run('due');
  assert.deepEqual((await fired()).map(({ label, ref }) => [label, ref]), [['due', 'later']]);
  const manifest = await bucket.get(`journal/${id}/manifest.json`);
  assert.equal((JSON.parse(await manifest!.text()) as { last_seq: number }).last_seq, 1, 'the journal_flush row published the edit');
  const after = await rows();
  assert.deepEqual(after.map(row => row.kind), ['journal_flush']);
  assert.equal(await box.alarmAt(), after[0].due_at);
});

test('deleting one timer leaves the other and re-arms to it', async t => {
  const { box, rows } = await setup(t);
  await box.setup('ready');
  const now = Date.now();
  await box.schedule('test_a', 'first', now + 10 * 60_000);
  await box.schedule('test_b', 'second', now + 20 * 60_000);
  assert.equal(await box.alarmAt(), now + 10 * 60_000);
  await box.cancel('test_a', 'first');
  assert.deepEqual(await rows(), [{ due_at: now + 20 * 60_000, kind: 'test_b', ref: 'second' }]);
  assert.equal(await box.alarmAt(), now + 20 * 60_000, 'the alarm moves later to the remaining row');
  await box.cancel('test_b', 'second');
  assert.equal(await box.alarmAt(), null);
});

test('set replaces a due time and the lower-only variant keeps the earlier one', async t => {
  const { box, rows } = await setup(t);
  await box.setup('ready');
  const now = Date.now();
  await box.schedule('test_a', 'x', now + 30_000);
  await box.schedule('test_a', 'x', now + 90_000, true);
  assert.deepEqual((await rows()).map(row => row.due_at), [now + 30_000]);
  await box.schedule('test_a', 'x', now + 10_000, true);
  assert.deepEqual((await rows()).map(row => row.due_at), [now + 10_000]);
  await box.schedule('test_a', 'x', now + 90_000);
  assert.deepEqual((await rows()).map(row => row.due_at), [now + 90_000]);
  assert.equal(await box.alarmAt(), now + 90_000);
  assert.match(await box.scheduleError('unknown_kind', 'x', now) ?? '', /timer kind/i);
  assert.match(await box.scheduleError('journal_flush', 'lane', now) ?? '', /timer kind/i);
  assert.match(await box.scheduleError('test_a', '', now) ?? '', /timer/i);
});

test('a crash after a handler commit and before re-arm still fires the remaining timers next alarm', async t => {
  const { box, stub, rows, fired } = await setup(t);
  await box.setup('ready');
  const due = Date.now() - 10;
  for (const ref of ['a', 'b', 'c']) await box.schedule('test_a', ref, due);
  await box.plan('a', 'crash');
  const claimedAfter = Date.now();
  await assert.rejects(box.run('crash'));
  const after = stub();
  assert.deepEqual((await fired(after)).map(({ label, ref }) => [label, ref]), [['crash', 'a']], 'the handler commit is durable');
  const left = await rows(after);
  assert.deepEqual(left.map(row => row.ref), ['b', 'c'], 'the crashed run left the other rows');
  const alarm = await after.alarmAt();
  assert.ok(alarm !== null, 'the durable wake-up survives the crash');
  for (const row of left) {
    assert.ok(row.due_at >= claimedAfter + RETRY_MS - 1_000 && row.due_at <= Date.now() + RETRY_MS, 'claimed rows wait one retry interval');
    assert.ok(alarm <= row.due_at, 'the armed alarm is no later than each remaining row');
  }
  await after.setClockOffset(alarm - Date.now() + RETRY_MS);
  await after.run('next');
  assert.deepEqual((await fired(after)).map(({ label, ref }) => [label, ref]), [['crash', 'a'], ['next', 'b'], ['next', 'c']]);
  assert.deepEqual(await rows(after), []);
});

test('1,000 due rows drain in 64-row steps in order, none skipped and none run twice', async t => {
  const { box, rows, fired } = await setup(t);
  await box.setup('ready');
  const base = Date.now() - 60_000;
  await box.seed(1_000, base);
  const expected = (await rows()).map(row => `${row.kind}/${row.ref}`);
  assert.equal(expected.length, 1_000);
  const steps: string[][] = [];
  for (let step = 1; step <= 16; step++) {
    await box.run(`s${step}`);
    const ran = (await fired()).filter(row => row.label === `s${step}`).map(row => `${row.kind}/${row.ref}`);
    steps.push(ran);
    assert.equal(new Set(ran).size, ran.length, `step ${step} ran a row twice`);
    const armed = await box.lastArmed();
    if (step < 16) {
      assert.equal(ran.length, 64, `step ${step} size`);
      assert.ok(armed !== null && armed <= Date.now(), `step ${step} re-arms at once while rows are still due`);
    } else {
      assert.equal(ran.length, 40);
      assert.equal(armed, null, 'nothing left to wake for');
    }
  }
  assert.deepEqual(steps.flat(), expected, 'every row ran exactly once, in (due_at, kind, ref) order');
  assert.deepEqual(await rows(), []);
});

test('a throwing handler neither blocks the other due rows nor spins, and retries after 60 seconds', async t => {
  const { box, rows, fired } = await setup(t);
  await box.setup('ready');
  const due = Date.now() - 10;
  const moved = Date.now() + 5 * 60_000;
  for (const ref of ['a', 'b', 'c', 'd', 'e']) await box.schedule('test_a', ref, due);
  await box.plan('a', 'throw');
  await box.plan('d', 'move-and-throw', moved);
  await box.plan('e', 'keep');
  const before = Date.now();
  await box.run('first');
  const after = Date.now();
  assert.deepEqual((await fired()).map(row => row.ref), ['a', 'b', 'c', 'd', 'e']);
  const left = await rows();
  const at = (ref: string) => left.find(row => row.ref === ref)?.due_at;
  assert.deepEqual(left.map(row => row.ref).sort(), ['a', 'd', 'e']);
  assert.ok(at('a')! >= before + RETRY_MS && at('a')! <= after + RETRY_MS, 'a failed row retries 60 s after it failed');
  assert.equal(at('d'), moved, 'a row the handler moved before failing keeps its new time');
  assert.ok(at('e')! >= before + RETRY_MS - 1_000 && at('e')! <= after + RETRY_MS, 'a row left in place waits one retry interval');
  assert.equal(await box.alarmAt(), Math.min(at('a')!, at('e')!));

  await box.run('again');
  assert.deepEqual((await fired()).filter(row => row.label === 'again'), [], 'an immediate re-run does not spin on failed rows');

  await box.setClockOffset(RETRY_MS + 1_000);
  await box.run('retry');
  assert.deepEqual((await fired()).filter(row => row.label === 'retry').map(row => row.ref).sort(), ['a', 'e']);
});

test('armFor coalescing: later edits never push the journal_flush deadline later', async t => {
  const { box, rows } = await setup(t);
  await box.setup('ready');
  const before = Date.now();
  await box.setFlags(...scope, 'missing-message', 0, []).catch(() => {});
  const flags = lane(await rows());
  assert.ok(flags && flags.due_at >= before + 60 * 60_000 - 15_000, 'a flag edit arms the hourly recovery point');
  await box.setLabel(...scope, 'first', 'First');
  const settings = lane(await rows());
  assert.ok(settings && settings.due_at < flags.due_at && settings.due_at <= Date.now() + 45_000, 'a settings edit pulls it earlier');
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    await box.setLabel(...scope, `edit-${i}`, `Edit ${i}`);
    await box.setFlags(...scope, 'missing-message', 0, []).catch(() => {});
  }
  const rowsAfter = await rows();
  assert.deepEqual(rowsAfter, [settings], 'a stream of edits keeps the first deadline');
  assert.equal(await box.alarmAt(), settings.due_at);
});

test('armSoon during a running alarm still produces an immediate follow-up run', async t => {
  const { box, rows, alertGate, lifecycle } = await setup(t);
  await box.setup('missing');
  alertGate.entered = Promise.withResolvers<void>();
  alertGate.release = Promise.withResolvers<void>();
  const running = box.run('missing');
  await alertGate.entered.promise;
  // The missing mailbox's alarm is blocked sending restore_blocked; an operator bootstrap arrives.
  assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
  alertGate.release.resolve();
  await running;
  const flush = lane(await rows());
  assert.ok(flush && flush.due_at <= Date.now(), 'the follow-up is due now, not after the held recheck');
  const armed = await box.lastArmed();
  assert.ok(armed !== null && armed <= Date.now(), 'the alarm is armed for an immediate run');

  alertGate.entered = undefined;
  alertGate.release = undefined;
  await box.run('follow-up');
  assert.equal((await lifecycle()).state, 'ready', 'the follow-up run completed the bootstrap');
});

test('restore takeover calls every registered rebuild inside the transaction that finishes it', async t => {
  const { box, rows, lifecycle } = await setup(t);
  await box.setup('ready');
  await box.setLabel(...scope, 'kept', 'Kept');
  await box.run('publish');
  await box.wipe();
  // A row left over in the target is local state with no journalled source.
  await box.seedStale('test_b', 'stale', Date.now() + 60_000);
  assert.equal(await box.restoreFromBackup(...scope), 'restoring');

  await box.setRebuildFault(true);
  await box.run('restore-fails');
  const failed = await lifecycle();
  assert.deepEqual([failed.state, failed.phase], ['restoring', 'deliveries'], 'a failed rebuild rolls back the finishing transaction');
  assert.deepEqual(JSON.parse(await box.rebuilds()), []);
  assert.deepEqual((await rows()).map(row => row.kind), ['journal_flush'], 'the reset cleared rows rebuilt from journalled state');

  await box.setRebuildFault(false);
  await box.run('restore');
  assert.equal((await lifecycle()).state, 'ready');
  assert.deepEqual(JSON.parse(await box.labels()), [{ id: 'kept', name: 'Kept' }]);
  assert.deepEqual(JSON.parse(await box.rebuilds()), [{ kind: 'test_a', state: 'ready' }, { kind: 'test_b', state: 'ready' }],
    'each rebuild ran once, after the ready transition in the same transaction');
  const restored = await rows();
  assert.deepEqual(restored.filter(row => row.kind !== 'journal_flush').map(row => `${row.kind}/${row.ref}`),
    ['test_a/rebuilt', 'test_b/rebuilt']);
  assert.ok(lane(restored), 'the journal_flush row survives a restore');
  assert.equal(await box.alarmAt(), Math.min(...restored.map(row => row.due_at)));
});
