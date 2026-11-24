import PostalMime, { addressParser, type Address } from 'postal-mime';
import { sha256 } from './bytes.ts';
import { bodyForIndex } from './mail-text.ts';
import { parseObjectKey } from './object-key.ts';
import { indexedAttachmentName, threadingHeaders, type ThreadingHeaders } from '../../../contracts/mail-api/src/headers.ts';
import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { Address as WireAddress } from '../../../contracts/mail-api/src/wire.ts';

const EXTERNAL_ATTACHMENT_BYTES = 256 * 1024;
const MAX_INDEXED_ATTACHMENTS = 512;

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

export async function readMailMime(raw: Uint8Array<ArrayBuffer>, rawKey: string) {
  const key = parseObjectKey(rawKey);
  if (key?.kind !== 'raw' || await sha256(raw) !== key.digest) throw new Error('Raw message digest mismatch');
  return PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer', maxNestingDepth: 32, maxRfc822NestingDepth: 3 });
}

export async function parseMail(raw: Uint8Array<ArrayBuffer>, rawKey: string, mailApiEnabled = false) {
  const key = parseObjectKey(rawKey)!;
  const parsed = await readMailMime(raw, rawKey);
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
  const attachments = parsed.attachments.slice(0, kept).map((attachment, index) => {
    const bytes = decodedAttachment(attachment.content);
    return {
      part: index + 1,
      name: mailApiEnabled ? indexedAttachmentName(attachment.filename ?? '') : (attachment.filename ?? '').slice(0, 512),
      mimeType: attachment.mimeType.slice(0, 255),
      size: bytes.byteLength,
      external: bytes.byteLength >= EXTERNAL_ATTACHMENT_BYTES ? bytes : null,
    };
  });
  if (kept < count) {
    let size = 0;
    for (let i = kept; i < count; i++) size += decodedAttachment(parsed.attachments[i].content).byteLength;
    attachments.push({ part: kept + 1, name: `(${count - kept} more attachments)`, mimeType: 'application/octet-stream',
      size, external: null });
  }
  const display: MessageDisplay | undefined = mailApiEnabled ? buildDisplay(parsed, subject, body, messageId, kept) : undefined;
  return {
    display,
    size: raw.byteLength, sentDate: parsed.date ?? null, sender: addresses(parsed.from ? [parsed.from] : []),
    to: addresses(parsed.to), cc: addresses(parsed.cc), subject, subjectNorm, subjectKey, body, snippet: body.trim().slice(0, 240),
    messageId, dedupeKey, attachments, singleFrom,
    refs: [...headerIds(parsed.inReplyTo).slice(-1), ...headerIds(parsed.references).slice(-20).reverse()],
  };
}

function buildDisplay(parsed: Awaited<ReturnType<typeof readMailMime>>, subject: string, body: string,
  messageId: string | null, kept: number): MessageDisplay {
  const from = wireAddresses(parsed.from ? [parsed.from] : [])[0] ?? { name: '', email: '' };
  const to = wireAddresses(parsed.to);
  const cc = wireAddresses(parsed.cc);
  const references = headerIds(parsed.references);
  const encoder = new TextEncoder();
  return {
    from, to, cc, replyTo: wireAddresses(parsed.replyTo), hasHtml: !!parsed.html,
    remoteImages: !!parsed.html && /<img\b[^>]*\b(?:src|srcset)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(parsed.html),
    textTruncated: parsed.text
      ? encoder.encodeInto(parsed.text, new Uint8Array(LIMITS.messageTextBytes)).read < parsed.text.length
      : encoder.encode(body).byteLength >= LIMITS.messageTextBytes - 3,
    inline: parsed.attachments.slice(0, kept).flatMap((a, i) => a.contentId && a.disposition !== 'attachment' ? [i + 1] : []),
    ...(kept < parsed.attachments.length ? { syntheticPart: kept + 1 } : {}),
    replyHeaders: threadingHeaders([...references.slice(0, 1), ...references.slice(Math.max(1, references.length - 10)), messageId ?? ''], LIMITS),
    searchFrom: normalizeSearch(`${from.name} ${from.email}`),
    searchTo: normalizeSearch([...to, ...cc].map(a => `${a.name} ${a.email}`).join(' ')),
    searchSubject: normalizeSearch(subject),
  };
}

export type ParsedMail = Awaited<ReturnType<typeof parseMail>>;
