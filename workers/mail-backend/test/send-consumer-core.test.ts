import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import type { ProviderResult } from '../src/mailbox-send-dispatch.ts';
import type { QuotaPort } from '../src/mailbox-send-quota.ts';
import type { ConsumerMailbox, ConsumerPorts, StoredResult } from '../src/send-consumer.ts';

// The mailbox modules use TypeScript syntax Node does not strip, so the core is bundled as the Worker would be.
const bundled = await build({ entryPoints: [fileURLToPath(new NodeURL('../src/send-consumer.ts', import.meta.url))], bundle: true, format: 'esm',
  platform: 'neutral', write: false });
const { classifySend, dispatchSend, storeSendResult, UNCODED } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`) as
  typeof import('../src/send-consumer.ts');

// Unit tests of the dispatch core with stub ports (the acceptance tests run
// against the real Mailbox object in send-consumer.test.ts).

const coded = (code: unknown) => Object.assign(new Error('provider error'), { code });

test('the error table: every documented code has its class, and anything else is ambiguous', () => {
  const rejected = (code: string) => classifySend({ ok: false, error: coded(code) });
  assert.deepEqual(rejected('E_DAILY_LIMIT_EXCEEDED'), { kind: 'provider_daily' });
  assert.deepEqual(rejected('E_RATE_LIMIT_EXCEEDED'), { kind: 'try_later' });
  for (const code of ['E_ACCOUNT_SUSPENDED', 'E_SENDER_NOT_VERIFIED', 'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_SENDER_DOMAIN_NOT_CONFIGURED',
    'E_EMAIL_SENDING_NOT_READY']) assert.deepEqual(rejected(code), { kind: 'outage', code }, code);
  const reasons: Record<string, string> = {
    E_VALIDATION_ERROR: 'rejected', E_RECIPIENT_SUPPRESSED: 'suppressed', E_TOO_MANY_RECIPIENTS: 'too_many_recipients',
    E_TOO_MANY_ATTACHMENTS: 'too_many_attachments', E_CONTENT_TOO_LARGE: 'message_too_large', E_FIELD_MISSING: 'invalid_header',
    E_HEADER_NOT_ALLOWED: 'invalid_header', E_HEADER_USE_API_FIELD: 'invalid_header', E_HEADER_VALUE_INVALID: 'invalid_header',
    E_HEADER_VALUE_TOO_LONG: 'invalid_header', E_HEADER_NAME_INVALID: 'invalid_header', E_HEADERS_TOO_LARGE: 'invalid_header',
    E_HEADERS_TOO_MANY: 'invalid_header',
  };
  for (const [code, reason] of Object.entries(reasons)) assert.deepEqual(rejected(code), { kind: 'rejected', reason }, code);
  assert.deepEqual(rejected('E_INTERNAL_SERVER_ERROR'), { kind: 'ambiguous' }, 'a known ambiguous code raises no unknown-code alert');
  // Not in the table: ambiguous, with the code for the mailbox's unknown-code alert.
  for (const code of ['E_DELIVERY_FAILED', 'E_RECIPIENT_NOT_ALLOWED', 'E_SOMETHING_NEW', 'toString', 'constructor']) {
    assert.deepEqual(rejected(code), { kind: 'ambiguous', code }, code);
  }
  // No usable code: ambiguous and alerted as uncoded.
  for (const error of [new TypeError('bad argument'), new Error('reset'), coded(42), coded('bad code with spaces'), coded('x'.repeat(65)), null, undefined, 'text']) {
    assert.deepEqual(classifySend({ ok: false, error }), { kind: 'ambiguous', code: UNCODED }, String(error));
  }
});

test('a fulfilled call is accepted, with a null id unless it carries a usable one', () => {
  assert.deepEqual(classifySend({ ok: true, value: { messageId: '<abc@example.net>' } }), { kind: 'accepted', messageId: '<abc@example.net>' });
  for (const value of [undefined, null, {}, 'id', { messageId: 7 }, { messageId: '' }, { messageId: 'line\nbreak' }, { messageId: 'x'.repeat(999) }]) {
    assert.deepEqual(classifySend({ ok: true, value }), { kind: 'accepted', messageId: null }, JSON.stringify(value));
  }
});

// A stub mailbox and quota that always let the consumer reach send().
function stubPorts(overrides: Partial<ConsumerPorts> = {}, mailbox: Partial<ConsumerMailbox> = {}) {
  const events: string[] = [];
  const fence = { epoch: 0, attempt: 1 };
  let clock = 1_000_000;
  const box: ConsumerMailbox = {
    claimSend: async () => ({ status: 'claimed', fence, leaseUntil: clock + 300_000, recipients: [{ idx: 0, email: 'a@example.net', field: 'to' }],
      release: [], from: { email: 'me@example.com', name: '' }, replyTo: [], sentCopyKey: null }),
    markSend: async () => ({ status: 'ok' }),
    sendRequest: async () => ({ status: 'ok', request: { from: 'me@example.com', to: 'a@example.net', subject: 's', text: 't', headers: {} } }),
    authorizeDispatch: async () => { events.push('authorize'); return { status: 'ok', remainingMs: 10_000 }; },
    recordResult: async (_ws, _mb, _id, _fence, result) => { events.push(`record:${result.kind}`); return { status: 'recorded' }; },
    delaySend: async (_ws, _mb, _id, _fence, cause) => { events.push(`delay:${cause}`); return { status: 'delayed', until: clock }; },
    abandonClaim: async () => { events.push('abandon'); return { status: 'ok' }; },
    ...mailbox,
  };
  const quota: QuotaPort = {
    reserve: async () => ({ status: 'ok', day: 'd', dayEnd: clock + 86_400_000 }),
    confirm: async () => ({ status: 'ok', day: 'd', dayEnd: clock + 86_400_000 }),
    release: async () => { events.push('release'); },
    resetAt: async () => clock + 86_400_000,
  };
  const ports: ConsumerPorts = {
    mailbox: () => box, quota: () => quota,
    request: (message, f) => box.sendRequest(message.ws, message.mb, message.sendId, f),
    email: () => ({ send: async () => { events.push('send'); return { messageId: 'id' }; } }),
    storeResult: async () => { events.push('store'); },
    notify: async () => { events.push('notify'); },
    now: () => clock,
    ...overrides,
  };
  return { ports, events, advance: (ms: number) => { clock += ms; } };
}
const message = { kind: 'dispatch', ws: 'w1', mb: 'mailbox-a', sendId: '01KBN8ZJ7G0000000000000000' };

test('a synchronous throw from the call is folded into the settled promise, and the deadline check has no await before the call', async () => {
  const { ports, events } = stubPorts({ email: () => ({ send: () => { events.push('send'); throw coded('E_RATE_LIMIT_EXCEEDED'); } }) });
  assert.equal((await dispatchSend(message, ports)).step, 'recorded');
  assert.deepEqual(events, ['authorize', 'send', 'record:try_later']);

  // The clock passes the deadline while the authorization answer is in flight: no call.
  const late = stubPorts({}, { authorizeDispatch: async () => { late.advance(10_000); return { status: 'ok', remainingMs: 10_000 }; } });
  assert.equal((await dispatchSend(message, late.ports)).step, 'abandoned');
  assert.deepEqual(late.events, ['abandon']);
});

test('a failed claim is retried by the queue; a malformed message is acknowledged without a claim', async () => {
  const failing = stubPorts({}, { claimSend: async () => { throw new Error('claim'); } });
  assert.deepEqual(await dispatchSend(message, failing.ports), { ack: false, step: 'claim_failed' });
  const { ports, events } = stubPorts({}, { claimSend: async () => { events.push('claim'); throw new Error('unreachable'); } });
  for (const bad of [null, {}, { ...message, kind: 'result' }, { ...message, sendId: 'not-an-id' }, { ...message, ws: '' }]) {
    assert.deepEqual(await dispatchSend(bad, ports), { ack: true, step: 'invalid' }, JSON.stringify(bad));
  }
  assert.deepEqual(events, []);
});

test('after the authorization only the missed deadline abandons: a failed daily-limit delay is left to the lease', async () => {
  const daily = stubPorts({ email: () => ({ send: async () => { throw coded('E_DAILY_LIMIT_EXCEEDED'); } }) },
    { delaySend: async () => { daily.events.push('delay'); throw new Error('mailbox'); } });
  assert.equal((await dispatchSend(message, daily.ports)).step, 'stale');
  assert.deepEqual(daily.events, ['authorize', 'delay']);
});

test('store-then-notice: the result is stored when recordResult cannot complete, a lost notice still acknowledges, a failed store does not', async () => {
  for (const answer of ['restoring', 'unpublished', 'throw'] as const) {
    const { ports, events } = stubPorts({}, { recordResult: async () => {
      if (answer === 'throw') throw new Error('deploy');
      return { status: answer };
    } });
    assert.equal((await dispatchSend(message, ports)).step, 'stored', answer);
    assert.deepEqual(events, ['authorize', 'send', 'store', 'notify']);
  }
  const lost = stubPorts({ notify: async () => { throw new Error('queue'); } }, { recordResult: async () => ({ status: 'restoring' }) });
  assert.deepEqual(await dispatchSend(message, lost.ports), { ack: true, step: 'stored', fence: { epoch: 0, attempt: 1 } });
  const failed = stubPorts({ storeResult: async () => { throw new Error('d1'); } }, { recordResult: async () => { throw new Error('deploy'); } });
  assert.deepEqual(await dispatchSend(message, failed.ports), { ack: false, step: 'store_failed', fence: { epoch: 0, attempt: 1 } });
});

test('a stale or gone refusal releases that fence once; a stale ambiguous result releases nothing; a stale or gone acceptance is stored; a failed release keeps the charge', async () => {
  for (const status of ['stale', 'gone'] as const) {
    for (const [code, expected] of [['E_RATE_LIMIT_EXCEEDED', ['release']], ['E_SENDER_NOT_VERIFIED', ['release']], ['E_VALIDATION_ERROR', ['release']],
      ['E_INTERNAL_SERVER_ERROR', []], [undefined, ['store', 'notify']]] as const) {
      const { ports, events } = stubPorts({ email: () => ({ send: async () => code === undefined ? { messageId: 'id' } : Promise.reject(coded(code)) }) },
        { recordResult: async () => ({ status }) });
      const outcome = await dispatchSend(message, ports);
      assert.equal(outcome.step, code === undefined ? 'stored' : 'unrecorded', `${status} ${code}`);
      assert.deepEqual(events.filter(event => event !== 'authorize'), expected, `${status} ${code}`);
    }
  }
  const failing = stubPorts({ email: () => ({ send: async () => { throw coded('E_RATE_LIMIT_EXCEEDED'); } }) }, { recordResult: async () => ({ status: 'stale' }) });
  failing.ports.quota = () => ({ ...stubPorts().ports.quota(), release: async () => { throw new Error('quota'); } });
  assert.deepEqual(await dispatchSend(message, failing.ports), { ack: true, step: 'unrecorded', fence: { epoch: 0, attempt: 1 } });
});

test('storeSendResult writes ids, indexes and the provider id only, with notify_after five minutes on', async () => {
  const writes: unknown[][] = [];
  const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ run: async () => { writes.push([sql.includes('ON CONFLICT DO NOTHING'), ...values]); } }) }) };
  const row = (result: ProviderResult): StoredResult => ({ workspaceId: 'w1', mailboxId: 'm', sendId: 's', fence: { epoch: 2, attempt: 3 }, result, createdAt: 1000 });
  for (const result of [{ kind: 'accepted', messageId: 'id', suppressed: [1, 3] }, { kind: 'accepted', messageId: null }, { kind: 'rejected', reason: 'rejected' },
    { kind: 'try_later' }, { kind: 'outage', code: 'E_ACCOUNT_SUSPENDED' }, { kind: 'ambiguous' }, { kind: 'ambiguous', code: 'E_X' }] as ProviderResult[]) {
    await storeSendResult(db as never, row(result));
  }
  assert.deepEqual(writes.map(([conflict, , , , , , kind, messageId, detail, suppressed, created, notify]) => [conflict, kind, messageId, detail, suppressed, created, notify]), [
    [true, 'accepted', 'id', null, 10, 1000, 301_000], [true, 'accepted', null, null, 0, 1000, 301_000], [true, 'rejected', null, 'rejected', 0, 1000, 301_000],
    [true, 'try_later', null, null, 0, 1000, 301_000], [true, 'outage', null, 'E_ACCOUNT_SUSPENDED', 0, 1000, 301_000],
    [true, 'ambiguous', null, null, 0, 1000, 301_000], [true, 'ambiguous', null, 'E_X', 0, 1000, 301_000],
  ]);
});
