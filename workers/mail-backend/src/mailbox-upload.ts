import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { Upload } from '../../../contracts/mail-api/src/wire.ts';
import { fail, invalid, iso, text } from './mailbox-api-input.ts';
import { parseObjectKey } from './object-key.ts';

export const UPLOAD_EXPIRY = 'upload_expiry';
export const IDEM_EXPIRY = 'idem_expiry';
export const UPLOAD_TTL_MS = LIMITS.uploadRetentionSeconds * 1000;
export const IN_PROGRESS_TTL_MS = 5 * 60_000;

export type UploadRow = {
  id: string; objectKey: string; name: string; mediaType: string; size: number;
  expiresAt: number; holder: string;
};

const columns = 'id, object_key AS objectKey, name, media_type AS mediaType, size, expires_at AS expiresAt, holder';
export const uploadRow = (sql: SqlStorage, id: string): UploadRow | undefined =>
  sql.exec<UploadRow>(`SELECT ${columns} FROM mailbox_api_uploads WHERE id = ?`, id).toArray()[0];
export const uploadReferenced = (sql: SqlStorage, id: string): boolean =>
  sql.exec('SELECT 1 FROM mailbox_api_draft_uploads WHERE upload_id = ? LIMIT 1', id).toArray().length !== 0;

export const unusableSource = (sql: SqlStorage, kind: 'draft' | 'upload', id: string): boolean =>
  sql.exec('SELECT 1 FROM mailbox_unusable_sources WHERE kind = ? AND id = ?', kind, id).toArray().length !== 0;

export function wireUpload(row: UploadRow): Upload {
  const key = parseObjectKey(row.objectKey);
  if (key?.kind !== 'att') throw new Error('Invalid upload object key');
  return { id: row.id, name: row.name, type: row.mediaType, size: row.size, sha256: key.digest, expiresAt: iso(row.expiresAt) };
}

export type UploadBody = {
  stream: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  mediaType: string;
  contentLength: string | null;
};

export function uploadName(value: unknown): string {
  const name = text(value, 255, '/name');
  if (!name || /[\/\\\p{Cc}]/u.test(name)) return invalid('/name');
  return name;
}

export function uploadMediaType(value: string): string {
  const type = value.split(';', 1)[0].trim().toLowerCase();
  // Store a MIME type, not a raw header supplied by the client.
  if (type.length > 127 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) return 'application/octet-stream';
  return type;
}

// The final generation key requires the complete digest before its holder can
// be registered. Read a bounded, rewindable body, hashing each chunk as it
// arrives; then stream those same chunks into the signed PUT. Never write an
// untracked staging object or tee a body into an unbounded queue.
export async function readUpload({ stream, contentLength }: UploadBody, compareCommitted = false): Promise<{
  digest: string; size: number; bytes: ReadableStream<Uint8Array>;
}> {
  const max = LIMITS.uploadBytes;
  // No committed upload exceeded the cap, so an oversized retry is already
  // known to differ without buffering or hashing the rest of its body.
  const tooLarge = () => compareCommitted ? fail('idempotency_key_reused') : fail('payload_too_large', { limit: max });
  if (contentLength !== null && Number(contentLength) > max) {
    void stream?.cancel().catch(() => {});
    return tooLarge();
  }
  let size = 0;
  let offset = 0;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const hash = new crypto.DigestStream('SHA-256');
  const writer = hash.getWriter();
  // A failed/aborted upload must not leave the digest rejection unobserved.
  void hash.digest.catch(() => {});
  const reader = stream?.getReader();
  // An abandoned body cannot occupy the upload staging lane beyond its key lease.
  let timedOut = false;
  const timeout = reader && setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, IN_PROGRESS_TTL_MS);
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) return tooLarge();
      if (!value.byteLength) continue;
      await writer.write(value);
      // Coalesce arbitrary inbound chunk boundaries so tiny chunks cannot
      // inflate object overhead without also consuming the byte budget.
      for (let start = 0; start < value.byteLength;) {
        if (!chunks.length || offset === chunks.at(-1)!.byteLength) {
          chunks.push(new Uint8Array(Math.min(64 * 1024, max - (size - value.byteLength + start))));
          offset = 0;
        }
        const chunk = chunks.at(-1)!;
        const length = Math.min(value.byteLength - start, chunk.byteLength - offset);
        chunk.set(value.subarray(start, start + length), offset);
        offset += length;
        start += length;
      }
    }
    if (timedOut) return fail('unavailable', { retryAfterSeconds: 1 });
    await writer.close();
    const digest = Array.from(new Uint8Array(await hash.digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (chunks.length) chunks[chunks.length - 1] = chunks.at(-1)!.subarray(0, offset);
    let cursor = 0;
    const bytes = new ReadableStream<Uint8Array>({ pull(controller) {
      const chunk = chunks[cursor];
      if (!chunk) { controller.close(); return; }
      chunks[cursor++] = new Uint8Array(0);
      controller.enqueue(chunk);
    } });
    return { digest, size, bytes };
  } catch (error) {
    void writer.abort().catch(() => {});
    if (reader) void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
    reader?.releaseLock();
    writer.releaseLock();
  }
}
