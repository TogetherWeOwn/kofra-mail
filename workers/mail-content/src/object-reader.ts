import { AwsClient } from 'aws4fetch';
import PostalMime from 'postal-mime';
import type { VerdictLevel } from '../../../contracts/mail-api/src/wire.ts';
import { workspaceMailBucket } from '../../mail-backend/src/directory.ts';
import { parseObjectKey } from '../../mail-backend/src/object-key.ts';
import { MAX_RAW_BYTES, readExact, sha256 } from '../../mail-backend/src/bytes.ts';
import { reserveMime } from './mime-budget.ts';
import { shareMime } from './mime-flight.ts';
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

export function readOnlyObjects(env: ContentStoreConfig, ws: string, requestSignal: AbortSignal,
    keepAlive?: (work: Promise<void>) => void) {
  const { CONTENT_S3_ENDPOINT: endpoint, CONTENT_S3_ACCESS_KEY_ID: accessKeyId, CONTENT_S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
  const origin = endpoint ? URL.parse(endpoint) : null;
  if (!origin || origin.protocol !== 'https:' || origin.href !== `${origin.origin}/` || !accessKeyId || !secretAccessKey) {
    throw new Error('content store is not configured');
  }
  const endpointOrigin = origin.origin;
  const bucket = workspaceMailBucket(ws);
  const s3 = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto', retries: 0 });
  async function get(key: string, kind: 'raw' | 'att', ownerSignal: AbortSignal) {
    if (!keyOf(key, kind)) throw new Error('invalid mail object key');
    const headersDeadline = kind === 'att' ? new AbortController() : undefined;
    const signal = AbortSignal.any([ownerSignal, headersDeadline?.signal ?? AbortSignal.timeout(60_000)]);
    const timer = headersDeadline && setTimeout(() => headersDeadline.abort(new DOMException('object header timeout', 'TimeoutError')), 60_000);
    let response: Response;
    try {
      response = await s3.fetch(`${endpointOrigin}/${bucket}/${key}`, {
        method: 'GET', redirect: 'manual', signal,
        cf: { cacheTtlByStatus: { '100-599': -1 } },
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const header = response.headers.get('content-length');
    const size = header && /^\d{1,8}$/.test(header) ? Number(header) : NaN;
    if (response.status !== 200 || !response.body || !(size > 0 && size <= MAX_RAW_BYTES)) {
      void response.body?.cancel().catch(() => {});
      throw new Error('mail object unavailable');
    }
    return { stream: response.body, size, signal };
  }
  return {
    withMime<T>(rawKey: string, sub: string, purpose: 'body' | 'att' | 'cid', prepare: (mail: MailMime) => T | Promise<T>): Promise<T> {
      // Equal raw keys in different buckets must not share an object read.
      return shareMime(`${bucket}/${rawKey}`, sub, requestSignal, async (install, byteWaitMs, flightSignal) => {
        const { stream, size, signal } = await get(rawKey, 'raw', flightSignal);
        try {
          install((await reserveMime(size, signal, byteWaitMs))());
          const raw = await readExact(stream, size, MAX_RAW_BYTES);
          if (await sha256(raw) !== parseObjectKey(rawKey)?.digest) throw new Error('mail object digest mismatch');
          // Same parser version and options as mail-backend's indexed part numbers.
          return await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer', maxNestingDepth: 32, maxRfc822NestingDepth: 3 });
        } catch (error) {
          void stream.cancel().catch(() => {});
          throw error;
        }
      }, prepare, purpose, keepAlive);
    },
    async attachment(proof: AttachmentProof) {
      const { stream, size } = await get(proof.key, 'att', requestSignal);
      if (size !== proof.size) {
        void stream.cancel().catch(() => {});
        throw new Error('attachment length mismatch');
      }
      return verifiedAttachmentStream(stream, proof);
    },
  };
}

export type MailMime = Awaited<ReturnType<typeof PostalMime.parse>>;
export const EXTERNAL_PART_BYTES = 256 * 1024;
const proofBlockBytes = 64 * 1024;

export type AttachmentProof = { key: string; size: number; blocks: readonly string[] };

/** Keep only digests, not the decoded MIME part, for the response transfer. */
export async function proveAttachment(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<AttachmentProof> {
  if (await sha256(bytes) !== parseObjectKey(key)?.digest) throw new Error('attachment digest mismatch');
  const blocks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += proofBlockBytes) {
    blocks.push(await sha256(bytes.subarray(offset, offset + proofBlockBytes)));
  }
  return { key, size: bytes.byteLength, blocks };
}

export function verifiedAttachmentStream(stream: ReadableStream<Uint8Array>, proof: AttachmentProof): ReadableStream<Uint8Array> {
  const reader = stream.getReader({ mode: 'byob' });
  let offset = 0;
  async function read(view: Uint8Array<ArrayBuffer>) {
    const { promise, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => reject(new DOMException('attachment body idle', 'TimeoutError')), 30_000);
    try { return await Promise.race([reader.read(view), promise]); }
    finally { clearTimeout(timer); }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (offset === proof.size) {
          if (!(await read(new Uint8Array(1))).done) throw new Error('attachment length mismatch');
          controller.close();
          return;
        }
        // Read no more than one bounded block before authenticating and emitting it.
        const length = Math.min(proofBlockBytes, proof.size - offset);
        let block = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const { done, value } = await read(block.subarray(filled));
          if (done || !value?.byteLength) throw new Error('attachment length mismatch');
          filled += value.byteLength;
          block = new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset + value.byteLength - filled, length);
        }
        if (await sha256(block) !== proof.blocks[offset / proofBlockBytes]) throw new Error('attachment bytes mismatch');
        offset += length;
        controller.enqueue(block);
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
      }
    },
    cancel() { return reader.cancel(); },
  }, { highWaterMark: 0 });
}

export function decodedBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // PostalMime can return a view for calendar parts even in arraybuffer mode.
  if (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('invalid decoded part');
}
