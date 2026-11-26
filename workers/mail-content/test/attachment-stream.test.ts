import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../../mail-backend/src/bytes.ts';
import { proveAttachment, verifiedAttachmentStream } from '../src/object-reader.ts';

function source(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    type: 'bytes',
    start(controller) { controller.enqueue(bytes.slice()); controller.close(); },
  });
}

test('attachment verification emits a clean control, but never emits a corrupted block', async () => {
  const clean = new Uint8Array(256 * 1024).fill(65);
  const digest = await sha256(clean);
  const proof = await proveAttachment(`att/${digest}/01Z00000000000000000000000`, clean);
  const verified = new Response(verifiedAttachmentStream(source(clean), proof));
  assert.equal(await sha256(new Uint8Array(await verified.arrayBuffer())), digest);

  const corrupt = clean.slice();
  corrupt[64 * 1024]++;
  const reader = verifiedAttachmentStream(source(corrupt), proof).getReader();
  try {
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(first.value?.length, 64 * 1024);
    assert.equal(await sha256(new Uint8Array(first.value!)), await sha256(clean.subarray(0, 64 * 1024)));
    await assert.rejects(reader.read(), /attachment bytes mismatch/);
  } finally { await reader.cancel().catch(() => {}); }
});
