// The MIME-builder port of the send path (docs/m3-outbound-plan.md, section 3,
// M3-3). Release builds the sent copy only through this port, from inputs the
// send froze at sendDraft, so a rerun builds identical bytes. The builder
// version is frozen too: a deploy that adds a version keeps the old one for
// sends that recorded it.
//
// The default builder here is a deterministic stand-in until the MIME builder
// package (M3-4) replaces it. It writes plain RFC 5322 with base64 parts and
// never a Bcc header, and folds every header line well under 998 octets; it
// leaves out unsafe threading ids (cleanMimeMessage).

import { hasHeaderControl, indexedAttachmentName, isSafeMessageId } from '../../../contracts/mail-api/src/headers.ts';
import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';

export type SendMimeAddress = { email: string; name?: string };
export type SendMimeAttachment = { name: string; type: string; size: number };
export type SendMimeMessage = {
  // `<…>`, derived from the send id.
  messageId: string;
  // Derived from the send id.
  boundary: string;
  // The message's Date: the send's first undoUntil, never moved.
  date: number;
  from: SendMimeAddress;
  replyTo: SendMimeAddress[];
  to: SendMimeAddress[];
  cc: SendMimeAddress[];
  subject: string;
  text: string;
  attachments: SendMimeAttachment[];
  inReplyTo?: string;
  references?: string;
};
// Reads one attachment's bytes, in the order of `attachments`.
export type SendMimeParts = (index: number) => Promise<Uint8Array<ArrayBuffer>>;

export interface SendMimeBuilder {
  readonly version: number;
  // The exact encoded size of `build` for this message, without reading any attachment.
  encodedSize(message: SendMimeMessage): number;
  build(message: SendMimeMessage, parts: SendMimeParts): Promise<Uint8Array<ArrayBuffer>>;
}

export type SendMimeBuilders = { readonly current: number; get(version: number): SendMimeBuilder | undefined };

export function mimeBuilders(...builders: SendMimeBuilder[]): SendMimeBuilders {
  const byVersion = new Map(builders.map(builder => [builder.version, builder]));
  if (!builders.length || byVersion.size !== builders.length) throw new Error('Invalid MIME builder set');
  return { current: Math.max(...byVersion.keys()), get: version => byVersion.get(version) };
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;
const CRLF = '\r\n';
// Base64 in lines of 76 characters, each followed by CRLF.
export function base64MimeBytes(size: number): number {
  const chars = 4 * Math.ceil(size / 3);
  return chars + 2 * Math.ceil(chars / 76);
}
function base64Lines(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.byteLength; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  const encoded = btoa(binary);
  let out = '';
  for (let i = 0; i < encoded.length; i += 76) out += `${encoded.slice(i, i + 76)}${CRLF}`;
  return out;
}
const ascii = (text: string) => /^[\x20-\x7e]*$/.test(text);
// Folding whitespace: every header line stays far below the 998-octet limit.
const FOLD = `${CRLF} `;
// RFC 2047 encoded words of at most 45 UTF-8 bytes each (60 base64
// characters), split at code points and folded one word per line.
function encodedWords(text: string): string {
  const words: string[] = [];
  let chunk = '';
  for (const character of text) {
    if (chunk && bytes(chunk + character) > 45) { words.push(chunk); chunk = ''; }
    chunk += character;
  }
  if (chunk || !words.length) words.push(chunk);
  return words.map(word => `=?UTF-8?B?${base64Lines(encoder.encode(word)).replaceAll(CRLF, '')}?=`).join(FOLD);
}
const word = (text: string) => ascii(text) && text.length <= 900 ? text : encodedWords(text);
const quoted = (name: string) => ascii(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodedWords(name);
const mailbox = ({ email, name }: SendMimeAddress) => name ? `${quoted(name)} <${email}>` : email;
const list = (addresses: SendMimeAddress[]) => addresses.map(mailbox).join(`,${FOLD}`);
const filename = (name: string) => `filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

// Version 1 cleans the values a draft carries before laying them out. This is
// part of the frozen builder version: a change to it needs a new version, or a
// rerun after a restore would build other bytes than the registered digest.
// A failed send does not restore its draft, so a value the user cannot fix is
// cleaned rather than failing the send:
// - a file name outside 1 to 255 bytes, with a control character, or with a
//   lone UTF-16 surrogate (which encodeURIComponent refuses) goes through the
//   indexed-name cleaning; uploads and parts indexed with the mail API on fit;
// - a type with a header control, over 255 characters or composite
//   (multipart/*, message/*: parsers drop such a leaf part) is sent opaque;
// - threading is optional: an unsafe or over-long In-Reply-To is left out, and
//   References keeps its safe ids, in order, while it fits headerValueBytes.
const isFileName = (name: string) => name !== '' && bytes(name) <= 255 && !hasHeaderControl(name) && !name.includes('\t');
function fileName(name: string): string {
  const whole = name.toWellFormed();
  return isFileName(whole) ? whole : indexedAttachmentName(whole);
}
function fileType(type: string): string {
  const whole = type.toWellFormed();
  return whole.length <= 255 && !hasHeaderControl(whole) && !/^\s*(?:multipart|message)\//i.test(whole) ? whole : 'application/octet-stream';
}
function threading(inReplyTo: string | undefined, references: string | undefined): Pick<SendMimeMessage, 'inReplyTo' | 'references'> {
  const max = LIMITS.headerValueBytes;
  const fits = (id: string) => isSafeMessageId(id) && bytes(id) <= max;
  const kept: string[] = [];
  let total = -1;
  for (const id of references?.split(' ') ?? []) {
    if (!fits(id) || total + 1 + id.length > max) continue;
    kept.push(id);
    total += 1 + id.length;
  }
  return { ...(inReplyTo && fits(inReplyTo) && { inReplyTo }), ...(kept.length && { references: kept.join(' ') }) };
}
export function cleanMimeMessage(message: SendMimeMessage): SendMimeMessage {
  const { inReplyTo: _inReplyTo, references: _references, ...rest } = message;
  return { ...rest, subject: message.subject.toWellFormed(), ...threading(message.inReplyTo, message.references),
    attachments: message.attachments.map(({ name, type, size }) => ({ name: fileName(name), type: fileType(type), size })) };
}

type Segment = string | { part: number; size: number };

function layout(raw: SendMimeMessage): Segment[] {
  const message = cleanMimeMessage(raw);
  const headers = [
    `From: ${mailbox(message.from)}`,
    ...(message.replyTo.length ? [`Reply-To: ${list(message.replyTo)}`] : []),
    ...(message.to.length ? [`To: ${list(message.to)}`] : []),
    ...(message.cc.length ? [`Cc: ${list(message.cc)}`] : []),
    `Subject: ${word(message.subject)}`,
    `Date: ${new Date(message.date).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${message.messageId}`,
    ...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`] : []),
    ...(message.references ? [`References: ${message.references.split(' ').join(FOLD)}`] : []),
    'MIME-Version: 1.0',
  ];
  const text = base64Lines(encoder.encode(message.text));
  const body = `Content-Type: text/plain; charset=UTF-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${text}`;
  if (!message.attachments.length) return [`${headers.join(CRLF)}${CRLF}${body}`];
  const delimiter = `--${message.boundary}${CRLF}`;
  const segments: Segment[] = [
    `${headers.join(CRLF)}${CRLF}Content-Type: multipart/mixed; boundary="${message.boundary}"${CRLF}${CRLF}${delimiter}${body}`,
  ];
  message.attachments.forEach((attachment, part) => {
    segments.push(`${delimiter}Content-Type: ${attachment.type}${CRLF}Content-Disposition: attachment; ${filename(attachment.name)}${CRLF}`
      + `Content-Transfer-Encoding: base64${CRLF}${CRLF}`, { part, size: attachment.size });
  });
  segments.push(`--${message.boundary}--${CRLF}`);
  return segments;
}

export const stubMimeBuilder: SendMimeBuilder = {
  version: 1,
  encodedSize(message) {
    return layout(message).reduce((total, segment) => total + (typeof segment === 'string' ? bytes(segment) : base64MimeBytes(segment.size)), 0);
  },
  async build(message, parts) {
    let out = '';
    for (const segment of layout(message)) {
      if (typeof segment === 'string') { out += segment; continue; }
      const data = await parts(segment.part);
      if (data.byteLength !== segment.size) throw new Error('Send attachment size changed');
      out += base64Lines(data);
    }
    return new Uint8Array(encoder.encode(out));
  },
};

export const defaultMimeBuilders = () => mimeBuilders(stubMimeBuilder);
