import type { Limits } from './limits.ts';

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).length;

/**
 * Control characters (Unicode category Cc) other than horizontal tab. A
 * subject, display name or address containing one answers 422
 * `invalid_header` when a draft is saved, and again at send; it is never
 * stripped silently. CR and LF are the header-injection case.
 */
export function hasHeaderControl(text: string): boolean {
  return /[\x00-\x08\x0a-\x1f\x7f-\x9f]/.test(text);
}

/**
 * A `Message-ID` we will repeat in a header: `<`, printable ASCII without
 * space, `<` or `>`, then `>`, at most `MESSAGE_ID_MAX` bytes. Ids come from
 * third-party mail, so anything else (CR, NUL, space, non-ASCII, a missing
 * bracket, an id too long for one line) is dropped, never sent.
 */
export function isSafeMessageId(id: string): boolean {
  return id.length <= MESSAGE_ID_MAX && /^<[\x21-\x3b\x3d\x3f-\x7e]+>$/.test(id);
}

/**
 * The longest id we repeat: `In-Reply-To: <id>` must fit one RFC 5322 line
 * of 998 octets, since a single id cannot be folded.
 */
export const MESSAGE_ID_MAX = 998 - 'In-Reply-To: '.length;

/**
 * An attachment name taken from third-party mail or Drive, as the index
 * stores it: control characters, `/` and `\` removed, at most 255 UTF-8
 * bytes. Outbound MIME then always encodes it (RFC 2231) unless it is a
 * plain token, so a name can never add a header or a parameter.
 */
export function indexedAttachmentName(name: string): string {
  let clean = name.replace(/[\p{Cc}/\\]/gu, '');
  while (utf8Bytes(clean) > 255) clean = [...clean].slice(0, -1).join('');
  return clean || 'attachment';
}

/** How many of the most recent ids `References` keeps after the first one. */
export const REFERENCES_RECENT = 10;

export interface ThreadingHeaders {
  inReplyTo?: string;
  /** Bracketed ids joined by one space (the unfolded value). */
  references?: string;
}

/**
 * The threading headers of a reply. `chain` is the parent's `References`
 * followed by the parent's own `Message-ID`, oldest first, each a bracketed
 * id such as `<id@host>`.
 * - `In-Reply-To` is the parent's id.
 * - `References` keeps the parent's id, then the first id, then the most
 *   recent ids newest first, at most `REFERENCES_RECENT` after the first,
 *   while the unfolded value fits `headerValueBytes`. The kept ids stay in
 *   chain order.
 * - An id that alone exceeds `headerValueBytes`, or that fails
 *   `isSafeMessageId`, is never sent; an unsafe parent id leaves out
 *   `In-Reply-To`.
 */
export function threadingHeaders(input: readonly string[], limits: Pick<Limits, 'headerValueBytes'>): ThreadingHeaders {
  const max = limits.headerValueBytes;
  const chain = input.filter(isSafeMessageId);
  if (!chain.length) return {};
  const parentSafe = isSafeMessageId(input[input.length - 1]);
  const parent = chain.length - 1;
  const recent: number[] = [];
  for (let i = parent; i >= 1 && recent.length < REFERENCES_RECENT; i--) recent.push(i);
  const order = parent === 0 ? [0] : [parent, 0, ...recent.slice(1)];
  const kept = new Set<number>();
  let total = -1; // No separator before the first id.
  for (const i of order) {
    const size = utf8Bytes(chain[i]);
    if (size > max) continue;
    if (total + 1 + size > max) {
      if (i === 0) continue; // The first id did not fit next to the parent; the recent run may still.
      break;
    }
    kept.add(i);
    total += 1 + size;
  }
  const references = chain.filter((_, i) => kept.has(i)).join(' ');
  return {
    ...(parentSafe && utf8Bytes(chain[parent]) <= max && { inReplyTo: chain[parent] }),
    ...(references && { references }),
  };
}
