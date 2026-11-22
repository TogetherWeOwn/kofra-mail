import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { deliver, dlq } from '../src/deliver.ts';
import { receive } from '../src/inbound.ts';
import { Outbox } from '../src/outbox.ts';
import { handleEmail, handleQueue, type Env } from '../src/worker.ts';

const bytes = new TextEncoder().encode('Authentication-Results: mx.cloudflare.net; dmarc=fail\r\nAuthentication-Results: mx.cloudflare.net; dmarc=pass\r\n\r\nhello\n');
const digest = createHash('sha256').update(bytes).digest('hex');
const id = '01KBN8ZJ7G0000000000000000';
const rawKey = `raw/${digest}/${id}`;
const recipient = { workspaceId: 'workspace', mailboxId: 'box' };
const mf = new Miniflare({ modules: true, script: 'export default {};', d1Databases: ['DIRECTORY'] });
let db: D1Database;
before(async () => {
  db = await mf.getD1Database('DIRECTORY') as unknown as D1Database;
  const migration = await readFile(new URL('../migrations/0002_outbox.sql', import.meta.url), 'utf8');
  await db.batch(migration.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
});
after(() => mf.dispose());

function fixture(input = bytes, rawSize = input.byteLength) {
  const calls: string[] = [];
  const message = {
    from: 'sender@example.test', to: 'box@example.test', rawSize,
    raw: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(input); c.close(); } }),
    setReject(reason: string) { assert.match(reason, /unknown recipient/i); calls.push('reject'); },
  };
  const ports = {
    lookup: async (_to: string) => recipient as typeof recipient | null,
    register: async (workspaceId: string, hash: string, deliveryId: string) => {
      calls.push('register');
      assert.deepEqual([workspaceId, hash, deliveryId], ['workspace', digest, id]);
      return rawKey;
    },
    put: async (workspaceId: string, key: string, body: Uint8Array<ArrayBuffer>) => {
      calls.push('put');
      assert.deepEqual([workspaceId, key, body], ['workspace', rawKey, bytes]);
    },
    insert: async (row: Parameters<Outbox['insert']>[0]) => { calls.push('insert'); await new Outbox(db).insert(row); },
    send: async (deliveryId: string) => { assert.equal(deliveryId, id); calls.push('send'); },
    newId: (_now: number) => id,
    now: () => 100,
  };
  return { calls, message, ports };
}

test('outbox accepts a lowercase workspace ID and rejects IDs that cannot name a mail bucket', async () => {
  const outbox = new Outbox(db);
  const row = {
    id: '01KBN8ZJ7G0000000000000003', workspaceId: '01arz3ndektsv4rrffq69g5fav',
    mailboxId: 'box', envelopeFrom: 'sender@example.test', envelopeTo: 'box@example.test',
    rawKey, authResults: null, createdAt: 100,
  };
  for (const workspaceId of [row.workspaceId.toUpperCase(), `${row.workspaceId}-`]) {
    await assert.rejects(outbox.insert({ ...row, workspaceId }), /CHECK constraint failed: length\(workspace_id\)/);
  }
  await outbox.insert(row);
  assert.equal((await outbox.get(row.id))?.workspaceId, row.workspaceId);
});

test('ships off and throws without resolving bindings or permanently rejecting', async () => {
  const { message, calls } = fixture();
  await assert.rejects(handleEmail(message, {}), /disabled/i);
  assert.deepEqual(calls, []);
});

test('durably hands off unchanged MIME before queue send and waits for the send', async () => {
  const { message, calls, ports } = fixture();
  const sent = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  ports.send = async () => { calls.push('send'); sent.resolve(); await finish.promise; };
  let accepted = false;
  const pending = receive(message, ports).then(() => { accepted = true; });
  await Promise.race([sent.promise, pending]);
  const row = await new Outbox(db).get(id);
  assert.equal(accepted, false);
  assert.deepEqual(calls, ['register', 'put', 'insert', 'send']);
  assert.equal(row?.authResults, 'mx.cloudflare.net; dmarc=fail');
  assert.equal(row?.state, 'pending');
  assert.deepEqual(row?.mailboxIds, ['box']);
  assert.equal(row?.rawKey, rawKey);
  finish.resolve();
  await pending;
});

test('will not put a key whose digest differs from the registered raw digest', async () => {
  const { message, ports, calls } = fixture();
  ports.register = async () => `raw/${'0'.repeat(64)}/${id}`;
  await assert.rejects(receive(message, ports), /Invalid registered raw key/);
  assert.deepEqual(calls, []);
});

test('only a successful miss permanently rejects', async () => {
  const miss = fixture();
  miss.ports.lookup = async () => null;
  await receive(miss.message, miss.ports);
  assert.deepEqual(miss.calls, ['reject']);
  const error = fixture();
  error.ports.lookup = async () => { throw new Error('directory unavailable'); };
  await assert.rejects(receive(error.message, error.ports), /directory unavailable/);
  assert.deepEqual(error.calls, []);
});

for (const failure of ['register', 'put', 'insert', 'send'] as const) {
  test(`throws on ${failure} failure without skipping the handoff order`, async () => {
    const { message, ports, calls } = fixture();
    if (failure === 'send') {
      // Use another isolated id; the row must survive queue failure.
      const second = '01KBN8ZJ7G0000000000000001';
      ports.newId = () => second;
      ports.register = async () => { calls.push('register'); return rawKey; };
      ports.send = async () => { calls.push('send'); throw new Error('send unavailable'); };
      await assert.rejects(receive(message, ports), /send unavailable/);
      assert.equal((await new Outbox(db).get(second))?.state, 'pending');
    } else {
      ports[failure] = async () => { calls.push(failure); throw new Error(`${failure} unavailable`); };
      await assert.rejects(receive(message, ports), /unavailable/);
    }
    assert.deepEqual(calls, ['register', 'put', 'insert', 'send'].slice(0, ['register', 'put', 'insert', 'send'].indexOf(failure) + 1));
  });
}

test('rejects malformed size via exception without touching storage or SMTP rejection', async () => {
  for (const length of [25 * 1024 * 1024 + 1, bytes.length - 1, bytes.length + 1]) {
    const oversized = fixture(bytes, length);
    await assert.rejects(receive(oversized.message, oversized.ports), /size/i);
    assert.deepEqual(oversized.calls, []);
  }
});

test('accepts a 25 MiB raw message without truncating or rewriting it', async () => {
  const max = new Uint8Array(25 * 1024 * 1024);
  max.set(bytes);
  max[max.length - 1] = 0xff;
  const { message, ports, calls } = fixture(max);
  ports.register = async (_workspace, hash) => { calls.push('register'); return `raw/${hash}/${id}`; };
  ports.put = async (_workspace, _key, body) => {
    assert.equal(body.byteLength, max.byteLength);
    assert.equal(body[body.length - 1], 0xff);
    calls.push('put');
  };
  ports.insert = async () => { calls.push('insert'); };
  await receive(message, ports);
  assert.deepEqual(calls, ['register', 'put', 'insert', 'send']);
});

test('queue failure leaves pending, then an acknowledgement marks done before releasing', async () => {
  const box = new Outbox(db);
  let indexed = 0;
  let released = 0;
  const ports = {
    outbox: box,
    index: async (_workspaceId: string, _mailboxId: string, received: string) => { indexed++; assert.equal(received, id); },
    release: async () => {
      assert.equal((await box.get(id))?.state, 'done');
      if (++released === 1) throw new Error('sweeper unavailable');
    },
    now: () => 200,
  };
  await assert.rejects(deliver(id, { ...ports, index: async () => { throw new Error('DO unavailable'); } }), /DO unavailable/);
  assert.equal((await box.get(id))?.state, 'pending');
  await assert.rejects(deliver(id, ports), /sweeper unavailable/);
  assert.equal((await box.get(id))?.state, 'done');
  await deliver(id, ports);
  assert.equal(indexed, 1);
  assert.equal(released, 2);
});

test('DLQ retries until its redacted service-binding POST receives a 2xx', async () => {
  const calls: unknown[] = [];
  let acks = 0;
  let retries = 0;
  const batch = { queue: 'dlq', messages: [{ body: { envelopeFrom: 'private@example.test' },
    ack: () => { acks++; }, retry: () => { retries++; } }] } as unknown as MessageBatch<unknown>;
  const env = {
    MAIL_BACKEND_ENABLED: 'on', DIRECTORY: db, DELIVERY_QUEUE_NAME: 'deliver', DEAD_LETTER_QUEUE_NAME: 'dlq',
    ALERTS: { fetch: async (url: string, init: RequestInit) => {
      calls.push([new URL(url).pathname, init.method, JSON.parse(String(init.body))]);
      return new Response(null, { status: calls.length === 1 ? 503 : 204 });
    } },
  } as Env;
  await handleQueue(batch, env);
  assert.deepEqual([acks, retries], [0, 1]);
  await handleQueue(batch, env);
  assert.deepEqual([acks, retries], [1, 1]);
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ['/v1/alert', 'POST', {
    source: 'mail:delivery_dlq', key: 'invalid-delivery', title: 'Mail delivery dead-lettered',
  }]));
});

test('DLQ emits a redacted signal even for malformed input', async () => {
  const events: unknown[] = [];
  await dlq(id, async event => { events.push(event); });
  await dlq({ envelopeFrom: 'private@example.test' }, async event => { events.push(event); });
  assert.deepEqual(events, [{ code: 'delivery_dlq', deliveryId: id }, { code: 'delivery_dlq' }]);
});
