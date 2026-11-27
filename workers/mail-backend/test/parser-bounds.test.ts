import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { TextEncoder } from 'node:util';
import { build } from 'esbuild';
import { Miniflare, Response, type Request } from 'miniflare';
import { parseMail as referenceParseMail } from './fixtures/parse-mail-reference.ts';
import { sha256 } from '../src/bytes.ts';
import type { IndexPlumbing } from './fixtures/index-plumbing.ts';

const id = '01KBN8ZJ7G0000000000000000';
let runtime: Miniflare;
let boxes: { getByName(name: string): Pick<IndexPlumbing, 'indexRaw' | 'indexThroughKofra' | 'overlongThroughKofra' | 'parts' | 'storeCalls'> };
let raw: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
// The object store behind the Kofra adapter; a PUT is kept only if its body matches its signed digest.
const stored = new Map<string, Uint8Array>();
// Set to fail the next attachment PUT after reading part of its body.
let failNextPut = false;
// Body bytes the store received for the last PUT, also when the body failed.
let lastPutBytes = 0;
before(async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/index-plumbing.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false });
  runtime = new Miniflare({ modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle.outputFiles[0].text }],
    compatibilityDate: '2025-06-01', durableObjects: { BOX: { className: 'IndexPlumbing', useSQLite: true } },
    r2Buckets: ['RAW', 'STATE'],
    bindings: { KOFRA_S3_ENDPOINT: 'https://storage.example.test', KOFRA_S3_ACCESS_KEY_ID: 'fixture-access', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture-signing' },
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      if (request.method !== 'PUT' || url.origin !== 'https://storage.example.test') return new Response(null, { status: 403 });
      if (failNextPut) {
        failNextPut = false;
        await request.body?.getReader().read();
        return new Response(null, { status: 500 });
      }
      const chunks: Uint8Array[] = [];
      lastPutBytes = 0;
      const reader = request.body!.getReader();
      for (let next = await reader.read(); !next.done; next = await reader.read()) { chunks.push(next.value); lastPutBytes += next.value.byteLength; }
      const body = new Uint8Array(lastPutBytes);
      chunks.reduce((offset, chunk) => { body.set(chunk, offset); return offset + chunk.byteLength; }, 0);
      if (request.headers.get('x-amz-content-sha256') !== await sha256(body)) return new Response('<Error><Code>BadDigest</Code></Error>', { status: 400 });
      stored.set(url.pathname, body);
      return new Response(null, { status: 200 });
    } });
  boxes = await runtime.getDurableObjectNamespace('BOX') as unknown as typeof boxes;
  raw = await runtime.getR2Bucket('RAW');
});
after(async () => { await runtime?.dispose(); });

async function upload(mime: string) {
  const bytes = new TextEncoder().encode(mime);
  const key = `raw/${await sha256(bytes)}/${id}`;
  await raw.put(key, bytes);
  return key;
}

const multipart = (boundary: string, parts: string[]) => `Content-Type: multipart/mixed; boundary=${boundary}\r\n\r\n` +
  parts.map(part => `--${boundary}\r\n${part}\r\n`).join('') + `--${boundary}--\r\n`;

test('mailbox rejects MIME nesting deeper than 32 as a permanent error', async () => {
  let mime = 'Content-Type: text/plain\r\n\r\nbody';
  for (let i = 0; i < 33; i++) mime = multipart(`nested-${i}`, [mime]);
  const box = boxes.getByName('too-deep');
  assert.match(await box.indexRaw(id, await upload(mime)), /Maximum MIME nesting depth of 32 levels exceeded/);
});

test('mailbox indexes 600 attachments as 511 parts and a single overflow row', async () => {
  const mime = multipart('many', Array.from({ length: 600 }, (_, i) =>
    `Content-Type: text/plain\r\nContent-Disposition: attachment; filename="part-${i + 1}.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\neA==`));
  const box = boxes.getByName('many-parts');
  assert.equal(await box.indexRaw(id, await upload(mime)), 'indexed');
  const rows = JSON.parse(await box.parts());
  assert.equal(rows.length, 512);
  assert.deepEqual(rows.slice(0, 511).map((row: { name: string }) => row.name),
    Array.from({ length: 511 }, (_, i) => `part-${i + 1}.txt`));
  assert.deepEqual(rows[511], { message_id: id, part: 512, name: '(89 more attachments)',
    mime_type: 'application/octet-stream', size: 89, object_key: null });
});

test('mailbox keeps the fourth inline message/rfc822 as an attachment', async () => {
  let mime = 'Subject: Innermost message\r\nContent-Type: text/plain\r\n\r\ninnermost body';
  for (let depth = 4; depth > 0; depth--) {
    mime = `Subject: Forward at level ${depth}\r\nMIME-Version: 1.0\r\n` + multipart(`forward-${depth}`, [
      `Content-Type: text/plain\r\n\r\nforwarded at level ${depth}`,
      `Content-Type: message/rfc822\r\nContent-Disposition: inline; filename="level-${depth}.eml"\r\n\r\n${mime}`,
    ]);
  }
  const box = boxes.getByName('nested-forwards');
  assert.equal(await box.indexRaw(id, await upload(mime)), 'indexed');
  const rows = JSON.parse(await box.parts()) as Array<{ name: string; mime_type: string }>;
  assert.deepEqual(rows.map(({ name, mime_type }) => [name, mime_type]), [['level-4.eml', 'message/rfc822']]);
});

test('mailbox stores large attachments through the streamed Kofra PUT with the keys and bytes of the unbounded parse', async () => {
  const binary = new Uint8Array(700 * 1024).map((_, i) => (i * 2654435761) >>> 24);
  const text = 'Grüße aus Köln = 100 % sicher\r\n'.repeat(12_000);
  const qp = Array.from(new TextEncoder().encode(text), b => b > 126 || b === 61 ? `=${b.toString(16).toUpperCase()}` : String.fromCharCode(b))
    .join('').replace(/\r\n/g, '=0D=0A=\r\n');
  const mime = multipart('stored', [
    'Content-Type: text/plain\r\n\r\nThree files.',
    `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=one.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(binary).toString('base64').match(/.{1,76}/g)!.join('\r\n')}`,
    `Content-Type: text/plain; charset=utf-8\r\nContent-Disposition: attachment; filename=two.txt\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qp}`,
    `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=small.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAw==`,
  ]);
  const key = await upload(mime);
  const reference = await referenceParseMail(new Uint8Array(new TextEncoder().encode(mime)), key);
  const box = boxes.getByName('kofra-store');
  assert.equal(await box.indexThroughKofra(id, key), 'indexed');
  const rows = JSON.parse(await box.parts()) as Array<{ part: number; size: number; object_key: string | null }>;
  assert.equal(rows.length, 3);
  assert.equal(stored.size, 2);
  for (const [i, row] of rows.entries()) {
    const expected = reference.attachments[i];
    assert.equal(row.size, expected.size);
    if (!expected.external) { assert.equal(row.object_key, null); continue; }
    assert.equal(row.object_key, `att/${await sha256(expected.external)}/${id}`);
    assert.deepEqual(stored.get(`/mail-workspace/${row.object_key}`), expected.external);
  }
});

// A message whose one quoted-printable attachment is filled with `unit`
// repeated, in 76-byte lines, up to `rawBytes` of body.
function expanding(charset: string, unit: number[], rawBytes: number): Uint8Array<ArrayBuffer> {
  const head = new TextEncoder().encode('Message-ID: <expand@example.test>\r\nContent-Type: multipart/mixed; boundary=grow\r\n\r\n--grow\r\n' +
    `Content-Type: application/octet-stream; charset=${charset}\r\nContent-Disposition: attachment; filename=grow.bin\r\n` +
    'Content-Transfer-Encoding: quoted-printable\r\n\r\n');
  const tail = new TextEncoder().encode('\r\n--grow--\r\n');
  const lines = Math.floor(rawBytes / 78);
  const line = new Uint8Array(78);
  for (let i = 0; i < 76; i++) line[i] = unit[i % unit.length];
  line[76] = 13; line[77] = 10;
  const wire = new Uint8Array(head.byteLength + lines * 78 + tail.byteLength);
  wire.set(head);
  for (let i = 0; i < lines; i++) wire.set(line, head.byteLength + i * 78);
  wire.set(tail, head.byteLength + lines * 78);
  return wire;
}

async function assertStoredLikeBefore(name: string, wire: Uint8Array<ArrayBuffer>, decodedAtLeast: number) {
  const key = `raw/${await sha256(wire)}/${id}`;
  await raw.put(key, wire);
  const reference = await referenceParseMail(wire, key);
  const expected = reference.attachments[0].external!;
  assert.ok(wire.byteLength < 25 * 1024 * 1024 && expected.byteLength >= decodedAtLeast, `${wire.byteLength} -> ${expected.byteLength}`);
  const box = boxes.getByName(name);
  assert.equal(await box.indexThroughKofra(id, key), 'indexed');
  const [row] = JSON.parse(await box.parts()) as Array<{ size: number; object_key: string }>;
  assert.equal(row.size, expected.byteLength);
  assert.equal(row.object_key, `att/${await sha256(expected)}/${id}`);
  assert.deepEqual(stored.get(`/mail-workspace/${row.object_key}`), expected);
  // Streamed in blocks of at most 64 KiB, never handed over whole.
  const calls = JSON.parse(await box.storeCalls()) as Array<{ method: string; key: string; chunks: number; largest: number }>;
  assert.deepEqual(calls.map(({ method, key }) => [method, key]), [['putStream', row.object_key]]);
  assert.ok(calls[0].largest <= 64 * 1024 && calls[0].chunks >= Math.ceil(expected.byteLength / (64 * 1024)), JSON.stringify(calls));
}

test('mailbox streams an attachment that decodes to 3 bytes per raw byte, past the raw message cap', async () => {
  // Each invalid UTF-8 byte decodes to U+FFFD: a 9 MiB part becomes over 27 MB.
  await assertStoredLikeBefore('kofra-expanding-utf8', expanding('utf-8', [0x80], 9 * 1024 * 1024), 27_000_000);
});

test('mailbox streams a UTF-16 attachment that decodes past the raw message cap', async () => {
  // Each 2 raw bytes decode to one CJK character of 3 UTF-8 bytes: 20.9 MB becomes over 30 MB.
  await assertStoredLikeBefore('kofra-expanding-utf16', expanding('utf-16le', [0x00, 0x4e], 20_900_000), 30_000_000);
});

test('an attachment PUT that fails midway is retried from a fresh decode and stores the same bytes', async () => {
  const binary = new Uint8Array(400 * 1024).map((_, i) => (i * 2246822519) >>> 24);
  const mime = multipart('retry', [
    'Content-Type: text/plain\r\n\r\nOne file.',
    `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=retry.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(binary).toString('base64').match(/.{1,76}/g)!.join('\r\n')}`,
  ]);
  const key = await upload(mime);
  const box = boxes.getByName('kofra-retry');
  failNextPut = true;
  assert.equal(await box.indexThroughKofra(id, key), 'Kofra object PUT failed (500)');
  assert.equal(failNextPut, false);
  assert.equal(await box.indexThroughKofra(id, key), 'indexed');
  const [row] = JSON.parse(await box.parts()) as Array<{ size: number; object_key: string }>;
  assert.equal(row.object_key, `att/${await sha256(binary)}/${id}`);
  assert.deepEqual(stored.get(`/mail-workspace/${row.object_key}`), binary);
});

for (const mode of ['overlong', 'digest'] as const) test(`a ${mode === 'overlong' ? 'replay that overruns its measured size' : 'body that fails its digest after most of it was sent'} fails the Kofra PUT with no unhandled rejection`, async () => {
  const binary = new Uint8Array(300 * 1024).map((_, i) => (i * 2654435761) >>> 24);
  const key = await upload(multipart('overlong', [
    `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=over.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(binary).toString('base64').match(/.{1,76}/g)!.join('\r\n')}`,
  ]));
  const before = stored.size;
  lastPutBytes = 0;
  const result = JSON.parse(await boxes.getByName(`kofra-${mode}`).overlongThroughKofra(key, mode)) as { error: string; unhandled: string[] };
  assert.notEqual(result.error, 'stored');
  assert.deepEqual(result.unhandled, []);
  assert.equal(stored.size, before);
  // The caller sees the body's own failure, not a store answer such as BadDigest ('failed (400)').
  assert.equal(result.error, mode === 'overlong' ? 'Attachment size changed on decode' : 'Attachment digest changed on decode');
  // The digest case fails after the store has received all but the last
  // block, which is held back until the digest check.
  if (mode === 'digest') assert.ok(lastPutBytes >= binary.byteLength - 64 * 1024 && lastPutBytes < binary.byteLength, `received ${lastPutBytes}`);
  else assert.equal(lastPutBytes, 0);
});
