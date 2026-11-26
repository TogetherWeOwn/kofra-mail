import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as next } from 'node:timers/promises';

import { MimeBusy, reserveMime } from '../src/mime-budget.ts';
const mib = 1024 * 1024;

test('large concurrent MIME reads wait while the current response owns its byte reservation', async () => {
  const controller = new AbortController();
  const first = (await reserveMime(24 * mib, controller.signal))();
  let started = false;
  const second = reserveMime(24 * mib, controller.signal).then(release => { started = true; return release; });
  await next();
  assert.equal(started, false);
  first();
  (await second)()();
});

test('small reads can overlap and larger reads queue at the total raw MIME limit', async () => {
  const controller = new AbortController();
  const first = (await reserveMime(12 * mib, controller.signal))();
  const second = (await reserveMime(12 * mib, controller.signal))();
  let started = false;
  const third = reserveMime(2 * mib, controller.signal).then(release => { started = true; return release; });
  await next();
  assert.equal(started, false);
  second();
  (await third)()();
  first();
});

test('a disconnected request releases a grant it did not claim', async () => {
  const abandoned = new AbortController();
  const claim = await reserveMime(25 * mib, abandoned.signal);
  abandoned.abort();
  assert.throws(() => claim(), { name: 'AbortError' });
  const ready = await reserveMime(25 * mib, new AbortController().signal);
  ready()();
});

test('a saturated waiter stays pending at 1,999 ms and gets MimeBusy at 2,000 ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const signal = new AbortController().signal;
  const done = (await reserveMime(25 * mib, signal))();
  let outcome: unknown = 'pending';
  const waiter = reserveMime(1, signal).then(claim => { claim()(); outcome = 'granted'; }, error => { outcome = error; });
  try {
    t.mock.timers.tick(1_999);
    await next();
    assert.equal(outcome, 'pending');
    t.mock.timers.tick(1);
    await next();
    assert.ok((outcome as unknown) instanceof MimeBusy, 'the saturated request must settle at the exact deadline');
  } finally { done(); await waiter; }
});

test('a cancelled waiter never takes capacity and cannot strand the next waiter', async () => {
  const controller = new AbortController();
  const first = (await reserveMime(25 * mib, controller.signal))();
  const cancelled = new AbortController();
  const second = reserveMime(25 * mib, cancelled.signal);
  const third = reserveMime(25 * mib, controller.signal);
  cancelled.abort();
  await assert.rejects(second, { name: 'AbortError' });
  first();
  (await third)()();
});
