import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { URL } from 'node:url';

async function config(path: string) {
  return JSON.parse((await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^\s*\/\/[^\n]*/gm, ''));
}

for (const local of [false, true]) test(`mail-send ${local ? 'local' : 'production'} bindings stay private and off`, async () => {
  const filename = local ? 'wrangler.local.jsonc' : 'wrangler.jsonc';
  const send = await config(`../../mail-send/${filename}`);
  const backend = await config(`../${filename}`);
  assert.equal(send.name, local ? 'mail-send-local' : 'mail-send');
  assert.equal(backend.name, local ? 'mail-backend-local' : 'mail-backend');
  assert.equal(send.main, 'src/entry.ts');
  assert.equal(send.workers_dev, false);
  assert.equal(send.preview_urls, false);
  assert.ok(!('send_email' in send) && !('routes' in send) && !('route' in send));
  assert.equal(send.vars.MAIL_SEND_ENABLED, 'off');
  assert.equal(backend.vars.MAIL_SEND_ENABLED, 'off');
  assert.equal(send.vars.MAIL_ENVIRONMENT, backend.vars.MAIL_ENVIRONMENT);
  assert.equal(send.vars.SEND_QUEUE_NAME, 'send');
  assert.equal(send.vars.SEND_DLQ_NAME, 'send-dlq');
  assert.deepEqual(send.durable_objects.bindings, [{ name: 'MAILBOX', class_name: 'Mailbox', script_name: backend.name }]);
  assert.deepEqual(send.d1_databases, backend.d1_databases);
  assert.ok(send.services.some(({ binding }: { binding: string }) => binding === 'ALERTS'));
  assert.ok(backend.services.some(({ binding }: { binding: string }) => binding === 'ALERTS'));
  for (const worker of [send, backend]) assert.ok(worker.queues.producers.some(({ binding, queue }: { binding: string; queue: string }) =>
    binding === 'SEND' && queue === 'send'));
  assert.deepEqual(send.queues.consumers.map(({ queue }: { queue: string }) => queue), ['send', 'send-dlq']);
  assert.equal(send.queues.consumers[0].dead_letter_queue, 'send-dlq');
  assert.deepEqual(backend.triggers.crons, ['* * * * *']);
});
