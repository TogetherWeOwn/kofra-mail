// Shared fixtures for the remote-image proxy tests. Every name is a reserved
// example name; no test reaches the real network.
import { remoteImageConfig, type FetchLike, type RemoteImageConfig } from '../src/proxy.ts';

export const ownDomains = {
  suiteDomain: 'suite.example',
  contentDomain: 'content-zone.example',
  storageDomains: ['storage.example', 'r2.storage-two.example'],
  accountDomains: ['account.example'],
  workersDevSubdomain: 'example-acct.workers.dev',
};

export const config: RemoteImageConfig = remoteImageConfig(ownDomains);

export const origins = {
  contentOrigin: 'https://content.content-zone.example',
  appOrigin: 'https://mail.suite.example',
};

const ascii = (text: string) => Array.from(text, c => c.charCodeAt(0));
const pad = (head: number[], size = 64) => {
  const out = new Uint8Array(Math.max(size, head.length));
  out.set(head);
  return out;
};

export const images: Record<string, Uint8Array> = {
  'image/png': pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR')]),
  'image/jpeg': pad([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...ascii('JFIF')]),
  'image/gif': pad(ascii('GIF89a')),
  'image/webp': pad([...ascii('RIFF'), 56, 0, 0, 0, ...ascii('WEBPVP8 ')]),
  'image/avif': pad([0, 0, 0, 28, ...ascii('ftyp'), ...ascii('avif'), 0, 0, 0, 0, ...ascii('avifmif1miaf')]),
  'image/bmp': pad([...ascii('BM'), 64, 0, 0, 0]),
  'image/x-icon': pad([0, 0, 1, 0, 1, 0, 16, 16]),
};

export const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
export const html = new TextEncoder().encode('<!doctype html><html><body><script>alert(1)</script></body></html>');

export interface Recorded {
  url: string; method?: string; redirect?: string; cache?: string; cf?: unknown; hasSignal: boolean; headers: [string, string][];
}
type Route = (signal: AbortSignal | undefined) => Response | Promise<Response>;

/** A local upstream: a fetch stub that records every request and flags unknown URLs. */
export function upstream(routes: Record<string, Route>) {
  const calls: Recorded[] = [];
  const unexpected: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url, method: init.method, redirect: init.redirect, cache: init.cache, cf: (init as { cf?: unknown }).cf,
      hasSignal: init.signal instanceof AbortSignal,
      headers: [...new Headers(init.headers)],
    });
    const route = routes[url];
    if (!route) {
      unexpected.push(url);
      throw new TypeError('unexpected fetch');
    }
    return route(init.signal ?? undefined);
  };
  return { fetchImpl, calls, unexpected };
}

export const image = (type: string, body: BodyInit | null, headers: Record<string, string> = {}, status = 200) =>
  () => new Response(body, { status, headers: { 'content-type': type, ...headers } });
export const redirect = (location: string | null, status = 302) =>
  () => new Response(null, { status, headers: location === null ? {} : { location } });

/** A body stream that yields `chunk`-sized pieces forever and records cancellation. */
export function endless(chunk = 64 * 1024) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled += chunk;
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state };
}
