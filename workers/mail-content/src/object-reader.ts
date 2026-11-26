import { AwsClient } from 'aws4fetch';
import PostalMime from 'postal-mime';
import type { VerdictLevel } from '../../../contracts/mail-api/src/wire.ts';
import { workspaceMailBucket } from '../../mail-backend/src/directory.ts';
import { parseObjectKey } from '../../mail-backend/src/object-key.ts';
import { MAX_RAW_BYTES, readExact, sha256 } from '../../mail-backend/src/bytes.ts';
import type { MessageRecord } from './verify.ts';

const keyOf = (value: unknown, kind: 'raw' | 'att'): value is string =>
  typeof value === 'string' && value.length === kind.length + 1 + 64 + 1 + 26 && parseObjectKey(value)?.kind === kind;
const levels = new Set<VerdictLevel>(['none', 'spam', 'suspicious', 'phishing']);

/** RPC is a boundary: check the complete projection before any object read. */
export function checkedRecord(value: unknown): MessageRecord | null {
  if (!value || typeof value !== 'object') return null;
  const { rawKey, attachments, verdict } = value as Record<string, unknown>;
  if (!keyOf(rawKey, 'raw') || !Array.isArray(attachments) || typeof verdict !== 'string') return null;
  const parts = new Set<number>();
  const list: MessageRecord['attachments'][number][] = [];
  for (const item of attachments) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const { part, objectKey } = item;
    if (!Number.isSafeInteger(part) || part < 1 || parts.has(part) || (objectKey !== null && !keyOf(objectKey, 'att'))) return null;
    parts.add(part);
    list.push({ part, objectKey });
  }
  return { rawKey, attachments: list, verdict: levels.has(verdict as VerdictLevel) ? verdict : 'phishing' };
}

export type ContentStoreConfig = Partial<Record<
  'CONTENT_S3_ENDPOINT' | 'CONTENT_S3_ACCESS_KEY_ID' | 'CONTENT_S3_SECRET_ACCESS_KEY', string
>>;

export function readOnlyObjects(env: ContentStoreConfig, ws: string) {
  const { CONTENT_S3_ENDPOINT: endpoint, CONTENT_S3_ACCESS_KEY_ID: accessKeyId, CONTENT_S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
  const origin = endpoint ? URL.parse(endpoint) : null;
  if (!origin || origin.protocol !== 'https:' || origin.href !== `${origin.origin}/` || !accessKeyId || !secretAccessKey) {
    throw new Error('content store is not configured');
  }
  const endpointOrigin = origin.origin;
  const bucket = workspaceMailBucket(ws);
  const s3 = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto', retries: 0 });
  async function get(key: string, kind: 'raw' | 'att') {
    if (!keyOf(key, kind)) throw new Error('invalid mail object key');
    const response = await s3.fetch(`${endpointOrigin}/${bucket}/${key}`, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(60_000),
      cf: { cacheTtlByStatus: { '100-599': -1 } },
    });
    const header = response.headers.get('content-length');
    const size = header && /^\d{1,8}$/.test(header) ? Number(header) : NaN;
    if (response.status !== 200 || !response.body || !(size > 0 && size <= MAX_RAW_BYTES)) {
      void response.body?.cancel().catch(() => {});
      throw new Error('mail object unavailable');
    }
    return { stream: response.body, size };
  }
  return {
    async mime(rawKey: string) {
      const { stream, size } = await get(rawKey, 'raw');
      const raw = await readExact(stream, size, MAX_RAW_BYTES);
      if (await sha256(raw) !== parseObjectKey(rawKey)?.digest) throw new Error('mail object digest mismatch');
      // Same parser version and options as mail-backend's indexed part numbers.
      return PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer', maxNestingDepth: 32, maxRfc822NestingDepth: 3 });
    },
    async attachment(key: string, expected: Uint8Array<ArrayBuffer>) {
      if (await sha256(expected) !== parseObjectKey(key)?.digest) throw new Error('attachment digest mismatch');
      const { stream, size } = await get(key, 'att');
      if (size !== expected.byteLength) {
        void stream.cancel().catch(() => {});
        throw new Error('attachment length mismatch');
      }
      // Authenticate the streamed copy against the part already decoded from
      // digest-verified MIME. Never emit a corrupt chunk, or finish a short body.
      let offset = 0;
      const checked = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (offset + chunk.byteLength > size || !chunk.every((byte, i) => byte === expected[offset + i])) {
            throw new Error('attachment bytes mismatch');
          }
          offset += chunk.byteLength;
          controller.enqueue(chunk);
        },
        flush() { if (offset !== size) throw new Error('attachment length mismatch'); },
      }));
      const output = new FixedLengthStream(size);
      void checked.pipeTo(output.writable).catch(() => {});
      return output.readable;
    },
  };
}

export function decodedBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // PostalMime can return a view for calendar parts even in arraybuffer mode.
  if (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('invalid decoded part');
}
