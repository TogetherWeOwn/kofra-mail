// The save-time check (workspace override) and deploy-time check (deployment
// config) of a link storage location (docs/m3-outbound-plan.md, M3-15a).
//
// In order: the endpoint rules; HeadBucket; a 1-byte probe put and get; an
// anonymous GET and an anonymous list of the probe, both of which must be
// refused; a probe multipart (create, part, ListParts, complete, delete); a
// second multipart that is created and aborted; then the probe delete. The
// answer is one fixed reason code. Provider bodies, headers and statuses are
// never returned or logged.

import type { S3Credentials } from './credentials.ts';
import { locationFields, type LinkLocationFields } from './location.ts';
import { boundedText, bucketUrl, discard, objectUrl, s3Request, type Fetcher } from './s3.ts';

export const LINK_CHECK_REASONS = ['endpoint', 'redirect', 'public_bucket', 'auth', 'bucket', 'multipart', 'network'] as const;
export type LinkCheckReason = (typeof LINK_CHECK_REASONS)[number];
export type LinkCheckResult = { ok: true } | { ok: false; reason: LinkCheckReason };

export interface LinkCheckOptions {
  /** Defaults to the global `fetch`. */
  fetch?: Fetcher;
  /** Per request; default 10 s. */
  timeoutMs?: number;
}

class CheckFailure extends Error {
  readonly reason: LinkCheckReason;
  constructor(reason: LinkCheckReason) { super(reason); this.reason = reason; }
}

const PROBE_BYTES = 'k';
const uploadIdPattern = /<UploadId>([A-Za-z0-9._~+/=-]{1,1024})<\/UploadId>/;

/**
 * Runs the check for `fields` with the read-only and read-write credentials.
 * `zones` are the refused zones for this caller (the override refuses our own
 * domains; the operator's deployment config refuses only the required zones).
 */
export async function checkLinkLocation(fields: LinkLocationFields, credentials: { read: S3Credentials; write: S3Credentials },
  zones: readonly string[] | undefined, options: LinkCheckOptions = {}): Promise<LinkCheckResult> {
  // The endpoint rules run again here, so nothing is ever sent to a refused host.
  const valid = locationFields(fields, zones);
  if (!valid.ok) return { ok: false, reason: 'endpoint' };
  const location = valid.fields;
  const fetcher: Fetcher = options.fetch ?? (request => fetch(request));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('');
  const probeKey = `${location.prefix}link-probe-${nonce}`;
  const multipartKey = `${location.prefix}link-probe-${nonce}-mp`;
  const cleanup: (() => Promise<unknown>)[] = [];

  const call = async (as: S3Credentials | undefined, method: 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE', url: URL,
    body?: string, headers?: Record<string, string>): Promise<Response> => {
    let response: Response;
    try {
      response = await s3Request(fetcher, location, as, url, { method, body, headers, timeoutMs });
    } catch {
      throw new CheckFailure('network');
    }
    if (response.status >= 300 && response.status < 400) {
      discard(response);
      throw new CheckFailure('redirect');
    }
    return response;
  };
  // Expects one of `ok`; a 401 or 403 is `denied`; anything else is `other`.
  const expect = (response: Response, ok: number[], denied: LinkCheckReason, other: LinkCheckReason): Response => {
    if (ok.includes(response.status)) return response;
    discard(response);
    throw new CheckFailure(response.status === 401 || response.status === 403 ? denied : other);
  };
  const objectAt = (key: string, query = '') => {
    const url = objectUrl(location, key);
    url.search = query;
    return url;
  };

  try {
    const bucket = bucketUrl(location);
    discard(expect(await call(credentials.write, 'HEAD', bucket), [200], 'auth', 'bucket'));

    discard(expect(await call(credentials.write, 'PUT', objectAt(probeKey), PROBE_BYTES,
      { 'content-type': 'application/octet-stream' }), [200], 'auth', 'bucket'));
    cleanup.push(() => call(credentials.write, 'DELETE', objectAt(probeKey)).then(discard));
    const got = expect(await call(credentials.read, 'GET', objectAt(probeKey)), [200], 'auth', 'bucket');
    if (await boundedText(got, 1024) !== PROBE_BYTES) throw new CheckFailure('bucket');

    // The bucket must be private: an anonymous read and an anonymous list are both refused.
    const anonymous = await call(undefined, 'GET', objectAt(probeKey));
    discard(anonymous);
    if (anonymous.status !== 401 && anonymous.status !== 403) throw new CheckFailure('public_bucket');
    const list = new URL(bucket);
    list.search = new URLSearchParams({ 'list-type': '2', prefix: probeKey }).toString();
    const listed = await call(undefined, 'GET', list);
    discard(listed);
    if (listed.status !== 401 && listed.status !== 403) throw new CheckFailure('public_bucket');

    // A probe multipart upload, completed and deleted.
    const created = expect(await call(credentials.write, 'POST', objectAt(multipartKey, 'uploads')), [200], 'multipart', 'multipart');
    const uploadId = uploadIdPattern.exec(await boundedText(created) ?? '')?.[1];
    if (!uploadId) throw new CheckFailure('multipart');
    let completed = false;
    cleanup.push(() => completed ? call(credentials.write, 'DELETE', objectAt(multipartKey)).then(discard)
      : call(credentials.write, 'DELETE', objectAt(multipartKey, new URLSearchParams({ uploadId }).toString())).then(discard));
    const part = expect(await call(credentials.write, 'PUT', objectAt(multipartKey, new URLSearchParams({ partNumber: '1', uploadId }).toString()),
      PROBE_BYTES), [200], 'multipart', 'multipart');
    discard(part);
    const etag = part.headers.get('etag');
    if (!etag || !/^"?[\x21\x23-\x7e]{1,128}"?$/.test(etag)) throw new CheckFailure('multipart');
    const parts = expect(await call(credentials.write, 'GET', objectAt(multipartKey, new URLSearchParams({ uploadId }).toString())),
      [200], 'multipart', 'multipart');
    if (!/<PartNumber>1<\/PartNumber>/.test(await boundedText(parts) ?? '')) throw new CheckFailure('multipart');
    const completion = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag.replace(/[<>&]/g, '')}</ETag></Part></CompleteMultipartUpload>`;
    const complete = expect(await call(credentials.write, 'POST', objectAt(multipartKey, new URLSearchParams({ uploadId }).toString()),
      completion, { 'content-type': 'application/xml' }), [200], 'multipart', 'multipart');
    // S3 can answer 200 with an error document to a Complete.
    const result = await boundedText(complete);
    if (!result || !result.includes('<CompleteMultipartUploadResult') || result.includes('<Error>')) throw new CheckFailure('multipart');
    completed = true;
    discard(expect(await call(credentials.write, 'DELETE', objectAt(multipartKey)), [200, 204], 'multipart', 'multipart'));
    cleanup.pop();

    // A second multipart upload, created and aborted.
    const second = expect(await call(credentials.write, 'POST', objectAt(multipartKey, 'uploads')), [200], 'multipart', 'multipart');
    const secondId = uploadIdPattern.exec(await boundedText(second) ?? '')?.[1];
    if (!secondId) throw new CheckFailure('multipart');
    cleanup.push(() => call(credentials.write, 'DELETE', objectAt(multipartKey, new URLSearchParams({ uploadId: secondId }).toString())).then(discard));
    discard(expect(await call(credentials.write, 'DELETE', objectAt(multipartKey, new URLSearchParams({ uploadId: secondId }).toString())),
      [200, 204], 'multipart', 'multipart'));
    cleanup.pop();

    discard(expect(await call(credentials.write, 'DELETE', objectAt(probeKey)), [200, 204], 'auth', 'bucket'));
    cleanup.length = 0;
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof CheckFailure ? error.reason : 'network' };
  } finally {
    // Best effort; a cleanup failure never changes the answer.
    for (const step of cleanup.reverse()) await step().catch(() => {});
  }
}
