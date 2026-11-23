import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { TextEncoder } from 'node:util';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { sha256 } from '../src/bytes.ts';
import type { IndexPlumbing } from './fixtures/index-plumbing.ts';

const id = '01KBN8ZJ7G0000000000000000';
let runtime: Miniflare;
let boxes: { getByName(name: string): Pick<IndexPlumbing, 'indexRaw' | 'parts'> };
let raw: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
before(async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/index-plumbing.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false });
  runtime = new Miniflare({ modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle.outputFiles[0].text }],
    compatibilityDate: '2025-06-01', durableObjects: { BOX: { className: 'IndexPlumbing', useSQLite: true } },
    r2Buckets: ['RAW', 'STATE'] });
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
