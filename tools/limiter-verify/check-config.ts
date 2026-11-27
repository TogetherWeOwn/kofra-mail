import { writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failures, isEntryPoint, isRecord, report, type Verdict } from './cli.ts';
import { EXPECTED_BUCKETS, bucketNames } from './expected-buckets.ts';

type Environment = { CLOUDFLARE_ACCOUNT_ID?: string; CLOUDFLARE_API_TOKEN?: string };
type Options = { probeConfigPath?: string };
type ProbeRateBinding = { name: string; namespace_id: string; simple: { limit: number; period: number } };
const pathSegment = /^[a-z0-9_-]+$/i;

async function writeProbeConfig(path: string, name: string, ratelimits: ProbeRateBinding[]): Promise<void> {
  const config = {
    name,
    main: relative(dirname(resolve(path)), fileURLToPath(new URL('./probe-worker.ts', import.meta.url))),
    compatibility_date: '2026-11-22',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    preview_urls: false,
    ratelimits,
  };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

export async function checkConfig(script: string | undefined, env: Environment, request = fetch,
  { probeConfigPath }: Options = {}): Promise<Verdict[]> {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = env;
  if (!script || !pathSegment.test(script) || !account || !pathSegment.test(account) || !token) return failures();
  const probeName = `${script}-r2-probe`;
  if (probeConfigPath !== undefined && (!probeConfigPath || probeName.length > 63)) return failures();

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
    const verified: ProbeRateBinding[] = [];
    const verdicts = bucketNames.map((bucket) => {
      const { binding, limit, period } = EXPECTED_BUCKETS[bucket];
      const matches = bindings.filter(({ name }) => name === binding);
      if (matches.length !== 1) return { bucket, pass: false };
      const { namespace_id, simple, type } = matches[0];
      if (type !== 'ratelimit' || typeof namespace_id !== 'string' || !/^[0-9]+$/.test(namespace_id)
        || rateBindings.filter((candidate) => candidate.namespace_id === namespace_id).length !== 1
        || !isRecord(simple) || simple.limit !== limit || simple.period !== period) return { bucket, pass: false };
      verified.push({ name: binding, namespace_id, simple: { limit, period } });
      return { bucket, pass: true };
    });
    if (probeConfigPath && verified.length === bucketNames.length) await writeProbeConfig(probeConfigPath, probeName, verified);
    return verdicts;
  } catch {
    return failures();
  }
}

if (isEntryPoint(import.meta)) {
  const args = process.argv.slice(2);
  const generate = args.length === 3 && args[1] === '--write-probe-config';
  report(args.length === 1 || generate
    ? await checkConfig(args[0], process.env, fetch, { probeConfigPath: generate ? args[2] : undefined })
    : failures());
}
