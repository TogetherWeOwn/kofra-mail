import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response, type Request } from 'miniflare';
import type { TimerMailbox } from './fixtures/mailbox-timers.ts';
import { migrateDirectory, seedDirectory } from './fixtures/directory-db.ts';
import { mailboxName } from '../src/worker.ts';

type Row = { due_at: number; kind: string; ref: string };
type Fired = { label: string; kind: string; ref: string; now: number; flushed: number };
const scope = ['workspace', 'mailbox'] as const;
const RETRY_MS = 60_000;
const LEASE_MS = 5 * 60_000;
const HELD_MS = 15 * 60_000;

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
    labels: async (target = box) => JSON.parse(await target.labels()) as Array<{ id: string; name: string }>,
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

test('a crash after a handler commit and before re-arm still fires the remaining timers next alarm', { timeout: 20_000 }, async t => {
  const { box, stub, rows, fired } = await setup(t);
  await box.setup('ready');
  // A shortened retry lets the platform itself deliver the successor alarm.
  await box.setRetry(2_000);
  const due = Date.now() - 10;
  for (const ref of ['b', 'c']) await box.seedStale('test_a', ref, due);
  await box.plan('a', 'crash');
  // The handler of `a` commits directly and resets the object before any re-arm.
  await box.dispatchAlarms('crash', 'successor', 'spare-1', 'spare-2');
  const claimedAfter = Date.now();
  // Arming the first row lets the platform fire the alarm.
  await box.schedule('test_a', 'a', due);
  const poll = async <T>(read: (target: typeof box) => Promise<T>, done: (value: T) => boolean, what: string) => {
    const giveUp = Date.now() + 15_000;
    let target = stub();
    for (;;) {
      // Fail within the test's own timeout instead of polling after it.
      assert.ok(Date.now() < giveUp, `timed out waiting for ${what}`);
      try {
        const value = await read(target);
        if (done(value)) return { value, target };
      } catch {
        // A stub to the reset object fails once; take a fresh one.
        target = stub();
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const crashed = await poll(target => fired(target), seen => seen.length >= 1, 'the crash');
  let after = crashed.target;
  assert.deepEqual(crashed.value.map(({ label, ref }) => [label, ref]), [['crash', 'a']], 'the handler commit is durable');
  // Recorded in the crashing handler's committed transaction: the alarm armed at
  // the crash (the successor the claim wrote), and the rows left for it.
  type Run = { label: string | null; at: number };
  const crash = await after.crashState();
  assert.ok(crash && crash.armed !== null, 'a durable successor wake-up was armed when the object crashed');
  const armed = crash.armed;
  assert.deepEqual(crash.rows.map(row => row.ref), ['b', 'c'], 'the crashed run left the other rows');
  for (const row of crash.rows) assert.ok(armed <= row.due_at, 'the armed alarm is no later than each remaining row');
  // The platform delivers that successor; it runs the remaining rows.
  const done = await poll(target => fired(target), seen => seen.length >= 3, 'the successor');
  after = done.target;
  assert.deepEqual(done.value.map(({ label, ref }) => [label, ref]), [['crash', 'a'], ['successor', 'b'], ['successor', 'c']]);
  const runs = JSON.parse(await after.alarmRuns()) as Run[];
  assert.deepEqual(runs.map(run => run.label), ['crash', 'successor'], 'the second platform alarm call, not a retry, ran them');
  assert.ok(runs[1].at >= armed, 'at the successor time armed before the crash');
  assert.ok(armed >= claimedAfter + 2_000 - 50, 'which is the 2 s retry after the claim');
  assert.deepEqual((await rows(after)).filter(row => row.kind !== 'journal_flush'), []);
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
    const writes = (await box.alarmWrites()).count;
    await box.run(`s${step}`);
    const ran = (await fired()).filter(row => row.label === `s${step}`).map(row => `${row.kind}/${row.ref}`);
    steps.push(ran);
    assert.equal(new Set(ran).size, ran.length, `step ${step} ran a row twice`);
    const armed = await box.lastArmed();
    if (step < 16) {
      assert.equal(ran.length, 64, `step ${step} size`);
      assert.ok((await box.alarmWrites()).count > writes, `step ${step} wrote the alarm`);
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
  try {
    // Fail at this checkpoint if the run ends, or stalls, without sending the alert.
    const reached = await Promise.race([alertGate.entered.promise.then(() => 'alert'), running.then(() => 'returned'),
      new Promise(resolve => setTimeout(() => resolve('stalled'), 5_000))]);
    assert.equal(reached, 'alert', 'the missing mailbox alarm sends restore_blocked');
    // The missing mailbox's alarm is blocked sending restore_blocked; an operator bootstrap arrives.
    assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
  } finally {
    alertGate.release.resolve();
  }
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

  await box.setRebuildFault('throw');
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

const published = async (bucket: Awaited<ReturnType<typeof setup>>['bucket'], id: string) => {
  const manifest = await bucket.get(`journal/${id}/manifest.json`);
  return (JSON.parse(await manifest!.text()) as { last_seq: number }).last_seq;
};

test('a timer written by an RPC is armed before the RPC answers', async t => {
  const { box, rows } = await setup(t);
  await box.setup('ready');
  const at = Date.now() + 5 * 60_000;
  await box.schedule('test_a', 'armed', at);
  assert.equal(await box.alarmAt(), at);
  await box.setLabel(...scope, 'edit', 'Edit');
  const flush = lane(await rows());
  assert.ok(flush && flush.due_at < at);
  assert.equal(await box.alarmAt(), flush.due_at, 'an edit arms its journal_flush deadline before it answers');
});

test('a due journal_flush runs first, even behind more than 64 earlier due rows', async t => {
  const { box, rows, fired, bucket } = await setup(t);
  const id = await box.setup('ready');
  await box.setLabel(...scope, 'edit', 'Edit');
  await box.seed(100, Date.now() - 60_000);
  await box.setLaneDue(Date.now() - 1);
  await box.run('first');
  assert.equal(await published(bucket, id), 1);
  const ran = (await fired()).filter(row => row.label === 'first');
  assert.equal(ran.length, 63, 'journal_flush takes one of the 64 places');
  assert.ok(ran.every(row => row.flushed === 1), 'the journal was published before any other handler ran');
  assert.equal((await rows()).filter(row => row.kind !== 'journal_flush').length, 37);
});

test('a journal_flush that falls due after the claim runs before the first other-kind handler', { timeout: 10_000 }, async t => {
  const { box, fired, alertGate, bucket } = await setup(t);
  const id = await box.setup('ready', true);
  // Rows are claimed a minute ahead, so an edit armed mid-run is already due for the dispatcher.
  await box.setClockOffset(60_000);
  await box.setLaneDue(Date.now() - 1);
  await box.schedule('test_a', 'next', Date.now() - 1);
  alertGate.entered = Promise.withResolvers<void>();
  alertGate.release = Promise.withResolvers<void>();
  const run = box.run('first');
  // The claimed journal_flush runs first and is sending its backup_stale alert.
  await alertGate.entered.promise;
  await box.setLabel(...scope, 'edit', 'Edit');
  alertGate.release.resolve();
  await run;
  assert.deepEqual((await fired()).map(row => [row.ref, row.flushed]), [['next', 1]],
    'the journal deadline that fell due after the claim ran before the other handler started');
  assert.equal(await published(bucket, id), 1);
});

test('an in-flight call blocks a new start only for its lease, and its late settle keeps the newer entry', { timeout: 10_000 }, async t => {
  const { box, fired } = await setup(t);
  await box.setup('ready');
  await box.setBudgets(100, 20 * 60_000);
  const due = Date.now() - 1_000;
  await box.schedule('test_a', 'slow', due);
  await box.plan('slow', 'hang', due);
  await box.run('first');
  await box.run('second');
  assert.deepEqual((await fired()).map(row => row.label), ['first'], 'a running call is not started twice');
  // Five minutes later the first call's lease has passed.
  await box.setClockOffset(LEASE_MS + RETRY_MS);
  await box.run('third');
  assert.deepEqual((await fired()).map(row => row.label), ['first', 'third'], 'an expired lease no longer blocks a start');
  // The first call settles: it must not clear the entry the third call holds.
  // Both calls have registered their hang gates (a start is recorded before its gate).
  while (await box.hangCount() < 2) await new Promise(resolve => setTimeout(resolve, 10));
  await box.releaseHang(0);
  // Once an RPC sees the first call finished, its settlement (in the same turn) has been processed.
  while ((await box.handlerState()).running['test_a/slow'] !== 1) await new Promise(resolve => setTimeout(resolve, 10));
  await box.run('fourth');
  assert.deepEqual((await fired()).map(row => row.label), ['first', 'third'], 'the newer call still blocks a start');
  await box.releaseHang();
});

test('an RPC that holds the work lane across the journal deadline cannot start a handler before journal_flush', { timeout: 10_000 }, async t => {
  const { box, fired, bucket } = await setup(t);
  const id = await box.setup('ready');
  await box.setLabel(...scope, 'edit', 'Edit');
  await box.schedule('test_a', 'next', Date.now() - 1_000);
  // Due a minute after the claim on the timer clock; the RPC holding the lane moves that clock past it.
  await box.setBudgets(10 * 60_000, 20 * 60_000);
  await box.setLaneDue(Date.now() + 60_000);
  await box.run('first', { kind: 'hold', ms: 300, advance: 61_000 });
  assert.deepEqual((await fired()).map(row => [row.ref, row.flushed]), [['next', 1]],
    'the journal deadline that passed while the RPC held the lane ran first');
  assert.equal(await published(bucket, id), 1);
});

test('a journal_flush that falls due mid-batch counts against the 64-row cap', { timeout: 10_000 }, async t => {
  const { box, rows, fired, bucket } = await setup(t);
  const id = await box.setup('ready');
  await box.setLabel(...scope, 'edit', 'Edit');
  await box.seed(64, Date.now() - 60_000);
  await box.plan('r0000', 'due-lane');
  await box.run('first');
  assert.equal(await published(bucket, id), 1, 'the journal ran when it fell due');
  assert.equal((await fired()).length, 63, 'the journal run took one of the 64 places');
  const left = (await rows()).filter(row => row.kind !== 'journal_flush');
  assert.equal(left.length, 1);
  assert.ok(left[0].due_at <= Date.now(), 'the unused claim went back to its due time');
  const armed = await box.lastArmed();
  assert.ok(armed !== null && armed <= Date.now(), 'and the successor is armed at once');
});

test('a row replaced at exactly its claimed time is not run early', async t => {
  const { box, rows, fired } = await setup(t);
  await box.setup('ready');
  await box.schedule('test_a', 'x', Date.now() - 1_000);
  await box.run('first', { kind: 'replace', ref: 'x' });
  assert.deepEqual(await fired(), [], 'the replacement, not the claim, governs');
  const row = (await rows()).find(r => r.ref === 'x');
  assert.ok(row && row.due_at > Date.now(), 'the row keeps the time the RPC set');
});

test('a write after an await in a handler step cannot land', async t => {
  const { box, rows } = await setup(t);
  await box.setup('ready');
  await box.schedule('test_a', 'x', Date.now() - 1_000);
  await box.plan('x', 'async-write');
  await box.run('first');
  const { errors } = await box.handlerState();
  assert.ok(errors.includes('Timer steps must be synchronous'), JSON.stringify(errors));
  assert.ok(errors.includes('late write: Mailbox timer step has ended'), JSON.stringify(errors));
  assert.equal((await rows()).find(row => row.ref === 'late'), undefined);
});

test('a handler that throws after losing its race is retried 60 s after the throw', { timeout: 10_000 }, async t => {
  const { box, rows } = await setup(t);
  await box.setup('ready');
  await box.setBudgets(100, 20 * 60_000);
  await box.schedule('test_a', 'x', Date.now() - 1_000);
  await box.plan('x', 'hang-throw');
  await box.run('first');
  const claimed = (await rows()).find(row => row.ref === 'x')!.due_at;
  // The call throws 20 s (on the timer clock) after it lost its race.
  await box.setClockOffset(20_000);
  const thrown = Date.now() + 20_000;
  await box.releaseHang();
  const giveUp = Date.now() + 5_000;
  let due = claimed;
  while (due === claimed && Date.now() < giveUp) {
    await new Promise(resolve => setTimeout(resolve, 20));
    due = (await rows()).find(row => row.ref === 'x')!.due_at;
  }
  assert.ok(due >= thrown + RETRY_MS && due <= Date.now() + 20_000 + RETRY_MS, `due ${due - thrown} ms after the throw`);
});

const FLAGS_DEADLINE_MS = 60 * 60_000 - 15_000;
const SETTINGS_DEADLINE_MS = 60_000 - 15_000;

test('a first flag edit during an init alarm run keeps its exact journal_flush deadline', { timeout: 10_000 }, async t => {
  const { box, rows, lifecycle } = await setup(t);
  const message = '01KBN8ZJ7G0000000000000000';
  await box.seedMessage(message, `raw/${'a'.repeat(64)}/${message}`);
  // No lifecycle yet: the alarm takes the init path while the edit creates the mailbox.
  await box.run('first', { kind: 'edit', message });
  assert.equal((await lifecycle()).state, 'ready');
  assert.equal(await box.messageFlags(message), 1, 'the first write succeeded');
  const window = await box.editTimes();
  assert.ok(window);
  const flush = lane(await rows());
  assert.ok(flush && flush.due_at >= window.before + FLAGS_DEADLINE_MS && flush.due_at <= window.after + FLAGS_DEADLINE_MS,
    `the row carries the edit's own deadline, not the run's fallback (${flush && flush.due_at - window.after} ms)`);
  assert.equal(await box.lastArmed(), flush.due_at, 'and is armed');
});

test('a first label edit during an init alarm run keeps its exact journal_flush deadline', { timeout: 10_000 }, async t => {
  const { box, rows, lifecycle, labels } = await setup(t);
  await box.run('first', { kind: 'edit' });
  assert.equal((await lifecycle()).state, 'ready');
  assert.deepEqual(await labels(), [{ id: 'first', name: 'First' }], 'the first write succeeded');
  const window = await box.editTimes();
  assert.ok(window);
  const flush = lane(await rows());
  assert.ok(flush && flush.due_at >= window.before + SETTINGS_DEADLINE_MS && flush.due_at <= window.after + SETTINGS_DEADLINE_MS,
    `the row carries the edit's own deadline (${flush && flush.due_at - window.after} ms)`);
});

test('a late throw keeps its 60 s retry across an alarm that skipped the still-running call', { timeout: 10_000 }, async t => {
  const { box, rows } = await setup(t);
  await box.setup('ready');
  await box.setBudgets(100, 20 * 60_000);
  await box.schedule('test_a', 'x', Date.now() - 1_000);
  await box.plan('x', 'hang-throw');
  await box.run('first');
  // A minute later the row is due again; the call is still running, so this alarm skips it.
  await box.setClockOffset(RETRY_MS + 1_000);
  await box.run('second');
  // The call throws at 119 s without having moved its row.
  await box.setClockOffset(119_000);
  const thrown = Date.now() + 119_000;
  const skipped = (await rows()).find(row => row.ref === 'x')!.due_at;
  await box.releaseHang();
  const giveUp = Date.now() + 5_000;
  let due = skipped;
  while (due === skipped && Date.now() < giveUp) {
    await new Promise(resolve => setTimeout(resolve, 20));
    due = (await rows()).find(row => row.ref === 'x')!.due_at;
  }
  assert.ok(due >= thrown + RETRY_MS, `the retry is ${Math.round((due - thrown) / 1000)} s after the throw, not at the skipped claim`);
});

test('a stale call that throws late does not delay a replacement of its row', { timeout: 10_000 }, async t => {
  const { box, rows } = await setup(t);
  await box.setup('ready');
  await box.setBudgets(100, 20 * 60_000);
  await box.schedule('test_a', 'x', Date.now() - 1_000);
  await box.plan('x', 'hang-throw');
  await box.run('first');
  // An RPC replaces the row while the first call still runs; the replacement comes due a minute later.
  await box.setClockOffset(RETRY_MS + 1_000);
  await box.schedule('test_a', 'x', Date.now());
  await box.run('second');
  const claimed = (await rows()).find(row => row.ref === 'x')!.due_at;
  // The stale first call throws at 119 s.
  await box.setClockOffset(119_000);
  await box.releaseHang();
  while (!(await box.handlerState()).errors.includes('Fixture late handler failure')) await new Promise(resolve => setTimeout(resolve, 10));
  await box.barrier();
  assert.equal((await rows()).find(row => row.ref === 'x')?.due_at, claimed, 'the replacement keeps its own schedule');
});

test('an eviction does not turn an ordinary timer into a journal_flush row', async t => {
  const { box, stub, rows } = await setup(t);
  await box.setup('ready');
  const at = Date.now() + 10 * 60_000;
  await box.schedule('test_a', 'only', at);
  await assert.rejects(box.evict());
  const after = stub();
  assert.equal(lane(await rows(after)), undefined, 'no journal_flush row is adopted from this version\'s alarm');
  await after.cancel('test_a', 'only');
  assert.deepEqual(await rows(after), []);
  assert.equal(await after.alarmAt(), null);
});

test('an alarm armed by an earlier version becomes the journal_flush row when the object starts', async t => {
  const { box, stub, rows } = await setup(t);
  await box.setup('ready');
  const at = Date.now() + 10 * 60_000;
  await assert.rejects(box.seedLegacyAlarm(at));
  const after = stub();
  assert.deepEqual(lane(await rows(after))?.due_at, at);
  await after.schedule('test_a', 'later', at + 60_000);
  assert.equal(await after.alarmAt(), at, 'a later timer does not drop the earlier deadline');
  await after.cancel('test_a', 'later');
  assert.equal(await after.alarmAt(), at);
});

test('a due row on a mailbox that is not ready is held while journal_flush still runs', async t => {
  const { box, rows, fired, alerts } = await setup(t);
  await box.setup('missing');
  await box.schedule('test_a', 'x', Date.now() - 1_000);
  await box.setLaneDue(Date.now() - 1);
  const before = Date.now();
  await box.run('first');
  assert.deepEqual(await fired(), [], 'no handler runs on a mailbox that is not ready');
  const row = (await rows()).find(r => r.ref === 'x');
  assert.ok(row && row.due_at >= before + HELD_MS && row.due_at <= Date.now() + HELD_MS, 'the row waits the held recheck');
  assert.equal(alerts.length, 1, 'journal_flush ran (it raised restore_blocked)');
});

test('armSoon after a disabled period arms an overdue journal_flush row at once', async t => {
  const { box } = await setup(t);
  await box.setup('missing');
  await box.setLaneDue(Date.now() - 1_000);
  // A disabled alarm moves only the platform alarm, to the held recheck.
  await box.setBackendEnabled(false);
  await box.run('off');
  const held = await box.lastArmed();
  assert.ok(held !== null && held > Date.now() + 60_000);
  await box.setBackendEnabled(true);
  assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
  const armed = await box.lastArmed();
  assert.ok(armed !== null && armed <= Date.now() + 1_000, 'the restore request wakes the mailbox at once, not after the held recheck');
});

test('armSoon keeps a journal_flush wake-up already due within one second', async t => {
  const { box, rows } = await setup(t);
  await box.setup('missing');
  const at = Date.now() + 800;
  await box.setLaneDue(at, true);
  assert.equal(await box.restoreFromBackup(...scope, true), 'restoring');
  assert.equal(lane(await rows())?.due_at, at);
  assert.equal(await box.lastArmed(), at, 'the armed wake-up is kept');
});

test('a hung handler does not delay a journal_flush that is due when the alarm starts', { timeout: 10_000 }, async t => {
  const { box, fired, bucket } = await setup(t);
  const id = await box.setup('ready');
  await box.setBudgets(10 * 60_000, 20 * 60_000);
  await box.setLabel(...scope, 'edit', 'Edit');
  await box.schedule('test_a', 'hung', Date.now() - 1_000);
  await box.plan('hung', 'hang');
  await box.setLaneDue(Date.now() - 1);
  const run = box.run('first');
  // The handler's ten-minute budget is still running; journal_flush has already run.
  while ((await box.handlerState()).active.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await published(bucket, id), 1);
  assert.deepEqual((await fired()).map(row => [row.ref, row.flushed]), [['hung', 1]], 'journal_flush ran before the hung handler');
  await box.releaseHang();
  await run;
});

test('a hung handler does not delay a journal_flush that becomes due while it runs', { timeout: 10_000 }, async t => {
  const { box, fired, bucket } = await setup(t);
  const id = await box.setup('ready');
  // The handler's own budget is ten minutes: only the journal deadline can end its race.
  await box.setBudgets(10 * 60_000, 20 * 60_000);
  await box.setLabel(...scope, 'edit', 'Edit');
  await box.schedule('test_a', 'hung', Date.now() - 1_000);
  await box.plan('hung', 'hang');
  const started = Date.now();
  // Far enough ahead that the handler starts first even on a loaded host.
  await box.setLaneDue(started + 1_500);
  await box.run('first');
  const elapsed = Date.now() - started;
  assert.equal(await published(bucket, id), 1, 'journal_flush ran at its deadline');
  assert.ok(elapsed < 8_000, `the run took ${elapsed} ms`);
  assert.deepEqual((await fired()).map(row => [row.ref, row.flushed]), [['hung', 0]], 'the handler started before the deadline');
  assert.deepEqual((await box.handlerState()).active, ['test_a/hung'], 'the handler is still awaiting');
  await box.releaseHang();
});

test('an RPC that moves journal_flush earlier while a handler hangs runs it at once', { timeout: 10_000 }, async t => {
  const { box, bucket } = await setup(t);
  const id = await box.setup('ready');
  await box.setBudgets(10 * 60_000, 20 * 60_000);
  await box.schedule('test_a', 'hung', Date.now() - 1_000);
  await box.plan('hung', 'hang');
  await box.setLaneDue(Date.now() + 10 * 60_000);
  const run = box.run('first');
  while ((await box.handlerState()).active.length === 0) await new Promise(resolve => setTimeout(resolve, 10));
  // Past the new deadline the edit arms, so the moved deadline is already due.
  await box.setClockOffset(60_000);
  // The edit's work-lane step completes while the handler awaits: the handler does not hold the work lane.
  await box.setLabel(...scope, 'edit', 'Edit');
  await run;
  assert.equal(await published(bucket, id), 1, 'the moved deadline ran journal_flush without waiting for the handler');
  assert.deepEqual((await box.handlerState()).active, ['test_a/hung']);
  await box.releaseHang();
});

test('a handler that lost its race is not started again in this isolate until it settles', { timeout: 10_000 }, async t => {
  const { box, rows, fired } = await setup(t);
  await box.setup('ready');
  await box.setBudgets(100, 20 * 60_000);
  const due = Date.now() - 1_000;
  await box.schedule('test_a', 'slow', due);
  // The handler re-arms its own row (still due) before it hangs.
  await box.plan('slow', 'hang', due);
  await box.run('first');
  assert.equal((await rows()).find(row => row.ref === 'slow')?.due_at, due, 'a lost race keeps the due time the handler set');
  await box.run('second');
  assert.deepEqual((await fired()).map(row => row.label), ['first'], 'the in-flight call is not started twice');
  const waiting = (await rows()).find(row => row.ref === 'slow');
  assert.ok(waiting && waiting.due_at > Date.now(), 'the skipped row waits for its retry instead of spinning');
  await box.releaseHang();
  await box.setClockOffset(RETRY_MS + 1_000);
  await box.plan('slow', 'delete');
  await box.run('third');
  assert.deepEqual((await fired()).map(row => row.label), ['first', 'third'], 'it runs again once the earlier call settled');
  assert.equal((await box.handlerState()).overlaps, 0);
});

test('rows left when the run budget is spent wait for an immediate re-arm', { timeout: 10_000 }, async t => {
  const { box, rows, fired } = await setup(t);
  await box.setup('ready');
  await box.setBudgets(150, 200);
  const due = Date.now() - 1_000;
  for (const ref of ['h1', 'h2', 'h3', 'h4']) {
    await box.schedule('test_a', ref, due);
    await box.plan(ref, 'hang');
  }
  await box.run('first');
  const ran = (await fired()).map(row => row.ref);
  // On a loaded host the claim alone may spend the budget, so none may start.
  assert.ok(ran.length < 4, `ran ${ran.join(',')}`);
  const unstarted = ['h1', 'h2', 'h3', 'h4'].filter(ref => !ran.includes(ref));
  const left = (await rows()).filter(row => row.kind !== 'journal_flush' && !ran.includes(row.ref));
  assert.deepEqual(left.map(row => row.ref).sort(), unstarted, 'every unstarted row is still scheduled');
  assert.ok(left.every(row => row.due_at === due), 'at its original due time');
  const armed = await box.lastArmed();
  assert.ok(armed !== null && armed <= Date.now(), 'and the alarm re-arms at once');
  await box.releaseHang();
});

test('a due time that the platform alarm cannot take is refused before the row is written', async t => {
  const { box, rows } = await setup(t);
  await box.setup('ready');
  for (const at of [0, -5]) assert.match(await box.scheduleError('test_a', 'zero', at) ?? '', /Invalid mailbox timer/);
  assert.deepEqual(await rows(), []);
});

test('an asynchronous rebuild is refused and the restore does not finish without its rows', async t => {
  const { box, rows, lifecycle } = await setup(t);
  await box.setup('ready');
  await box.setLabel(...scope, 'kept', 'Kept');
  await box.run('publish');
  await box.wipe();
  assert.equal(await box.restoreFromBackup(...scope), 'restoring');
  await box.setRebuildFault('async');
  await box.run('restore-async');
  const failed = await lifecycle();
  assert.deepEqual([failed.state, failed.phase], ['restoring', 'deliveries'], 'the ready transition rolled back');
  assert.deepEqual((await rows()).map(row => row.kind), ['journal_flush'], 'no rebuilt row, deferred or not, landed');
  await box.setRebuildFault(false);
  await box.run('restore');
  assert.equal((await lifecycle()).state, 'ready');
});

test('a client call restores a missing journal_flush row even when another timer armed the alarm', async t => {
  const { box, rows } = await setup(t);
  await box.setup('missing');
  await box.schedule('test_a', 'later', Date.now() + 10 * 60_000);
  assert.equal(lane(await rows()), undefined);
  assert.notEqual(await box.alarmAt(), null);
  await box.setLabel(...scope, 'blocked', 'Blocked').catch(() => {});
  const flush = lane(await rows());
  assert.ok(flush && flush.due_at <= Date.now(), 'the journal lane gets a wake-up');
  assert.equal(await box.lastArmed(), flush.due_at, 'armed at once');
});

test('the run budget is checked again after a handler waited for the work lane', { timeout: 10_000 }, async t => {
  const { box, rows, fired } = await setup(t);
  await box.setup('ready');
  await box.setBudgets(10 * 60_000, 60_000);
  const due = Date.now() - 1_000;
  await box.schedule('test_a', 'x', due);
  // The RPC holding the lane moves the timer clock past the run budget.
  await box.run('first', { kind: 'hold', ms: 100, advance: 61_000 });
  assert.deepEqual(await fired(), [], 'no handler starts after the budget');
  assert.equal((await rows()).find(row => row.ref === 'x')?.due_at, due, 'the claim went back to its due time');
});

test('a handler step must be synchronous', async t => {
  const { box, rows } = await setup(t);
  await box.setup('ready');
  await box.schedule('test_a', 'async', Date.now() - 1_000);
  await box.plan('async', 'async-step');
  const before = Date.now();
  await box.run('first');
  assert.deepEqual((await box.handlerState()).errors, ['Timer steps must be synchronous']);
  const row = (await rows()).find(r => r.ref === 'async');
  assert.ok(row && row.due_at >= before + RETRY_MS, 'the refused handler is retried like any failure');
});
