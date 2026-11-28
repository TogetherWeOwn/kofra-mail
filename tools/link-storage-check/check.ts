// The deploy-time check of the deployment's link storage (docs/m3-outbound-plan.md, M3-15a).
// It reads the config and both credential secrets from its own environment, runs the
// same check as the save-time check on every location, and, given Cloudflare API
// access, confirms that each Worker binds only the link secrets it needs. It prints
// location ids, Worker and secret names and fixed codes only: never a secret value.
import {
  checkLinkLocation, credentialSecret, deploymentLocations, linkSecretViolations, refusedZones,
  type Fetcher, type LinkWorkerRole,
} from '../../packages/link-storage/src/index.ts';
import ts from 'typescript';
import { separateOrigins } from '../../workers/mail-content/src/origins.ts';

export type CheckLine =
  | { location: string; result: 'ok' | 'missing_credentials' | string }
  | { worker: string; result: 'ok' | 'forbidden_secrets' | 'unavailable'; names?: string[] }
  | { linkHost: string; result: 'ok' | 'invalid' | 'not_first' | 'mismatch' | 'shared_domain' | 'shared_domain_allowed' }
  | { config: 'invalid' };

const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const dnsName = (value: string) => value.length <= 253 && value.split('.').length >= 2 && value.split('.').every(part => label.test(part));
// The registrable domain, approximated by the last two labels. With a multi-label
// public suffix (such as co.uk) this over-matches, which refuses more, never less.
const registrable = (host: string) => host.split('.').slice(-2).join('.');

/**
 * The link host (docs/m3-outbound-plan.md, M3-13). A deploy is link-enabled when
 * LINK_HOST is set; it then needs LINK_HOSTS (mail-content's served hosts, every
 * entry valid, LINK_HOST first) and valid https MAIL_APP_ORIGIN and CONTENT_ORIGIN,
 * and fails closed without them. The current LINK_HOST must be a registrable domain
 * separate from both origins, so a Safe Browsing flag on one link cannot block
 * reading mail; older hosts still listed in LINK_HOSTS keep serving their links
 * and are not held to it. A shared domain is refused unless
 * LINK_HOST_ALLOW_SHARED_DOMAIN=1, which passes with `shared_domain_allowed` so the
 * risk is printed at every deploy. Without LINK_HOST, a LINK_HOSTS list (old hosts
 * still served) must still be valid.
 */
export function linkHostCheck(env: Record<string, string | undefined>): CheckLine | undefined {
  const host = env.LINK_HOST;
  const listed = env.LINK_HOSTS;
  if (host === undefined && listed === undefined) return undefined;
  let hosts: string[] | undefined;
  if (listed !== undefined) {
    // mail-content serves no link host at all if any entry is invalid, so every entry is checked.
    hosts = listed.toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (!hosts.length || !hosts.every(entry => /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(entry))) {
      return { linkHost: 'LINK_HOSTS', result: 'invalid' };
    }
  }
  if (host === undefined) return { linkHost: 'LINK_HOSTS', result: 'ok' };
  if (!dnsName(host)) return { linkHost: 'LINK_HOST', result: 'invalid' };
  if (!hosts) return { linkHost: 'LINK_HOSTS', result: 'invalid' };
  if (hosts[0] !== host) return { linkHost: host, result: 'not_first' };
  // mail-content's own rule: canonical https origins (no path, no trailing slash) on separate hosts.
  let origins: string[];
  try {
    const { content, app } = separateOrigins({ contentOrigin: env.CONTENT_ORIGIN ?? '', appOrigin: env.MAIL_APP_ORIGIN ?? '' });
    origins = [app.hostname, content.hostname];
  } catch {
    return { linkHost: 'origins', result: 'invalid' };
  }
  if (!origins.every(dnsName)) return { linkHost: 'origins', result: 'invalid' };
  if (!origins.some(other => registrable(other) === registrable(host))) return { linkHost: host, result: 'ok' };
  return { linkHost: host, result: env.LINK_HOST_ALLOW_SHARED_DOMAIN === '1' ? 'shared_domain_allowed' : 'shared_domain' };
}

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
/**
 * `vars.LINK_HOST` of a Wrangler config (JSONC), as mail-backend deploys it; undefined if absent.
 * Throws if the file cannot be parsed.
 */
export function configuredLinkHost(jsonc: string): string | undefined {
  const { config, error } = ts.parseConfigFileTextToJson('wrangler.jsonc', jsonc);
  if (error || !config || typeof config !== 'object') throw new Error('Invalid Wrangler config');
  const host = (config as { vars?: Record<string, unknown> }).vars?.LINK_HOST;
  if (host !== undefined && typeof host !== 'string') throw new Error('Invalid Wrangler config');
  return host;
}

/**
 * Runs the check. `configHost` is mail-backend's deployed `vars.LINK_HOST`: it is
 * used when the environment has no LINK_HOST, and a different LINK_HOST in the
 * environment fails the check (`mismatch`). `ok` is false if anything fails.
 */
export async function deployCheck(env: Record<string, string | undefined>, request: Fetcher = r => fetch(r), configHost?: string):
  Promise<{ ok: boolean; lines: CheckLine[] }> {
  if (configHost !== undefined && env.LINK_HOST !== undefined && env.LINK_HOST !== configHost) {
    return { ok: false, lines: [{ linkHost: 'LINK_HOST', result: 'mismatch' }] };
  }
  if (configHost !== undefined && env.LINK_HOST === undefined) env = { ...env, LINK_HOST: configHost };
  const locations = deploymentLocations(env.LINK_LOCATIONS);
  const read = credentialSecret(env.LINK_READ_CREDENTIALS);
  const write = credentialSecret(env.LINK_WRITE_CREDENTIALS);
  const host = linkHostCheck(env);
  if (!locations || !read || !write) return { ok: false, lines: [{ config: 'invalid' }, ...host ? [host] : []] };
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
  if (host) lines.push(host);
  return { ok: lines.every(line => 'result' in line && (line.result === 'ok' || line.result === 'shared_domain_allowed')), lines };
}

