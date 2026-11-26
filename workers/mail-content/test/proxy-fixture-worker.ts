// Test-only Worker: runs the proxy guard and fetch inside workerd, so URL
// parsing and the manual-redirect fetch are the runtime's own. The incoming
// request deliberately carries cookies and forwarding headers; none may reach
// the upstream. `/image` answers the way the `img` handler will: the rebuilt
// headers and bytes, or 404 with an empty body, plus the rule 7 log line.
import { checkRemoteImageUrl, fetchRemoteImage, logRemoteImage, remoteImageInFlight, remoteImageResponseHeaders } from '../src/proxy.ts';
import { config, origins } from './proxy-fixtures.ts';

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/inflight') return Response.json(remoteImageInFlight());
    if (path === '/guard') {
      const { urls } = await request.json<{ urls: string[] }>();
      return Response.json(urls.map(url => {
        const verdict = checkRemoteImageUrl(url, config);
        return verdict.ok ? verdict.url.href : null;
      }));
    }
    const { url, timeoutMs, inFlightBytes, tokenHash } = await request.json<{
      url: string; timeoutMs?: number; inFlightBytes?: number; tokenHash?: string;
    }>();
    const effective = {
      ...config,
      ...(timeoutMs === undefined ? {} : { remoteImageTimeoutMs: timeoutMs }),
      ...(inFlightBytes === undefined ? {} : { remoteImageInFlightBytes: inFlightBytes }),
    };
    const result = await fetchRemoteImage(url, effective, (input, init) => fetch(input, init), Date.now);
    logRemoteImage(tokenHash ?? '', result);
    if (path === '/image') {
      return result.ok
        ? new Response(result.bytes, { headers: remoteImageResponseHeaders(result, origins) })
        : new Response(null, { status: 404 });
    }
    return Response.json(result.ok
      ? { ok: true, contentType: result.contentType, length: result.length, first: Array.from(result.bytes.slice(0, 8)) }
      : { ok: false, reason: result.reason });
  },
};
