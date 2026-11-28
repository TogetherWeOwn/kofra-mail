// Usage: node tools/link-storage-check/cli.ts
// Reads LINK_LOCATIONS, LINK_READ_CREDENTIALS and LINK_WRITE_CREDENTIALS (and, optionally,
// CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and LINK_WORKERS) from its environment only.
// Prints one JSON line per location and Worker; exits 1 if any check fails.
import { deployCheck } from './check.ts';

const { ok, lines } = await deployCheck(process.env);
for (const line of lines) console.log(JSON.stringify(line));
process.exitCode = ok ? 0 : 1;
