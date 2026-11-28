// Revocable file links on the link host (docs/m3-outbound-plan.md, M3-13):
//   GET  /f/<token>           the download page
//   GET  /f/<token>/download  the file, streamed from the link's S3-compatible location (Range supported)
//   POST /f/<token>/report    an abuse report
// The IP-keyed flood bucket runs first, before any lookup. Then the token's
// SHA-256 finds the routing row, and the sender's mailbox decides whether the
// link is live, on every request. A download is charged its Content-Length when
// its response starts, in one check-and-increment in the mailbox. The provider's
// response headers are never passed on: every header is rebuilt here. No token
// or token hash is ever logged.
import { AwsClient } from 'aws4fetch';
import { credentialSecret } from '../../../packages/link-storage/src/credentials.ts';
import { deploymentLocations, linkEndpoint, locationFingerprint, refusedZones, type LinkLocationFields } from '../../../packages/link-storage/src/location.ts';
import { objectUrl } from '../../../packages/link-storage/src/s3.ts';
import { busyPage, LINK_DOWNLOAD_CSP, limitPage, linkDisposition, linkPage, linkPageHeaders, reportedPage, unavailablePage } from './link-page.ts';

export type LinkLocationRef = { kind: 'deployment' | 'workspace'; id: string };
export type FileLinkHandle = { ws: string; mb: string; linkId: string };
export type FileLinkView = {
  status: 'live'; handle: FileLinkHandle; name: string; size: number; sender: { name: string; email: string }; expiresAt: number | null;
  location: LinkLocationRef; key: string; fingerprint: string; fields: LinkLocationFields | null;
};
export interface FileLinkLookup {
  fileLink(tokenHash: string): Promise<FileLinkView | { status: 'gone' | 'unavailable' | 'limit' }>;
  chargeFileLink(handle: FileLinkHandle, bytes: number): Promise<'ok' | 'gone' | 'limit' | 'unavailable'>;
  reportFileLink(tokenHash: string): Promise<'reported' | 'gone' | 'limit' | 'unavailable'>;
  linkReadCredential(ws: string, locationId: string): Promise<{ accessKeyId: string; secretAccessKey: string } | null>;
}
export interface RateLimit { limit(input: { key: string }): Promise<{ success: boolean }> }
export type FileLinkEnv = {
  MAIL_CONTENT_ENABLED?: string;
  // The hosts links are served on (space- or comma-separated, the current one first).
  LINK_HOSTS?: string;
  // The IP-keyed flood bucket in front of /f/ (a Rate Limiting binding). Missing: every link request answers 503.
  LINK_FLOOD?: RateLimit;
  // The deployment's link locations and their read-only keys (packages/link-storage).
  LINK_LOCATIONS?: string;
  LINK_READ_CREDENTIALS?: string;
  MAIL_LOOKUP: Partial<FileLinkLookup>;
};

const TOKEN = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const encoder = new TextEncoder();
// The provider has this long to answer with headers; the body is a native pipe with no per-chunk JavaScript.
const HEADERS_TIMEOUT_MS = 60_000;

/** The configured link hosts (`host` or `host:port`), lowercased; empty if unset or invalid. */
export function linkHosts(raw: string | undefined): string[] {
  const hosts = (raw ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  return hosts.every(host => /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(host)) ? hosts : [];
}

async function tokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

type Action = 'page' | 'download' | 'report';
type Answer = { response: Response; bytes: number };

function html(status: number, body: string, extra: Record<string, string> = {}): Answer {
  const headers = linkPageHeaders();
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return { response: new Response(body, { status, headers }), bytes: 0 };
}
const gone = () => html(404, unavailablePage());
const busy = (status = 503) => html(status, busyPage(), status === 503 ? { 'retry-after': '60' } : {});
const limited = () => html(429, limitPage(), { 'retry-after': '3600' });

export type ByteRange = { start: number; end: number };
/**
 * One byte range of a file of `size` bytes: a range, `none` (serve the whole
 * file: no header, several ranges, or a malformed one) or `unsatisfiable` (416).
 */
export function parseRange(header: string | null, size: number): ByteRange | 'none' | 'unsatisfiable' {
  if (header === null) return 'none';
  const match = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'none';
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  if (match[2] !== '' && Number(match[2]) < start) return 'none';
  if (start >= size) return 'unsatisfiable';
  return { start, end: match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1) };
}

function downloadHeaders(view: FileLinkView): Headers {
  return new Headers({
    'content-type': 'application/octet-stream',
    'content-disposition': linkDisposition(view.name),
    'content-security-policy': LINK_DOWNLOAD_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, no-store',
    'x-robots-tag': 'noindex, nofollow',
    'accept-ranges': 'bytes',
    // The object never changes, so the link id is a strong validator for resumed downloads.
    etag: `"${view.handle.linkId}"`,
  });
}

/** The location's fields and read-only key, after checking they are the ones the link was made with. */
async function source(view: FileLinkView, env: FileLinkEnv): Promise<{ fields: LinkLocationFields; key: { accessKeyId: string; secretAccessKey: string } } | null> {
  let fields: LinkLocationFields | undefined | null;
  let key: { accessKeyId: string; secretAccessKey: string } | null | undefined;
  if (view.location.kind === 'deployment') {
    fields = deploymentLocations(env.LINK_LOCATIONS)?.locations.get(view.location.id);
    key = credentialSecret(env.LINK_READ_CREDENTIALS)?.get(view.location.id)?.reveal();
  } else {
    fields = view.fields;
    key = fields && await env.MAIL_LOOKUP.linkReadCredential?.(view.handle.ws, view.location.id);
  }
  // A location is immutable: a repointed one would serve other bytes, so it is never read.
  if (!fields || !key || !linkEndpoint(fields.endpoint, refusedZones([])) || await locationFingerprint(fields) !== view.fingerprint) return null;
  return { fields, key };
}

async function download(request: Request, view: FileLinkView, env: FileLinkEnv): Promise<Answer> {
  const lookup = env.MAIL_LOOKUP;
  if (!lookup.chargeFileLink) return busy();
  const headers = downloadHeaders(view);
  const ifRange = request.headers.get('if-range');
  const range = ifRange === null || ifRange === headers.get('etag') ? parseRange(request.headers.get('range'), view.size) : 'none';
  if (range === 'unsatisfiable') {
    headers.set('content-range', `bytes */${view.size}`);
    return { response: new Response(null, { status: 416, headers }), bytes: 0 };
  }
  const from = await source(view, env);
  if (!from) return busy(502);
  const client = new AwsClient({ ...from.key, service: 's3', region: from.fields.region, retries: 0 });
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('link object header timeout', 'TimeoutError')), HEADERS_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await client.fetch(objectUrl(from.fields, view.key).href, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.any([request.signal, deadline.signal]),
      headers: range === 'none' ? {} : { range: `bytes=${range.start}-${range.end}` },
      cf: { cacheTtlByStatus: { '100-599': -1 } },
    } as RequestInit);
  } catch {
    return busy(502);
  } finally {
    clearTimeout(timer);
  }
  const length = range === 'none' ? view.size : range.end - range.start + 1;
  // Only the exact bytes asked for are passed on; a redirect, an error or a
  // mismatched length or range is never served, whatever the provider says.
  const expected = range === 'none' ? upstream.status === 200
    : upstream.status === 206 && upstream.headers.get('content-range') === `bytes ${range.start}-${range.end}/${view.size}`;
  if (!expected || upstream.headers.get('content-length') !== String(length)) {
    void upstream.body?.cancel().catch(() => {});
    console.error(JSON.stringify({ code: 'link_object_unexpected', status: upstream.status }));
    return busy(502);
  }
  // Charged when the response starts, at its Content-Length; the mailbox re-checks the link is live.
  let charge: Awaited<ReturnType<FileLinkLookup['chargeFileLink']>>;
  try { charge = await lookup.chargeFileLink(view.handle, length); }
  catch { charge = 'unavailable'; }
  if (charge !== 'ok') {
    void upstream.body?.cancel().catch(() => {});
    return charge === 'gone' ? gone() : charge === 'limit' ? limited() : busy();
  }
  headers.set('content-length', String(length));
  if (range !== 'none') headers.set('content-range', `bytes ${range.start}-${range.end}/${view.size}`);
  const output = new FixedLengthStream(length);
  if (upstream.body) void upstream.body.pipeTo(output.writable).catch(() => {});
  else void output.writable.close().catch(() => {});
  return { response: new Response(output.readable, { status: range === 'none' ? 200 : 206, headers }), bytes: length };
}

async function answer(request: Request, env: FileLinkEnv, action: Action, token: string): Promise<Answer> {
  const lookup = env.MAIL_LOOKUP;
  if (!lookup.fileLink || !lookup.reportFileLink) return busy();
  const hash = await tokenHash(token);
  if (action === 'report') {
    void request.body?.cancel().catch(() => {});
    const outcome = await lookup.reportFileLink(hash);
    if (outcome === 'reported') return html(200, reportedPage());
    return outcome === 'gone' ? gone() : outcome === 'limit' ? html(429, reportedPage(), { 'retry-after': '3600' }) : busy();
  }
  const view = await lookup.fileLink(hash);
  if (view.status !== 'live') return view.status === 'limit' ? limited() : view.status === 'unavailable' ? busy() : gone();
  if (action === 'page') {
    return html(200, linkPage({ token, name: view.name, size: view.size, sender: view.sender, expiresAt: view.expiresAt }));
  }
  return download(request, view, env);
}

/** Every request to a link host. */
export async function serveFileLink(request: Request, env: FileLinkEnv): Promise<Response> {
  const url = new URL(request.url);
  let action: Action | 'none' = 'none';
  let result: Answer;
  try {
    result = await route(request, env, url, a => { action = a; });
  } catch {
    // Failures are closed and never expose a port's or the provider's error.
    result = busy();
  }
  console.log(JSON.stringify({ purpose: 'link', action, status: result.response.status, bytes: result.bytes }));
  return result.response;
}

async function route(request: Request, env: FileLinkEnv, url: URL, seen: (action: Action) => void): Promise<Answer> {
  if (env.MAIL_CONTENT_ENABLED !== 'on') return gone();
  // The flood bucket runs first, before any lookup, keyed by the client's IP only.
  const flood = env.LINK_FLOOD;
  if (!flood || typeof flood.limit !== 'function') return busy();
  let admitted: unknown;
  try { admitted = (await flood.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' }))?.success; }
  catch { return busy(); }
  if (admitted !== true) return html(429, busyPage(), { 'retry-after': '60' });
  const match = /^\/f\/([^/]{1,64})(?:\/(download|report))?$/.exec(url.pathname);
  if (!match || !TOKEN.test(match[1]) || url.search) return gone();
  const action: Action = match[2] === 'download' ? 'download' : match[2] === 'report' ? 'report' : 'page';
  seen(action);
  if ((action === 'report') !== (request.method === 'POST') || (request.method !== 'GET' && request.method !== 'POST')) {
    const headers = linkPageHeaders();
    headers.set('allow', action === 'report' ? 'POST' : 'GET');
    return { response: new Response(null, { status: 405, headers }), bytes: 0 };
  }
  return answer(request, env, action, match[1]);
}
