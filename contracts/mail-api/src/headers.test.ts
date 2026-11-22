import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasHeaderControl, LIMITS, threadingHeaders } from './index.ts';

const id = (n: number, bytes = 20) => {
  const tail = `.${n}@example.net>`;
  return `<${'x'.repeat(bytes - 1 - tail.length)}${tail}`;
};

test('header text refuses CR, LF and other controls but allows tab', () => {
  for (const text of ['a\rb', 'a\nb', 'a\u0000b', 'a\u007fb', 'a\u0085b']) assert.ok(hasHeaderControl(text), JSON.stringify(text));
  for (const text of ['plain', 'tab\tseparated', 'é and 日本']) assert.ok(!hasHeaderControl(text), text);
});

test('threading headers keep the first id and the last 10 when they fit', () => {
  assert.deepEqual(threadingHeaders([], LIMITS), {});
  assert.deepEqual(threadingHeaders([id(1)], LIMITS), { inReplyTo: id(1), references: id(1) });
  const chain = Array.from({ length: 15 }, (_, i) => id(i + 1));
  const { inReplyTo, references } = threadingHeaders(chain, LIMITS);
  assert.equal(inReplyTo, id(15));
  assert.deepEqual(references?.split(' '), [chain[0], ...chain.slice(-10)]);
});

test('threading headers trim References by bytes, newest ids first', () => {
  const limits = { headerValueBytes: 100 };
  const chain = Array.from({ length: 6 }, (_, i) => id(i + 1, 30));
  // Parent, then the first id, then the newest ids while the value fits 100 bytes: 3 ids and 2 spaces.
  assert.deepEqual(threadingHeaders(chain, limits).references?.split(' '), [chain[0], chain[4], chain[5]]);
});

test('an id longer than the header limit is never sent', () => {
  const limits = { headerValueBytes: 50 };
  const huge = id(9, 60);
  assert.deepEqual(threadingHeaders([id(1), huge], limits), { references: id(1) });
  assert.deepEqual(threadingHeaders([huge, id(2)], limits), { inReplyTo: id(2), references: id(2) });
  // When the first id does not fit beside the parent, the parent alone is kept.
  assert.deepEqual(threadingHeaders([id(1, 30), id(2, 30)], limits), { inReplyTo: id(2, 30), references: id(2, 30) });
});
