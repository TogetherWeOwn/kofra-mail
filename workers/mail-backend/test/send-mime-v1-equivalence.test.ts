import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasHeaderControl, isSafeMessageId, threadingHeaders } from '../../../contracts/mail-api/src/headers.ts';
import { canonicalMailText, LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { AddressInput } from '../../../contracts/mail-api/src/wire.ts';
import { defaultMimeBuilders, type SendMimeMessage } from '../src/mailbox-send-mime.ts';
import { buildSentCopy, SEND_MIME_VERSION, type SendMimeInput } from '../src/send-mime.ts';

// Frozen v1 reference from a0fd496. Only the stored-copy path for valid inputs
// is copied here; the production input validation has its own tests. In
// particular, the legacy string writer and its plan must not track changes to
// the production serializer, or this test could miss a changed sent digest.
const CRLF = '\r\n';
const encoder = new TextEncoder();
const simpleBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

function encodedWords(value: string): string[] {
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => { words.push(`=?UTF-8?B?${simpleBase64(Uint8Array.from(chunk))}?=`); chunk = []; };
  for (const char of value) {
    const bytes = encoder.encode(char);
    if (chunk.length + bytes.length > 42) flush();
    chunk.push(...bytes);
  }
  if (chunk.length) flush();
  return words;
}

function asciiHeader(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value) && value.trim() === value && !value.includes('=?');
}

function addressWords({ name, email }: Readonly<AddressInput>): string[] {
  if (!name) return [email];
  const quoted = `"${name.replace(/["\\]/g, '\\$&')}"`;
  const words = quoted.length <= 68 && asciiHeader(name) ? [quoted] : encodedWords(name);
  return [...words, `<${email}>`];
}

function addressList(addresses: readonly Readonly<AddressInput>[]): string[] {
  return addresses.flatMap((address, i) => {
    const words = addressWords(address);
    if (i + 1 < addresses.length) words[words.length - 1] += ',';
    return words;
  });
}

function fold(name: string, words: readonly string[]): string {
  let line = `${name}:`;
  const lines: string[] = [];
  let encodedLine = false;
  for (const word of words) {
    const encodedWord = word.startsWith('=?UTF-8?B?') && word.endsWith('?=');
    const limit = encodedLine || encodedWord ? 76 : line === `${name}:` ? 998 : 78;
    if (line.length + 1 + word.length > limit) {
      lines.push(line);
      line = '';
      encodedLine = false;
    }
    line += ` ${word}`;
    encodedLine ||= encodedWord;
    assert.ok(line.length <= (encodedLine ? 76 : 998));
  }
  lines.push(line);
  return lines.join(CRLF) + CRLF;
}

function byteEscape(byte: number, prefix: string): string {
  return prefix + byte.toString(16).toUpperCase().padStart(2, '0');
}

function contentDisposition(name: string): string {
  const plain = /^[a-zA-Z0-9._-]+$/;
  if (plain.test(name)) return `Content-Disposition: attachment; filename=${name}${CRLF}`;
  const fallback = Array.from(name, char => plain.test(char) ? char : '_').join('');
  const chunks: string[] = [];
  let chunk = "UTF-8''";
  for (const char of name) {
    const token = plain.test(char) ? char : Array.from(encoder.encode(char), byte => byteEscape(byte, '%')).join('');
    if (chunk.length + token.length > 60) { chunks.push(chunk); chunk = ''; }
    chunk += token;
  }
  chunks.push(chunk);
  const extended = chunks.length === 1
    ? ` filename*=${chunks[0]}`
    : chunks.map((value, i) => ` filename*${i}*=${value}`).join(`;${CRLF}`);
  return `Content-Disposition: attachment;${CRLF} filename=${fallback};${CRLF}${extended}${CRLF}`;
}

function base64Size(length: number): number {
  return Math.ceil(length / 3) * 4 + Math.max(1, Math.ceil(length / 57)) * CRLF.length;
}

function wrappedBase64(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 57) lines.push(simpleBase64(bytes.subarray(offset, offset + 57)));
  return lines.join(CRLF) + CRLF;
}

function quotedPrintable(bytes: Uint8Array, ceiling: number, framing: string): string | undefined {
  let size = 0;
  let line = '';
  const lines: string[] = [];
  const flush = (suffix: string) => { lines.push(line + suffix + CRLF); size += line.length + suffix.length + CRLF.length; line = ''; };
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 13 && bytes[i + 1] === 10) {
      flush('');
      i++;
    } else {
      const whiteSpace = byte === 9 || byte === 32;
      const literal = whiteSpace ? i + 1 < bytes.length && bytes[i + 1] !== 13 : byte >= 33 && byte <= 126 && byte !== 61;
      const token = literal ? String.fromCharCode(byte) : byteEscape(byte, '=');
      if (line.length + token.length > 75) flush('=');
      line += token;
    }
    if (size + line.length >= ceiling) return;
  }
  if (size + line.length + framing.length < ceiling) return lines.join('') + line + framing;
}

const textType = `Content-Type: text/plain; charset=UTF-8${CRLF}`;
const encodingHeader = (name: string) => `Content-Transfer-Encoding: ${name}${CRLF}`;
const qpHeader = encodingHeader('quoted-printable');
const base64Header = encodingHeader('base64');

function textPart(value: string, multipart: boolean): [string, string | Uint8Array] {
  const bytes = encoder.encode(canonicalMailText(value));
  const qp = quotedPrintable(bytes, base64Size(bytes.length) + base64Header.length - qpHeader.length, multipart ? CRLF : '');
  return qp !== undefined ? [textType + qpHeader, qp] : [textType + base64Header, bytes];
}

function storedAttachmentType(type: string): string {
  const opaque = 'application/octet-stream';
  if (type.length > 127 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(type)) return opaque;
  const lower = type.toLowerCase();
  return lower.startsWith('multipart/') || lower.startsWith('message/') || lower === 'text/calendar' || lower === 'application/ics'
    ? opaque : type;
}

function legacyBuildSentCopy(input: SendMimeInput): Uint8Array {
  const { to, cc, attachments, subject, from, dateAt, messageId, boundary } = input;
  // The corpus supplies fully frozen wire values, as in replay.
  assert.ok(messageId && isSafeMessageId(messageId));
  assert.ok(boundary?.includes('=_') && !hasHeaderControl(boundary));
  const chain = input.threading?.references?.split(' ').filter(Boolean) ?? [];
  const parent = input.threading?.inReplyTo ?? '';
  if (chain.at(-1) !== parent) chain.push(parent);
  const thread = threadingHeaders(chain, LIMITS);
  type Piece = string | Uint8Array | { part: number; size: number };
  const pieces: Piece[] = [
    fold('From', addressWords(from)),
    ...(to.length ? [fold('To', addressList(to))] : []),
    ...(cc.length ? [fold('Cc', addressList(cc))] : []),
    fold('Subject', !subject ? [] : subject.length <= 69 && asciiHeader(subject) ? [subject] : encodedWords(subject)),
    `Date: ${new Date(dateAt).toUTCString().replace('GMT', '+0000')}${CRLF}`,
    `Message-ID: ${messageId}${CRLF}`,
  ];
  if (thread.inReplyTo) pieces.push(fold('In-Reply-To', thread.inReplyTo.split(' ')));
  if (thread.references) pieces.push(fold('References', thread.references.split(' ')));
  if (input.frozenReplyTo) pieces.push(fold('Reply-To', addressWords(input.frozenReplyTo)));
  pieces.push(`MIME-Version: 1.0${CRLF}`);
  if (attachments.length) pieces.push(`Content-Type: multipart/mixed; boundary="${boundary}"${CRLF}${CRLF}--${boundary}${CRLF}`);
  const [textHeader, textBody] = textPart(input.text, attachments.length > 0);
  pieces.push(textHeader, CRLF, textBody);
  for (const [i, { name, type, bytes }] of attachments.entries()) {
    pieces.push(`--${boundary}${CRLF}Content-Type: ${storedAttachmentType(type)}${CRLF}`, base64Header,
      contentDisposition(name), CRLF, { part: i, size: bytes.byteLength });
  }
  if (attachments.length) pieces.push(`--${boundary}--${CRLF}`);
  const encodedSize = pieces.reduce((size, piece) => size + (typeof piece === 'string' ? piece.length :
    base64Size(piece instanceof Uint8Array ? piece.byteLength : piece.size)), 0);
  const bytes = new Uint8Array(encodedSize);
  let offset = 0;
  for (const piece of pieces) {
    const text = typeof piece === 'string' ? piece : wrappedBase64(piece instanceof Uint8Array ? piece : attachments[piece.part].bytes);
    offset += encoder.encodeInto(text, bytes.subarray(offset)).written;
  }
  return bytes;
}

const seed = 0x7c31a548;
let randomState = seed;
function random(): number {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return randomState >>> 0;
}

function sampleBytes(length: number) {
  // Use a nonzero byteOffset to catch writers that ignore the input view.
  const bytes = new Uint8Array(length + 7).subarray(3, length + 3);
  for (let i = 0; i < length; i++) bytes[i] = random() & 255;
  return bytes;
}

function messageFor(i: number, sizes: number[]): { message: SendMimeMessage; input: SendMimeInput; parts: Uint8Array<ArrayBuffer>[] } {
  const types = ['application/octet-stream', 'text/calendar', 'message/rfc822', 'text/plain', 'application/pdf'];
  const parts = sizes.map(sampleBytes);
  const inReplyTo = i % 3 === 0 ? '<parent@example.test>' : undefined;
  const references = inReplyTo ? `<older@example.test> ${inReplyTo}` : undefined;
  const text = i < 2 ? '' : i % 3 === 0 ? `${'界🌍'.repeat(8)}${'!'.repeat(i % 4)}\rあ` :
    `first line ${'t'.repeat(70 + i % 8)} \nsecond\r\nthird\rlast\t`;
  const message: SendMimeMessage = {
    messageId: `<seed-${i}@example.test>`, boundary: `=_km_seed_${i}`, date: Date.UTC(2026, 0, 1) + i * 1000,
    from: { email: 'from@example.test', name: i % 2 === 0 ? 'Abc "quoted"' : 'Résumé 界🌍' },
    to: i % 5 === 0 ? [] : [{ email: 'to@example.test', name: '受信者' }],
    cc: i % 3 === 0 ? [{ email: 'cc@example.test' }, { email: 'other@example.test', name: 'café' }] : [],
    bcc: [{ email: 'hidden@example.test' }], replyTo: i % 2 === 0 ? [] : [{ email: 'reply@example.test', name: 'Réponses' }],
    subject: i % 3 === 0 ? '界🌍'.repeat(50) : i % 3 === 1 ? 'ASCII subject' : '', text,
    attachments: sizes.map((size, n) => ({ size, type: types[random() % types.length],
      name: n % 2 === 0 ? `file-${i}-${n}.bin` : `${'日本'.repeat(32)}🌍;file-${i}-${n}.txt` })),
    inReplyTo, references,
  };
  const input: SendMimeInput = {
    ...message, dateAt: message.date, builderVersion: 1, frozenReplyTo: message.replyTo[0],
    threading: { inReplyTo, references }, attachments: message.attachments.map(({ name, type }, n) => ({ name, type, bytes: parts[n] })),
  };
  return { message, input, parts };
}

const builder = defaultMimeBuilders().get(1)!;

test('both v1 sent-copy paths match the legacy bytes for 64 seeded messages', async () => {
  assert.equal(SEND_MIME_VERSION, 1);
  const lineEdges = [0, 1, 2, 3, 55, 56, 57, 58, 59, 112, 113, 114, 115, 116, 170, 171, 172];
  for (let i = 0; i < 64; i++) {
    const size = i <= lineEdges.length ? lineEdges[i - 1] : i >= 61 ? (i - 60) * 1024 ** 2 + (i % 3) : random() % (128 * 1024);
    const sizes = i === 0 || (i > lineEdges.length && i % 8 === 0) ? [] :
      i % 2 === 0 ? [size, lineEdges[random() % lineEdges.length]] : [size];
    const { message, input, parts } = messageFor(i, sizes);
    const expected = legacyBuildSentCopy(input);
    const actual = buildSentCopy(input);
    const label = `seed 0x${seed.toString(16)}, case ${i}, attachment lengths [${sizes}]`;
    assert.equal(actual.encodedSize, expected.byteLength, label);
    assert.equal(builder.encodedSize(message), expected.byteLength, label);
    assert.equal(Buffer.compare(actual.bytes, expected), 0, `direct: ${label}`);
    assert.equal(Buffer.compare(await builder.build(message, async n => parts[n]), expected), 0, `mailbox: ${label}`);
  }
});

test('the mailbox builder writes a part before reading the next part', async () => {
  const { message, input, parts } = messageFor(7, [58, 114]);
  const expected = legacyBuildSentCopy(input);
  const actual = await builder.build(message, async n => {
    if (n === 1) parts[0].fill(0); // The source can reuse a backing store on its next read.
    return parts[n];
  });
  assert.equal(Buffer.compare(actual, expected), 0);
});
