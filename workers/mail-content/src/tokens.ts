// Signed content URL tokens (docs/content-origin.md sections 2.1-2.3).
//
// A token is `<kid>.<payload>.<mac>`: payload is unpadded base64url of compact JSON claims, and mac is
// unpadded base64url of HMAC-SHA-256 under `kid` over "kofra-mail-content/v1\n" + purpose + "\n" + payload.
// checkToken runs verification steps 1-3 (format, MAC, time); verify.ts adds steps 4 and 5.
// Nothing here logs, and refusals carry no reason.
import { KID_PATTERN, type ContentUrlKeys } from './keys.ts';

/** `contentUrlSeconds`: the longest span a token may have, enforced at mint and at verify. */
export const CONTENT_URL_SECONDS = 300;
/** A token may be issued up to this far ahead of the verifier's clock. */
export const IAT_SKEW_SECONDS = 30;
/** The longest payload segment, in base64url characters (so the decoded claims are smaller still). */
export const MAX_PAYLOAD_BYTES = 4096;
export const MAX_IMAGE_URL_BYTES = 2048;
const MAX_ID_CHARS = 256;
const MAC_BYTES = 32;
const MAC_CHARS = 43;
const MAX_TOKEN_CHARS = 32 + 1 + MAX_PAYLOAD_BYTES + 1 + MAC_CHARS;
const DOMAIN = 'kofra-mail-content/v1';

/** `lnk` is reserved for revocable file links and is refused until that package defines it. */
export const PURPOSES = ['body', 'cid', 'att', 'img'] as const;
export type Purpose = typeof PURPOSES[number];

interface CommonClaims {
  v: 1; ws: string; mb: string; msg: string; sub: string; ep: number; iat: number; exp: number;
}
export interface BodyClaims extends CommonClaims { ri: boolean }
export interface PartClaims extends CommonClaims { part: number }
export interface ImageClaims extends CommonClaims { u: string }
export interface ClaimsByPurpose { body: BodyClaims; cid: PartClaims; att: PartClaims; img: ImageClaims }

/** Mint input: `v` is always 1; `iat` defaults to `now` and `exp` to `iat + CONTENT_URL_SECONDS`. */
export type MintClaims<P extends Purpose> =
  Omit<ClaimsByPurpose[P], 'v' | 'iat' | 'exp'> & { iat?: number; exp?: number };

/** Thrown by mint for claims it must not sign. The message never includes a claim value. */
export class ContentClaimsError extends TypeError {
  constructor() {
    super('content URL claims are not valid');
    this.name = 'ContentClaimsError';
  }
}

const EXTRA_CLAIM = { body: 'ri', cid: 'part', att: 'part', img: 'u' } as const satisfies Record<Purpose, string>;
const COMMON_CLAIMS = ['v', 'ws', 'mb', 'msg', 'sub', 'ep', 'iat', 'exp'];
const ID_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function isPurpose(value: unknown): value is Purpose {
  return typeof value === 'string' && (PURPOSES as readonly string[]).includes(value);
}

function encode(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict unpadded base64url: only canonical encodings decode, so each byte string has one spelling. */
function decode(text: string): Uint8Array | undefined {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return undefined;
  let binary: string;
  try { binary = atob(text.replace(/-/g, '+').replace(/_/g, '/')); } catch { return undefined; }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return encode(bytes) === text ? bytes : undefined;
}

const signed = (purpose: Purpose, payload: string) => encoder.encode(`${DOMAIN}\n${purpose}\n${payload}`);
const isId = (value: unknown) => typeof value === 'string' && value.length <= MAX_ID_CHARS && ID_PATTERN.test(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Exactly the claim set of section 2.1 for this purpose, each with its type and bound. */
function validClaims<P extends Purpose>(purpose: P, value: unknown): value is ClaimsByPurpose[P] {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const claims = value as Record<string, unknown>;
  const extra = EXTRA_CLAIM[purpose];
  const names = Object.keys(claims);
  if (names.length !== COMMON_CLAIMS.length + 1 || !names.every((name) => name === extra || COMMON_CLAIMS.includes(name))) return false;
  if (claims.v !== 1 || !isId(claims.ws) || !isId(claims.mb) || !isId(claims.msg) || !isId(claims.sub)) return false;
  if (!isCount(claims.ep) || !isCount(claims.iat) || !isCount(claims.exp)) return false;
  switch (extra) {
    case 'ri': return typeof claims.ri === 'boolean';
    case 'part': return isCount(claims.part);
    case 'u': return typeof claims.u === 'string' && claims.u.length > 0 && encoder.encode(claims.u).length <= MAX_IMAGE_URL_BYTES;
  }
}

/** Step 3: iat - 30 s <= now < exp, and 0 < exp - iat <= 300. */
function inTime(claims: CommonClaims, now: number): boolean {
  return claims.iat - IAT_SKEW_SECONDS <= now && now < claims.exp
    && claims.exp > claims.iat && claims.exp - claims.iat <= CONTENT_URL_SECONDS;
}

/**
 * Signs claims for `purpose` under the current key. Refuses (throws ContentClaimsError) anything
 * the verifier would refuse at `now`, so a minting bug cannot issue an unusable or long-lived URL.
 * Callers set ws, mb and sub from an authenticated session, never from request input.
 */
export async function mint<P extends Purpose>(
  keys: ContentUrlKeys, purpose: P, claims: MintClaims<P>, now: number,
): Promise<string> {
  if (!isPurpose(purpose) || typeof now !== 'number' || !Number.isFinite(now)) throw new ContentClaimsError();
  if (typeof claims !== 'object' || claims === null) throw new ContentClaimsError();
  const input = claims as Record<string, unknown>;
  const extra = EXTRA_CLAIM[purpose];
  const allowed = ['ws', 'mb', 'msg', 'sub', 'ep', extra, 'iat', 'exp'];
  if (!Object.keys(input).every((name) => allowed.includes(name))) throw new ContentClaimsError();
  const iat = input.iat ?? Math.floor(now);
  const exp = input.exp ?? (typeof iat === 'number' ? iat + CONTENT_URL_SECONDS : undefined);
  const full = {
    v: 1, ws: input.ws, mb: input.mb, msg: input.msg, [extra]: input[extra], sub: input.sub, ep: input.ep, iat, exp,
  };
  if (!validClaims(purpose, full) || !inTime(full, now)) throw new ContentClaimsError();
  const payload = encode(encoder.encode(JSON.stringify(full)));
  const key = keys.keys.get(keys.current);
  if (payload.length > MAX_PAYLOAD_BYTES || !key) throw new ContentClaimsError();
  const mac = encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, signed(purpose, payload))));
  return `${keys.current}.${payload}.${mac}`;
}

/**
 * Verification steps 1-3 for a token presented on the `purpose` path. Returns the claims, or
 * undefined for every failure alike. Steps run in order and the MAC is checked only by
 * crypto.subtle.verify, never by comparing strings.
 */
export async function checkToken<P extends Purpose>(
  keys: ContentUrlKeys, purpose: P, token: string, now: number,
): Promise<ClaimsByPurpose[P] | undefined> {
  // 1. Format: three parts, a known kid, at most 4 KiB of payload, v = 1 and this purpose's claims.
  if (!isPurpose(purpose) || typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [kid, payload, mac] = parts;
  const key = KID_PATTERN.test(kid) ? keys.keys.get(kid) : undefined;
  if (!key || payload.length > MAX_PAYLOAD_BYTES || mac.length !== MAC_CHARS) return undefined;
  const payloadBytes = decode(payload);
  const macBytes = decode(mac);
  if (!payloadBytes || macBytes?.length !== MAC_BYTES) return undefined;
  let claims: unknown;
  try { claims = JSON.parse(decoder.decode(payloadBytes)); } catch { return undefined; }
  if (!validClaims(purpose, claims)) return undefined;
  // 2. MAC: the purpose is inside the signed bytes, so a token for one path fails on another.
  if (!await crypto.subtle.verify('HMAC', key, macBytes, signed(purpose, payload))) return undefined;
  // 3. Time.
  if (!inTime(claims, now)) return undefined;
  return claims;
}
