import { failures, isEntryPoint, isRecord, report, type Verdict } from './cli.ts';
import { EXPECTED_BUCKETS, bucketNames } from './expected-buckets.ts';

type Environment = { CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_API_TOKEN?: string };
const pathSegment = /^[a-z0-9_-]+$/i;

export async function checkConfig(script: string | undefined, env: Environment, request = fetch): Promise<Verdict[]> {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = env;
  if (!script || !pathSegment.test(script) || !account || !pathSegment.test(account) || !token) return failures();

  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}/settings`;
    const response = await request(url, {
      headers: { authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failures();
    }
    const envelope: unknown = await response.json();
    if (!isRecord(envelope) || envelope.success !== true || !isRecord(envelope.result)
      || !Array.isArray(envelope.result.bindings)) return failures();

    const bindings = (envelope.result.bindings as unknown[]).filter(isRecord);
    const rateBindings = bindings.filter(({ type }) => type === 'ratelimit');
    return bucketNames.map((bucket) => {
      const { binding, limit, period } = EXPECTED_BUCKETS[bucket];
      const matches = bindings.filter(({ name }) => name === binding);
      const [match] = matches;
      const pass = matches.length === 1 && match.type === 'ratelimit'
        && typeof match.namespace_id === 'string' && /^[0-9]+$/.test(match.namespace_id)
        && rateBindings.filter(({ namespace_id }) => namespace_id === match.namespace_id).length === 1
        && isRecord(match.simple) && match.simple.limit === limit && match.simple.period === period;
      return { bucket, pass };
    });
  } catch {
    return failures();
  }
}

if (isEntryPoint(import.meta)) {
  const args = process.argv.slice(2);
  report(args.length === 1 ? await checkConfig(args[0], process.env) : failures());
}
