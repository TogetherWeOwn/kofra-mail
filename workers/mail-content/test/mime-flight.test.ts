import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as next } from 'node:timers/promises';
import { MAX_RAW_BYTES } from '../../mail-backend/src/bytes.ts';
import { MimeBusy, mimeBudgetUsage, reserveMime } from '../src/mime-budget.ts';
import { shareMime } from '../src/mime-flight.ts';
import type { MailMime } from '../src/object-reader.ts';

const mail = { html: '<p>fixture</p>' } as MailMime;

for (const stage of ['load', 'prepare'] as const) test(`an abort retains the raw reservation until active ${stage} settles`, async () => {
  const abort = new AbortController();
  const entered = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<void>();
  const active = shareMime(`workspace/raw/${stage}`, 'account', abort.signal, async install => {
    install((await reserveMime(16, abort.signal))());
    if (stage === 'load') { entered.resolve(); await settle.promise; }
    return mail;
  }, async () => {
    if (stage === 'prepare') { entered.resolve(); await settle.promise; }
    return 'rendered';
  });
  let stoppedWaiting = false;
  const consumed = assert.rejects(active, { name: 'AbortError' }).then(() => { stoppedWaiting = true; });
  try {
    await entered.promise;
    abort.abort();
    await next();
    assert.equal(mimeBudgetUsage().inFlight, 16);
    assert.equal(stoppedWaiting, true, 'the cancelled response no longer awaits the active work');
  } finally { settle.resolve(); await consumed; await next(); }
  assert.equal(mimeBudgetUsage().inFlight, 0);
});

test('an aborted leader does not discard a successful parse for a live CID member', async () => {
  const abort = new AbortController();
  const entered = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<void>();
  const leader = shareMime('workspace/raw/cancelled-leader', 'account', abort.signal, async install => {
    install((await reserveMime(16, abort.signal))());
    entered.resolve();
    await settle.promise;
    return mail;
  }, () => assert.fail('the aborted leader cannot prepare a response'), 'cid');
  const cancelled = assert.rejects(leader, { name: 'AbortError' });
  await entered.promise;
  const survivor = shareMime('workspace/raw/cancelled-leader', 'account', new AbortController().signal,
    async () => assert.fail('the survivor must use the existing parse'), value => value.html, 'cid');
  void survivor.catch(() => {});
  try {
    await next();
    abort.abort();
    assert.equal(mimeBudgetUsage().inFlight, 16);
  } finally { settle.resolve(); await cancelled; }
  assert.equal(await survivor, mail.html);
  assert.equal(mimeBudgetUsage().inFlight, 0);
});

test('a stalled flight continues for live followers when only the leader cancels', async () => {
  const leaderSignal = new AbortController();
  const entered = Promise.withResolvers<void>();
  const origin = Promise.withResolvers<MailMime>();
  let source: AbortSignal | undefined;
  const leader = shareMime('workspace/raw/stalled-origin', 'first-account', leaderSignal.signal,
    async (install: (release: () => void) => void, _: number, signal = leaderSignal.signal) => {
      source = signal;
      install((await reserveMime(16, signal))());
      const abort = () => origin.reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      entered.resolve();
      try { return await origin.promise; }
      finally { signal.removeEventListener('abort', abort); }
    }, () => assert.fail('the cancelled leader must not prepare a response'), 'cid');
  const cancelled = assert.rejects(leader, { name: 'AbortError' });
  await entered.promise;
  const followers = Promise.all(['first-account', 'other-account'].map(sub =>
    shareMime('workspace/raw/stalled-origin', sub, new AbortController().signal,
      async () => assert.fail('a follower must not open another read'), value => value.html, 'cid')));
  void followers.catch(() => {});
  try {
    await next();
    leaderSignal.abort();
    await next();
    assert.equal(source?.aborted, false, 'the shared origin read stays live for followers');
    assert.equal(mimeBudgetUsage().inFlight, 16);
  } finally {
    origin.resolve(mail);
    await cancelled;
    await followers.catch(() => {});
  }
  assert.deepEqual(await followers, [mail.html, mail.html]);
  assert.equal(mimeBudgetUsage().inFlight, 0);
});

test('the last cancelled member aborts the shared origin but keeps its charge until settlement', async () => {
  const first = new AbortController();
  const second = new AbortController();
  const entered = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<void>();
  let source: AbortSignal | undefined;
  const lead = shareMime('workspace/raw/all-cancelled', 'account', first.signal,
    async (install: (release: () => void) => void, _: number, signal = new AbortController().signal) => {
      source = signal;
      install((await reserveMime(16, signal))());
      entered.resolve();
      await settle.promise;
      signal.throwIfAborted();
      return mail;
    }, () => assert.fail('cancelled leader should not prepare'));
  const leadCancelled = assert.rejects(lead, { name: 'AbortError' });
  await entered.promise;
  const follow = shareMime('workspace/raw/all-cancelled', 'account', second.signal,
    async () => assert.fail('the follower must not open another read'), () => assert.fail('cancelled follower should not prepare'));
  const followCancelled = assert.rejects(follow, { name: 'AbortError' });
  try {
    await next();
    first.abort();
    await next();
    assert.equal(source?.aborted, false);
    second.abort();
    await next();
    assert.equal(source?.aborted, true);
    assert.equal(mimeBudgetUsage().inFlight, 16);
  } finally { settle.resolve(); await Promise.all([leadCancelled, followCancelled]); await next(); }
  assert.equal(mimeBudgetUsage().inFlight, 0);
});

for (const cancelled of [false, true]) test(`a lost continuation ${cancelled ? 'after cancellation' : 'with a live member'} frees its reservation at 30 seconds`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const warn = t.mock.method(console, 'warn', () => {});
  const entered = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<void>();
  const member = new AbortController();
  const attempt = shareMime('workspace/raw/lost', 'account', member.signal,
    async (install: (release: () => void) => void, _: number, signal = member.signal) => {
      install((await reserveMime(16, signal))());
      entered.resolve();
      await settle.promise; // Simulate a continuation that never observes cancellation.
      return mail;
    }, () => 'unexpected');
  let outcome = 'pending';
  const observed = attempt.then(() => { outcome = 'resolved'; }, error => { outcome = error.name; });
  try {
    await entered.promise;
    if (cancelled) {
      member.abort();
      await observed;
      assert.equal(outcome, 'AbortError');
    }
    t.mock.timers.tick(29_999);
    await next();
    assert.equal(mimeBudgetUsage().inFlight, 16);
    t.mock.timers.tick(1);
    await next();
    assert.equal(mimeBudgetUsage().inFlight, 0);
    assert.equal(outcome, cancelled ? 'AbortError' : 'TimeoutError');
    assert.deepEqual(warn.mock.calls.map(call => call.arguments), [
      [JSON.stringify({ metric: 'mail_content_mime_flight_watchdog', count: 1 })],
    ]);
  } finally { settle.resolve(); await observed; await next(); }
  assert.equal(mimeBudgetUsage().inFlight, 0);
});

test('the shared loader signal has its own 25-second timeout from load start', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const entered = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<void>();
  const member = new AbortController();
  let source: AbortSignal | undefined;
  const leader = shareMime('workspace/raw/load-deadline', 'account', member.signal,
    async (install: (release: () => void) => void, _: number, signal = member.signal) => {
      source = signal;
      install((await reserveMime(16, signal))());
      entered.resolve();
      await settle.promise;
      signal.throwIfAborted();
      return mail;
    }, () => 'unexpected');
  const outcome = leader.then(() => 'resolved', error => error.name);
  try {
    await entered.promise;
    t.mock.timers.tick(24_999);
    await next();
    assert.equal(source?.aborted, false);
    t.mock.timers.tick(1);
    await next();
    assert.equal(source?.aborted, true);
    assert.equal(source?.reason?.name, 'TimeoutError');
    assert.equal(mimeBudgetUsage().inFlight, 16);
  } finally { settle.resolve(); await outcome; await next(); }
  assert.equal(await outcome, 'TimeoutError');
  assert.equal(mimeBudgetUsage().inFlight, 0);
});

for (const bothFit of [true, false]) test(`a follower re-leads at 27 seconds and ${bothFit ? 'serves while the stale charge remains' : 'gets 503 from the normal byte gate'}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const warn = t.mock.method(console, 'warn', () => {});
  const entered = Promise.withResolvers<void>();
  const lost = Promise.withResolvers<void>();
  const key = 'workspace/raw/generations';
  const oldBytes = bothFit ? 16 : MAX_RAW_BYTES;
  const signal = new AbortController().signal;
  const leader = shareMime(key, 'account', signal,
    async (install: (release: () => void) => void, _: number, controller = signal) => {
      install((await reserveMime(oldBytes, controller))());
      entered.resolve();
      await lost.promise; // The old producer is not available to observe its timeout.
      return mail;
    }, () => 'stale response', 'cid');
  const leaderDone = leader.then(() => {}, () => {});
  await entered.promise;
  let successorAttempts = 0;
  let heldTogether = 0;
  const follower = shareMime(key, 'account', signal,
    async (install: (release: () => void) => void, wait: number, controller = signal) => {
      successorAttempts++;
      install((await reserveMime(16, controller, wait))());
      heldTogether = mimeBudgetUsage().inFlight;
      return { ...mail, html: 'fresh generation' };
    }, parsed => parsed.html, 'cid');
  let outcome: unknown = 'pending';
  const followerDone = follower.then(value => { outcome = value; }, error => { outcome = error; });
  try {
    await next();
    t.mock.timers.tick(26_999);
    await next();
    assert.equal(successorAttempts, 0);
    assert.equal(outcome, 'pending');
    t.mock.timers.tick(1);
    await next();
    assert.equal(successorAttempts, 1);
    if (bothFit) {
      assert.equal(heldTogether, oldBytes + 16);
      assert.equal(outcome, 'fresh generation');
      t.mock.timers.tick(2_000);
    } else {
      assert.equal(outcome, 'pending');
      t.mock.timers.tick(1_999);
      await next();
      assert.equal(outcome, 'pending');
      t.mock.timers.tick(1);
      await next();
      assert.ok((outcome as unknown) instanceof MimeBusy);
    }
    assert.equal(mimeBudgetUsage().inFlight, oldBytes);
    t.mock.timers.tick(1_000);
    await next();
    assert.equal(mimeBudgetUsage().inFlight, 0);
    assert.equal(warn.mock.callCount(), 1);
  } finally { lost.resolve(); await Promise.all([leaderDone, followerDone]); await next(); }
});

test('a follower of a failed load retries once and reports capacity unavailable if its own load fails', async () => {
  const signal = new AbortController().signal;
  const entered = Promise.withResolvers<void>();
  const fail = Promise.withResolvers<void>();
  const key = 'workspace/raw/failed-load';
  const leader = shareMime(key, 'first-account', signal, async () => {
    entered.resolve();
    await fail.promise;
    throw new Error('the first load failed');
  }, () => 'unexpected');
  const leaderDone = assert.rejects(leader, /first load failed/);
  await entered.promise;
  let attempts = 0;
  const follower = shareMime(key, 'other-account', signal, async () => {
    attempts++;
    throw new Error('the second load failed');
  }, () => 'unexpected');
  const followerDone = follower.then(() => ({ resolved: true }), error => ({ error }));
  await next();
  fail.resolve();
  await leaderDone;
  const result = await followerDone;
  assert.equal(attempts, 1);
  assert.ok('error' in result && result.error instanceof MimeBusy);
});

test('a settled load keeps all bytes during prepare past 75 seconds and blocks another reservation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const warn = t.mock.method(console, 'warn', () => {});
  const entered = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<void>();
  const signal = new AbortController().signal;
  const preparing = shareMime('workspace/raw/long-prepare', 'account', signal, async install => {
    install((await reserveMime(MAX_RAW_BYTES, signal))());
    return mail;
  }, async () => { entered.resolve(); await settle.promise; return 'prepared'; });
  const observed = preparing.then(value => value, error => error);
  try {
    await entered.promise;
    t.mock.timers.tick(75_001);
    await next();
    assert.equal(mimeBudgetUsage().inFlight, MAX_RAW_BYTES);
    assert.equal(warn.mock.callCount(), 0);
    let second: unknown = 'pending';
    void reserveMime(MAX_RAW_BYTES, signal).then(claim => { claim()(); second = 'admitted'; }, error => { second = error; });
    t.mock.timers.tick(1_999);
    await next();
    assert.equal(second, 'pending');
    t.mock.timers.tick(1);
    await next();
    assert.ok((second as unknown) instanceof MimeBusy);
    assert.equal(mimeBudgetUsage().inFlight, MAX_RAW_BYTES);
  } finally { settle.resolve(); await observed; }
  assert.equal(await observed, 'prepared');
  assert.equal(mimeBudgetUsage().inFlight, 0);
});

test('a request arriving after load waits for the previous prepare then starts a new flight', async () => {
  const signal = new AbortController().signal;
  const entered = Promise.withResolvers<void>();
  const settle = Promise.withResolvers<void>();
  let loads = 0;
  const load = async (install: (release: () => void) => void) => {
    loads++;
    install((await reserveMime(16, signal))());
    return mail;
  };
  const first = shareMime('workspace/raw/same', 'account', signal, load, async () => {
    entered.resolve();
    await settle.promise;
    return 'first';
  });
  await entered.promise;
  const second = shareMime('workspace/raw/same', 'account', signal, load, () => 'second');
  let outcome = 'pending';
  const observed = second.then(value => { outcome = value; }, () => { outcome = 'rejected'; });
  try {
    await next();
    assert.equal(outcome, 'pending');
    assert.equal(loads, 1);
  } finally { settle.resolve(); await first; await observed; }
  assert.equal(outcome, 'second');
  assert.equal(loads, 2);
});
