import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response, type Request } from 'miniflare';
import { RETENTION_MS } from '../src/reconcile.ts';
import type { DeleteConfirmation } from './fixtures/delete-confirmation.ts';

const generation = `raw/${'a'.repeat(64)}/01KBN8ZJ7G0000000000000000`;
const xml = (code: string, message = 'Fixture') => `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message></Error>`;
const truncated = '<Error><Code>NoSuchKey</Code>';
const atLimit = xml('NoSuchKey', 'x'.repeat(4096 - Buffer.byteLength(xml('NoSuchKey', ''))));
// The first 4 KiB are a valid document; only reading past the cap detects excess.
const oversized = `${atLimit} `;
let runtime: Miniflare;
let boxes: { getByName(name: string): DeleteConfirmation };
let response: () => Response;
const deleted: string[] = [];

before(async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./fixtures/delete-confirmation.ts', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false });
  runtime = new Miniflare({ modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle.outputFiles[0].text }],
    compatibilityDate: '2025-06-01', durableObjects: { TEST: { className: 'DeleteConfirmation', useSQLite: true } },
    bindings: { KOFRA_S3_ENDPOINT: 'https://s3.invalid', KOFRA_S3_ACCESS_KEY_ID: 'fixture', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture' },
    outboundService: async (request: Request) => {
      assert.ok(request.method === 'GET' || request.method === 'DELETE');
      if (request.method === 'DELETE') deleted.push(new URL(request.url).pathname);
      return response();
    },
  });
  boxes = await runtime.getDurableObjectNamespace('TEST') as unknown as typeof boxes;
});
after(async () => { await runtime?.dispose(); });

for (const [name, status, body, confirmed] of [
  ['204', 204, null, true],
  ['404 NoSuchKey', 404, xml('NoSuchKey'), true],
  ['404 NoSuchKey at exactly 4 KiB', 404, atLimit, true],
  ['404 with a truncated NoSuchKey envelope', 404, truncated, false],
  ['404 with a 4097-byte NoSuchKey body', 404, oversized, false],
  ['404 NoSuchBucket', 404, xml('NoSuchBucket'), false],
  ['empty 404', 404, null, false],
  ['404 with code after the first 4 KiB', 404, `${' '.repeat(4096)}${xml('NoSuchKey')}`, false],
  ['404 with code in a comment', 404, '<Error><!-- <Code>NoSuchKey</Code> --><Code>NoSuchBucket</Code></Error>', false],
  ['403 with NoSuchKey', 403, xml('NoSuchKey'), false],
] as const) {
  test(`${name} ${confirmed ? 'confirms' : 'does not confirm'} a swept generation`, async () => {
    response = () => new Response(body, { status });
    assert.equal(await boxes.getByName(name).remove(generation), confirmed ? 'confirmed' : `Kofra object DELETE failed (${status})`);
  });
}

for (const [name, body, result] of [
  ['a complete NoSuchKey envelope at exactly 4 KiB', atLimit, 'missing'],
  ['a truncated NoSuchKey envelope', truncated, 'Kofra object GET failed (404)'],
  ['a 4097-byte NoSuchKey body', oversized, 'Kofra object GET failed (404)'],
] as const) {
  test(`GET with ${name} returns ${result === 'missing' ? 'verified missing' : 'an unconfirmed error'}`, async () => {
    response = () => new Response(body, { status: 404 });
    assert.equal(await boxes.getByName(`get ${name}`).getResult(generation), result);
  });
}

for (const [name, body, valid] of [
  ['an unclosed Message', '<Error><Code>NoSuchKey</Code><Message>Request failed</Error>', false],
  ['an unknown child', '<Error><Code>NoSuchKey</Code><Unknown>extra</Unknown></Error>', false],
  ['a second Code', '<Error><Code>NoSuchKey</Code><Code>NoSuchBucket</Code></Error>', false],
  ['a malformed declaration', '<?xml nope?><Error><Code>NoSuchKey</Code></Error>', false],
  ['an XML 1.1 declaration', '<?xml version="1.1"?><Error><Code>NoSuchKey</Code></Error>', false],
  ['a U+00A0 between Code and Error closing tags', '<Error><Code>NoSuchKey</Code> </Error>', false],
  ['a bare ampersand in Key', '<Error><Code>NoSuchKey</Code><Key>a&b</Key></Error>', false],
  ['a DOCTYPE', '<!DOCTYPE Error><Error><Code>NoSuchKey</Code></Error>', false],
  ['a comment inside a leaf', '<Error><Code>NoSuchKey</Code><Key>a<!-- note -->b</Key></Error>', false],
  ['CDATA inside a leaf', '<Error><Code>NoSuchKey</Code><Key><![CDATA[a]]></Key></Error>', false],
  ['an invalid UTF-8 byte in Key', Buffer.concat([
    Buffer.from('<Error><Code>NoSuchKey</Code><Key>'), Buffer.from([0xff]), Buffer.from('</Key></Error>'),
  ]), false],
  ['a NUL character in Key', '<Error><Code>NoSuchKey</Code><Key>a\u0000b</Key></Error>', false],
  ['a C0 control character in Message', '<Error><Code>NoSuchKey</Code><Message>a\u0001b</Message></Error>', false],
  ['a U+FFFE noncharacter in Key', '<Error><Code>NoSuchKey</Code><Key>a\uFFFEb</Key></Error>', false],
  ['the bridge document', '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>Request failed</Message><RequestId>r&amp;1</RequestId></Error>', true],
  ['the bridge document with a newline after the declaration and an astral character',
    '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>NoSuchKey</Code><Key>a\u{1F600}b</Key><HostId>h</HostId></Error>', true],
] as const) {
  test(`strict S3 error confirmation on both GET and DELETE with ${name}`, async () => {
    response = () => new Response(body, { status: 404 });
    const fixture = boxes.getByName(`strict XML ${name}`);
    assert.deepEqual({ get: await fixture.getResult(generation), delete: await fixture.remove(generation) }, valid
      ? { get: 'missing', delete: 'confirmed' }
      : { get: 'Kofra object GET failed (404)', delete: 'Kofra object DELETE failed (404)' });
  });
}

for (const [name, body] of [['NoSuchBucket', xml('NoSuchBucket')], ['empty 404', null]] as const) {
  test(`ledger preserves a retired generation after ${name} and retries it`, async () => {
    const box = boxes.getByName(`ledger ${name}`);
    const key = await box.retireCandidate(100);
    const due = 100 + RETENTION_MS;
    const path = `/mail-workspace/${key}`;
    deleted.length = 0;
    response = () => new Response(body, { status: 404 });
    await box.sweepAt(due);
    assert.deepEqual(deleted, [path]);
    assert.equal(await box.next(), due + 60_000);
    response = () => new Response(null, { status: 204 });
    await box.sweepAt(due + 60_000);
    assert.deepEqual(deleted, [path, path]);
    assert.equal(await box.next(), null);
  });
}
