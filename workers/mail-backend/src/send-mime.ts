import { hasHeaderControl, threadingHeaders, type ThreadingHeaders } from '../../../contracts/mail-api/src/headers.ts';
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
export interface SendMimeInput {
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
  readonly attachments: readonly SendMimeAttachment[];
  /** UTC epoch milliseconds; never the updated undo deadline on restore. */
  readonly dateAt: number;
  readonly sendId: string;
  readonly builderVersion: number;
}

export interface SentCopy {
  bytes: Uint8Array<ArrayBuffer>;
  encodedSize: number;
}

export type SendRequestHeaders = Partial<Record<'In-Reply-To' | 'References', string>>;
export type SendRequest = EmailMessageBuilder & { headers: SendRequestHeaders };

const CRLF = '\r\n';
const encoder = new TextEncoder();

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
  if (extra !== undefined || local.length > 64 || email.length > LIMITS.addressBytes || !labels || labels.length < 2 ||
      !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local) ||
      !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) fail(code);
}

function simpleBase64(bytes: Uint8Array): string {
  // This only receives one line's worth of bytes (at most 57).
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
    if (line.length > (encodedLine ? 76 : 998)) throw new Error('MIME header line too long');
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

function requestHeaders(input: SendMimeInput): SendRequestHeaders {
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

// Versioned serialization: leave v1 unchanged when adding another version.
// String pieces are wire ASCII; byte pieces describe wrapped base64. The
// request path can check the very same encoded size without encoding files.
function planV1(input: SendMimeInput) {
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
  const files: EmailAttachment[] = attachments.map(({ name, type, bytes }, i) => {
    checkHeader(name, `/attachments/${i}/name`, false);
    if (!name || exceedsUtf8(name, 255)) invalid(`/attachments/${i}/name`);
    checkHeader(type, `/attachments/${i}/type`);
    return { disposition: 'attachment', filename: name, type: attachmentType(type), content: bytes };
  });

  const date = new Date(dateAt);
  if (!Number.isSafeInteger(dateAt) || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 9999) {
    throw new RangeError('Invalid frozen MIME date');
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sendId)) throw new TypeError('Invalid frozen send ID');
  // The '=_' sequence cannot appear in either wrapped base64 or quoted-printable.
  const boundary = `=_km_${sendId}`;
  const headers = requestHeaders(input);
  const pieces: (string | Uint8Array)[] = [
    fold('From', addressWords(from)),
    ...(to.length ? [fold('To', addressList(to))] : []),
    ...(cc.length ? [fold('Cc', addressList(cc))] : []),
    fold('Subject', !subject ? [] : subject.length <= 69 && asciiHeader(subject) ? [subject] : encodedWords(subject)),
    `Date: ${date.toUTCString().replace('GMT', '+0000')}${CRLF}`,
    `Message-ID: <${sendId}@${from.email.split('@')[1]}>${CRLF}`,
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
      contentDisposition(file.filename), CRLF, attachments[i].bytes);
  }
  if (files.length) pieces.push(`--${boundary}--${CRLF}`);
  const encodedSize = pieces.reduce((size, piece) => size + (typeof piece === 'string' ? piece.length : base64Size(piece.length)), 0);
  if (encodedSize > LIMITS.outboundMessageBytes) fail('message_too_large', { limit: LIMITS.outboundMessageBytes });
  return { headers, pieces, files, encodedSize };
}

function plan(input: SendMimeInput) {
  switch (input.builderVersion) {
    case 1: return planV1(input);
    default: throw new RangeError('Unsupported MIME builder version');
  }
}

/** Stored copy only. Its bytes never include the Bcc recipients. */
export function buildSentCopy(input: SendMimeInput): SentCopy {
  const { pieces, encodedSize } = plan(input);
  const bytes = new Uint8Array(encodedSize);
  let offset = 0;
  for (const piece of pieces) {
    const text = typeof piece === 'string' ? piece : wrappedBase64(piece);
    offset += encoder.encodeInto(text, bytes.subarray(offset)).written;
  }
  return { bytes, encodedSize };
}

const destination = ({ name, email }: Readonly<AddressInput>) => name ? { name, email } : email;

/** Structured binding payload only: this function never sends mail. */
export function buildSendRequest(input: SendMimeInput): SendRequest {
  const { files, headers } = plan(input);
  const to = input.to.map(destination), cc = input.cc.map(destination), bcc = input.bcc.map(destination);
  const message = {
    from: destination(input.from), subject: input.subject, text: input.text, attachments: files, headers,
    ...(input.frozenReplyTo && { replyTo: destination(input.frozenReplyTo) }),
    ...(cc.length && { cc }), ...(bcc.length && { bcc }),
  };
  // Plan validation guarantees at least one non-empty destination list.
  return to.length ? { ...message, to } : cc.length ? { ...message, cc } : { ...message, bcc };
}
