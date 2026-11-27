import { failures, isEntryPoint, isRecord, report, targetOrigin, type Verdict } from './cli.ts';
import { EXPECTED_BUCKETS, bucketNames, refusalBand } from './expected-buckets.ts';
import { PROBE_PATH, PROBE_SECRET_HEADER } from './probe-protocol.ts';

type Outcome = 'pass' | 'late' | 'fail';
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The probe confirms that each binding is wired and enforcing: at least one
// call allowed, then a refusal by 150% of the limit. No allowance, a later
// refusal or none can come from a counter window boundary or a saturated
// window, so it gets one retry with a fresh key after a full period.
export async function checkProbe(baseUrl: string | undefined, secret: string | undefined, request = fetch,
  sleep = wait): Promise<Verdict[]> {
  const origin = targetOrigin(baseUrl);
  if (!origin || !secret) return failures();

  const verdicts: Verdict[] = [];
  for (const bucket of bucketNames) {
    const { limit, period } = EXPECTED_BUCKETS[bucket];
    const { min, max } = refusalBand(limit);
    const attempt = async (): Promise<Outcome> => {
      try {
        const url = new URL(PROBE_PATH, origin);
        url.searchParams.set('bucket', bucket);
        const response = await request(url, {
          method: 'POST', headers: { [PROBE_SECRET_HEADER]: secret }, redirect: 'manual',
          signal: AbortSignal.timeout(period * 1000),
        });
        if (response.status !== 200) { await response.body?.cancel(); return 'fail'; }
        const result: unknown = await response.json();
        if (!isRecord(result) || !Number.isInteger(result.allowed) || (result.allowed as number) < 0 || typeof result.refused !== 'boolean') return 'fail';
        const allowed = result.allowed as number;
        if (!result.refused || allowed > max) return 'late';
        return allowed < min ? 'late' : 'pass';
      } catch {
        // A failed request is a verdict, not a reason to print upstream details.
        return 'fail';
      }
    };
    let outcome = await attempt();
    if (outcome === 'late') {
      // A failed wait is this bucket's failure, never a reason to drop the others.
      try {
        await sleep((period + 1) * 1000);
        outcome = await attempt();
      } catch {
        outcome = 'fail';
      }
    }
    verdicts.push({ bucket, pass: outcome === 'pass' });
  }
  return verdicts;
}

if (isEntryPoint(import.meta)) {
  const args = process.argv.slice(2);
  report(args.length === 1 ? await checkProbe(args[0], process.env.R2_PROBE_SECRET) : failures());
}
