// Test-only Worker: runs the proxy guard and fetch inside workerd, so URL
// parsing and the manual-redirect fetch are the runtime's own. The incoming
// request deliberately carries cookies and forwarding headers; none may reach
// the upstream.
import { checkRemoteImageUrl, fetchRemoteImage } from '../src/proxy.ts';
import { config } from './proxy-fixtures.ts';

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/guard') {
      const { urls } = await request.json<{ urls: string[] }>();
      return Response.json(urls.map(url => {
        const verdict = checkRemoteImageUrl(url, config);
        return verdict.ok ? verdict.url.href : null;
      }));
    }
    const { url } = await request.json<{ url: string }>();
    const result = await fetchRemoteImage(url, config, (input, init) => fetch(input, init), Date.now);
    return Response.json(result.ok
      ? { ok: true, contentType: result.contentType, length: result.length, first: Array.from(result.bytes.slice(0, 8)) }
      : { ok: false, reason: result.reason });
  },
};
