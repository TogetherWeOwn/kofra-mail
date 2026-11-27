import { createHash, timingSafeEqual } from 'node:crypto';
import { EXPECTED_BUCKETS, isBucket } from './expected-buckets.ts';
import { PROBE_PATH, PROBE_SECRET_HEADER } from './probe-protocol.ts';

type BindingName = (typeof EXPECTED_BUCKETS)[keyof typeof EXPECTED_BUCKETS]['binding'];
type Limiter = { limit(input: { key: string }): Promise<{ success: boolean }> };
type ProbeEnvironment = Partial<Record<BindingName, Limiter>> & { R2_PROBE_SECRET?: string };

const digest = (value: string) => createHash('sha256').update(value).digest();
const empty = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

export default {
  async fetch(request: Request, env: ProbeEnvironment): Promise<Response> {
    const expected = env.R2_PROBE_SECRET;
    const supplied = request.headers.get(PROBE_SECRET_HEADER);
    const url = new URL(request.url);
    const bucket = url.searchParams.get('bucket') ?? '';
    if (!expected || !supplied || !timingSafeEqual(digest(expected), digest(supplied))
      || request.method !== 'POST' || url.pathname !== PROBE_PATH
      || !isBucket(bucket) || url.searchParams.getAll('bucket').length !== 1) return empty(404);

    try {
      const { binding, limit } = EXPECTED_BUCKETS[bucket];
      const limiter = env[binding];
      if (!limiter || typeof limiter.limit !== 'function') return empty(503);
      const key = `r2-probe:${crypto.randomUUID()}`;
      let allowed = 0;
      let refused = false;
      for (let i = 0; i <= limit; i++) {
        const { success } = await limiter.limit({ key });
        if (success === false) { refused = true; break; }
        if (success !== true) return empty(503);
        allowed++;
      }
      return Response.json({ allowed, refused }, { headers: { 'cache-control': 'no-store' } });
    } catch {
      return empty(503);
    }
  },
};
