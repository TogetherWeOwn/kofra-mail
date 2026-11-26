// Content URL verification, steps 1-5 (docs/content-origin.md section 2.3), and the cid/img
// tokens minted from an authorised body (section 2.2).
//
// Steps 4 and 5 reach the account service, the directory and the mailbox Durable Object through
// injected ports, addressed only from claims that have already passed steps 1-3. Every failure,
// including a port that throws, returns the one frozen REFUSED value; nothing is logged.
import type { ContentUrlKeys } from './keys.ts';
import {
  checkToken, ContentClaimsError, isPurpose, mint,
  type BodyClaims, type ImageClaims, type PartClaims,
} from './tokens.ts';

/** The credential-epoch answer is cached for at most this long, as the app does. */
export const EPOCH_CACHE_SECONDS = 60;

export interface MessageAttachment {
  part: number;
  objectKey: string | null;
}

export interface MessageRecord {
  rawKey: string;
  attachments: readonly MessageAttachment[];
  verdict: string;
}

export function attachmentFor(_message: MessageRecord, _part: number): MessageAttachment | undefined {
  throw new Error('not implemented');
}

export interface ContentPorts {
  /** The account service's current credential epoch for `sub`, or null for an unknown user. */
  credentialEpoch(sub: string): Promise<number | null>;
  /** A directory point lookup: the user id owning mailbox `mb` of workspace `ws`, or null. */
  mailboxOwner(ws: string, mb: string): Promise<string | null>;
  /** The mailbox Durable Object (ws, mb): the message's object keys and verdict, or null once deleted or expired. */
  message(ws: string, mb: string, msg: string): Promise<MessageRecord | null>;
}

export type Verified =
  | { readonly ok: true; readonly purpose: 'body'; readonly claims: BodyClaims; readonly message: MessageRecord }
  | { readonly ok: true; readonly purpose: 'cid' | 'att'; readonly claims: PartClaims; readonly message: MessageRecord }
  | { readonly ok: true; readonly purpose: 'img'; readonly claims: ImageClaims };
export type VerifiedBody = Extract<Verified, { purpose: 'body' }>;

/** The single refusal value. Callers answer 404 with an empty body and never learn why. */
export const REFUSED: { readonly ok: false } = Object.freeze({ ok: false as const });
export type Refused = typeof REFUSED;

/** Body results issued by a verifier in this isolate; mintFromBody accepts nothing else. */
const verifiedBodies = new WeakSet<object>();

/** Per-isolate cache of credential epochs, keyed by sub. Failures and unknown users are not cached. */
export class EpochCache {
  readonly #entries = new Map<string, { ep: number; at: number }>();
  readonly #ttl: number;
  readonly #max: number;

  constructor(ttlSeconds = EPOCH_CACHE_SECONDS, maxEntries = 10_000) {
    if (!(ttlSeconds > 0 && ttlSeconds <= EPOCH_CACHE_SECONDS) || !(Number.isSafeInteger(maxEntries) && maxEntries > 0)) {
      throw new RangeError('epoch cache bounds are not valid');
    }
    this.#ttl = ttlSeconds;
    this.#max = maxEntries;
  }

  get size(): number { return this.#entries.size; }

  /** The cached epoch while its entry is younger than the TTL, otherwise a fresh `load`. */
  async epoch(sub: string, now: number, load: (sub: string) => Promise<number | null>): Promise<number | null> {
    const hit = this.#entries.get(sub);
    if (hit && hit.at <= now && now - hit.at < this.#ttl) return hit.ep;
    return this.refresh(sub, now, load);
  }

  /**
   * Always asks `load`, then caches a valid answer. Epochs only rise, so when loads overlap, a slow
   * reply never replaces a higher epoch that is still fresh; the caller gets the higher one.
   */
  async refresh(sub: string, now: number, load: (sub: string) => Promise<number | null>): Promise<number | null> {
    const ep = await load(sub);
    if (typeof ep !== 'number' || !Number.isSafeInteger(ep)) {
      this.#entries.delete(sub);
      return ep === null ? null : Number.NaN;
    }
    const known = this.#entries.get(sub);
    if (known && known.ep > ep && now - known.at < this.#ttl) return known.ep;
    this.#entries.delete(sub);
    this.#entries.set(sub, { ep, at: now });
    while (this.#entries.size > this.#max) this.#entries.delete(this.#entries.keys().next().value!);
    return ep;
  }
}

export function createVerifier({ keys, ports, epochs }: { keys: ContentUrlKeys; ports: ContentPorts; epochs: EpochCache }): {
  verify(purpose: string, token: string, now: number): Promise<Verified | Refused>;
} {
  const loadEpoch = (sub: string) => ports.credentialEpoch(sub);
  return {
    async verify(purpose, token, now) {
      try {
        if (!isPurpose(purpose)) return REFUSED;
        // Steps 1-3.
        const claims = await checkToken(keys, purpose, token, now);
        if (!claims) return REFUSED;
        if (purpose === 'img') return Object.freeze({ ok: true, purpose, claims: Object.freeze(claims as ImageClaims) });
        // Step 4: the credential epoch of sub is still ep, and sub still owns mb.
        let ep = await epochs.epoch(claims.sub, now, loadEpoch);
        // Epochs only rise, so a cached value below the token's is stale: ask again rather than refuse.
        if (typeof ep === 'number' && ep < claims.ep) ep = await epochs.refresh(claims.sub, now, loadEpoch);
        if (ep !== claims.ep) return REFUSED;
        if (await ports.mailboxOwner(claims.ws, claims.mb) !== claims.sub) return REFUSED;
        // Step 5: the message still exists in the Durable Object named by the verified claims.
        const message = await ports.message(claims.ws, claims.mb, claims.msg);
        if (typeof message !== 'object' || message === null) return REFUSED;
        const result = Object.freeze({ ok: true, purpose, claims: Object.freeze(claims), message }) as Verified;
        if (purpose === 'body') verifiedBodies.add(result);
        return result;
      } catch {
        return REFUSED;
      }
    },
  };
}

export type DerivedRef = { purpose: 'cid'; part: number } | { purpose: 'img'; u: string };

/**
 * Mints a cid or img token while sanitising a body this isolate has verified. It copies the body's
 * ws, mb, msg, sub, ep and exp, so the images expire with the body. An img token needs a body that
 * allows remote images (ri). iat is never before the body's, which keeps exp - iat <= 300 s.
 */
export async function mintFromBody(keys: ContentUrlKeys, body: VerifiedBody, ref: DerivedRef, now: number): Promise<string> {
  if (!verifiedBodies.has(body) || body.purpose !== 'body') throw new ContentClaimsError();
  const { ws, mb, msg, sub, ep, iat: bodyIat, exp, ri } = body.claims;
  const iat = Math.max(Math.floor(now), bodyIat);
  if (ref?.purpose === 'cid') return mint(keys, 'cid', { ws, mb, msg, sub, ep, part: ref.part, iat, exp }, now);
  if (ref?.purpose === 'img' && ri === true) return mint(keys, 'img', { ws, mb, msg, sub, ep, u: ref.u, iat, exp }, now);
  throw new ContentClaimsError();
}
