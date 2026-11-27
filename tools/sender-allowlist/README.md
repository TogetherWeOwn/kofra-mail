# Sender allow-list job

The manual **Sender allow-list** workflow runs on `main` in the `production` environment. `dry-run` is the default and reads the directory only. Keep the outbound feature off until its enablement gates are met. The first production deploy requires explicit operator approval.

This workflow is the only deployer for `mail-send`, including code-only deploys. `deploy` requires the M3-5 config at `workers/mail-send/wrangler.jsonc`. The config must name the worker `mail-send` and leave out the `send_email` binding. The job generates the `EMAIL` binding's sender list at deploy time, or leaves the binding out entirely if the list is empty. Deploys are serialized; dry runs use separate concurrency groups and cannot displace a queued deploy. A stale deploy dispatch is refused before D1 access. To roll back worker code, revert on `main` and start a fresh dispatch; don't re-run a stale job or directly roll back a deployment.

The job reads at most 501 rows per directory table and stops if either table exceeds the 500-row cap. It lowers unlisted active rows, deploys, verifies the latest Workers deployment has exactly one version matching the Wrangler result at 100% traffic, and then promotes eligible pending rows from the deployed list. Promotion tracks the deployed address string, not a particular mailbox: a pending row recreated at the same address and workspace can be promoted if its domain is still eligible. The sender check uses the current directory to determine which mailbox can send. An unchanged rerun still deploys and verifies the selected code, but makes no directory mutations.

The workflow passes the Cloudflare account, API token, and directory database ID through the environment. The token needs D1 read for dry run, and D1 write and Workers deployment permissions for deploy. Successful runs print only counts: `pending` and `active` at the read, `listed`, `lowered`, `promoted`, and `domains`. Wrangler output stays in private runner files. Nothing from those files is printed or uploaded; the temporary files are removed after the attempt.

| Exit code | Meaning |
| --- | --- |
| 2 | Invalid mode or missing/invalid sending worker config |
| 3 | Directory credentials, reads, cap, or writes failed |
| 4 | Worker deploy failed or didn't return a valid version |
| 5 | The active deployment couldn't be verified; no rows were promoted |

Test locally with `node --test tools/sender-allowlist/*.test.ts`. Tests use a loopback D1 REST fixture and fake Wrangler; they don't read production credentials or deploy anything.
