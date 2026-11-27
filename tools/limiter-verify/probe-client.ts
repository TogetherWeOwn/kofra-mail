import { failures, isEntryPoint, isRecord, report, targetOrigin, type Verdict } from './cli.ts';
import { EXPECTED_BUCKETS, bucketNames, refusalBand } from './expected-buckets.ts';
import { PROBE_PATH, PROBE_SECRET_HEADER } from './probe-protocol.ts';

export async function checkProbe(baseUrl: string | undefined, secret: string | undefined, request = fetch): Promise<Verdict[]> {
  const origin = targetOrigin(baseUrl);
  if (!origin || !secret) return failures();

  const verdicts: Verdict[] = [];
  for (const bucket of bucketNames) {
    let pass = false;
    try {
      const { limit, period } = EXPECTED_BUCKETS[bucket];
      const url = new URL(PROBE_PATH, origin);
      url.searchParams.set('bucket', bucket);
      const response = await request(url, {
        method: 'POST', headers: { [PROBE_SECRET_HEADER]: secret }, redirect: 'manual',
        signal: AbortSignal.timeout(period * 1000),
      });
      if (response.status === 200) {
        const result: unknown = await response.json();
        const { min, max } = refusalBand(limit);
        pass = isRecord(result) && result.refused === true && typeof result.allowed === 'number'
          && result.allowed >= min && result.allowed <= max;
      } else await response.body?.cancel();
    } catch {
      // A failed request is a verdict, not a reason to print upstream details.
    }
    verdicts.push({ bucket, pass });
  }
  return verdicts;
}

if (isEntryPoint(import.meta)) {
  const args = process.argv.slice(2);
  report(args.length === 1 ? await checkProbe(args[0], process.env.R2_PROBE_SECRET) : failures());
}
