# Mail limiter verification (R2)

Run from the repository root with Node.js 24. The clients print only `bucket PASS` or `bucket FAIL` and exit 1 if any selected bucket fails. Save those lines as the environment's receipt. **Running any of these checks against production requires the owner's approval.** No tool enables a flag or deploys a Worker.

## Step 1: both outbound flags off

1. Put `CLOUDFLARE_ACCOUNT_ID` and a Workers-settings read token in `CLOUDFLARE_API_TOKEN` in the process environment. Check the deployed mail-web script:

   ```sh
   node tools/limiter-verify/check-config.ts MAIL_WEB_SCRIPT_NAME
   ```

   The configuration check verifies the binding names, distinct namespaces, limits and periods. It does not print any IDs.
2. Manually deploy `probe-worker.ts` as a temporary, separate Worker in the same Cloudflare account. In a private operator config, use `nodejs_compat` and copy **the actual mail-web `ratelimits` bindings**, including the same names, `namespace_id` values, limits and periods. Do not attach mail data bindings. Set the Worker secret `R2_PROBE_SECRET`, and load that same value into the client process environment:

   ```sh
   node tools/limiter-verify/probe-client.ts https://probe.example
   ```

   The client sends the secret in `x-r2-probe-secret`. Each request exercises one binding with a fresh `r2-probe:` key. The direct probe tests the threshold, not the period; the settings check verifies the period. Remove the temporary probe after the check.

## Step 2: relevant flag on, before user traffic

The target must already expose the mail HTTP API to the operator; turning on a feature flag alone does not expose it. Use a dedicated operator account with a provisioned mailbox and a clean limiter window. The admin check needs a workspace admin session reauthenticated within the contract's 10-minute window and a clean workspace counter. Load the full Cookie header value into `R2_MAIL_COOKIE` and the session's CSRF value into `R2_MAIL_CSRF`. The base URL must be an HTTPS origin (plain HTTP is accepted only on loopback for local fixtures). Run only buckets whose routes are enabled:

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

The client sends the first `limit` requests in batches of up to eight; all must return the listed status before the single final request is sent. The final request must return 429 `rate_limited` with the configured period in `Retry-After` and `retryAfterSeconds`. This is a strict verification check, not a claim that Cloudflare's approximate, location-local limiter always provides an exact quota.
