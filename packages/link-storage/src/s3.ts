// The few S3 calls link storage makes, signed with SigV4. Every request uses
// `redirect: 'manual'` (a 3xx is an error, never followed), a fixed deadline
// and only the headers built here. Response headers are never passed on.

import { AwsClient } from 'aws4fetch';
import type { S3Credentials } from './credentials.ts';
import type { LinkLocationFields } from './location.ts';

export type Fetcher = (request: Request) => Promise<Response>;

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

/** The bucket's URL: `https://<endpoint>/<bucket>` path-style, `https://<bucket>.<endpoint>/` otherwise. */
export function bucketUrl(fields: LinkLocationFields): URL {
  const endpoint = new URL(fields.endpoint);
  return fields.pathStyle ? new URL(`${endpoint.origin}/${fields.bucket}`) : new URL(`https://${fields.bucket}.${endpoint.hostname}/`);
}

/** An object's URL. `key` is the full key, prefix included. */
export function objectUrl(fields: LinkLocationFields, key: string): URL {
  const base = bucketUrl(fields);
  return new URL(fields.pathStyle ? `${base.href}/${encodeKey(key)}` : `${base.origin}/${encodeKey(key)}`);
}

export interface S3RequestInit {
  method: 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE';
  body?: string | Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
  timeoutMs: number;
}

/** Sends one request, signed if `credentials` is given, anonymous otherwise. Network failures throw. */
export async function s3Request(fetcher: Fetcher, fields: LinkLocationFields, credentials: S3Credentials | undefined,
  url: URL, init: S3RequestInit): Promise<Response> {
  const request: RequestInit = {
    method: init.method,
    headers: { ...init.headers },
    body: init.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(init.timeoutMs),
  };
  if (!credentials) return fetcher(new Request(url, request));
  const { accessKeyId, secretAccessKey } = credentials.reveal();
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: fields.region, retries: 0 });
  // UNSIGNED-PAYLOAD, as streamed link parts will use (aws4fetch's default for S3).
  return fetcher(await client.sign(url.href, request));
}

/** Reads at most `max` bytes of a body as UTF-8; undefined if larger or not text. */
export async function boundedText(response: Response, max = 64 * 1024): Promise<string | undefined> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let text = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      total += value.byteLength;
      if (total > max) return undefined;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return undefined;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Discards a body without reading it. */
export function discard(response: Response): void {
  void response.body?.cancel().catch(() => {});
}
