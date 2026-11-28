# Link storage

Where file links (outbound plan, M3-13 and M3-15) keep their files: any S3-compatible bucket. There is no built-in provider. This package holds the location rules, the save-time and deploy-time check, the credential sealing and the directory rows (migration `0010_link_storage.sql` in `workers/mail-backend`).

## Deployment config

- `LINK_LOCATIONS` (plain variable): `{ "current": "<id>", "locations": { "<id>": { "endpoint": "https://…", "region": "…", "bucket": "…", "prefix": "", "pathStyle": true } } }`. An id is stable: a changed location is a new id, and the old id stays until its links are gone. Each id's fingerprint is recorded in D1 on first use (`ensureDeploymentFingerprint`), and a later use with other fields is refused.
- `LINK_READ_CREDENTIALS` and `LINK_WRITE_CREDENTIALS` (secrets): `{ "<id>": { "accessKeyId": "…", "secretAccessKey": "…" } }`, a read-only and a read-write key per location.
- `LINK_CRED_KEK` (secret): `{ "current": "<version>", "keys": { "<version>": "<base64 of 32 bytes>" } }`, versions 1 to 255. Generate each key with `openssl rand -base64 32` and pipe the JSON to `wrangler secret put` through stdin, never in argv. Keep an escrow copy. It seals workspace override credentials.
- `LINK_REFUSED_ZONES` (mail-web, plain variable): a JSON array of the deployment's own zones (suite, content, link, storage and account domains). Overrides may not point at them. Without it, overrides cannot be saved.

Which Worker binds which secret (`LINK_SECRET_BINDINGS`):

| Worker | Link secrets |
|---|---|
| mail-content | `LINK_READ_CREDENTIALS` only |
| mail-web | `LINK_WRITE_CREDENTIALS`, `LINK_CRED_KEK` |
| mail-backend (sweeper, content lookup) | `LINK_WRITE_CREDENTIALS`, `LINK_CRED_KEK` |

mail-content gets a workspace override's read-only key from the backend's `ContentLookup.linkReadCredential`, which opens only the read column.

## Checks

- **Endpoint rules:** `https:` on port 443, a DNS name (no IP literal), no user information, path, query or fragment, and outside `localhost`, `local`, `internal`, `arpa`, `workers.dev` and the configured zones, with all their subdomains. Requests use `redirect: 'manual'`, and any 3xx is an error.
- **The check** (`checkLinkLocation`): HeadBucket; a 1-byte probe put, get (with the read key) and delete; an anonymous GET and an anonymous list of the probe, which must answer 401 or 403; a probe multipart upload (create, part, ListParts, complete, delete); and a second one that is aborted. It answers one fixed reason: `endpoint`, `redirect`, `public_bucket`, `auth`, `bucket`, `multipart` or `network`.
- **Deploy time:** `node tools/link-storage-check/cli.ts` runs the check on every deployment location from its own environment and, with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, compares each Worker's secret names with the table above (`LINK_WORKERS` overrides the Worker names). It prints ids, names and codes only.

## Workspace overrides

An admin adds the workspace's own location through `createLinkLocation` (contract section 8.7). Its fields never change; its keys rotate in place after passing the check. Both keys are sealed with AES-256-GCM under the current KEK version. The AAD is (workspace, location, key version, role), so a value copied to another row or column fails to open.

**Deleting** first sets the row to `deleting`, then asks `LinkLocationUsage.inUse`, and deletes only if nothing uses the location; otherwise it sets the row back. Every writer of a reference to a location (links, pending deletes, draft attachments, unfinished uploads) must require `state = 'active'` in the same statement. M3-13 and M3-15b provide the usage port; until then deletes answer `feature_unavailable`.

## Rotating the KEK

1. Add a new version to `LINK_CRED_KEK` and switch `current` to it.
2. Deploy. Credentials are rewrapped under the new version on their next use.
3. Run `MailAdmin.rewrapLinkCredentials(100)` until it rewraps none.
4. Remove the old version only when `MailAdmin.linkCredentialKeyVersions()` no longer lists it.
