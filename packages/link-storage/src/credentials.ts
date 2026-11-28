// S3 credentials for link storage. A credential never serialises its secret:
// JSON, `String()` and Node's inspector all show only the key id's last 4
// characters, so an accidental log line or response cannot carry it.

export type CredentialRole = 'read' | 'write';

const keyIdPattern = /^[\x21-\x7e]{8,128}$/;
const secretPattern = /^[\x21-\x7e]{8,256}$/;
const inspect = Symbol.for('nodejs.util.inspect.custom');

export class S3Credentials {
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;

  private constructor(accessKeyId: string, secretAccessKey: string) {
    this.#accessKeyId = accessKeyId;
    this.#secretAccessKey = secretAccessKey;
  }

  /** Undefined unless both values are printable ASCII without spaces, of the accepted lengths. */
  static from(value: unknown): S3Credentials | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const keys = Object.keys(value);
    if (keys.length !== 2 || !keys.includes('accessKeyId') || !keys.includes('secretAccessKey')) return undefined;
    const { accessKeyId, secretAccessKey } = value as Record<string, unknown>;
    if (typeof accessKeyId !== 'string' || !keyIdPattern.test(accessKeyId)) return undefined;
    if (typeof secretAccessKey !== 'string' || !secretPattern.test(secretAccessKey)) return undefined;
    return new S3Credentials(accessKeyId, secretAccessKey);
  }

  /** The only part of a credential the API ever returns. */
  get keyIdLast4(): string { return this.#accessKeyId.slice(-4); }

  /** For signing and sealing only. */
  reveal(): { accessKeyId: string; secretAccessKey: string } {
    return { accessKeyId: this.#accessKeyId, secretAccessKey: this.#secretAccessKey };
  }

  toJSON(): { keyIdLast4: string } { return { keyIdLast4: this.keyIdLast4 }; }
  toString(): string { return `[S3Credentials ...${this.keyIdLast4}]`; }
  [inspect](): string { return this.toString(); }
}

/**
 * Parses `LINK_READ_CREDENTIALS` or `LINK_WRITE_CREDENTIALS`: a JSON object keyed
 * by deployment location id, each `{ accessKeyId, secretAccessKey }`. Undefined if
 * absent or invalid. Never echoes the input, even in an error.
 */
export function credentialSecret(raw: unknown): Map<string, S3Credentials> | undefined {
  if (typeof raw !== 'string' || raw.length > 64 * 1024) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = new Map<string, S3Credentials>();
  for (const [id, entry] of Object.entries(value)) {
    const credentials = S3Credentials.from(entry);
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) || !credentials) return undefined;
    result.set(id, credentials);
  }
  return result;
}
