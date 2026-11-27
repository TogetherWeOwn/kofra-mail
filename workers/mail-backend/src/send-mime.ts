import { hasHeaderControl, isSafeMessageId, threadingHeaders, type ThreadingHeaders } from '../../../contracts/mail-api/src/headers.ts';
import { canonicalMailText, LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { AddressInput } from '../../../contracts/mail-api/src/wire.ts';
import type { MailErrorCode, Problem } from '../../../contracts/mail-api/src/errors.ts';

type SendMimeProblem = Pick<Problem, 'code' | 'errors' | 'limit'>;

/** Invalid input at the builder boundary; the caller decides how to report it. */
export class SendMimeError extends Error {
  readonly problem: SendMimeProblem;
  constructor(problem: SendMimeProblem) {
    super(problem.code);
    this.name = 'SendMimeError';
    this.problem = problem;
  }
}

/** A deterministic violation of the builder's frozen input contract. */
export class SendMimeInvariantError extends Error {}

function fail(code: MailErrorCode, extra?: Omit<SendMimeProblem, 'code'>): never {
  throw new SendMimeError({ code, ...extra });
}

function invalid(field: string, code: NonNullable<Problem['errors']>[number]['code'] = 'invalid'): never {
  return fail('invalid_request', { errors: [{ field, code }] });
}

export const SEND_MIME_VERSION = 1;

export interface SendMimeAttachment {
  readonly name: string;
  readonly type: string;
  /** Resolved bytes of an upload or a forwarded part, in draft order. */
  readonly bytes: Uint8Array;
}

/** Inputs from the immutable draft revision and the frozen send record, not live settings. */
type MimeFields = {
  readonly from: Readonly<AddressInput>;
  readonly to: readonly Readonly<AddressInput>[];
  readonly cc: readonly Readonly<AddressInput>[];
  readonly bcc: readonly Readonly<AddressInput>[];
  readonly subject: string;
  /** Final plain text, with any link attachments already included by the caller. */
  readonly text: string;
  readonly frozenReplyTo?: Readonly<AddressInput>;
  /** Parent id and space-joined References captured when the draft was saved. */
  readonly threading?: Readonly<ThreadingHeaders>;
  /** UTC epoch milliseconds; never the updated undo deadline on restore. */
  readonly dateAt: number;
  readonly builderVersion: number;
};

// Direct callers can ask for canonical wire values. Release already has both
// values frozen and must not derive either a second time.
type WireValues = Readonly<
  { sendId: string; messageId?: string; boundary?: string } |
  { sendId?: never; messageId: string; boundary: string }
>;

type AttachmentHeaders = Pick<SendMimeAttachment, 'name' | 'type'>;
type MimeInput<Attachment extends AttachmentHeaders> = MimeFields & WireValues & { readonly attachments: readonly Attachment[] };
export type SendMimeInput = MimeInput<SendMimeAttachment>;
export type SendMimeSizingInput = MimeInput<AttachmentHeaders & { readonly size: number }>;

export interface SentCopy {
  bytes: Uint8Array<ArrayBuffer>;
  encodedSize: number;
}

export type SendRequestHeaders = Partial<Record<'In-Reply-To' | 'References', string>>;
export type SendRequest = EmailMessageBuilder & { headers: SendRequestHeaders };

const CRLF = '\r\n';
const encoder = new TextEncoder();

export function sendMimeBoundary(sendId: string): string {
  return `=_km_${sendId}`;
}

export function sendMimeMessageId(sendId: string, from: Readonly<AddressInput>): string {
  return `<${sendId}@${from.email.slice(from.email.lastIndexOf('@') + 1)}>`;
}

export function isSendMimeBoundary(boundary: string): boolean {
  // RFC 2046 bchars, no trailing space; '=_' cannot occur in encoded body parts.
  return boundary.includes('=_') && !hasHeaderControl(boundary) && /^[0-9A-Za-z'()+_,./:=? -]{0,69}[0-9A-Za-z'()+_,./:=?-]$/.test(boundary);
}

function checkHeader(value: string, field: string, allowTab = true) {
  if (hasHeaderControl(value) || (!allowTab && value.includes('\t'))) fail('invalid_header', { errors: [{ field, code: 'invalid' }] });
}

function exceedsUtf8(value: string, max: number): boolean {
  return value.length > max || encoder.encode(value).length > max;
}

function checkAddress({ name, email }: Readonly<AddressInput>, field: string, code: 'invalid_sender' | 'invalid_recipients' | 'invalid_header') {
  checkHeader(email, `${field}/email`);
  if (name !== undefined) {
    checkHeader(name, `${field}/name`);
    if (exceedsUtf8(name, LIMITS.displayNameBytes)) invalid(`${field}/name`, 'too_long');
  }
  // A bare ASCII dot-atom and DNS domain, matching the mail-core send contract.
  const [local, domain, extra] = email.split('@');
  const labels = domain?.split('.');
  if (extra !== undefined || local.includes('=?') || local.length > 64 || email.length > LIMITS.addressBytes || !labels || labels.length < 2 ||
      !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local) ||
      !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) fail(code);
}

function simpleBase64(bytes: Uint8Array): string {
  // Only for bounded RFC 2047 header words (at most 42 bytes).
  return btoa(String.fromCharCode(...bytes));
}

// 42 UTF-8 bytes yield 68 ASCII characters including the RFC 2047 wrapper.
// Never split a code point between encoded words.
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

/** Fold only between complete tokens; a long address or Message-ID stays intact. */
function fold(name: string, words: readonly string[]): string {
  let line = `${name}:`;
  const lines: string[] = [];
  let encodedLine = false;
  for (const word of words) {
    const encodedWord = word.startsWith('=?UTF-8?B?') && word.endsWith('?=');
    // RFC 2047 is tighter than the normal folding target on encoded-word lines.
    const limit = encodedLine || encodedWord ? 76 : line === `${name}:` ? 998 : 78;
    if (line.length + 1 + word.length > limit) {
      lines.push(line);
      line = '';
      encodedLine = false;
    }
    line += ` ${word}`;
    encodedLine ||= encodedWord;
    if (line.length > (encodedLine ? 76 : 998)) throw new SendMimeInvariantError('MIME header line too long');
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
  // Every 57 input bytes give 76 base64 columns. Include each line's CRLF.
  return Math.ceil(length / 3) * 4 + Math.max(1, Math.ceil(length / 57)) * CRLF.length;
}

const base64Alphabet = encoder.encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
const base64Pad = 0x3d; // '='

/** Write frozen v1's 76-column base64 without any per-line allocation. */
function writeBase64(source: Uint8Array, output: Uint8Array, offset: number): number {
  let i = 0;
  // The empty part still owns one CRLF. Full lines are 57 bytes, so only
  // the final line can need padding.
  do {
    const end = Math.min(i + 57, source.length);
    while (i + 2 < end) {
      const a = source[i++], b = source[i++], c = source[i++];
      output[offset++] = base64Alphabet[a >>> 2];
      output[offset++] = base64Alphabet[((a & 3) << 4) | (b >>> 4)];
      output[offset++] = base64Alphabet[((b & 15) << 2) | (c >>> 6)];
      output[offset++] = base64Alphabet[c & 63];
    }
    if (i < end) {
      const a = source[i++];
      const hasSecond = i < end;
      const b = hasSecond ? source[i++] : 0;
      output[offset++] = base64Alphabet[a >>> 2];
      output[offset++] = base64Alphabet[((a & 3) << 4) | (b >>> 4)];
      output[offset++] = hasSecond ? base64Alphabet[(b & 15) << 2] : base64Pad;
      output[offset++] = base64Pad;
    }
    output[offset++] = 13;
    output[offset++] = 10;
  } while (i < source.length);
  return offset;
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
      // Whitespace cannot end a physical line. A soft break itself ends in '='.
      const literal = whiteSpace ? i + 1 < bytes.length && bytes[i + 1] !== 13 : byte >= 33 && byte <= 126 && byte !== 61;
      const token = literal ? String.fromCharCode(byte) : byteEscape(byte, '=');
      if (line.length + token.length > 75) flush('=');
      line += token;
    }
    if (size + line.length >= ceiling) return;
  }
  // A multipart delimiter owns its framing CRLF (RFC 2046). Never use it to
  // complete a soft break, or add a newline to the content of a single part.
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

function requestHeaders(input: MimeFields): SendRequestHeaders {
  const chain = input.threading?.references?.split(' ').filter(Boolean) ?? [];
  const parent = input.threading?.inReplyTo ?? '';
  // The stored snapshot may already end in the parent. Keep an empty last
  // slot when the parent is unknown so no ancestor becomes In-Reply-To.
  if (chain.at(-1) !== parent) chain.push(parent);
  const thread = threadingHeaders(chain, LIMITS);
  return {
    ...(thread.inReplyTo && { 'In-Reply-To': thread.inReplyTo }),
    ...(thread.references && { References: thread.references }),
  };
}

const opaqueAttachmentType = 'application/octet-stream';

function attachmentType(type: string): string {
  // Uploads already store a MIME type, but a forwarded part may be legacy mail.
  return type.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(type) ? type : opaqueAttachmentType;
}

function storedAttachmentType(type: string): string {
  const lower = type.toLowerCase();
  // Store composite types as opaque base64 files, not MIME containers. The
  // sent-copy reader also normalizes calendar text, so make it opaque to
  // preserve the exact attachment bytes. This doesn't change provider metadata.
  return lower.startsWith('multipart/') || lower.startsWith('message/') || lower === 'text/calendar' || lower === 'application/ics'
    ? opaqueAttachmentType : type;
}

type Piece = string | Uint8Array | { part: number; size: number };

// Versioned serialization: leave v1 unchanged when adding another version.
// Strings are wire ASCII; binary text and attachment references are wrapped
// base64. The same plan gives exact size using only the file metadata.
function planV1<Attachment extends AttachmentHeaders>(input: MimeInput<Attachment>,
  sizeOf: (attachment: Attachment) => number) {
  const { to, cc, bcc, attachments, subject, from, dateAt, sendId } = input;
  checkAddress(from, '/from', 'invalid_sender');
  checkHeader(subject, '/subject');
  if (exceedsUtf8(subject, LIMITS.subjectBytes)) invalid('/subject', 'too_long');
  if (input.frozenReplyTo) checkAddress(input.frozenReplyTo, '/replyTo', 'invalid_header');
  const recipients = to.length + cc.length + bcc.length;
  if (!recipients) fail('invalid_recipients');
  if (recipients > LIMITS.recipientsPerMessage) fail('too_many_recipients', { limit: LIMITS.recipientsPerMessage });
  for (const [key, list] of [['to', to], ['cc', cc], ['bcc', bcc]] as const) {
    list.forEach((address, i) => checkAddress(address, `/${key}/${i}`, 'invalid_recipients'));
  }
  if (attachments.length > LIMITS.attachmentsPerMessage) fail('too_many_attachments', { limit: LIMITS.attachmentsPerMessage });
  const files = attachments.map((attachment, i) => {
    const { name, type } = attachment;
    checkHeader(name, `/attachments/${i}/name`, false);
    if (!name || exceedsUtf8(name, 255)) invalid(`/attachments/${i}/name`);
    checkHeader(type, `/attachments/${i}/type`);
    const size = sizeOf(attachment);
    if (!Number.isSafeInteger(size) || size < 0) throw new SendMimeInvariantError('Invalid MIME attachment size');
    return { name, type: attachmentType(type), size };
  });

  const date = new Date(dateAt);
  if (!Number.isSafeInteger(dateAt) || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 9999) {
    throw new SendMimeInvariantError('Invalid frozen MIME date');
  }
  if (sendId !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(sendId)) throw new SendMimeInvariantError('Invalid frozen send ID');
  const boundary = sendId === undefined ? input.boundary : input.boundary ?? sendMimeBoundary(sendId);
  const messageId = sendId === undefined ? input.messageId : input.messageId ?? sendMimeMessageId(sendId, from);
  if (!isSafeMessageId(messageId) || hasHeaderControl(messageId) || !isSendMimeBoundary(boundary)) {
    throw new SendMimeInvariantError('Invalid frozen MIME wire values');
  }
  const headers = requestHeaders(input);
  const pieces: Piece[] = [
    fold('From', addressWords(from)),
    ...(to.length ? [fold('To', addressList(to))] : []),
    ...(cc.length ? [fold('Cc', addressList(cc))] : []),
    fold('Subject', !subject ? [] : subject.length <= 69 && asciiHeader(subject) ? [subject] : encodedWords(subject)),
    `Date: ${date.toUTCString().replace('GMT', '+0000')}${CRLF}`,
    `Message-ID: ${messageId}${CRLF}`,
  ];
  for (const name of ['In-Reply-To', 'References'] as const) {
    const value = headers[name];
    if (value) pieces.push(fold(name, value.split(' ')));
  }
  if (input.frozenReplyTo) pieces.push(fold('Reply-To', addressWords(input.frozenReplyTo)));
  pieces.push(`MIME-Version: 1.0${CRLF}`);
  if (files.length) pieces.push(`Content-Type: multipart/mixed; boundary="${boundary}"${CRLF}${CRLF}--${boundary}${CRLF}`);
  const [textHeader, textBody] = textPart(input.text, files.length > 0);
  pieces.push(textHeader, CRLF, textBody);
  for (const [i, file] of files.entries()) {
    pieces.push(`--${boundary}${CRLF}Content-Type: ${storedAttachmentType(file.type)}${CRLF}`, base64Header,
      contentDisposition(file.name), CRLF, { part: i, size: file.size });
  }
  if (files.length) pieces.push(`--${boundary}--${CRLF}`);
  const encodedSize = pieces.reduce((size, piece) => size + (typeof piece === 'string' ? piece.length :
    base64Size(piece instanceof Uint8Array ? piece.byteLength : piece.size)), 0);
  return { headers, pieces, files, encodedSize };
}

function plan<Attachment extends AttachmentHeaders>(input: MimeInput<Attachment>, sizeOf: (attachment: Attachment) => number) {
  switch (input.builderVersion) {
    case 1: return planV1(input, sizeOf);
    default: throw new SendMimeInvariantError('Unsupported MIME builder version');
  }
}

/** Exact wire size, including sizes over the send limit, without loading file bytes. */
export function encodedSentCopySize(input: SendMimeSizingInput): number {
  return plan(input, attachment => attachment.size).encodedSize;
}

function checkedPlan<Attachment extends AttachmentHeaders>(input: MimeInput<Attachment>, sizeOf: (attachment: Attachment) => number) {
  const result = plan(input, sizeOf);
  if (result.encodedSize > LIMITS.outboundMessageBytes) fail('message_too_large', { limit: LIMITS.outboundMessageBytes });
  return result;
}

function writePiece(piece: string | Uint8Array, bytes: Uint8Array, offset: number): number {
  return typeof piece === 'string' ? offset + encoder.encodeInto(piece, bytes.subarray(offset)).written
    : writeBase64(piece, bytes, offset);
}

/** Stored copy only. Its bytes never include the Bcc recipients. */
export function buildSentCopy(input: SendMimeInput): SentCopy {
  const { pieces, encodedSize } = checkedPlan(input, attachment => attachment.bytes.byteLength);
  const bytes = new Uint8Array(encodedSize);
  let offset = 0;
  for (const piece of pieces) {
    offset = writePiece(typeof piece === 'string' || piece instanceof Uint8Array ? piece : input.attachments[piece.part].bytes, bytes, offset);
  }
  return { bytes, encodedSize };
}

/** Build from verified part sizes, retaining only the attachment being written. */
export async function buildSentCopyFromParts(input: SendMimeSizingInput,
  readPart: (index: number) => Promise<Uint8Array<ArrayBuffer>>): Promise<Uint8Array<ArrayBuffer>> {
  const { pieces, encodedSize } = checkedPlan(input, attachment => attachment.size);
  const bytes = new Uint8Array(encodedSize);
  let offset = 0;
  for (const piece of pieces) {
    if (typeof piece === 'string' || piece instanceof Uint8Array) {
      offset = writePiece(piece, bytes, offset);
    } else {
      const data = await readPart(piece.part);
      if (data.byteLength !== piece.size) throw new SendMimeInvariantError('Send attachment size changed');
      offset = writeBase64(data, bytes, offset);
    }
  }
  return bytes;
}

const destination = ({ name, email }: Readonly<AddressInput>) => name ? { name, email } : email;

/** Structured binding payload only: this function never sends mail. */
export function buildSendRequest(input: SendMimeInput): SendRequest {
  const { files, headers } = checkedPlan(input, attachment => attachment.bytes.byteLength);
  const to = input.to.map(destination), cc = input.cc.map(destination), bcc = input.bcc.map(destination);
  const attachments: EmailAttachment[] = files.map(({ name, type }, i) => ({
    disposition: 'attachment', filename: name, type, content: input.attachments[i].bytes,
  }));
  const message = {
    from: destination(input.from), subject: input.subject, text: input.text, attachments, headers,
    ...(input.frozenReplyTo && { replyTo: destination(input.frozenReplyTo) }),
    ...(cc.length && { cc }), ...(bcc.length && { bcc }),
  };
  // Plan validation guarantees at least one non-empty destination list.
  return to.length ? { ...message, to } : cc.length ? { ...message, cc } : { ...message, bcc };
}
