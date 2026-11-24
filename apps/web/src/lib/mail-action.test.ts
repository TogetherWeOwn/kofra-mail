import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mailAction } from './mail-action.ts';

test('a failed action retries with the same key until the input or action changes', () => {
  const action = mailAction();
  const first = action.options({ name: 'Finance' }).idempotencyKey;
  assert.match(first, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(action.options({ name: 'Finance' }).idempotencyKey, first);
  const edited = action.options({ name: 'Projects' }).idempotencyKey;
  assert.notEqual(edited, first);
  action.clear();
  assert.notEqual(action.options({ name: 'Projects' }).idempotencyKey, edited);
});
