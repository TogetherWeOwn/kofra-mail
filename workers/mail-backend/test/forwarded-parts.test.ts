import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';

// Small forwarded parts are decoded from their source raw messages when a
// draft attaches them (docs/m3-outbound-plan.md, M3-2 forwarded parts). Each
// source can be large, so sources are read and parsed one at a time.
type Drafts = typeof import('../src/mailbox-api-drafts.ts');
let drafts: Drafts;
before(async () => {
  // The module's dependencies use TypeScript syntax that plain type stripping does not run.
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/mailbox-api-drafts.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], write: false });
  drafts = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`) as Drafts;
});

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const files = (tag: string) => [`${tag} first file`, `${tag} second file`];
// A stored raw message with two small attachments, under its content-addressed key.
function source(tag: string, generation: string) {
  const parts = files(tag).map((text, i) => ['--b', 'Content-Type: text/plain', `Content-Disposition: attachment; filename="f${i}.txt"`,
    'Content-Transfer-Encoding: base64', '', Buffer.from(text).toString('base64')].join('\r\n'));
  const raw = new Uint8Array(Buffer.from(['From: a@example.net', 'To: b@example.com', `Subject: ${tag}`, 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain', '', 'Body', ...parts, '--b--', ''].join('\r\n')));
  return { key: `raw/${sha256(raw)}/${generation}`, raw };
}
const attachment = (key: string, messageId: string, part: number, size: number) =>
  ({ wire: { kind: 'message' as const, messageId, part, name: `f${part - 1}.txt`, type: 'text/plain', size }, key });

test('forwarded parts are fingerprinted one source at a time, each source read once for all its parts', async () => {
  const sources = [source('one', '01KBN8ZJ7G0000000000000001'), source('two', '01KBN8ZJ7G0000000000000002')];
  const reads: string[] = [];
  let inFlight = 0, most = 0;
  const index = { readObject: async (key: string) => {
    reads.push(key);
    most = Math.max(most, ++inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      return sources.find(item => item.key === key)!.raw;
    } finally { inFlight--; }
  } };
  const wanted = sources.flatMap(({ key }, s) => files(s ? 'two' : 'one').map((text, i) => attachment(key, `m${s}`, i + 1, text.length)));
  const result = await drafts.fingerprintParts(index as never, wanted as never) as unknown as { part?: { digest: string; size: number } }[];
  assert.equal(most, 1, 'no two source reads in flight at once');
  assert.deepEqual(reads, sources.map(({ key }) => key), 'each source is read once, in order');
  assert.deepEqual(result.map(({ part }) => part), [...files('one'), ...files('two')].map(text =>
    ({ digest: sha256(Buffer.from(text)), size: text.length })));
});

test('a forwarded part whose decoded size differs from its indexed size is refused when attached', async () => {
  const { key, raw } = source('one', '01KBN8ZJ7G0000000000000001');
  const index = { readObject: async () => raw };
  const size = files('one')[0].length;
  await drafts.fingerprintParts(index as never, [attachment(key, 'm0', 1, size)] as never);
  await assert.rejects(drafts.fingerprintParts(index as never, [attachment(key, 'm0', 1, size + 1)] as never),
    (error: { problem?: { code?: string } }) => error.problem?.code === 'not_found');
});
