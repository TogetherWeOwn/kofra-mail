// Usage: node tools/link-storage-check/cli.ts
// Reads LINK_LOCATIONS, LINK_READ_CREDENTIALS and LINK_WRITE_CREDENTIALS (and, optionally,
// CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, LINK_WORKERS, and LINK_HOST with LINK_HOSTS,
// MAIL_APP_ORIGIN, CONTENT_ORIGIN and LINK_HOST_ALLOW_SHARED_DOMAIN) from its environment, and
// vars.LINK_HOST from workers/mail-backend/wrangler.jsonc (LINK_BACKEND_CONFIG overrides the path).
// Prints one JSON line per location and Worker; exits 1 if any check fails.
import { readFileSync } from 'node:fs';
import { configuredLinkHost, deployCheck } from './check.ts';

// mail-backend's deployed LINK_HOST: the environment may leave it out, but may not contradict it.
const backendConfig = process.env.LINK_BACKEND_CONFIG ?? new URL('../../workers/mail-backend/wrangler.jsonc', import.meta.url).pathname;
let configHost: string | undefined;
try { configHost = configuredLinkHost(readFileSync(backendConfig, 'utf8')); }
catch {
  console.log(JSON.stringify({ config: 'invalid' }));
  process.exit(1);
}
const { ok, lines } = await deployCheck(process.env, undefined, configHost);
for (const line of lines) console.log(JSON.stringify(line));
// The operator's override of the separate link domain is a standing risk: say so at every deploy.
if (lines.some(line => 'linkHost' in line && line.result === 'shared_domain_allowed')) {
  console.warn('LINK_HOST shares a registrable domain with the mail app or content origin (LINK_HOST_ALLOW_SHARED_DOMAIN=1): '
    + 'a Safe Browsing flag on one file link can block reading mail. Move links to a domain of their own.');
}
process.exitCode = ok ? 0 : 1;
