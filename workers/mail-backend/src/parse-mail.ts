import { Parser } from 'htmlparser2';
import PostalMime, { addressParser, type Address } from 'postal-mime';
import { sha256 } from './bytes.ts';
import { bodyForIndex } from './mail-text.ts';
import { parseObjectKey } from './object-key.ts';
import { indexedAttachmentName, isSafeMessageId, threadingHeaders, type ThreadingHeaders } from '../../../contracts/mail-api/src/headers.ts';
import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { Address as WireAddress } from '../../../contracts/mail-api/src/wire.ts';

const EXTERNAL_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_INDEXED_ATTACHMENTS = 512;

export function decodedAttachment(content: unknown): Uint8Array<ArrayBuffer> {
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  // PostalMime emits calendar parts as views even in arraybuffer mode.
  if (content instanceof Uint8Array && content.buffer instanceof ArrayBuffer) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  throw new Error('Invalid decoded attachment');
}

function addresses(input: Address[] | undefined): string {
  if (!input) return '';
  return input.flatMap(x => x.group ? x.group.map(y => y.address) : [x.address]).filter(Boolean).join(', ').slice(0, 4096);
}

function bodyStart(bytes: Uint8Array): number | null {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 10) continue;
    if (bytes[i + 1] === 10) return i + 2;
    if (bytes[i + 1] === 13 && bytes[i + 2] === 10) return i + 3;
  }
  return null;
}

function headerIds(value: string | undefined): string[] {
  return value?.slice(0, 8192).match(/<[^<>\s]{1,512}>/g) ?? [];
}

export type MessageDisplay = {
  from: WireAddress; to: WireAddress[]; cc: WireAddress[]; replyTo: WireAddress[];
  hasHtml: boolean; remoteImages: boolean; textTruncated: boolean;
  inline: number[]; syntheticPart?: number; replyHeaders: ThreadingHeaders;
  searchFrom: string; searchTo: string; searchSubject: string;
};

export const normalizeSearch = (value: string) => value.normalize('NFKC').toLowerCase();

function wireAddresses(input: Address[] | undefined): WireAddress[] {
  return (input ?? []).flatMap(x => x.group ?? [x]).filter(x => x.address).slice(0, 100)
    .map(x => ({ email: x.address!.slice(0, 512), name: x.name.slice(0, 512) }));
}

// Bytes that do not match their raw/ key's digest: with the length enforced by
// the read, the stored object is corrupt for good.
export class RawDigestMismatch extends Error { constructor() { super('Raw message digest mismatch'); } }

const MIME_OPTIONS = { attachmentEncoding: 'arraybuffer', maxNestingDepth: 32, maxRfc822NestingDepth: 3 } as const;

async function verifyRaw(raw: Uint8Array<ArrayBuffer>, rawKey: string): Promise<void> {
  const key = parseObjectKey(rawKey);
  if (key?.kind !== 'raw') throw new Error('Raw message digest mismatch');
  if (await sha256(raw) !== key.digest) throw new RawDigestMismatch();
}

export async function readMailMime(raw: Uint8Array<ArrayBuffer>, rawKey: string) {
  await verifyRaw(raw, rawKey);
  return PostalMime.parse(raw, MIME_OPTIONS);
}

// PostalMime 2.7.6 internals that the bounded parse relies on. The package
// version is pinned; parse-mail-equivalence.test.ts fails if they change.
type PostalChunk = ArrayBuffer | Uint8Array | string;
type PostalDecoder = { chunks: PostalChunk[]; decoder?: TextDecoder; update(line: Uint8Array): void; finalize(): Promise<ArrayBuffer> };
type PostalNode = {
  state: string; contentDecoder: PostalDecoder | false;
  contentType: { multipart?: string | false; parsed?: { value?: string | false } };
  contentDisposition?: { parsed?: { value?: string | false } };
};
type PostalInternals = { currentNode: PostalNode; readPos: number; processLine(line: Uint8Array, isFinal: boolean): Promise<void> };
type Parsed = Awaited<ReturnType<typeof PostalMime.parse>>;

// A decoded part the parse only measured: its body lines in the raw message
// and the decoder PostalMime chose for them. Decoding them again yields the
// bytes PostalMime would have returned.
export type PartSource = { raw: Uint8Array<ArrayBuffer>; start: number; end: number; size: number; decoder: () => PostalDecoder };

class BoundedParseFallback extends Error {}

const utf8 = new TextEncoder();
// The bytes a Blob of PostalMime's decoder chunks would hold.
const chunkBytes = (chunk: PostalChunk): Uint8Array => typeof chunk === 'string' ? utf8.encode(chunk)
  : chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk;
const chunkSize = (chunk: PostalChunk) => typeof chunk === 'string' ? utf8.encode(chunk).byteLength : chunk.byteLength;

// Which parts PostalMime returns only as attachment bytes: not multipart, not
// an inline message/rfc822 (parsed as a nested message), not inline text, and
// not a calendar part (re-encoded from its text). Any other leaf with content
// becomes exactly one attachment holding its decoded bytes.
function measuredOnly(node: PostalNode): boolean {
  if (node.contentType.multipart) return false;
  const type = node.contentType.parsed?.value;
  const disposition = node.contentDisposition?.parsed?.value;
  if (type === 'message/rfc822') return (disposition || 'inline') !== 'inline';
  if ((type === 'text/plain' || type === 'text/html') && disposition !== 'attachment') return false;
  return type !== 'text/calendar' && type !== 'application/ics';
}

// Counts a part's decoded bytes and drops them as they are produced. Its
// finalize() answers a distinct empty buffer that stands for the part, so the
// attachment PostalMime returns for it can be matched to its source.
class MeasuringDecoder {
  private start = -1;
  private end = -1;
  private size = 0;
  private readonly parser: BoundedParser;
  private readonly inner: PostalDecoder;
  constructor(parser: BoundedParser, inner: PostalDecoder) { this.parser = parser; this.inner = inner; }

  update(line: Uint8Array): void {
    // A leaf's body lines are contiguous; anything else is not the parse this relies on.
    if (this.start < 0) this.start = line.byteOffset;
    else if (line.byteOffset !== this.end) throw new BoundedParseFallback('Non-contiguous part');
    // PostalMime has already read past this line's LF.
    this.end = (this.parser as unknown as PostalInternals).readPos;
    this.inner.update(line);
    this.drain();
  }

  private drain(): void {
    const { chunks } = this.inner;
    this.inner.chunks = [];
    for (const chunk of chunks) this.size += chunkSize(chunk);
  }

  async finalize(): Promise<ArrayBuffer> {
    this.drain();
    this.size += (await this.inner.finalize()).byteLength;
    const token = new ArrayBuffer(0);
    const { inner } = this;
    const Decoder = inner.constructor as new (options: { decoder?: TextDecoder }) => PostalDecoder;
    const decoder = inner.decoder;
    this.parser.parts.set(token, { raw: this.parser.raw, start: Math.max(this.start, 0), end: Math.max(this.end, 0), size: this.size,
      decoder: () => new Decoder({ decoder }) });
    return token;
  }
}

// PostalMime with the body of each attachment-only part measured instead of
// kept, so a parse never holds the decoded attachments.
class BoundedParser extends PostalMime {
  readonly parts = new Map<ArrayBuffer, PartSource>();
  private last: PostalNode | null = null;
  readonly raw: Uint8Array<ArrayBuffer>;
  constructor(raw: Uint8Array<ArrayBuffer>) { super(MIME_OPTIONS); this.raw = raw; }

  async processLine(line: Uint8Array, isFinal: boolean): Promise<void> {
    await (PostalMime.prototype as unknown as PostalInternals).processLine.call(this, line, isFinal);
    // A part's decoder is created when its header block ends, before its first body line.
    const node = (this as unknown as PostalInternals).currentNode;
    if (node === this.last || node.state !== 'body') return;
    this.last = node;
    const decoder = node.contentDecoder;
    if (decoder && Array.isArray(decoder.chunks) && !decoder.chunks.length && measuredOnly(node)) {
      node.contentDecoder = new MeasuringDecoder(this, decoder) as unknown as PostalDecoder;
    }
  }
}

// PostalMime's parse of `raw`, with each attachment's content as its bytes
// or, for a measured part, as the source to decode it from when it is stored.
export async function boundedMime(raw: Uint8Array<ArrayBuffer>) {
  const parser = new BoundedParser(raw);
  // A whole-buffer view is parsed in place; PostalMime copies any other view.
  const input = raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength ? raw.buffer : raw;
  let parsed: Parsed;
  try {
    parsed = await parser.parse(input);
  } catch (error) {
    if (!(error instanceof BoundedParseFallback)) throw error;
    // Not the parse this relies on: keep every part, as an unbounded parse does.
    console.error({ code: 'mail_parse_fallback' });
    parsed = await PostalMime.parse(raw, MIME_OPTIONS);
    return { parsed, contents: parsed.attachments.map(attachment => decodedAttachment(attachment.content)) };
  }
  const contents = parsed.attachments.map((attachment): Uint8Array<ArrayBuffer> | PartSource =>
    attachment.content instanceof ArrayBuffer && parser.parts.get(attachment.content) || decodedAttachment(attachment.content));
  return { parsed, contents };
}

// The decoded bytes of a measured part in blocks of up to 64 KiB, exactly as
// PostalMime's decoder produces them from the same body lines.
async function* partBlocks(source: PartSource): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const { raw, end } = source;
  const decoder = source.decoder();
  let block = new Uint8Array(64 * 1024);
  let used = 0;
  let total = 0;
  function* take(chunks: PostalChunk[]): Generator<Uint8Array<ArrayBuffer>> {
    for (const chunk of chunks) {
      const bytes = chunkBytes(chunk);
      total += bytes.byteLength;
      for (let offset = 0; offset < bytes.byteLength;) {
        const count = Math.min(block.byteLength - used, bytes.byteLength - offset);
        block.set(bytes.subarray(offset, offset + count), used);
        used += count;
        offset += count;
        if (used === block.byteLength) { yield block; block = new Uint8Array(block.byteLength); used = 0; }
      }
    }
  }
  // PostalMime's line reader: a line ends at LF; trailing CR and LF are not part of it.
  for (let pos = source.start; pos < end;) {
    const start = pos;
    let stop = pos;
    while (pos < end) {
      const c = raw[pos++];
      if (c !== 0x0d && c !== 0x0a) stop = pos;
      if (c === 0x0a) break;
    }
    decoder.update(raw.subarray(start, stop));
    const { chunks } = decoder;
    decoder.chunks = [];
    yield* take(chunks);
  }
  const { chunks } = decoder;
  decoder.chunks = [];
  yield* take([...chunks, await decoder.finalize()]);
  if (total !== source.size) throw new Error('Attachment size changed on decode');
  if (used) yield block.slice(0, used);
}

function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function partDigest(source: PartSource): Promise<string> {
  const stream = new crypto.DigestStream('SHA-256');
  const writer = stream.getWriter();
  for await (const block of partBlocks(source)) await writer.write(block);
  await writer.close();
  return hex(await stream.digest);
}

// The part's bytes for a PUT under `digest`. The last block is released only
// once the bytes match the digest, so a mismatch errors the stream before it ends.
export function partStream(source: PartSource, digest: string): ReadableStream<Uint8Array> {
  const blocks = partBlocks(source);
  const check = new crypto.DigestStream('SHA-256');
  const writer = check.getWriter();
  let held: Uint8Array<ArrayBuffer> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const next = await blocks.next();
        if (next.done) {
          await writer.close();
          if (hex(await check.digest) !== digest) throw new Error('Attachment digest changed on decode');
          if (held) controller.enqueue(held);
          controller.close();
          return;
        }
        await writer.write(next.value);
        const previous = held;
        held = next.value;
        if (previous) { controller.enqueue(previous); return; }
      }
    },
    async cancel() { await blocks.return(undefined); await writer.abort().catch(() => {}); },
  }, { highWaterMark: 0 });
}

export async function parseMail(raw: Uint8Array<ArrayBuffer>, rawKey: string, mailApiEnabled = false) {
  const key = parseObjectKey(rawKey)!;
  await verifyRaw(raw, rawKey);
  const { parsed, contents } = await boundedMime(raw);
  // PostalMime keeps only the first From address; DMARC alignment needs to know
  // whether the message named exactly one author.
  const fromFields = parsed.headers.filter(header => header.key === 'from');
  const fromMailboxes = fromFields.length === 1
    ? addressParser(fromFields[0].value).flatMap(x => x.group ? x.group : [x]).filter(x => x.address).length : 0;
  const singleFrom = fromMailboxes === 1;
  const part = bodyStart(raw);
  const messageId = headerIds(parsed.messageId)[0] ?? null;
  const dedupeKey = messageId && part !== null ? `${messageId}:${await sha256(raw.subarray(part))}` : `raw/${key.digest}`;
  const subject = (parsed.subject ?? '').slice(0, 4096);
  const subjectNorm = subject.normalize('NFC').trim().replace(/^(?:(?:re|fw|fwd):\s*)+/i, '').toLowerCase();
  const subjectKey = await sha256(new Uint8Array(new TextEncoder().encode(subjectNorm)));
  const body = bodyForIndex(parsed.text, parsed.html);
  const count = parsed.attachments.length;
  const kept = count > MAX_INDEXED_ATTACHMENTS ? MAX_INDEXED_ATTACHMENTS - 1 : count;
  // A measured part is decoded again only when it is stored.
  const sizeOf = (content: Uint8Array | PartSource) => content instanceof Uint8Array ? content.byteLength : content.size;
  const attachments = parsed.attachments.slice(0, kept).map((attachment, index) => {
    const size = sizeOf(contents[index]);
    return {
      part: index + 1,
      name: mailApiEnabled ? indexedAttachmentName(attachment.filename ?? '') : (attachment.filename ?? '').slice(0, 512),
      mimeType: attachment.mimeType.slice(0, 255),
      size,
      external: size >= EXTERNAL_ATTACHMENT_BYTES ? contents[index] : null,
    };
  });
  if (kept < count) {
    let size = 0;
    for (let i = kept; i < count; i++) size += sizeOf(contents[i]);
    attachments.push({ part: kept + 1, name: `(${count - kept} more attachments)`, mimeType: 'application/octet-stream',
      size, external: null });
  }
  const display: MessageDisplay | undefined = mailApiEnabled ? buildDisplay(parsed, subject, body, kept) : undefined;
  return {
    display,
    size: raw.byteLength, sentDate: parsed.date ?? null, sender: addresses(parsed.from ? [parsed.from] : []),
    to: addresses(parsed.to), cc: addresses(parsed.cc), subject, subjectNorm, subjectKey, body, snippet: body.trim().slice(0, 240),
    messageId, dedupeKey, attachments, singleFrom,
    refs: [...headerIds(parsed.inReplyTo).slice(-1), ...headerIds(parsed.references).slice(-20).reverse()],
  };
}

const remoteImageUrl = /^(?:https?:)?\/\//i;
const space = /[\t\n\f\r ]/;

function remoteSrcset(value: string): boolean {
  // A srcset URL is one non-whitespace token; interior commas (e.g. in a
  // data URL) belong to that URL. After it, commas separate descriptors.
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (value[i] === ',' || space.test(value[i]))) i++;
    const start = i;
    while (i < value.length && !space.test(value[i])) i++;
    const url = value.slice(start, i);
    if (remoteImageUrl.test(url)) return true;
    if (url.endsWith(',')) continue;
    let parentheses = 0;
    while (i < value.length) {
      const char = value[i++];
      if (char === '(') parentheses++;
      else if (char === ')' && parentheses) parentheses--;
      else if (char === ',' && !parentheses) break;
    }
  }
  return false;
}

function hasRemoteImages(html: string): boolean {
  let remote = false;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name !== 'img' && name !== 'source') return;
      remote = (name === 'img' && remoteImageUrl.test(attrs.src?.trimStart() ?? '')) || remoteSrcset(attrs.srcset ?? '');
      if (remote) parser.pause();
    },
  }, { decodeEntities: true });
  parser.write(html);
  if (!remote) parser.end();
  return remote;
}

function buildDisplay(parsed: Parsed, subject: string, body: string, kept: number): MessageDisplay {
  const from = wireAddresses(parsed.from ? [parsed.from] : [])[0] ?? { name: '', email: '' };
  const to = wireAddresses(parsed.to);
  const cc = wireAddresses(parsed.cc);
  // Reply headers only repeat whole, safe IDs, not tokens extracted from
  // malformed fields as the dedupe and inbound thread index still do.
  const messageIdFields = parsed.headers.filter(header => header.key === 'message-id');
  const parent = messageIdFields.length === 1 ? messageIdFields[0].value.trim() : '';
  // References can have adjacent IDs or separators between them. Start at
  // bracket boundaries without extracting an ID from a malformed nested token.
  const references = parsed.references?.slice(0, 8192)
    .match(/(?<![^\s,)>])<[^<>\s]+>(?![^\s,<(])/g)?.filter(isSafeMessageId) ?? [];
  const encoder = new TextEncoder();
  return {
    from, to, cc, replyTo: wireAddresses(parsed.replyTo), hasHtml: !!parsed.html,
    remoteImages: !!parsed.html && hasRemoteImages(parsed.html),
    textTruncated: parsed.text
      ? encoder.encodeInto(parsed.text, new Uint8Array(LIMITS.messageTextBytes)).read < parsed.text.length
      : encoder.encode(body).byteLength >= LIMITS.messageTextBytes - 3,
    inline: parsed.attachments.slice(0, kept).flatMap((a, i) => a.contentId && a.disposition !== 'attachment' ? [i + 1] : []),
    ...(kept < parsed.attachments.length ? { syntheticPart: kept + 1 } : {}),
    replyHeaders: threadingHeaders([...references.slice(0, 1), ...references.slice(Math.max(1, references.length - 10)), isSafeMessageId(parent) ? parent : ''], LIMITS),
    searchFrom: normalizeSearch(`${from.name} ${from.email}`),
    searchTo: normalizeSearch([...to, ...cc].map(a => `${a.name} ${a.email}`).join(' ')),
    searchSubject: normalizeSearch(subject),
  };
}

export type ParsedMail = Awaited<ReturnType<typeof parseMail>>;
