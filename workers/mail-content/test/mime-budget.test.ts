import assert from 'node:assert/strict';
import test from 'node:test';

import { reserveMime } from '../src/mime-budget.ts';
const mib = 1024 * 1024;
const next = () => Promise.resolve();

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
