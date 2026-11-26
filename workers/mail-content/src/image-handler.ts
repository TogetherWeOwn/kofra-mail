import { sha256 } from '../../mail-backend/src/bytes.ts';
import { fetchRemoteImage, remoteImageResponseHeaders, type ContentOrigins, type RemoteImageConfig } from './proxy.ts';

export type ImageCache = Pick<Cache, 'match' | 'put'>;
const cacheSeconds = 86_400;
const encoder = new TextEncoder();

/** Called only with the URL from a verified img token. Cache entries are never signed responses. */
export async function serveImage(url: string, origins: ContentOrigins, config: RemoteImageConfig,
    openCache: () => Promise<ImageCache>): Promise<{ response: Response; bytes: number } | null> {
  const key = new Request(`${origins.contentOrigin}/__image_cache/v1/${await sha256(new Uint8Array(encoder.encode(url)))}`);
  let cache: ImageCache | undefined;
  let cached = false;
  let first = true;
  const result = await fetchRemoteImage(url, config, async (target, init) => {
    // Only the first hop uses the exact original URL's cache entry. The proxy still
    // runs its URL checks before this callback, and checks cached bytes and type.
    if (first) {
      first = false;
      try {
        cache = await openCache();
        const hit = await cache.match(key);
        if (hit) { cached = true; return hit; }
      } catch { /* Cache failure does not prevent an upstream fetch. */ }
    }
    return fetch(target, init);
  }, Date.now, 'response');
  if (!result.ok) return null;
  try {
    if (cache && !cached) {
      // Finish cache population under the same reservation. No tee or outstanding
      // cache write can keep unbudgeted image bytes after the HTTP stream closes.
      try {
        await cache.put(key, new Response(result.bytes, { headers: {
          'content-type': result.contentType, 'cache-control': `public, max-age=${cacheSeconds}`,
        } }));
      } catch { /* The cache is optional. */ }
    }
    const headers = remoteImageResponseHeaders(result, origins);
    // Preserve the known Content-Length in workerd while backpressuring the
    // reserved image body; cancellation propagates to that stream.
    const body = new FixedLengthStream(result.length);
    void result.body.pipeTo(body.writable).catch(() => {});
    return { response: new Response(body.readable, { headers }), bytes: result.length };
  } catch (error) {
    void result.body.cancel().catch(() => {});
    throw error;
  }
}
