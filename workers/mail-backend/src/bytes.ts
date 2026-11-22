export const MAX_RAW_BYTES = 25 * 1024 * 1024;

export async function readExact(stream: ReadableStream<Uint8Array>, size: number, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(size) || size <= 0 || size > limit) throw new Error('Invalid object size');
  const bytes = new Uint8Array(size);
  const reader = stream.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > size - offset) throw new Error('Object size exceeded declared size');
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== size) throw new Error('Object did not reach declared size');
    return bytes;
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');
}
