# Mail limiter verification (R2)

Run from the repository root with Node.js 24. The clients print only `bucket PASS` or `bucket FAIL` and exit 1 if any selected bucket fails. Save those lines as the environment's receipt. **Running any of these checks against production requires the owner's approval.** No tool enables a flag or deploys a Worker.

## Step 1: both outbound flags off

1. Put `CLOUDFLARE_ACCOUNT_ID` and a Workers-settings read token in `CLOUDFLARE_API_TOKEN` in the process environment. Set `PROBE_CONFIG_PATH` to a new private JSON file path outside the checkout, then run:

   ```sh
   node tools/limiter-verify/check-config.ts MAIL_WEB_SCRIPT_NAME --write-probe-config "$PROBE_CONFIG_PATH"
   ```

   The check verifies binding names, distinct namespaces, limits and periods. Only if all buckets pass does it create a private configuration file (mode `0600`) with the checked account and the namespace IDs from the same settings response. It never prints those IDs or overwrites a file. Omit `--write-probe-config` and its path to run the configuration check alone.
2. Manually deploy the temporary probe Worker **only from that generated config**. Do not override the account, copy or hand-edit the rate limit bindings, commit the file, or attach mail data bindings. The generated name normally ends in `-r2-probe`; long or normalized names use a shortened name and hash suffix. Set the Worker secret `R2_PROBE_SECRET`, and load that same value into the client process environment:

   ```sh
   node tools/limiter-verify/probe-client.ts https://probe.example
   ```

   The client sends the secret in `x-r2-probe-secret`. Each request exercises one binding with a fresh `r2-probe:` key. The settings check verifies the period; the direct and HTTP bursts check only that each bucket admits and then refuses by 150% of its limit; the exact limit and the period are proved by the configuration check. Remove the temporary Worker and its private config after the check.

## Step 2: relevant flag on, before user traffic

The current gateway accepts only loopback requests with a development session provider. Use a local fixture until a deployed gateway exposes the API to the operator; turning on a feature flag alone does not expose it. This tooling does not add that gateway. Use a dedicated operator account with a provisioned mailbox and a clean limiter window. The admin check needs a workspace admin session reauthenticated within the contract's 10-minute window and a clean workspace counter. Load the full Cookie header value into `R2_MAIL_COOKIE` and the session's CSRF value into `R2_MAIL_CSRF`. The base URL must be an HTTPS origin (plain HTTP is accepted only on loopback for local fixtures). Run only buckets whose routes are enabled:

```sh
# Base API buckets (also the default if no buckets are listed)
node tools/limiter-verify/http-check.ts https://mail.example reads writes admin_writes
# When MAIL_DRAFT_UPLOADS_ENABLED is on
node tools/limiter-verify/http-check.ts https://mail.example uploads
# When MAIL_SEND_ENABLED is on
node tools/limiter-verify/http-check.ts https://mail.example sends undo
node tools/limiter-verify/http-check.ts https://mail.example undo_flood
```

Start the second undo command in a fresh flood-counter window (no undo requests for one full configured period) or use a different dedicated operator account. The `undo` check also consumes the account's `undo_flood` counter; sharing a window would make the flood check see 429 too early. Each burst must fit in one limiter window at one Cloudflare location. A failed run is not an enablement receipt; check the feature availability, session and window before running again. Do not admit user traffic until all enabled buckets pass.

| Bucket | Contract route (under `/api/v1`) | Side-effect-free request |
| --- | --- | --- |
| `reads` | `GET /drafts/{draftId}` | Generated not-found draft ID; expect 404. |
| `writes` | `POST /drafts` | No `Idempotency-Key` or body; expect 428. |
| `uploads` | `POST /uploads` | No `Idempotency-Key` or upload bytes; expect 428. |
| `sends` | `POST /drafts/{draftId}/send` | Generated not-found draft ID, no `Idempotency-Key` or `If-Match`; expect 428. |
| `undo` | `POST /sends/{sendId}/undo` | Same generated not-found send ID, no `Idempotency-Key`; expect 428. |
| `undo_flood` | `POST /sends/{sendId}/undo` | Distinct generated not-found send ID every time, no `Idempotency-Key`; expect 428. |
| `admin_writes` | `POST /admin/domains` | No `Idempotency-Key` or body; expect 428. |

The runtime checks confirm that each bucket is wired and enforcing; they cannot certify its exact number, because Cloudflare's counters are approximate and per location and an attempt can straddle a counter window. A bucket passes when, after at least one admitted request, a refusal arrives by 150% of the limit (rounded down). The HTTP client sends at most that many requests plus one per attempt: buckets up to 200 requests go one at a time, and the 600-request buckets go eight at a time to finish well inside one period. Every response before the refusal must have the listed status, and the refusal must be 429 `rate_limited` with the configured period in both `Retry-After` and `retryAfterSeconds`; any other answer or a failed request fails at once. No admission, a refusal after the cap, or none can come from a window boundary or a saturated window, so that bucket is retried once after waiting one full period, and the retry's result is the verdict. The direct probe follows the same rule, with a fresh key on the retry. The exact limit and period are proved by the configuration check, not by these runtime checks.
