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
 * - An id that alone exceeds `headerValueBytes` is never sent.
 */
export function threadingHeaders(chain: readonly string[], limits: Pick<Limits, 'headerValueBytes'>): ThreadingHeaders {
  const max = limits.headerValueBytes;
  if (!chain.length) return {};
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
    ...(utf8Bytes(chain[parent]) <= max && { inReplyTo: chain[parent] }),
    ...(references && { references }),
  };
}
