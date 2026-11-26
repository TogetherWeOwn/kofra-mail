import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as next } from 'node:timers/promises';
import { mimeBudgetUsage, reserveMime } from '../src/mime-budget.ts';
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
  const consumed = assert.rejects(active, { name: 'AbortError' });
  try {
    await entered.promise;
    abort.abort();
    await next();
    assert.equal(mimeBudgetUsage().inFlight, 16);
  } finally { settle.resolve(); await consumed; }
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
