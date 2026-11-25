// Content URL verification, steps 1-5 (docs/content-origin.md section 2.3). Stub.
import type { ContentUrlKeys } from './keys.ts';
import type { BodyClaims, ImageClaims, PartClaims } from './tokens.ts';

export const EPOCH_CACHE_SECONDS = 60;

export interface MessageRecord {
  rawKey: string;
  attachmentKeys: readonly string[];
  verdict: string;
}

export interface ContentPorts {
  credentialEpoch(sub: string): Promise<number | null>;
  mailboxOwner(ws: string, mb: string): Promise<string | null>;
  message(ws: string, mb: string, msg: string): Promise<MessageRecord | null>;
}

export type Verified =
  | { readonly ok: true; readonly purpose: 'body'; readonly claims: BodyClaims; readonly message: MessageRecord }
  | { readonly ok: true; readonly purpose: 'cid' | 'att'; readonly claims: PartClaims; readonly message: MessageRecord }
  | { readonly ok: true; readonly purpose: 'img'; readonly claims: ImageClaims };
export type VerifiedBody = Extract<Verified, { purpose: 'body' }>;

export const REFUSED: { readonly ok: false } = Object.freeze({ ok: false as const });
export type Refused = typeof REFUSED;

export class EpochCache {
  constructor(_ttlSeconds = EPOCH_CACHE_SECONDS, _maxEntries = 10_000) {}
  get size(): number { throw new Error('not implemented'); }
  async epoch(_sub: string, _now: number, _load: (sub: string) => Promise<number | null>): Promise<number | null> {
    throw new Error('not implemented');
  }
}

export function createVerifier(_options: { keys: ContentUrlKeys; ports: ContentPorts; epochs: EpochCache }): {
  verify(purpose: string, token: string, now: number): Promise<Verified | Refused>;
} {
  throw new Error('not implemented');
}

export type DerivedRef = { purpose: 'cid'; part: number } | { purpose: 'img'; u: string };

export async function mintFromBody(_keys: ContentUrlKeys, _body: VerifiedBody, _ref: DerivedRef, _now: number): Promise<string> {
  throw new Error('not implemented');
}
