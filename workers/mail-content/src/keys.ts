// CONTENT_URL_KEYS loading (docs/content-origin.md section 2.4). Stub: implementation follows the failing tests.

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

export async function loadContentUrlKeys(_secret: unknown): Promise<ContentUrlKeys> {
  throw new Error('not implemented');
}

export function contentUrlKeys(_secret: string): Promise<ContentUrlKeys> {
  throw new Error('not implemented');
}
