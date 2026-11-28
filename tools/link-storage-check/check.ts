// The deploy-time check of the deployment's link storage (docs/m3-outbound-plan.md, M3-15a).
// It reads the config and both credential secrets from its own environment, runs the
// same check as the save-time check on every location, and, given Cloudflare API
// access, confirms that each Worker binds only the link secrets it needs. It prints
// location ids, Worker and secret names and fixed codes only: never a secret value.
import {
  checkLinkLocation, credentialSecret, deploymentLocations, linkSecretViolations, refusedZones,
  type Fetcher, type LinkWorkerRole,
} from '../../packages/link-storage/src/index.ts';

export type CheckLine =
  | { location: string; result: 'ok' | 'missing_credentials' | string }
  | { worker: string; result: 'ok' | 'forbidden_secrets' | 'unavailable'; names?: string[] }
  | { config: 'invalid' };

const API = 'https://api.cloudflare.com/client/v4';
const ID = /^[a-z0-9_-]{1,64}$/i;
const DEFAULT_WORKERS: Record<LinkWorkerRole, string> = { content: 'mail-content', web: 'kofra-mail-web', backend: 'mail-backend' };

async function secretNames(env: Record<string, string | undefined>, script: string, request: Fetcher): Promise<string[] | undefined> {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = env;
  if (!account || !ID.test(account) || !token?.trim() || !ID.test(script)) return undefined;
  try {
    const response = await request(new Request(`${API}/accounts/${account}/workers/scripts/${script}/secrets`, {
      headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
    }));
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    const body = await response.json() as { success?: unknown; result?: unknown };
    if (body.success !== true || !Array.isArray(body.result)) return undefined;
    return body.result.map(entry => (entry as { name?: unknown }).name).filter((name): name is string => typeof name === 'string');
  } catch {
    return undefined;
  }
}

/** Runs the check; `ok` is false if any location or Worker fails. */
export async function deployCheck(env: Record<string, string | undefined>, request: Fetcher = r => fetch(r)): Promise<{ ok: boolean; lines: CheckLine[] }> {
  const locations = deploymentLocations(env.LINK_LOCATIONS);
  const read = credentialSecret(env.LINK_READ_CREDENTIALS);
  const write = credentialSecret(env.LINK_WRITE_CREDENTIALS);
  if (!locations || !read || !write) return { ok: false, lines: [{ config: 'invalid' }] };
  const lines: CheckLine[] = [];
  const zones = refusedZones([]);
  for (const [id, fields] of locations.locations) {
    const readKey = read.get(id);
    const writeKey = write.get(id);
    if (!readKey || !writeKey) { lines.push({ location: id, result: 'missing_credentials' }); continue; }
    const verdict = await checkLinkLocation(fields, { read: readKey, write: writeKey }, zones, { fetch: request });
    lines.push({ location: id, result: verdict.ok ? 'ok' : verdict.reason });
  }
  if (env.CLOUDFLARE_API_TOKEN) {
    let workers = DEFAULT_WORKERS;
    try { if (env.LINK_WORKERS) workers = { ...DEFAULT_WORKERS, ...JSON.parse(env.LINK_WORKERS) }; } catch { return { ok: false, lines: [...lines, { config: 'invalid' }] }; }
    for (const role of Object.keys(DEFAULT_WORKERS) as LinkWorkerRole[]) {
      const names = await secretNames(env, workers[role], request);
      if (!names) { lines.push({ worker: workers[role], result: 'unavailable' }); continue; }
      const extra = linkSecretViolations(role, names);
      lines.push(extra.length ? { worker: workers[role], result: 'forbidden_secrets', names: extra } : { worker: workers[role], result: 'ok' });
    }
  }
  return { ok: lines.every(line => 'result' in line && line.result === 'ok'), lines };
}

