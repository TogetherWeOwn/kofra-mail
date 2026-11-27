// Run from workers/mail-backend: node --expose-gc test/fixtures/parse-mail-memory.ts <case>
// Cases: one-attachment, eight-attachments, unwrapped-base64, qp-body.
import assert from 'node:assert/strict';
import { MAX_RAW_BYTES, sha256 } from '../../src/bytes.ts';
import { installDigestStream } from './digest-stream.ts';
// A namespace import, so this also runs against a parser without the part functions.
import * as parser from '../../src/parse-mail.ts';

assert.ok(globalThis.gc, 'run with --expose-gc');
installDigestStream();
const MiB = 1024 ** 2;
const kind = process.argv[2];

// A deterministic, incompressible-looking byte stream.
function filler(size: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; bytes[i] = x & 0xff; }
  return bytes;
}

function base64Lines(bytes: Uint8Array, width: number): string {
  const encoded = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += width) lines.push(encoded.slice(i, i + width));
  return lines.join('\r\n');
}

// Base64 with CRLF every 76 characters is 4/3 of the decoded size times 78/76.
const encodedSize = (decoded: number) => Math.ceil(decoded / 3) * 4 * 78 / 76;

function attachmentsMessage(count: number, width = 76): string {
  const head = 'From: Sender <sender@example.test>\r\nTo: rcpt@example.test\r\nSubject: Memory benchmark\r\n' +
    'Message-ID: <memory@example.test>\r\nDate: Thu, 01 Jan 2026 00:00:00 +0000\r\nMIME-Version: 1.0\r\n' +
    'Content-Type: multipart/mixed; boundary="=_memory"\r\n\r\n--=_memory\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' +
    'One body and large attachments.\r\n';
  // Leave room for the part headers and the closing boundary.
  const each = Math.floor((MAX_RAW_BYTES - 4096 * count - head.length) / count * 76 / 78 / 4) * 3;
  const parts = Array.from({ length: count }, (_, i) => `--=_memory\r\nContent-Type: application/octet-stream; name="file-${i}.bin"\r\n` +
    `Content-Disposition: attachment; filename="file-${i}.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    `${base64Lines(filler(each, i + 1), width)}\r\n`);
  assert.ok(encodedSize(each) * count < MAX_RAW_BYTES);
  return head + parts.join('') + '--=_memory--\r\n';
}

function qpMessage(): string {
  // 1 MiB of decoded UTF-8 text, all non-ASCII, in 76-character soft-broken lines.
  const text = 'Grüße, café, 日本語のテキスト。'.repeat(Math.ceil(MiB / 60));
  const utf8 = new TextEncoder().encode(text).subarray(0, MiB - (MiB % 3));
  let encoded = '';
  let line = '';
  for (const byte of utf8) {
    const token = byte >= 0x80 || byte === 0x3d ? `=${byte.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(byte);
    if (line.length + token.length > 75) { encoded += `${line}=\r\n`; line = ''; }
    line += token;
  }
  encoded += line;
  return 'From: sender@example.test\r\nTo: rcpt@example.test\r\nSubject: QP benchmark\r\nMessage-ID: <qp@example.test>\r\n' +
    'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' + encoded + '\r\n';
}

// Only the encoded message stays reachable; its source string is dropped.
const encode = (source: string) => new Uint8Array(new TextEncoder().encode(source));
let raw: Uint8Array<ArrayBuffer> | null = kind === 'one-attachment' ? encode(attachmentsMessage(1))
  : kind === 'eight-attachments' ? encode(attachmentsMessage(8))
  : kind === 'unwrapped-base64' ? encode(attachmentsMessage(1, Number.MAX_SAFE_INTEGER)) : kind === 'qp-body' ? encode(qpMessage()) : assert.fail(`unknown case ${kind}`);
assert.ok(raw.byteLength <= MAX_RAW_BYTES, `fixture too large: ${raw.byteLength}`);
const rawBytes = raw.byteLength;
const rawKey = `raw/${await sha256(raw)}/01KBN8ZJ7G0000000000000000`;

// External already includes ArrayBuffers. Print the components and the literal
// sum too, but count backing stores only once for the memory gate.
const used = (sample: NodeJS.MemoryUsage) => sample.heapUsed + sample.external;
const sum = (sample: NodeJS.MemoryUsage) => used(sample) + sample.arrayBuffers;
const mib = (bytes: number) => Number((bytes / MiB).toFixed(2));
const gc = globalThis.gc;
for (let i = 0; i < 3; i++) gc();
const baseline = process.memoryUsage();
let peak = baseline;
let sumPeak = sum(baseline);
let samples = 0;
const sample = () => {
  gc();
  samples++;
  const current = process.memoryUsage();
  if (used(current) > used(peak)) peak = current;
  sumPeak = Math.max(sumPeak, sum(current));
};

// The parser does not yield to timers, so sample at the allocation points a
// MIME parser can use for a large part: Blob assembly and reads, large text
// decoding and encoding, copies into large buffers and digests.
const restore: Array<() => void> = [];
function wrap<T extends object, K extends keyof T>(target: T, key: K, wrapper: (original: T[K]) => T[K]) {
  const original = target[key];
  target[key] = wrapper(original);
  restore.push(() => { target[key] = original; });
}
const large = (value: unknown) => ArrayBuffer.isView(value) ? value.byteLength >= 64 * 1024
  : value instanceof ArrayBuffer ? value.byteLength >= 64 * 1024 : typeof value === 'string' && value.length >= 64 * 1024;
const globals = globalThis as unknown as { Blob: typeof Blob };
const OriginalBlob = globals.Blob;
wrap(globals, 'Blob', () => class extends OriginalBlob {
  constructor(...args: ConstructorParameters<typeof Blob>) { super(...args); sample(); }
  async arrayBuffer() { sample(); const value = await super.arrayBuffer(); sample(); return value; }
} as typeof Blob);
// PostalMime decodes every line, so this also samples along the parse.
let decodes = 0;
wrap(TextDecoder.prototype, 'decode', decode => function (this: TextDecoder, input, options) {
  const value = decode.call(this, input, options);
  if (large(input) || ++decodes % 16_384 === 0) sample();
  return value;
});
wrap(TextEncoder.prototype, 'encode', encode => function (this: TextEncoder, input) {
  const value = encode.call(this, input);
  if (large(input)) sample();
  return value;
});
wrap(Uint8Array.prototype, 'set', set => function (this: Uint8Array, array, offset) {
  set.call(this, array, offset);
  if (this.byteLength >= MiB) sample();
});
wrap(crypto.subtle, 'digest', digest => async function (this: SubtleCrypto, algorithm, data) {
  sample();
  const value = await digest.call(this, algorithm, data);
  sample();
  return value;
});

const start = performance.now();
let indexed = 0;
let stored = 0;
try {
  // The inbound index path without storage: parse, then hash and stream each
  // stored attachment in turn, as holdAndStore does.
  const parsed = await parser.parseMail(raw, rawKey, true);
  sample();
  indexed = parsed.attachments.length;
  for (const { external } of parsed.attachments) {
    if (!external) continue;
    if (external instanceof Uint8Array) await sha256(external);
    else {
      const digest = await parser.partDigest(external);
      sample();
      const reader = parser.partStream(external, digest).getReader();
      let size = 0;
      for (let block = await reader.read(); !block.done; block = await reader.read()) {
        size += block.value.byteLength;
        if (size % (4 * MiB) < block.value.byteLength) sample();
      }
      assert.equal(size, external.size);
    }
    stored++;
  }
  sample();
} finally {
  for (const undo of restore.reverse()) undo();
}
raw = null;
const elapsedMs = Math.round(performance.now() - start);
console.log(JSON.stringify({ case: kind, node: process.version, rawBytes, rawMiB: mib(rawBytes), indexed, stored, samples, elapsedMs,
  baselineMiB: mib(used(baseline)), peakMiB: mib(used(peak)), deltaMiB: mib(used(peak) - used(baseline)),
  heapUsedMiB: mib(peak.heapUsed), externalMiB: mib(peak.external), arrayBuffersMiB: mib(peak.arrayBuffers),
  literalSumPeakMiB: mib(sumPeak), maxRssMiB: mib(process.resourceUsage().maxRSS * 1024),
}));
assert.ok(used(peak) <= 64 * MiB, `${kind} parse peak ${mib(used(peak))} MiB exceeds the 64 MiB budget`);
