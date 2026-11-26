import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import { ApiFault, fail, invalid } from './mailbox-api-input.ts';
import type { UploadBody } from './mailbox-upload.ts';

export type HttpMailboxWrite = UploadBody & { query: [string, string][] };

export function createQuery(http: HttpMailboxWrite, upload: boolean): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of http.query) {
    if (!upload || key !== 'name') return fail('unknown_field');
    if (Object.hasOwn(query, key)) return invalid('/name');
    query.name = value;
  }
  return query;
}

export function checkReplayInput(error: unknown, committed: boolean): never {
  // A committed result came from a valid bounded request. If the retry cannot
  // supply a comparable input under those bounds, it cannot claim that key.
  if (committed && error instanceof ApiFault &&
      ['invalid_request', 'unknown_field', 'unsupported_media_type', 'payload_too_large'].includes(error.problem.code)) {
    return fail('idempotency_key_reused');
  }
  throw error;
}

export async function readMailboxJson(http: HttpMailboxWrite, remainingMs: number): Promise<unknown> {
  if (remainingMs <= 0) return fail('unavailable', { retryAfterSeconds: 1 });
  if (http.mediaType.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('unsupported_media_type');
  // JSON may use six bytes to escape a one-byte draft character.
  const max = LIMITS.bodyBytes * 6 + 512 * 1024;
  if (Number(http.contentLength) > max) return fail('payload_too_large', { limit: max });
  if (!http.stream) return fail('invalid_request');
  const reader = http.stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, remainingMs);
  try {
    let source = '';
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) return fail('payload_too_large', { limit: max });
      source += decoder.decode(value, { stream: true });
    }
    if (expired) return fail('unavailable', { retryAfterSeconds: 1 });
    return JSON.parse(source + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof ApiFault) throw error;
    return fail('invalid_request');
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
