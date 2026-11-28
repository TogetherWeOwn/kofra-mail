// Workspace override credentials at rest: AES-256-GCM under a versioned key
// encryption key (KEK) held in the `LINK_CRED_KEK` Worker secret.
//
// - The secret is JSON `{ "current": "<version>", "keys": { "<version>": "<32 random bytes, base64>" } }`,
//   each key generated with `openssl rand -base64 32` and piped to `wrangler secret put` through stdin.
// - A sealed value is base64url of: one version byte, a 12-byte random IV, then the ciphertext and tag.
// - The AAD binds the value to its row and column: (workspace, location, key version, role).
//   A value copied to another workspace, location or role, or relabelled with another version, fails to open.
// - Rotation adds a new version and switches `current`. Rows are rewrapped on their next use and by a
//   bounded operator job; an old version is removed only when no row uses it.

import { S3Credentials, type CredentialRole } from './credentials.ts';

export interface LinkKek {
  current: number;
  keys: ReadonlyMap<number, CryptoKey>;
}

/** A sealed value that cannot be opened. Carries no detail: never the value, key or reason. */
export class CredentialSealError extends Error {
  constructor() { super('Link credential could not be opened'); this.name = 'CredentialSealError'; }
}

const utf8 = new TextEncoder();
const isVersion = (value: number) => Number.isSafeInteger(value) && value >= 1 && value <= 255;

function base64Bytes(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  return bytes.length === 32 ? bytes : undefined;
}

/** Parses `LINK_CRED_KEK`. Undefined if absent or invalid, so callers fail closed. */
export async function linkKek(raw: unknown): Promise<LinkKek | undefined> {
  if (typeof raw !== 'string' || raw.length > 16 * 1024) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { current, keys } = value as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof current !== 'string' || !/^[1-9]\d{0,2}$/.test(current)) return undefined;
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) return undefined;
  const parsed = new Map<number, CryptoKey>();
  for (const [version, encoded] of Object.entries(keys)) {
    const bytes = typeof encoded === 'string' ? base64Bytes(encoded) : undefined;
    if (!/^[1-9]\d{0,2}$/.test(version) || !isVersion(Number(version)) || !bytes) return undefined;
    parsed.set(Number(version), await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  if (!parsed.has(Number(current))) return undefined;
  return { current: Number(current), keys: parsed };
}

/** The additional data: an unambiguous encoding of the row and column the value belongs to. */
export function credentialAad(workspaceId: string, locationId: string, version: number, role: CredentialRole): Uint8Array<ArrayBuffer> {
  return new Uint8Array(utf8.encode(JSON.stringify(['kofra-mail/link-credential/v1', workspaceId, locationId, version, role])));
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) return undefined;
  try {
    return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export interface SealedCredential { version: number; sealed: string }

/** Seals a credential under the current KEK version for one row and role. */
export async function sealCredential(kek: LinkKek, workspaceId: string, locationId: string, role: CredentialRole,
  credentials: S3Credentials): Promise<SealedCredential> {
  const version = kek.current;
  const key = kek.keys.get(version);
  if (!key) throw new CredentialSealError();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = utf8.encode(JSON.stringify(credentials.reveal()));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: credentialAad(workspaceId, locationId, version, role) }, key, plain));
  plain.fill(0);
  const out = new Uint8Array(1 + iv.length + cipher.length);
  out[0] = version;
  out.set(iv, 1);
  out.set(cipher, 1 + iv.length);
  return { version, sealed: base64url(out) };
}

/**
 * Opens a sealed credential of one row and role. `version` is the row's stored key
 * version; it must match the value's version byte. Any failure throws `CredentialSealError`.
 */
export async function openCredential(kek: LinkKek, workspaceId: string, locationId: string, role: CredentialRole,
  version: number, sealed: string): Promise<S3Credentials> {
  const bytes = typeof sealed === 'string' ? fromBase64url(sealed) : undefined;
  const key = kek.keys.get(version);
  if (!bytes || bytes.length < 1 + 12 + 16 || bytes[0] !== version || !key) throw new CredentialSealError();
  let plain: Uint8Array<ArrayBuffer>;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(1, 13),
      additionalData: credentialAad(workspaceId, locationId, version, role) }, key, bytes.subarray(13)));
  } catch {
    throw new CredentialSealError();
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plain)); } catch { value = undefined; }
  plain.fill(0);
  const credentials = S3Credentials.from(value);
  if (!credentials) throw new CredentialSealError();
  return credentials;
}
