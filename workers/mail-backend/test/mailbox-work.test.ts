import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MailboxWork } from '../src/mailbox-work.ts';

test('an alarm cannot drain and disarm while a prior delivery is committing', async () => {
  const serial = new MailboxWork();
  const given = Promise.withResolvers<void>();
  const active = Promise.withResolvers<void>();
  const order: string[] = [];
  const delivery = serial.run(async () => {
    order.push('delivery started');
    active.resolve();
    await given.promise;
    order.push('journal commit');
  });
  await active.promise;
  const alarm = serial.run(async () => { order.push('journal flush'); });
  await Promise.resolve();
  assert.deepEqual(order, ['delivery started']);
  given.resolve();
  await Promise.all([delivery, alarm]);
  assert.deepEqual(order, ['delivery started', 'journal commit', 'journal flush']);
});

test('an exception does not prevent later mailbox work', async () => {
  const serial = new MailboxWork();
  await assert.rejects(serial.run(async () => { throw new Error('failed delivery'); }), /failed delivery/);
  assert.equal(await serial.run(async () => 1), 1);
});
