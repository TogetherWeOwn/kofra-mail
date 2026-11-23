import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response, type Request } from 'miniflare';
import type { SweepRearm } from './fixtures/sweep-rearm.ts';

async function setup(t: TestContext) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/sweep-rearm.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false });
  const deleted = Promise.withResolvers<string>();
  const alarmComplete = { '/off': Promise.withResolvers<void>(), '/on': Promise.withResolvers<void>() };
  const requests: string[] = [];
  const name = 'sweep-rearm-fixture';
  const runtime = new Miniflare({ name, modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle.outputFiles[0].text }],
    compatibilityDate: '2025-06-01', durableObjects: { SWEEPER: { className: 'SweepRearm', useSQLite: true } },
    bindings: { MAIL_BACKEND_ENABLED: 'on', MAIL_SWEEP_ENABLED: 'off', KOFRA_S3_ENDPOINT: 'https://s3.invalid',
      KOFRA_S3_ACCESS_KEY_ID: 'fixture', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture' },
    serviceBindings: {
      SWEEP_ADMIN: { name, entrypoint: 'MailAdmin' },
      SWEEP_ALARM_COMPLETE: (request: Request) => {
        const { pathname } = new URL(request.url);
        assert.ok(pathname === '/on' || pathname === '/off');
        alarmComplete[pathname].resolve();
        return new Response(null, { status: 204 });
      },
    },
    outboundService: async (request: Request) => {
      assert.equal(request.method, 'DELETE');
      const path = new URL(request.url).pathname;
      requests.push(path);
      deleted.resolve(path);
      return new Response(null, { status: 204 });
    },
  });
  t.after(() => runtime.dispose());
  const boxes = await runtime.getDurableObjectNamespace('SWEEPER') as unknown as { getByName(name: string): SweepRearm };
  const box = boxes.getByName('workspace');
  const key = await box.register('raw', 'b'.repeat(64), 'holder');
  return {
    box, boxes, key, requests, deleted: deleted.promise,
    offAlarmComplete: alarmComplete['/off'].promise, onAlarmComplete: alarmComplete['/on'].promise,
    rearmWorkspace: (workspaceId: string) => runtime.dispatchFetch(`http://fixture.local/rearm/${workspaceId}`, { method: 'POST' }),
  };
}

test('release while sweeping is off leaves an alarm that deletes when enabled without another release', { timeout: 10_000 }, async t => {
  const { box, key, requests, deleted } = await setup(t);
  await box.release(key, 'holder');
  const due = await box.nextSweep();
  assert.ok(due !== null);
  assert.equal(await box.alarmAt(), due);
  assert.deepEqual(requests, []);
  await box.enableSweeping();
  await box.bringDueForward(key);
  assert.equal(await deleted, `/mail-workspace/${key}`);
});

test('an off alarm keeps the ledger armed but never sends DELETE', async t => {
  const { box, key, requests } = await setup(t);
  await box.release(key, 'holder');
  const due = await box.nextSweep();
  await box.evaluateWhileOff();
  assert.equal(await box.alarmAt(), due, 'the later retention deadline controls');
  await box.bringDueForward(key);
  const before = Date.now();
  await box.evaluateWhileOff();
  const after = Date.now();
  const wake = await box.alarmAt();
  const day = 24 * 60 * 60_000;
  assert.ok(wake !== null && wake >= before + day && wake <= after + day);
  assert.deepEqual(requests, []);
});

test('a real alarm while the backend is off re-arms and later sweeps without another release', { timeout: 10_000 }, async t => {
  const { box, key, requests, offAlarmComplete, onAlarmComplete } = await setup(t);
  // Enable the deletion switch so only the backend kill switch blocks DELETE.
  await box.enableSweeping();
  await box.release(key, 'holder');
  await box.setBackendEnabled('off');
  const due = await box.bringDueForward(key);
  await offAlarmComplete;

  assert.deepEqual(requests, [], 'the disabled alarm must not DELETE');
  assert.equal(await box.nextSweep(), due, 'the overdue generation is still pending');
  const wake = await box.alarmAt();
  assert.ok(wake !== null, 'the real disabled alarm must leave another wake-up armed');
  assert.ok(wake >= due + 24 * 60 * 60_000, 'the wake-up is delayed by at least one day');

  await box.setBackendEnabled('on');
  await box.bringAlarmForward(); // Advance only the already-armed wake-up, not the ledger.
  await onAlarmComplete;
  assert.deepEqual(requests, [`/mail-workspace/${key}`]);
  assert.equal(await box.nextSweep(), null, 'confirmed DELETE clears the pending ledger row');
  assert.equal(await box.alarmAt(), null);
});

test('repeated releases with an overdue generation honor the disabled daily wake-up', async t => {
  const off = await setup(t);
  const on = await setup(t);
  await on.box.enableSweeping();
  const sample = async ({ box, key }: typeof off) => JSON.parse(await box.releaseWithOverdueGeneration(key)) as {
    due: number; started: number; finished: number; alarms: Array<number | null>;
  };
  const enabled = await sample(on);
  for (const alarm of enabled.alarms) {
    // workerd clamps an alarm scheduled in the past to an immediate wake-up.
    assert.ok(alarm !== null && alarm >= enabled.due && alarm <= enabled.finished, 'enabled releases arm an immediate wake-up');
  }
  const disabled = await sample(off);
  const day = 24 * 60 * 60_000;
  for (const alarm of disabled.alarms) {
    assert.equal(alarm !== null && alarm >= disabled.started + day && alarm <= disabled.finished + day,
      true, 'disabled releases arm an alarm 24 hours ahead, not at the overdue time');
  }
  assert.deepEqual(off.requests, []);
});

test('rearm restores a legacy ledger wake-up and is idempotent', async t => {
  const { box, key } = await setup(t);
  await box.rearmLedger();
  assert.equal(await box.alarmAt(), null, 'a holder is still active');
  await box.legacyRelease(key);
  assert.equal(await box.alarmAt(), null);
  const due = await box.nextSweep();
  assert.ok(due !== null);
  await box.rearmLedger();
  assert.equal(await box.alarmAt(), due);
  await box.rearmLedger();
  assert.equal(await box.alarmAt(), due);
});

test('MailAdmin.rearmSweeper arms the requested workspace from its ledger', async t => {
  const { box, boxes, key, requests, rearmWorkspace } = await setup(t);
  const other = boxes.getByName('neighbor');
  await other.legacyRelease(await other.register('raw', 'b'.repeat(64), 'holder'));
  await box.legacyRelease(key);
  const due = await box.nextSweep();
  assert.ok(due !== null);
  assert.equal(await box.alarmAt(), null);
  assert.equal(await other.alarmAt(), null);

  const response = await rearmWorkspace('workspace');
  assert.equal(response.status, 204, await response.text());
  assert.equal(await box.alarmAt(), due);
  assert.equal(await other.alarmAt(), null, 'another workspace does not gain an alarm');
  assert.deepEqual(requests, [], 'retention still controls deletion');
});
