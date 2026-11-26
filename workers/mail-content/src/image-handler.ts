import { fetchRemoteImage, remoteImageResponseHeaders, type ContentOrigins, type RemoteImageConfig } from './proxy.ts';

/** Called only with the URL from a verified img token. Version 1 does not cache upstream images. */
export async function serveImage(url: string, origins: ContentOrigins, config: RemoteImageConfig,
    signal: AbortSignal): Promise<{ response: Response; bytes: number } | null> {
  const result = await fetchRemoteImage(url, config, fetch, Date.now, 'response');
  if (!result.ok) return null;
  try {
    const headers = remoteImageResponseHeaders(result, origins);
    // Preserve the known Content-Length. The response deadline does not depend on pipe cancellation.
    const body = new FixedLengthStream(result.length);
    const response = new Response(body.readable, { headers });
    result.startTransfer(signal);
    void result.body.pipeTo(body.writable).catch(() => {});
    return { response, bytes: result.length };
  } catch (error) {
    void result.body.cancel().catch(() => {});
    throw error;
  }
}
