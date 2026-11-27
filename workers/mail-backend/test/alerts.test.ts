import assert from 'node:assert/strict';
import test from 'node:test';
import { mailAlert } from '../src/alerts.ts';

test('a send-invariant alert describes the release hold without assuming a registration', async () => {
  let payload: unknown;
  const send = mailAlert({ async fetch(_request, init) {
    payload = JSON.parse(String(init?.body));
    return new Response(null, { status: 204 });
  } });
  await send({ code: 'send_invariant', key: 'mailbox-fixture' });
  assert.deepEqual(payload, {
    source: 'mail:send_invariant', key: 'mailbox-fixture', title: 'A send is held after a release invariant failed',
  });
});
