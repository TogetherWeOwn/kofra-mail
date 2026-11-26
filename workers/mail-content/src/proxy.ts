// Remote-image proxy policy (docs/content-origin.md section 5, rules 1-5 and 7).
//
// This module decides which remote URLs may be fetched and how. It never logs:
// the only log output is the line built by `remoteImageLogLine`, which holds no
// URL and no token. Token verification and the fetch cache (rule 6) belong to
// the `img` handler, which must call `fetchRemoteImage` only after the token
// has passed every verification step.

/** The subset of `fetch` the proxy uses. The global `fetch` satisfies it. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Our own names. Each one is refused, together with all of its subdomains. */
export interface OwnDomains {
  suiteDomain: string;
  contentDomain: string;
  storageDomains: readonly string[];
  accountDomains: readonly string[];
  /** The account's full workers.dev name, for example `example-acct.workers.dev`. */
  workersDevSubdomain: string;
}

export interface RemoteImageConfig {
  /** Longest accepted URL, in UTF-8 bytes, before and after parsing. */
  maxUrlBytes: number;
  /** Redirect hops followed after the first request. */
  remoteImageRedirects: number;
  /** Largest body read into memory. */
  remoteImageBytes: number;
  /** Total deadline across every hop and the body read. */
  remoteImageTimeoutMs: number;
  /** Extra zones refused with all their subdomains, in addition to `requiredRefusedZones`. */
  refusedZones: readonly string[];
  /** Bytes that all concurrent body reads in one isolate may reserve together. */
  remoteImageInFlightBytes: number;
  ownDomains: OwnDomains;
}

export const remoteImageDefaults = {
  maxUrlBytes: 2048,
  remoteImageRedirects: 3,
  remoteImageBytes: 5 * 1024 * 1024,
  remoteImageTimeoutMs: 10_000,
  refusedZones: [],
  remoteImageInFlightBytes: 32 * 1024 * 1024,
} as const satisfies Omit<RemoteImageConfig, 'ownDomains'>;

/** Rule 2's private-use zones. Always refused; configuration can only add to them. */
export const requiredRefusedZones: readonly string[] = Object.freeze(['localhost', 'local', 'internal', 'arpa']);

export function remoteImageConfig(ownDomains: OwnDomains): RemoteImageConfig {
  return { ...remoteImageDefaults, ownDomains };
}

/** The only request headers ever sent upstream. Fixed; never derived from a request. */
export const remoteImageAccept = 'image/avif,image/webp,image/png,image/*;q=0.8';
export const remoteImageUserAgent = 'Mozilla/5.0 (compatible; ImageProxy/1.0)';

/**
 * Turns off Worker-controlled caching of every hop, so an upstream body is
 * never stored before the proxy has judged it (rule 6 caches only behind the
 * verifier). `cf` is used rather than `cache: 'no-store'`, because workerd
 * turns `no-store` into `Cache-Control: no-cache` and `Pragma: no-cache`
 * request headers, and rule 3 allows only Accept and User-Agent. A negative
 * `cacheTtlByStatus` means "do not cache at all"; `cacheTtl: 0` would still
 * store the response with immediate expiry.
 */
export const remoteImageCacheOptions = Object.freeze({
  cacheEverything: false,
  cacheTtlByStatus: Object.freeze({ '100-599': -1 }),
});

export type RemoteImageFailure = 'url' | 'redirect' | 'status' | 'type' | 'magic' | 'size' | 'timeout' | 'network';
export interface RemoteImage { ok: true; contentType: string; bytes: Uint8Array; length: number }
export interface StreamingRemoteImage extends RemoteImage {
  body: ReadableStream<Uint8Array>;
  startTransfer(signal?: AbortSignal): void;
}
type ImageRefusal = { ok: false; reason: RemoteImageFailure };
export type RemoteImageResult = RemoteImage | ImageRefusal;
export type RemoteImageUrlVerdict = { ok: true; url: URL } | { ok: false };

// ---- Rule 1: methods ----

/** Rule 1: `GET` only. The handler answers 405 to `HEAD` and every other method. */
export function remoteImageMethodAllowed(method: string): boolean {
  return method === 'GET';
}

// ---- Rule 2: the URL guard ----

const utf8 = new TextEncoder();
const byteLength = (value: string) => utf8.encode(value).length;
const label = /^(?!-)[a-z\d-]{1,63}(?<!-)$/;

/** Lowercase, drop one trailing dot, and require LDH labels. Returns undefined if not a DNS name. */
function dnsName(value: string, minLabels: number): string | undefined {
  let name = value.toLowerCase();
  if (name.endsWith('.')) name = name.slice(0, -1);
  if (name.length === 0 || name.length > 253) return undefined;
  const labels = name.split('.');
  if (labels.length < minLabels || !labels.every(part => label.test(part))) return undefined;
  // A final label that is numeric or hex would make the name an IPv4 address.
  const last = labels[labels.length - 1];
  if (/^\d+$/.test(last) || /^0x[\da-f]*$/.test(last)) return undefined;
  return name;
}

const isCount = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/** The spec's limits are ceilings: configuration may tighten them, never loosen them. */
const ceilings = remoteImageDefaults;

/** Every refused zone, normalised; undefined if any configured value is invalid (fail closed). */
function refusedNames(config: RemoteImageConfig): string[] | undefined {
  if (!isCount(config.maxUrlBytes, 1, ceilings.maxUrlBytes) || !isCount(config.remoteImageRedirects, 0, ceilings.remoteImageRedirects)
    || !isCount(config.remoteImageBytes, 1, ceilings.remoteImageBytes)
    || !isCount(config.remoteImageTimeoutMs, 1, ceilings.remoteImageTimeoutMs)
    || !isCount(config.remoteImageInFlightBytes, 1, ceilings.remoteImageInFlightBytes)) return undefined;
  const own = config.ownDomains;
  if (!own || !Array.isArray(config.refusedZones) || !Array.isArray(own.storageDomains) || !Array.isArray(own.accountDomains))
    return undefined;
  const zones = [...requiredRefusedZones, ...config.refusedZones].map(zone => typeof zone === 'string' ? dnsName(zone, 1) : undefined);
  const domains = [own.suiteDomain, own.contentDomain, ...own.storageDomains, ...own.accountDomains, own.workersDevSubdomain]
    .map(domain => typeof domain === 'string' ? dnsName(domain, 2) : undefined);
  const workersDev = domains[domains.length - 1];
  if (workersDev === undefined || !workersDev.endsWith('.workers.dev') || workersDev.split('.').length < 3) return undefined;
  const all = [...zones, ...domains];
  return all.every((name): name is string => name !== undefined) ? all : undefined;
}

const specialSchemes = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:']);
const within = (host: string, zone: string) => host === zone || host.endsWith(`.${zone}`);

/**
 * True if the raw URL or reference has an `@` in its authority. The URL parser
 * drops empty user information (`https://:@host/`), so this is checked before
 * parsing. It mirrors the parser's preprocessing (trim C0 controls and spaces,
 * remove tabs and newlines) and treats a backslash like a slash, as special schemes do.
 */
function rawAuthorityHasUserInfo(raw: string, base?: URL): boolean {
  const input = raw.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\n\r]/g, '');
  const scheme = /^[a-z][a-z\d+.-]*:/i.exec(input);
  let rest = scheme ? input.slice(scheme[0].length) : input;
  const slashes = /^[/\\]*/.exec(rest)![0];
  // Without a scheme, or with the base's own special scheme (`https:/a@b` against an https base),
  // only two leading slash-like characters start an authority; otherwise the reference is a path.
  // A different scheme, or no base, starts an authority after any number of slashes.
  const sameSpecialScheme = scheme !== null && base !== undefined && specialSchemes.has(base.protocol)
    && scheme[0].toLowerCase() === base.protocol;
  if ((!scheme || sameSpecialScheme) && slashes.length < 2) return false;
  rest = rest.slice(slashes.length);
  const end = rest.search(/[/\\?#]/);
  return (end === -1 ? rest : rest.slice(0, end)).includes('@');
}

/**
 * Rule 2. Accepts only http(s) URLs on ports 80 or 443, without user
 * information, whose host is a DNS name outside every refused zone. The
 * returned URL is the parsed form; callers fetch `url.href`, never the input.
 */
export function checkRemoteImageUrl(input: string, config: RemoteImageConfig): RemoteImageUrlVerdict {
  const refused = { ok: false } as const;
  const zones = refusedNames(config);
  if (zones === undefined || typeof input !== 'string' || byteLength(input) > config.maxUrlBytes) return refused;
  if (rawAuthorityHasUserInfo(input)) return refused;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return refused;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return refused;
  if (url.username !== '' || url.password !== '') return refused;
  if (url.port !== '' && url.port !== '80' && url.port !== '443') return refused;
  if (byteLength(url.href) > config.maxUrlBytes) return refused;
  // The WHATWG parser has already turned every IPv4 form (integer, octal, hex,
  // short, percent-encoded, full-width) into dotted decimal and bracketed IPv6.
  const hostname = url.hostname;
  if (hostname.startsWith('[') || /^[\d.]+$/.test(hostname)) return refused;
  const host = dnsName(hostname, 2);
  if (host === undefined || zones.some(zone => within(host, zone))) return refused;
  return { ok: true, url };
}

// ---- Rules 3 to 5: the fetch ----

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

const ascii = (text: string) => Array.from(text, c => c.charCodeAt(0));
const startsWith = (bytes: Uint8Array, prefix: number[], offset = 0) =>
  bytes.length >= offset + prefix.length && prefix.every((b, i) => bytes[offset + i] === b);

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || !startsWith(bytes, ascii('ftyp'), 4)) return false;
  const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  if (size < 16 || size > bytes.length || size % 4 !== 0) return false;
  for (let offset = 8; offset < size; offset += 4) {
    if (offset === 12) continue; // minor version
    if (startsWith(bytes, ascii('avif'), offset) || startsWith(bytes, ascii('avis'), offset)) return true;
  }
  return false;
}

/** Rule 4: the allowlist. Each type's leading bytes must match. SVG is absent on purpose. */
const imageTypes: ReadonlyMap<string, (bytes: Uint8Array) => boolean> = new Map([
  ['image/png', b => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', b => startsWith(b, [0xff, 0xd8, 0xff])],
  ['image/gif', b => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))],
  ['image/webp', b => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)],
  ['image/avif', isAvif],
  ['image/bmp', b => b.length >= 14 && startsWith(b, ascii('BM'))],
  // ICONDIR (6 bytes) with a nonzero image count, then at least one 16-byte directory entry.
  ['image/x-icon', b => b.length >= 22 && startsWith(b, [0, 0, 1, 0]) && (b[4] | b[5]) !== 0],
]);

// RFC 9110 media-type: type "/" subtype *( OWS ";" OWS [ name=value ] ), value a token or quoted-string.
// Exactly one is allowed, so two combined Content-Type fields ("a, b") never parse.
// Whitespace after a semicolon belongs only to the optional parameter, so no two branches can match the
// same spaces and matching stays linear (the other placement backtracks exponentially).
const tchar = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const quoted = '"(?:[\\t \\x21\\x23-\\x5b\\x5d-\\x7e\\x80-\\xff]|\\\\[\\t \\x21-\\x7e\\x80-\\xff])*"';
const mediaTypeSyntax = new RegExp(`^[\\t ]*(${tchar}/${tchar})(?:[\\t ]*;(?:[\\t ]*${tchar}=(?:${tchar}|${quoted}))?)*[\\t ]*$`);

function mediaType(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = mediaTypeSyntax.exec(header);
  const type = match?.[1].toLowerCase();
  return type !== undefined && imageTypes.has(type) ? type : undefined;
}

const inlineImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export function isInlineImage(type: string, bytes: Uint8Array): boolean {
  return inlineImageTypes.has(type) && imageTypes.get(type)!(bytes);
}

class Deadline extends Error {}

const copyList = (list: unknown) => (Array.isArray(list) ? Object.freeze([...list]) : list) as readonly string[];

/** A frozen copy of every field the proxy reads. Invalid shapes are kept as-is for validation to refuse. */
function snapshotConfig(config: RemoteImageConfig): RemoteImageConfig {
  const own = config.ownDomains;
  return Object.freeze({
    maxUrlBytes: config.maxUrlBytes,
    remoteImageRedirects: config.remoteImageRedirects,
    remoteImageBytes: config.remoteImageBytes,
    remoteImageTimeoutMs: config.remoteImageTimeoutMs,
    refusedZones: copyList(config.refusedZones),
    remoteImageInFlightBytes: config.remoteImageInFlightBytes,
    ownDomains: (own !== null && typeof own === 'object' ? Object.freeze({
      suiteDomain: own.suiteDomain,
      contentDomain: own.contentDomain,
      storageDomains: copyList(own.storageDomains),
      accountDomains: copyList(own.accountDomains),
      workersDevSubdomain: own.workersDevSubdomain,
    }) : own) as OwnDomains,
  });
}

// Rule 4: concurrent body reads in one isolate share an in-flight budget.
let inFlightBytes = 0;
const transferDeadlineMs = 60_000;
const transferDeadlines = new Map<() => void, number>();

/** Bytes currently reserved by body reads in this isolate. */
export function remoteImageInFlight(): number {
  return inFlightBytes;
}

function discard(response: Response) {
  response.body?.cancel().catch(() => {});
}

/**
 * Rules 3 to 5. Fetches with manual redirects (each `Location` re-checked by
 * the guard), sends only the fixed headers, accepts status 200 with an
 * allowlisted type whose magic bytes match, and buffers the whole body within
 * the byte limit and the total deadline. Never throws; any refusal is the
 * failure result, which the handler answers as 404 with an empty body.
 */
export function fetchRemoteImage(
  input: string, given: RemoteImageConfig, fetchImpl: FetchLike, now: () => number, lifetime: 'response',
): Promise<StreamingRemoteImage | ImageRefusal>;
export function fetchRemoteImage(input: string, given: RemoteImageConfig, fetchImpl?: FetchLike, now?: () => number): Promise<RemoteImageResult>;
export async function fetchRemoteImage(
  input: string, given: RemoteImageConfig, fetchImpl: FetchLike = fetch, now: () => number = Date.now, lifetime?: 'response',
): Promise<RemoteImageResult | StreamingRemoteImage> {
  const fail = (reason: RemoteImageFailure): RemoteImageResult => ({ ok: false, reason });
  // Validate and use a request-local copy, so changing a shared config mid-request cannot move its limits.
  let config: RemoteImageConfig;
  try {
    config = snapshotConfig(given);
  } catch {
    return fail('url');
  }
  const first = checkRemoteImageUrl(input, config);
  if (!first.ok) return fail('url');

  // Armed before the first await, so the deadline covers everything below.
  const deadline = now() + config.remoteImageTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Deadline()), config.remoteImageTimeoutMs);
  // Race every await against the deadline, so a fetchImpl or body that ignores the signal cannot hold us.
  // Each operation adds its own abort listener and removes it when it settles, so a body of many small
  // chunks keeps no per-chunk reaction alive.
  const bounded = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const signal = controller.signal;
    const onAbort = () => reject(new Deadline());
    if (signal.aborted) {
      work.catch(() => {});
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(value => {
      signal.removeEventListener('abort', onAbort);
      if (now() >= deadline) reject(new Deadline());
      else resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
  let reserved = 0;
  const reserve = (bytes: number): boolean => {
    // If a disconnected request's timer was discarded by the runtime, reclaim
    // its expired charge before admitting new work. Do not use its stream here.
    const current = Date.now();
    for (const [drop, until] of transferDeadlines) if (current >= until) drop();
    if (inFlightBytes + bytes > config.remoteImageInFlightBytes) return false;
    inFlightBytes += bytes;
    reserved += bytes;
    return true;
  };

  let response: Response | undefined;
  try {
    let url = first.url;
    for (let hop = 0; ; hop++) {
      const headers = new Headers({ accept: remoteImageAccept, 'user-agent': remoteImageUserAgent });
      const cf = { ...remoteImageCacheOptions, cacheTtlByStatus: { ...remoteImageCacheOptions.cacheTtlByStatus } };
      response = await bounded(fetchImpl(url.href, { method: 'GET', headers, redirect: 'manual', signal: controller.signal, cf }));
      if (!redirectStatuses.has(response.status)) break;
      const location = response.headers.get('location');
      discard(response);
      response = undefined;
      if (hop >= config.remoteImageRedirects || location === null || byteLength(location) > config.maxUrlBytes
        || rawAuthorityHasUserInfo(location, url)) return fail('redirect');
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return fail('redirect');
      }
      const verdict = checkRemoteImageUrl(next.href, config);
      if (!verdict.ok) return fail('redirect');
      url = verdict.url;
    }

    if (response.status !== 200) return fail('status');
    const contentType = mediaType(response.headers.get('content-type'));
    if (contentType === undefined) return fail('type');
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d{1,16}$/.test(declared) || Number(declared) > config.remoteImageBytes)) return fail('size');
    // Reserve before reading: the declared length if there is one, else the whole limit.
    if (!reserve(declared === null ? config.remoteImageBytes : Number(declared))) return fail('size');

    // One resizable buffer grows in place up to the limit, so a full-size image
    // is held once rather than as a chunk list plus a copy.
    const buffer = new ArrayBuffer(0, { maxByteLength: config.remoteImageBytes });
    let length = 0;
    if (response.body !== null) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await bounded(reader.read());
          if (done) break;
          if (!(value instanceof Uint8Array)) return fail('network');
          // The declared length is only an early refusal; the count of bytes read is what binds.
          if (length + value.byteLength > config.remoteImageBytes) return fail('size');
          // A body that outgrows its declared length must extend its reservation to the full limit.
          if (length + value.byteLength > reserved && !reserve(config.remoteImageBytes - reserved)) return fail('size');
          buffer.resize(length + value.byteLength);
          new Uint8Array(buffer, length, value.byteLength).set(value);
          length += value.byteLength;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    }
    response = undefined;

    // A fixed-length buffer for callers (Response bodies, the cache); V8 can move the backing store without copying.
    const bytes = new Uint8Array(buffer.transferToFixedLength());
    if (!imageTypes.get(contentType)!(bytes)) return fail('magic');
    const image: RemoteImage = { ok: true, contentType, bytes, length };
    if (lifetime !== 'response') return image;
    const transfer = reservedImageBody(bytes, () => { inFlightBytes -= length; });
    reserved -= length; // The transfer now owns this portion of the reservation.
    return { ...image, ...transfer };
  } catch (error) {
    return fail(error instanceof Deadline || controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
    if (response !== undefined) discard(response);
    controller.abort();
    inFlightBytes -= reserved;
    reserved = 0;
  }
}

function reservedImageBody(bytes: Uint8Array, release: () => void) {
  let offset = 0;
  let buffer: Uint8Array | undefined = bytes;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let requestSignal: AbortSignal | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drop = () => {
    if (!buffer) return;
    buffer = undefined;
    transferDeadlines.delete(drop);
    release();
  };
  const finish = () => {
    if (timer !== undefined) clearTimeout(timer);
    requestSignal?.removeEventListener('abort', abort);
    drop();
  };
  const fail = (reason: unknown) => {
    const output = controller;
    controller = undefined;
    finish();
    output?.error(reason);
  };
  const abort = () => fail(requestSignal?.reason);
  const timeout = () => fail(new DOMException('image transfer deadline exceeded', 'TimeoutError'));
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull(output) {
      if (!buffer) { timeout(); return; }
      if (offset === buffer.length) {
        output.close();
        controller = undefined;
        finish();
        return;
      }
      // A queued chunk cannot pin the complete image after the deadline.
      const chunk = buffer.slice(offset, offset + 64 * 1024);
      offset += chunk.length;
      output.enqueue(chunk);
    },
    cancel() { controller = undefined; finish(); },
  }, { highWaterMark: 0 });
  return { body, startTransfer(signal?: AbortSignal) {
    if (!buffer || timer !== undefined) return;
    requestSignal = signal;
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    transferDeadlines.set(drop, Date.now() + transferDeadlineMs);
    timer = setTimeout(timeout, transferDeadlineMs);
  } };
}

// ---- Rule 4 and section 3.1: outgoing headers, rebuilt from scratch ----

export interface ContentOrigins {
  /** `https://content.<content-domain>` */
  contentOrigin: string;
  /** `https://mail.<suite-domain>` */
  appOrigin: string;
  /** Local HTTP fixtures only; both origins must be different loopback hosts. */
  localLoopback?: boolean;
}

function bareOrigin(value: string, localLoopback: boolean): URL {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  const loopback = url?.hostname === 'localhost' || url?.hostname === '127.0.0.1';
  if (!url || url.origin !== value || (url.protocol !== 'https:' && !(localLoopback && loopback && url.protocol === 'http:'))) {
    throw new TypeError('invalid content or app origin');
  }
  return url;
}

/** The section 3.1 headers that every content-origin response carries. */
export function contentSecurityHeaders(origins: ContentOrigins): Headers {
  const content = bareOrigin(origins.contentOrigin, origins.localLoopback === true);
  const app = bareOrigin(origins.appOrigin, origins.localLoopback === true);
  if (content.protocol !== app.protocol || content.hostname === app.hostname) throw new TypeError('content and app origins must be separate');
  return new Headers({
    'content-security-policy': `default-src 'none'; img-src ${content.origin} data:; style-src 'unsafe-inline'; font-src data:; `
      + `base-uri 'none'; form-action 'none'; frame-ancestors ${app.origin}; sandbox allow-popups allow-popups-to-escape-sandbox`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  });
}

/**
 * Response headers for a fetched image: the normalised type, its length and
 * the section 3.1 headers. Nothing from the upstream response is used.
 */
export function remoteImageResponseHeaders(image: RemoteImage, origins: ContentOrigins): Headers {
  if (!imageTypes.has(image.contentType)) throw new TypeError('image type outside the allowlist');
  if (image.length !== image.bytes.byteLength) throw new TypeError('image length does not match its bytes');
  const headers = contentSecurityHeaders(origins);
  headers.set('content-type', image.contentType);
  headers.set('content-length', String(image.length));
  return headers;
}

// ---- Rule 7: logging ----

export interface RemoteImageLogLine { purpose: 'img'; status: 200 | 404; bytes: number; token: string | null }

/**
 * The only fields ever logged for a proxied image. `tokenHash` is the
 * lowercase hex SHA-256 of the token; anything else (such as the token itself)
 * logs no token prefix at all.
 */
export function remoteImageLogLine(tokenHash: string, result: RemoteImageResult): RemoteImageLogLine {
  return {
    purpose: 'img',
    status: result.ok ? 200 : 404,
    bytes: result.ok ? result.length : 0,
    token: /^[\da-f]{64}$/.test(tokenHash) ? tokenHash.slice(0, 8) : null,
  };
}

export function logRemoteImage(tokenHash: string, result: RemoteImageResult): void {
  console.log(JSON.stringify(remoteImageLogLine(tokenHash, result)));
}
