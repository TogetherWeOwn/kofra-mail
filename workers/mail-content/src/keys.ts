// CONTENT_URL_KEYS loading (docs/content-origin.md section 2.4).
//
// The secret is JSON: { "current": "<kid>", "keys": { "<kid>": "<32 random bytes, base64>" } }.
// Verification accepts every kid present; minting always uses `current`. Removing a kid from
// the secret (rotation step 5, or an emergency revocation) kills every token minted under it.
// Errors never carry the secret, any part of it, or a parser message that could quote it.

/** A kid is a short non-secret label. It cannot contain '.', the token separator. */
export const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Standard base64 of exactly 32 bytes, as `openssl rand -base64 32` prints it. */
const KEY_PATTERN = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const KEY_BYTES = 32;
const MAX_KEYS = 16;

export interface ContentUrlKeys {
  /** The kid every new token is minted under. */
  readonly current: string;
  /** Every kid the verifier accepts, the current one included. */
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

export class ContentKeysError extends Error {
  constructor() {
    super('CONTENT_URL_KEYS is not valid');
    this.name = 'ContentKeysError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function parse(secret: unknown): { current: string; material: Array<[string, Uint8Array]> } | undefined {
  if (typeof secret !== 'string') return undefined;
  let root: unknown;
  try { root = JSON.parse(secret); } catch { return undefined; }
  if (!isPlainObject(root)) return undefined;
  const fields = Object.keys(root);
  if (fields.length !== 2 || !fields.includes('current') || !fields.includes('keys')) return undefined;
  const { current, keys } = root;
  if (typeof current !== 'string' || !KID_PATTERN.test(current) || !isPlainObject(keys)) return undefined;
  const entries = Object.entries(keys);
  if (entries.length === 0 || entries.length > MAX_KEYS || !Object.hasOwn(keys, current)) return undefined;
  const material: Array<[string, Uint8Array]> = [];
  for (const [kid, value] of entries) {
    if (!KID_PATTERN.test(kid) || typeof value !== 'string' || !KEY_PATTERN.test(value)) return undefined;
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    if (bytes.length !== KEY_BYTES) return undefined;
    material.push([kid, bytes]);
  }
  return { current, material };
}

/** Parses and imports the secret. Keys are non-extractable HMAC-SHA-256 keys. */
export async function loadContentUrlKeys(secret: unknown): Promise<ContentUrlKeys> {
  const parsed = parse(secret);
  if (!parsed) throw new ContentKeysError();
  const keys = new Map<string, CryptoKey>();
  try {
    for (const [kid, bytes] of parsed.material) {
      keys.set(kid, await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
      bytes.fill(0);
    }
  } catch {
    throw new ContentKeysError();
  }
  return Object.freeze({ current: parsed.current, keys });
}

let memo: { secret: string; keys: Promise<ContentUrlKeys> } | undefined;

/** Loads the secret once per isolate, and again whenever its value changes. */
export function contentUrlKeys(secret: string): Promise<ContentUrlKeys> {
  if (memo?.secret !== secret) memo = { secret, keys: loadContentUrlKeys(secret) };
  return memo.keys;
}
