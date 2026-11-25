// Signed content URL tokens (docs/content-origin.md sections 2.1-2.3, steps 1-3). Stub.
import type { ContentUrlKeys } from './keys.ts';

export const CONTENT_URL_SECONDS = 300;
export const IAT_SKEW_SECONDS = 30;
export const MAX_PAYLOAD_BYTES = 4096;
export const MAX_IMAGE_URL_BYTES = 2048;

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

export async function mint<P extends Purpose>(
  _keys: ContentUrlKeys, _purpose: P, _claims: MintClaims<P>, _now: number,
): Promise<string> {
  throw new Error('not implemented');
}

export async function checkToken<P extends Purpose>(
  _keys: ContentUrlKeys, _purpose: P, _token: string, _now: number,
): Promise<ClaimsByPurpose[P] | undefined> {
  throw new Error('not implemented');
}

export function isPurpose(_value: unknown): _value is Purpose {
  throw new Error('not implemented');
}
