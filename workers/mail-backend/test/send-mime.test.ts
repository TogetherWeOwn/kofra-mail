import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import PostalMime from 'postal-mime';
import { MESSAGE_ID_MAX } from '../../../contracts/mail-api/src/headers.ts';
import { attachmentBudget, LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { SendMimeInput } from '../src/send-mime.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const frozen: SendMimeInput = {
  from: { email: 'sender@example.com', name: 'Café' },
  to: [{ email: 'reader@example.net', name: 'Reader' }],
  cc: [], bcc: [{ email: 'hidden@example.net' }],
  subject: 'Résumé', text: 'Hello, reader! This is a sent copy.',
  frozenReplyTo: { email: 'replies@example.com' },
  dateAt: Date.UTC(2026, 0, 2, 3, 4, 5), sendId: 'send_001', builderVersion: 1,
  attachments: [],
};
const file = (name: string, bytes: Uint8Array = Uint8Array.of(0, 255, 16)) => ({ name, type: 'application/octet-stream', bytes });
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').replace(/\r?\n/g, '\r\n');
const id = (n: number, length: number) => `<${String(n).padStart(5, '0')}.${'1234567890'.repeat(Math.ceil(length / 10)).slice(0, length - 20)}@example.com>`;
const header = (mime: string, name: string) => mime.split('\r\n\r\n')[0].split(/\r\n(?![ \t])/).find(line => line.startsWith(`${name}:`));
const unfold = (line?: string) => line?.slice(line.indexOf(':') + 1).replace(/\r\n[ \t]+/g, ' ').trim();

// Import inside each case so an absent builder reports each behavior as red.
const builders = () => import('../src/send-mime.ts');

test('sent MIME matches the forwarded filename golden file and parses with PostalMime', async () => {
  const { buildSentCopy } = await builders();
  const attachments = [file('a"b.txt'), file('a;b.txt'), file('café.txt'), file('plain.txt', new Uint8Array())];
  const { bytes, encodedSize } = buildSentCopy({ ...frozen, attachments });
  assert.equal(encodedSize, bytes.byteLength);
  assert.equal(decoder.decode(bytes), fixture('send-mime-forwarded.eml'));
  const parsed = await PostalMime.parse(bytes);
  assert.deepEqual(parsed.from, { address: frozen.from.email, name: frozen.from.name });
  assert.deepEqual(parsed.to, [{ address: 'reader@example.net', name: 'Reader' }]);
  assert.deepEqual(parsed.replyTo, [{ address: 'replies@example.com', name: '' }]);
  assert.equal(parsed.bcc, undefined);
  assert.equal(parsed.subject, frozen.subject);
  // PostalMime adds the delimiter's framing CRLF as an extra LF to a QP body.
  assert.equal(parsed.text?.replace(/\n$/, ''), frozen.text);
  assert.equal(parsed.date, '2026-01-02T03:04:05.000Z');
  assert.equal(parsed.messageId, '<send_001@example.com>');
  assert.deepEqual(parsed.attachments.map(({ filename, content }) => [filename, new Uint8Array(content as ArrayBuffer)]),
    attachments.map(({ name, bytes }) => [name, bytes]));
});

test('parts PostalMime treats specially still round-trip as opaque file bytes in the sent copy', async () => {
  const { buildSentCopy, buildSendRequest } = await builders();
  const bytes = encoder.encode('BEGIN:VCALENDAR\r\nEND:VCALENDAR');
  const attachments = ['multipart/mixed', 'text/calendar', 'application/ics', 'message/rfc822', 'application/pdf']
    .map((type, i) => ({ ...file(`forwarded-${i}`, bytes), type }));
  const input = { ...frozen, attachments };
  const parsed = await PostalMime.parse(buildSentCopy(input).bytes);
  assert.deepEqual(parsed.attachments.map(({ filename, mimeType, content }) => [filename, mimeType, new Uint8Array(content as ArrayBuffer)]),
    attachments.map(({ name, bytes, type }) => [name, type === 'application/pdf' ? type : 'application/octet-stream', bytes]));
  assert.deepEqual(buildSendRequest(input).attachments?.map(({ type }) => type), attachments.map(({ type }) => type));
});

test('long Unicode headers and filenames round-trip, with no physical line over 998 bytes', async () => {
  const { buildSentCopy } = await builders();
  const unicode = '界🌍'.repeat(100);
  const subject = ` ${unicode}  end `;
  const name = `Reader "quoted", <neither@example.org> ${'ab🌍'.repeat(30)}`;
  const filename = `${'日本'.repeat(41)};report`;
  const cc = Array.from({ length: LIMITS.recipientsPerMessage - 2 }, (_, i) => ({ email: `copy${i}@example.org` }));
  const input = { ...frozen, subject, to: [{ ...frozen.to[0], name }], cc, text: unicode, attachments: [file(filename)] };
  const mime = buildSentCopy(input).bytes;
  for (const line of decoder.decode(mime).split('\r\n')) assert.ok(Buffer.byteLength(line) <= 998);
  const words = decoder.decode(mime).match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? [];
  assert.ok(words.length > 1);
  for (const word of words) assert.ok(word.length <= 75);
  const parsed = await PostalMime.parse(mime);
  assert.equal(parsed.subject, subject);
  assert.deepEqual(parsed.to, [{ address: frozen.to[0].email, name }]);
  assert.deepEqual(parsed.cc?.map(({ address }) => address), cc.map(({ email }) => email));
  assert.equal(parsed.text, unicode);
  assert.equal(parsed.attachments[0].filename, filename);
});

test('lines with RFC 2047 encoded words stay within 76 characters', async () => {
  const { buildSentCopy } = await builders();
  const subject = 'A'.repeat(70);
  const { bytes } = buildSentCopy({ ...frozen, subject });
  const lines = header(decoder.decode(bytes), 'Subject')!.split('\r\n').filter(line => line.includes('=?UTF-8?B?'));
  assert.ok(lines.length > 0);
  for (const line of lines) assert.ok(line.length <= 76, `encoded-word line is ${line.length} characters`);
  assert.equal((await PostalMime.parse(bytes)).subject, subject);
});

test('References golden keeps the first and newest ids of a 12-id thread and folds between ids', async () => {
  const { buildSentCopy, buildSendRequest } = await builders();
  const chain = Array.from({ length: 12 }, (_, i) => id(i + 1, 200));
  assert.ok(chain.every(value => value.length === 200));
  const input = { ...frozen, threading: { inReplyTo: chain.at(-1), references: chain.join(' ') } };
  const mime = decoder.decode(buildSentCopy(input).bytes);
  const references = header(mime, 'References');
  assert.equal(`${references}\r\n`, fixture('send-mime-references.txt'));
  assert.equal(unfold(header(mime, 'In-Reply-To')), chain.at(-1));
  const value = unfold(references)!;
  assert.equal(buildSendRequest(input).headers.References, value);
  assert.deepEqual(value.split(' '), [chain[0], ...chain.slice(-9)]);
  assert.ok(Buffer.byteLength(value) <= LIMITS.headerValueBytes);
  for (const line of references!.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 998);
});

test('threading drops unsafe and overlong ids without promoting an ancestor to In-Reply-To', async () => {
  const { buildSentCopy, buildSendRequest } = await builders();
  const max = id(1, MESSAGE_ID_MAX);
  const input = { ...frozen, threading: {
    inReplyTo: id(2, LIMITS.headerValueBytes + 1),
    references: [id(3, MESSAGE_ID_MAX + 1), '<nested<id>>', '<bad\n@id>', max].join(' '),
  } };
  const mime = decoder.decode(buildSentCopy(input).bytes);
  assert.equal(header(mime, 'In-Reply-To'), undefined);
  assert.equal(unfold(header(mime, 'References')), max);
  assert.deepEqual(buildSendRequest(input).headers, { References: max });
  const legalParent = decoder.decode(buildSentCopy({ ...frozen, threading: { inReplyTo: max } }).bytes);
  assert.equal(header(legalParent, 'In-Reply-To')?.length, 998);
});

test('structured request sets only two threading headers and shares the frozen Reply-To with stored MIME', async () => {
  const { buildSendRequest, buildSentCopy } = await builders();
  const headers = Object.fromEntries(['Reply-To', 'Bcc', 'Sender', 'From', 'Return-Path', 'Date', 'Message-ID']
    .map(key => [key, 'ignored@example.org']));
  const attachment = file('report.txt');
  const parent = '<parent@example.net>';
  const frozenReplyTo = { email: 'replies@example.com', name: 'Réponses' };
  const input = { ...frozen, headers, replyTo: 'ignored@example.org', frozenReplyTo, attachments: [attachment],
    from: { ...frozen.from, headers, replyTo: 'ignored@example.org' },
    bcc: [{ email: 'hidden@example.net', headers }] };
  const request = buildSendRequest({ ...input, threading: { inReplyTo: parent, references: parent } });
  assert.deepEqual(Object.keys(request.headers), ['In-Reply-To', 'References']);
  assert.deepEqual(request, {
    from: frozen.from, to: frozen.to, bcc: ['hidden@example.net'], subject: frozen.subject, text: frozen.text, replyTo: frozenReplyTo,
    attachments: [{ disposition: 'attachment', filename: attachment.name, type: attachment.type, content: attachment.bytes }],
    headers: { 'In-Reply-To': parent, References: parent },
  });
  const parsed = await PostalMime.parse(buildSentCopy(input).bytes);
  assert.deepEqual(parsed.replyTo, [{ address: frozenReplyTo.email, name: frozenReplyTo.name }]);
  for (const value of Object.values(request.headers)) assert.ok(Buffer.byteLength(value) <= LIMITS.headerValueBytes);
  const withoutFrozen = buildSendRequest({ ...input, frozenReplyTo: undefined });
  assert.deepEqual(Object.keys(withoutFrozen.headers), []);
  assert.equal(withoutFrozen.replyTo, undefined);
  const bccOnly = { ...frozen, to: [] };
  assert.equal(header(decoder.decode(buildSentCopy(bccOnly).bytes), 'Bcc'), undefined);
  assert.deepEqual(buildSendRequest(bccOnly).bcc, ['hidden@example.net']);
});

test('builders reject invalid_header without stripping controls from header inputs', async () => {
  const { buildSentCopy, buildSendRequest } = await builders();
  for (const ch of ['\r', '\n', '\0', '\x1f', '\x7f', '\u0085']) {
    for (const [field, input] of [
      ['/from/name', { ...frozen, from: { ...frozen.from, name: `before${ch}after` } }],
      ['/from/email', { ...frozen, from: { email: `sender${ch}@example.com` } }],
      ['/to/0/name', { ...frozen, to: [{ ...frozen.to[0], name: ch }] }],
      ['/cc/0/email', { ...frozen, cc: [{ email: `copy${ch}@example.org` }] }],
      ['/bcc/0/name', { ...frozen, bcc: [{ ...frozen.bcc[0], name: ch }] }],
      ['/subject', { ...frozen, subject: `Hello${ch}world` }],
      ['/replyTo/email', { ...frozen, frozenReplyTo: { email: `replies${ch}@example.com` } }],
      ['/attachments/0/name', { ...frozen, attachments: [file(`attachment${ch}.txt`)] }],
    ] as const) {
      for (const build of [buildSentCopy, buildSendRequest]) {
        assert.throws(() => build(input), { message: 'invalid_header', problem: { code: 'invalid_header', errors: [{ field, code: 'invalid' }] } });
      }
    }
  }
  // Horizontal tab is explicitly allowed by the contract's hasHeaderControl rule.
  const parsed = await PostalMime.parse(buildSentCopy({ ...frozen, subject: 'a\tb' }).bytes);
  assert.equal(parsed.subject, 'a\tb');
});

test('builders enforce recipient syntax and count across To, Cc and Bcc', async () => {
  const { buildSentCopy, buildSendRequest } = await builders();
  const to = Array.from({ length: LIMITS.recipientsPerMessage - 2 }, (_, i) => ({ email: `reader${i}@example.net` }));
  const input = { ...frozen, to, cc: [{ email: 'copy@example.net' }] };
  for (const build of [buildSentCopy, buildSendRequest]) {
    assert.doesNotThrow(() => build(input));
    assert.throws(() => build({ ...input, bcc: [...frozen.bcc, { email: 'extra@example.net' }] }), { message: 'too_many_recipients' });
    assert.throws(() => build({ ...frozen, to: [], bcc: [] }), { message: 'invalid_recipients' });
    for (const email of ['reader@example.net, other@example.org', 'Name <other@example.org>', 'reader@example.net>']) {
      assert.throws(() => build({ ...frozen, to: [{ email }] }), { message: 'invalid_recipients' });
    }
  }
});

test('builders bound display names by UTF-8 bytes before serialization', async () => {
  const { buildSentCopy, buildSendRequest } = await builders();
  const name = 'é'.repeat(LIMITS.displayNameBytes / 2);
  for (const build of [buildSentCopy, buildSendRequest]) {
    assert.doesNotThrow(() => build({ ...frozen, from: { ...frozen.from, name } }));
    assert.throws(() => build({ ...frozen, from: { ...frozen.from, name: `${name}x` } }), {
      message: 'invalid_request', problem: { code: 'invalid_request', errors: [{ field: '/from/name', code: 'too_long' }] },
    });
  }
});

test('filenames disallow horizontal tab like the upload and index policies', async () => {
  const { buildSentCopy, buildSendRequest } = await builders();
  for (const build of [buildSentCopy, buildSendRequest]) {
    assert.throws(() => build({ ...frozen, attachments: [file('before\tafter.txt')] }), {
      message: 'invalid_header', problem: { code: 'invalid_header', errors: [{ field: '/attachments/0/name', code: 'invalid' }] },
    });
  }
});

test('builders accept 32 file attachments and refuse one more', async () => {
  const { buildSentCopy, buildSendRequest } = await builders();
  const attachments = Array.from({ length: LIMITS.attachmentsPerMessage }, (_, i) => file(`file${i}.txt`));
  for (const build of [buildSentCopy, buildSendRequest]) {
    assert.doesNotThrow(() => build({ ...frozen, attachments }));
    assert.throws(() => build({ ...frozen, attachments: [...attachments, file('extra.txt')] }), { message: 'too_many_attachments' });
  }
});

test('the exact encoded message limit is accepted and one more byte is refused', async () => {
  const { buildSentCopy, buildSendRequest } = await builders();
  const limit = LIMITS.outboundMessageBytes;
  const input = (size: number, text: string) => ({ ...frozen, text, attachments: [file('load.bin', new Uint8Array(size))] });
  const text = 'A'.repeat(54);
  const estimate = Math.floor((limit - 2048) * 57 / 78);
  const remaining = limit - buildSentCopy(input(estimate, text)).encodedSize;
  const size = estimate + Math.floor(remaining * 57 / 78) - 4;
  const padding = limit - buildSentCopy(input(size, text)).encodedSize;
  assert.ok(padding > 0 && padding < 20);
  const accepted = input(size, text + 'A'.repeat(padding));
  assert.equal(buildSentCopy(accepted).encodedSize, limit);
  assert.doesNotThrow(() => buildSendRequest(accepted));
  const over = { ...accepted, text: `${accepted.text}A` };
  for (const build of [buildSentCopy, buildSendRequest]) {
    assert.throws(() => build(over), { message: 'message_too_large', problem: { code: 'message_too_large', limit } });
  }
});

test('multiline base64 text decodes to canonical CRLF', async () => {
  const { buildSentCopy } = await builders();
  const unicode = '界🌍'.repeat(40);
  const text = `${unicode}\n${unicode}\r\n${unicode}\r${unicode}`;
  const { bytes } = buildSentCopy({ ...frozen, text });
  assert.equal(unfold(header(decoder.decode(bytes), 'Content-Transfer-Encoding')), 'base64');
  assert.equal((await PostalMime.parse(bytes)).text, Array(4).fill(unicode).join('\r\n'));
});

test('attachment budget leaves room for a 1 MiB body with newline-heavy Unicode text', async () => {
  const { buildSentCopy } = await builders();
  const text = '界\n'.repeat((1024 * 1024) / 4);
  assert.equal(Buffer.byteLength(text), LIMITS.bodyBytes);
  const canonicalBytes = Buffer.byteLength(text.replaceAll('\n', '\r\n'));
  const budget = attachmentBudget(LIMITS, text);
  assert.equal(budget, attachmentBudget(LIMITS, canonicalBytes));
  assert.ok(budget < attachmentBudget(LIMITS, LIMITS.bodyBytes));
  assert.ok(buildSentCopy({ ...frozen, text, attachments: [file('load.bin', new Uint8Array(budget))] }).encodedSize <=
    LIMITS.outboundMessageBytes);
});

test('chooses the smaller complete text part, including transfer header and wraps', async () => {
  const { buildSentCopy } = await builders();
  for (const [text, encoding] of [
    ['A'.repeat(150) + ' \n\nend ', 'quoted-printable'],
    ['A'.repeat(150) + '\r\nlast\n', 'quoted-printable'],
    ['世界🌍'.repeat(40), 'base64'],
  ]) {
    const { bytes } = buildSentCopy({ ...frozen, text });
    const mime = decoder.decode(bytes);
    assert.equal(unfold(header(mime, 'Content-Transfer-Encoding')), encoding);
    for (const line of mime.split('\r\n\r\n')[1].split('\r\n')) assert.ok(line.length <= 76);
    const parsed = (await PostalMime.parse(bytes)).text?.replaceAll('\r\n', '\n');
    const endsInNewline = text.endsWith('\n');
    if (encoding === 'quoted-printable') {
      // Without a delimiter there is no framing CRLF to emit in the body.
      assert.equal(mime.endsWith('\r\n'), endsInNewline);
    }
    // The parser appends an LF when the last encoded QP line has no terminator.
    assert.equal(encoding === 'quoted-printable' && !endsInNewline ? parsed?.replace(/\n$/, '') : parsed,
      text.replaceAll('\r\n', '\n'));
  }
});

test('restore rerun uses frozen inputs and ignores later settings and undo changes', async () => {
  const { buildSentCopy, buildSendRequest } = await builders();
  const input = { ...frozen, attachments: [file('a.txt')] };
  const restored = structuredClone(input);
  const original = buildSentCopy(input);
  assert.deepEqual(original, buildSentCopy(input));
  const rerun = { ...restored, undoUntil: frozen.dateAt + 60_000,
    settings: { displayName: 'New name', replyTo: 'changed@example.org', builderVersion: 2 } };
  assert.deepEqual(buildSentCopy(rerun), original);
  assert.deepEqual(buildSendRequest(rerun), buildSendRequest(input));
  assert.notDeepEqual(buildSentCopy({ ...input, sendId: 'send_002' }).bytes, original.bytes);
  assert.notDeepEqual(buildSentCopy({ ...input, dateAt: frozen.dateAt + 60_000 }).bytes, original.bytes);
  assert.throws(() => buildSentCopy({ ...input, builderVersion: 2 }), /unsupported MIME builder version/i);
});
