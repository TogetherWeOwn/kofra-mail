import assert from 'node:assert/strict';
import { test } from 'node:test';
import PostalMime from 'postal-mime';
import { sha256 } from '../src/bytes.ts';
import { boundedMime, decodedAttachment, parseMail, partDigest, partStream, type PartSource } from '../src/parse-mail.ts';
import { installDigestStream } from './fixtures/digest-stream.ts';
import { corpusMessage } from './fixtures/mail-corpus.ts';
import { parseMail as referenceParseMail } from './fixtures/parse-mail-reference.ts';

// The bounded parse must return what the unbounded parse returned for every
// input: the same PostalMime result apart from where attachment bytes live,
// the same bytes for every attachment, and the same parseMail output, from
// which the index rows, the stored attachment keys and bytes, the text and
// the snippets are derived.

installDigestStream();
const OPTIONS = { attachmentEncoding: 'arraybuffer', maxNestingDepth: 32, maxRfc822NestingDepth: 3 } as const;
const enc = new TextEncoder();
const bytesOf = (text: string) => new Uint8Array(enc.encode(text));
const keyOf = async (raw: Uint8Array<ArrayBuffer>) => `raw/${await sha256(raw)}/01KBN8ZJ7G0000000000000000`;

type Counts = { messages: number; rejected: number; attachments: number; measured: number; external: number; externalMeasured: number };
const counts = (): Counts => ({ messages: 0, rejected: 0, attachments: 0, measured: 0, external: 0, externalMeasured: 0 });

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The bytes a store would PUT for a measured part, checked against the old bytes.
async function assertPart(source: PartSource, expected: Uint8Array<ArrayBuffer>, label: string) {
  const digest = await sha256(expected);
  assert.equal(source.size, expected.byteLength, `${label}: size`);
  assert.equal(await partDigest(source), digest, `${label}: digest`);
  assert.deepEqual(await drain(partStream(source, digest)), expected, `${label}: bytes`);
}

const failure = async (run: () => Promise<unknown>) => {
  try { await run(); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
};

async function assertEquivalent(raw: Uint8Array<ArrayBuffer>, label: string, tally: Counts) {
  tally.messages++;
  const key = await keyOf(raw);
  let stock: Awaited<ReturnType<typeof PostalMime.parse>> | undefined;
  let bounded: Awaited<ReturnType<typeof boundedMime>> | undefined;
  const stockError = await failure(async () => { stock = await PostalMime.parse(raw, OPTIONS); });
  const boundedError = await failure(async () => { bounded = await boundedMime(raw); });
  assert.equal(boundedError, stockError, `${label}: parse error`);
  for (const api of [false, true]) {
    let reference: Awaited<ReturnType<typeof referenceParseMail>> | undefined;
    let current: Awaited<ReturnType<typeof parseMail>> | undefined;
    const referenceError = await failure(async () => { reference = await referenceParseMail(raw, key, api); });
    const currentError = await failure(async () => { current = await parseMail(raw, key, api); });
    assert.equal(currentError, referenceError, `${label}: parseMail error (api ${api})`);
    if (!reference || !current) continue;
    const { attachments: referenceAttachments, ...referenceRest } = reference;
    const { attachments: currentAttachments, ...currentRest } = current;
    assert.deepEqual(currentRest, referenceRest, `${label}: parseMail fields (api ${api})`);
    assert.equal(currentAttachments.length, referenceAttachments.length, `${label}: indexed attachments (api ${api})`);
    for (const [i, { external, ...row }] of currentAttachments.entries()) {
      const { external: expected, ...expectedRow } = referenceAttachments[i];
      assert.deepEqual(row, expectedRow, `${label}: attachment row ${i + 1} (api ${api})`);
      assert.equal(external === null, expected === null, `${label}: stored attachment ${i + 1} (api ${api})`);
      if (!external || !expected) continue;
      if (api) tally.external++;
      if (external instanceof Uint8Array) assert.deepEqual(external, expected, `${label}: stored bytes ${i + 1}`);
      else {
        if (api) tally.externalMeasured++;
        await assertPart(external, expected, `${label}: stored part ${i + 1}`);
      }
    }
  }
  if (!stock || !bounded) { tally.rejected++; return; }
  const withoutContent = (parsed: NonNullable<typeof stock>) => ({ ...parsed, attachments: parsed.attachments.map(({ content: _content, ...rest }) => rest) });
  assert.deepEqual(withoutContent(bounded.parsed), withoutContent(stock), `${label}: PostalMime result`);
  assert.equal(bounded.contents.length, stock.attachments.length);
  for (const [i, content] of bounded.contents.entries()) {
    tally.attachments++;
    const expected = decodedAttachment(stock.attachments[i].content);
    if (content instanceof Uint8Array) assert.deepEqual(content, expected, `${label}: attachment ${i + 1} bytes`);
    else {
      tally.measured++;
      await assertPart(content, expected, `${label}: attachment ${i + 1}`);
    }
  }
}

// The same message at a non-zero offset of a larger buffer, which PostalMime copies.
function offsetView(raw: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const padded = new Uint8Array(raw.byteLength + 16).fill(0x0a);
  padded.set(raw, 7);
  return padded.subarray(7, 7 + raw.byteLength);
}

const b64 = (bytes: Uint8Array, width = 76) => Buffer.from(bytes).toString('base64').match(new RegExp(`.{1,${width}}`, 'g'))?.join('\r\n') ?? '';
const fill = (size: number, seed = 1) => {
  const bytes = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; bytes[i] = x >>> 24; }
  return bytes;
};
const mixed = (boundary: string, parts: string[], close = true) => `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
  parts.map(part => `--${boundary}\r\n${part}\r\n`).join('') + (close ? `--${boundary}--\r\n` : '');
const head = 'From: Sender <sender@example.test>\r\nTo: rcpt@example.test\r\nSubject: Edge case\r\nMessage-ID: <edge@example.test>\r\nMIME-Version: 1.0\r\n';
const big = b64(fill(300 * 1024));
const attachment = (name: string, body = big, type = 'application/octet-stream') =>
  `Content-Type: ${type}\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`;

const EDGE_CASES: Record<string, () => Uint8Array<ArrayBuffer>> = {
  'nested multipart with an inline image': () => bytesOf(head + mixed('outer', [
    'Content-Type: multipart/alternative; boundary="alt"\r\n\r\n--alt\r\nContent-Type: text/plain\r\n\r\nplain\r\n' +
    '--alt\r\nContent-Type: multipart/related; boundary="rel"\r\n\r\n--rel\r\nContent-Type: text/html\r\n\r\n<img src="cid:logo@x">\r\n' +
    `--rel\r\nContent-Type: image/png\r\nContent-ID: <logo@x>\r\nContent-Transfer-Encoding: base64\r\n\r\n${big}\r\n--rel--\r\n--alt--`,
    attachment('report.pdf', big, 'application/pdf'),
  ])),
  'inline message/rfc822 with its own attachment': () => bytesOf(head + mixed('fwd', [
    'Content-Type: text/plain\r\n\r\nSee below.',
    `Content-Type: message/rfc822\r\n\r\nSubject: Inner\r\nFrom: inner@example.test\r\n${mixed('inner', ['Content-Type: text/plain\r\n\r\ninner body', attachment('inner.bin')])}`,
  ])),
  'message/rfc822 as an attachment': () => bytesOf(head + mixed('att', [
    'Content-Type: text/plain\r\n\r\nAttached.',
    `Content-Type: message/rfc822\r\nContent-Disposition: attachment; filename="forward.eml"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(bytesOf(`Subject: Inner\r\n\r\n${'x'.repeat(300_000)}`))}`,
  ])),
  'delivery report forces message/rfc822 to an attachment': () => bytesOf(head.replace('MIME-Version: 1.0\r\n', '') +
    'Content-Type: multipart/report; report-type=delivery-status; boundary="dsn"\r\n\r\n--dsn\r\nContent-Type: text/plain\r\n\r\nFailed.\r\n' +
    '--dsn\r\nContent-Type: message/delivery-status\r\n\r\nAction: failed\r\n' +
    `--dsn\r\nContent-Type: message/rfc822\r\n\r\nSubject: Original\r\n\r\n${'o'.repeat(300_000)}\r\n--dsn--\r\n`),
  'message/rfc822 nested past the depth limit': () => {
    let mime = `Subject: Innermost\r\n${mixed('in', ['Content-Type: text/plain\r\n\r\ninnermost', attachment('deep.bin', b64(fill(1000, 5)))])}`;
    for (let depth = 4; depth > 0; depth--) mime = `Subject: Level ${depth}\r\n${mixed(`lvl${depth}`, ['Content-Type: text/plain\r\n\r\nlevel', `Content-Type: message/rfc822\r\n\r\n${mime}`])}`;
    return bytesOf(mime);
  },
  'missing closing boundary': () => bytesOf(head + mixed('open', ['Content-Type: text/plain\r\n\r\nbody', attachment('open.bin')], false)),
  'boundary lines with trailing whitespace and junk': () => bytesOf(head + 'Content-Type: multipart/mixed; boundary=ws\r\n\r\n' +
    `--ws \t\r\nContent-Type: text/plain\r\n\r\nbody\r\n--ws junk\r\nnot a boundary\r\n--ws\r\n${attachment('ws.bin')}\r\n--ws-- \r\n`),
  'a boundary that prefixes a nested boundary': () => bytesOf(head + mixed('b', [
    `Content-Type: multipart/mixed; boundary="b2"\r\n\r\n--b2\r\n${attachment('nested.bin')}\r\n--b2--`,
    attachment('outer.bin', b64(fill(1000, 7))),
  ])),
  'missing transfer encoding on 8-bit binary': () => {
    const binary = fill(300 * 1024, 3);
    const prefix = bytesOf(head + 'Content-Type: multipart/mixed; boundary="bin"\r\n\r\n--bin\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=raw.bin\r\n\r\n');
    const suffix = bytesOf('\r\n--bin--\r\n');
    const out = new Uint8Array(prefix.byteLength + binary.byteLength + suffix.byteLength);
    out.set(prefix); out.set(binary, prefix.byteLength); out.set(suffix, prefix.byteLength + binary.byteLength);
    return out;
  },
  '8-bit text body': () => new Uint8Array(Buffer.from(`${head}Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nGr\xfc\xdfe aus K\xf6ln\r\n`, 'latin1')),
  'non-ASCII filenames': () => bytesOf(head + mixed('names', [
    'Content-Type: text/plain\r\n\r\nNames.',
    attachment('=?UTF-8?B?w6l0w6kgcsOpc3Vtw6kucGRm?=', b64(fill(100, 2))),
    `Content-Type: application/pdf\r\nContent-Disposition: attachment; filename*=UTF-8''%E6%97%A5%E6%9C%AC.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${big}`,
    `Content-Type: application/pdf\r\nContent-Disposition: attachment; filename*0*=UTF-8''%C3%A9t; filename*1*=%C3%A9.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(fill(10, 4))}`,
    'Content-Type: application/octet-stream; name="Grüße.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC',
  ])),
  'zero-byte parts': () => bytesOf(head + mixed('zero', [
    'Content-Type: text/plain\r\n\r\n',
    'Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=empty.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n',
    'Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=headers-only.bin',
    'Content-Type: image/gif\r\nContent-Transfer-Encoding: base64\r\n\r\n====',
  ])),
  'a single-part binary message': () => bytesOf(`${head}Content-Type: application/pdf; name=whole.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${big}\r\n`),
  'text/plain sent as a large attachment': () => bytesOf(head + mixed('txt', [
    'Content-Type: text/plain\r\n\r\nBody.',
    `Content-Type: text/plain; charset=utf-8\r\nContent-Disposition: attachment; filename=log.txt\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${'caf=C3=A9 ='.repeat(40_000)}`,
  ])),
  'a large calendar attachment': () => bytesOf(head + mixed('cal', [
    'Content-Type: text/plain\r\n\r\nInvite.',
    `Content-Type: text/calendar; method=REQUEST\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(bytesOf(`BEGIN:VCALENDAR\r\n${'X-A:b\r\n'.repeat(60_000)}END:VCALENDAR\r\n`))}`,
  ])),
  'quoted-printable binary in UTF-16 with invalid escapes': () => bytesOf(head + mixed('qp', [
    `Content-Type: application/octet-stream; charset=utf-16le\r\nContent-Disposition: attachment; filename=u16.bin\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${'ab=00=ZZcd=\r\n=4'.repeat(3_000)}=`,
    `Content-Type: application/x-thing; charset=x-unknown\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${'=E9t=E9 '.repeat(5_000)}`,
  ])),
  'base64 with garbage, odd length and bad padding': () => bytesOf(head + mixed('garbage', [
    `Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n${big.replace(/A/g, 'A!').slice(0, -3)}`,
    'Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\nQUJD=RA==\r\nRUY',
    'Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\nQ',
  ])),
  'more than 512 attachments': () => bytesOf(head + mixed('many', Array.from({ length: 600 }, (_, i) =>
    `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="part-${i}.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(fill(i, i + 1))}`))),
  'multipart/digest with default message/rfc822 parts': () => bytesOf(head + 'Content-Type: multipart/digest; boundary=dig\r\n\r\n' +
    '--dig\r\n\r\nSubject: First\r\n\r\nfirst body\r\n--dig\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment\r\n\r\nSubject: Second\r\n\r\nsecond\r\n--dig--\r\n'),
  'LF-only and bare CR line ends': () => bytesOf((head + mixed('lf', ['Content-Type: text/plain\r\n\r\nline\ronly', attachment('lf.bin', `${big}\r\r\r`)]))
    .replace(/\r\n/g, '\n')),
  'duplicate content headers': () => bytesOf(head + mixed('dup', [
    `Content-Type: application/octet-stream\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\nContent-Transfer-Encoding: 7bit\r\nContent-Disposition: attachment; filename=dup.bin\r\n\r\n${big}`,
  ])),
  'folded headers and an RFC 2231 boundary': () => bytesOf(head + 'Content-Type: multipart/mixed;\r\n boundary*0="fold";\r\n\tboundary*1="ed"\r\n\r\n' +
    `--folded\r\nContent-Type: application/octet-stream;\r\n name="folded.bin"\r\nContent-Transfer-Encoding:\r\n base64\r\n\r\n${big}\r\n--folded--\r\n`),
};

// PostalMime copies a view that is not its whole buffer; parse a few such views too.
const OFFSET_CASES = new Set(['nested multipart with an inline image', 'missing transfer encoding on 8-bit binary',
  'text/plain sent as a large attachment', 'LF-only and bare CR line ends']);

test('the bounded parse matches the unbounded parse on the named edge cases', async t => {
  const tally = counts();
  for (const [name, build] of Object.entries(EDGE_CASES)) {
    const raw = build();
    await assertEquivalent(raw, name, tally);
    if (OFFSET_CASES.has(name)) await assertEquivalent(offsetView(raw), `${name} (offset view)`, tally);
  }
  t.diagnostic(`edge cases: ${Object.keys(EDGE_CASES).length} ${JSON.stringify(tally)}`);
  assert.ok(tally.measured >= 600 && tally.externalMeasured >= 15, JSON.stringify(tally));
});

test('the bounded parse matches the unbounded parse on 200 seeded messages', async t => {
  const tally = counts();
  for (let seed = 1; seed <= 200; seed++) {
    const raw = corpusMessage(seed);
    await assertEquivalent(raw, `seed ${seed}`, tally);
    if (seed % 10 === 0) await assertEquivalent(offsetView(raw), `seed ${seed} (offset view)`, tally);
  }
  t.diagnostic(`seeded: ${JSON.stringify(tally)}`);
  assert.ok(tally.measured >= 200 && tally.externalMeasured >= 5, JSON.stringify(tally));
});

test('a parse that breaks the contiguous-part assumption falls back to the unbounded parse', async () => {
  const raw = EDGE_CASES['nested multipart with an inline image']();
  const proto = PostalMime.prototype as unknown as { processLine(line: Uint8Array, isFinal: boolean): Promise<void>; currentNode: { state: string; feed(line: Uint8Array): void } };
  const original = proto.processLine;
  let skewed = false;
  // Feed one measured body line twice, once, then restore the parser.
  proto.processLine = async function (this: typeof proto, line, isFinal) {
    await original.call(this, line, isFinal);
    if (!skewed && this.currentNode.state === 'body' && line.byteLength === 76) { skewed = true; this.currentNode.feed(line); }
  };
  const logged: unknown[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => { logged.push(...args); };
  let bounded: Awaited<ReturnType<typeof boundedMime>>;
  try { bounded = await boundedMime(raw); }
  finally { proto.processLine = original; console.error = log; }
  assert.ok(skewed);
  assert.deepEqual(logged, [{ code: 'mail_parse_fallback' }]);
  const stock = await PostalMime.parse(raw, OPTIONS);
  assert.deepEqual(bounded.contents, stock.attachments.map(a => decodedAttachment(a.content)));
  assert.ok(bounded.contents.every(content => content instanceof Uint8Array));
});

test('a stored part whose bytes no longer match the registered digest errors before the stream ends', async () => {
  const raw = EDGE_CASES['a single-part binary message']();
  const { contents: [source] } = await boundedMime(raw);
  assert.ok(source && !(source instanceof Uint8Array));
  const reader = partStream(source, '0'.repeat(64)).getReader();
  let delivered = 0;
  await assert.rejects(async () => { for (let next = await reader.read(); !next.done; next = await reader.read()) delivered += next.value.byteLength; },
    /Attachment digest changed on decode/);
  assert.ok(delivered < source.size, `delivered ${delivered} of ${source.size}`);
  // A different size errors too.
  await assert.rejects(partDigest({ ...source, size: source.size + 1 }), /Attachment size changed on decode/);
});
