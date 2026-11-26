import { AwsClient } from 'aws4fetch';
import { MAX_RAW_BYTES, readExact, sha256 } from './bytes.ts';
import { workspaceMailBucket } from './directory.ts';
import { ObjectInvalidError, ObjectMissingError } from './object-errors.ts';
import { isObjectDigest, parseObjectKey } from './object-key.ts';

export type KofraConfig = Partial<Record<
  'KOFRA_S3_ENDPOINT' | 'KOFRA_S3_ACCESS_KEY_ID' | 'KOFRA_S3_SECRET_ACCESS_KEY', string>>;

function objectDigest(key: string): string | null {
  if (key.startsWith('drafts/')) {
    const digest = key.slice('drafts/'.length);
    return isObjectDigest(digest) ? digest : null;
  }
  return parseObjectKey(key)?.digest ?? null;
}

export function isObjectKey(key: string): boolean {
  return objectDigest(key) !== null;
}

const MAX_DELETE_ERROR_BYTES = 4 * 1024;
// The bridge emits Code first in its S3 Error envelope. Do not accept a match
// buried in a message, HTML, or a comment inside some other error.
// A well-formed S3 error document: optional XML declaration, then <Error> whose
// first child is <Code>NoSuchKey</Code> and whose other children are known
// leaf elements with plain text, each closed. Anything else is unconfirmed.
// Leaf text may hold only characters and the five predefined XML entities; a
// declaration must be exactly version 1.0 with an optional UTF-8 encoding; no
// DTD, comment, processing instruction or CDATA is accepted.
// XML 1.0 Char: tab, LF, CR, U+0020-U+D7FF, U+E000-U+FFFD, U+10000-U+10FFFF,
// here also excluding `<`, `>` and `&` (which may only start an entity).
const XML_CHAR = String.raw`[\t\n\r\u0020-\u0025\u0027-\u003B\u003D\u003F-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]`;
const XML_TEXT = String.raw`(?:${XML_CHAR}|&(?:amp|lt|gt|quot|apos);)*`;
const XML_WS = String.raw`[ \t\r\n]*`;
const XML_DECL = String.raw`<\?xml version=(["'])1\.0\1(?: encoding=(["'])UTF-8\2)?${XML_WS}\?>`;
const NO_SUCH_KEY = new RegExp(String.raw`^(?:${XML_DECL})?${XML_WS}<Error>${XML_WS}<Code>NoSuchKey</Code>` +
  String.raw`(?:${XML_WS}<(Message|Key|BucketName|Resource|RequestId|HostId)>${XML_TEXT}</\3>)*${XML_WS}</Error>${XML_WS}$`, 'u');

class MissingObjectResponse extends Error {}

async function confirmsMissing(body: Response['body']): Promise<boolean> {
  if (!body) return false;
  let reader: ReadableStreamBYOBReader | undefined;
  try {
    reader = body.getReader({ mode: 'byob' });
    // Invalid UTF-8 is unconfirmed, never repaired.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    let remaining = MAX_DELETE_ERROR_BYTES;
    let text = '';
    // Only a complete, bounded S3 error document counts; a truncated or
    // oversized body is unconfirmed.
    for (;;) {
      const { done, value } = await reader.read(new Uint8Array(remaining + 1));
      if (value) {
        remaining -= value.byteLength;
        if (remaining < 0) return false;
        text += decoder.decode(value, { stream: true });
      }
      if (done) break;
    }
    return NO_SUCH_KEY.test(text + decoder.decode());
  } catch { return false; }
  finally { void reader?.cancel().catch(() => {}); }
}

export function kofra(config: KofraConfig, workspaceId: string) {
  const { KOFRA_S3_ENDPOINT: endpoint, KOFRA_S3_ACCESS_KEY_ID: accessKeyId,
    KOFRA_S3_SECRET_ACCESS_KEY: secretAccessKey } = config;
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error('Kofra mail object store unavailable for workspace');
  const bucket = workspaceMailBucket(workspaceId);
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid Kofra mail object store configuration');
  }
  const s3 = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto', retries: 0 });
  async function request(method: 'GET' | 'PUT' | 'DELETE', key: string,
    body?: Uint8Array<ArrayBuffer> | ReadableStream, verifiedDigest?: string, timeoutMs = 60_000): Promise<Response> {
    const keyDigest = objectDigest(key);
    if (!keyDigest) throw new Error('Invalid mail object key');
    let headers: Record<string, string> | undefined;
    if (body) {
      const digest = body instanceof Uint8Array ? await sha256(body) : verifiedDigest;
      if (digest !== keyDigest) throw new Error('Mail object digest mismatch');
      headers = { 'content-type': 'application/octet-stream', 'x-amz-content-sha256': digest };
    }
    // The client signs a fixed origin, bucket and validated path; never follow redirects.
    let response: Response;
    try {
      response = await s3.fetch(`${url.origin}/${bucket}/${key}`, { method, body, headers, redirect: 'manual',
        // A hung request must not hold a mailbox lane; an aborted one is retried.
        signal: AbortSignal.timeout(method === 'DELETE' ? 20_000 : timeoutMs) });
    } catch {
      throw new Error(`Kofra object ${method} failed`);
    }
    const accepted = method === 'DELETE' ? response.status === 204 || response.status === 404 : response.ok;
    if (method === 'GET' && response.status === 404 && await confirmsMissing(response.body)) throw new MissingObjectResponse();
    if (!accepted) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Kofra object ${method} failed (${response.status})`);
    }
    return response;
  }
  return {
    async deleteGeneration(key: string): Promise<void> {
      if (!parseObjectKey(key)) throw new Error('Invalid mail generation key');
      const response = await request('DELETE', key);
      if (response.status === 404 && !await confirmsMissing(response.body)) {
        throw new Error('Kofra object DELETE failed (404)');
      }
    },
    async put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
      const response = await request('PUT', key, bytes);
      await response.body?.cancel();
    },
    async putUpload(key: string, bytes: ReadableStream<Uint8Array>, size: number, digest: string, timeoutMs: number): Promise<void> {
      if (parseObjectKey(key)?.kind !== 'att' || !Number.isSafeInteger(size) || size < 0 || size > MAX_RAW_BYTES) {
        throw new Error('Invalid attachment PUT');
      }
      const stream = new FixedLengthStream(size);
      const pipe = new AbortController();
      const copied = bytes.pipeTo(stream.writable, { signal: pipe.signal });
      try {
        const [response] = await Promise.all([request('PUT', key, stream.readable, digest, Math.min(60_000, timeoutMs)), copied]);
        await response.body?.cancel();
      } finally {
        pipe.abort();
      }
    },
    async get(key: string): Promise<Uint8Array<ArrayBuffer>> {
      let response: Response;
      try {
        response = await request('GET', key);
      } catch (error) {
        if (error instanceof MissingObjectResponse) throw new ObjectMissingError('Kofra object does not exist');
        throw error;
      }
      const size = response.headers.get('content-length');
      if (!response.body || !size || !/^\d+$/.test(size) || Number(size) === 0 || Number(size) > MAX_RAW_BYTES) {
        void response.body?.cancel().catch(() => {});
        // A missing length is a transport problem; a declared empty or oversized object is not.
        if (size && /^\d+$/.test(size)) throw new ObjectInvalidError('Invalid Kofra object size');
        throw new Error('Invalid Kofra object size');
      }
      return readExact(response.body, Number(size), MAX_RAW_BYTES);
    },
  };
}
