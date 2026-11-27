import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import { buildSentCopy, SEND_MIME_VERSION, type SendMimeInput } from '../src/send-mime.ts';
import { defaultMimeBuilders, type SendMimeMessage } from '../src/mailbox-send-mime.ts';

const bytes = new TextEncoder();
const part = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes.encode(text));
const parts = [part('attachment bytes'), part('second attachment')];
const base: SendMimeMessage = {
  messageId: '<send_001@example.com>',
  boundary: '=_km_send_001',
  date: Date.UTC(2026, 0, 2, 3, 4, 5),
  from: { email: 'sender@example.com', name: 'Café' },
  replyTo: [{ email: 'replies@example.com', name: 'Replies' }],
  to: [{ email: 'reader@example.net', name: 'Reader' }],
  cc: [],
  bcc: [],
  subject: 'Résumé',
  text: 'Hello, reader!',
  attachments: [],
};

function input(message: SendMimeMessage, attachmentBytes = parts): SendMimeInput {
  const at = message.messageId.slice(1, message.messageId.indexOf('@'));
  return {
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: [],
    subject: message.subject,
    text: message.text,
    frozenReplyTo: message.replyTo[0],
    ...(message.inReplyTo || message.references ? { threading: { inReplyTo: message.inReplyTo, references: message.references } } : {}),
    attachments: message.attachments.map((attachment, index) => ({ ...attachment, bytes: attachmentBytes[index] })),
    dateAt: message.date,
    sendId: at,
    messageId: message.messageId,
    boundary: message.boundary,
    builderVersion: SEND_MIME_VERSION,
  };
}

test('the production MIME port uses the M3-4a builder byte-for-byte', async () => {
  const builder = defaultMimeBuilders().get(SEND_MIME_VERSION);
  assert.ok(builder);
  const message = { ...base, attachments: [{ name: 'note.txt', type: 'text/plain', size: parts[0].byteLength }] };
  const actual = await builder.build(message, async index => parts[index]);
  assert.deepEqual(actual, buildSentCopy(input(message)).bytes);
});

test('the pure builder honors frozen Message-ID and boundary values on a rerun', () => {
  const frozen = { ...input({ ...base, attachments: [{ name: 'frozen.txt', type: 'text/plain', size: parts[0].byteLength }] }),
    messageId: '<frozen@example.org>', boundary: '=_km_frozen' };
  const first = buildSentCopy(frozen);
  const rerun = buildSentCopy({ ...frozen });
  assert.deepEqual(rerun, first);
  const text = new TextDecoder().decode(first.bytes);
  assert.match(text, /^Message-ID: <frozen@example.org>$/m);
  assert.match(text, /boundary="=_km_frozen"/);
});

test('the production MIME port encoded size equals built bytes for all supported header and body shapes', async () => {
  const builder = defaultMimeBuilders().get(SEND_MIME_VERSION);
  assert.ok(builder);
  const cases: SendMimeMessage[] = [
    base,
    { ...base, attachments: [
      { name: 'note.txt', type: 'text/plain', size: parts[0].byteLength },
      { name: 'second.bin', type: 'application/octet-stream', size: parts[1].byteLength },
    ] },
    { ...base, to: [{ email: 'reader@example.net', name: '読者 🌍' }], attachments: [
      { name: 'résumé-日本語.txt', type: 'application/octet-stream', size: parts[0].byteLength },
    ] },
    { ...base, references: Array.from({ length: 12 }, (_, index) => `<${String(index).padStart(3, '0')}.${'x'.repeat(180)}@example.net>`).join(' '),
      inReplyTo: '<011.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx@example.net>',
      subject: 'Threaded message', attachments: [] },
  ];
  for (const message of cases) {
    const actual = await builder.build(message, async index => parts[index]);
    assert.equal(builder.encodedSize(message), actual.byteLength);
    assert.equal(builder.encodedSize(message), buildSentCopy(input(message)).encodedSize);
  }
  assert.ok(cases.at(-1)!.references!.length > LIMITS.headerValueBytes);
});
