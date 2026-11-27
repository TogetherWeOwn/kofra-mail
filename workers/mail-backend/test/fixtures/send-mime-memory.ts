// Run from workers/mail-backend: node --expose-gc test/fixtures/send-mime-memory.ts
import assert from 'node:assert/strict';
import { LIMITS } from '../../../../contracts/mail-api/src/limits.ts';
import { defaultMimeBuilders, type SendMimeMessage } from '../../src/mailbox-send-mime.ts';

assert.ok(globalThis.gc, 'run with --expose-gc');
const MiB = 1024 ** 2;
const target = 23.9 * MiB;
const builder = defaultMimeBuilders().get(1)!;
const message: SendMimeMessage = {
  from: { email: 'from@example.test' }, to: [{ email: 'to@example.test' }], cc: [], bcc: [], replyTo: [],
  messageId: '<memory@example.test>', boundary: '=_km_memory', date: Date.UTC(2026, 0, 1),
  subject: 'Sent-copy memory benchmark', text: 'One body and one large attachment.\n',
  attachments: [{ name: 'sample.bin', type: 'application/octet-stream', size: Math.floor(target * 57 / 78) }],
};
const encodedSize = builder.encodedSize(message);
assert.ok(Math.abs(encodedSize - target) < 1024, `unexpected fixture size: ${encodedSize}`);

// External already includes ArrayBuffers. Print the components and the literal
// sum too, but count backing stores only once for the memory gate.
const used = (sample: NodeJS.MemoryUsage) => sample.heapUsed + sample.external;
const sum = (sample: NodeJS.MemoryUsage) => used(sample) + sample.arrayBuffers;
const mib = (bytes: number) => Number((bytes / MiB).toFixed(2));
// Lift the cap only in this standalone process so the same fixture also runs
// against the original 5 MiB default. All other checks are unchanged.
Object.assign(LIMITS, { outboundMessageBytes: 24 * MiB });
for (let i = 0; i < 3; i++) globalThis.gc();
const baseline = process.memoryUsage();
let peak = baseline;
let sumPeak = sum(baseline);
const gc = globalThis.gc;
const sample = () => {
  gc();
  const current = process.memoryUsage();
  if (used(current) > used(peak)) peak = current;
  sumPeak = Math.max(sumPeak, sum(current));
};

// The serializer is synchronous between awaits. Sample at its notable
// allocation points rather than relying on a timer, which cannot run inside
// the base64 writer. The old join's scratch and output are both live here.
const join = Array.prototype.join;
const encodeInto = TextEncoder.prototype.encodeInto;
Array.prototype.join = function (separator?: string) {
  if (separator !== '\r\n' || this.length < 10_000) return join.call(this, separator);
  sample();
  const value = join.call(this, separator);
  sample();
  return value;
};
TextEncoder.prototype.encodeInto = function (source, destination) {
  // Include the output allocation and any flattened input string.
  sample();
  const result = encodeInto.call(this, source, destination);
  sample();
  return result;
};
const start = performance.now();
let bytes: Uint8Array;
try {
  bytes = await builder.build(message, index => {
    const data = new Uint8Array(message.attachments[index].size).fill(0x7b);
    sample();
    return Promise.resolve(data);
  });
  sample();
} finally {
  Array.prototype.join = join;
  TextEncoder.prototype.encodeInto = encodeInto;
}
assert.equal(bytes.byteLength, encodedSize);
const elapsedMs = Math.round(performance.now() - start);
console.log(JSON.stringify({ node: process.version, encodedSize, elapsedMs,
  inputPlusOutputMiB: mib(message.attachments[0].size + encodedSize),
  peakMiB: mib(used(peak)), deltaMiB: mib(used(peak) - used(baseline)),
  heapUsedMiB: mib(peak.heapUsed), externalMiB: mib(peak.external), arrayBuffersMiB: mib(peak.arrayBuffers),
  literalSumPeakMiB: mib(sumPeak), maxRssMiB: mib(process.resourceUsage().maxRSS * 1024),
}));
assert.ok(used(peak) < 64 * MiB, `sent-copy peak ${mib(used(peak))} MiB exceeds the 64 MiB budget`);
