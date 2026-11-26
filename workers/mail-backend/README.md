# Mail backend

Run from this directory with Node 24:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

This Worker is off unless `MAIL_BACKEND_ENABLED=on`. No deployment, domain, Email Routing rule or real S3 binding is part of the package. Tests use local workerd D1 and synthetic mail and storage fixtures.

Ingress performs a primary directory point lookup, holds a reference, uploads the unchanged raw message, commits an outbox row, and waits for the queue to accept the delivery ID. Recipient lookup lowercases the local part; it does not apply full Unicode case folding. If there is no `@`, the last `@` is the first or last character, or stripping the `+` tag leaves an empty local part, ingress permanently rejects with `Unknown recipient` before querying the directory. These checks are not full SMTP address validation. A successful lookup with no match also permanently rejects; directory errors throw instead. Group delivery is not enabled.

The object-store client takes `KOFRA_S3_ENDPOINT` from Worker configuration and `KOFRA_S3_ACCESS_KEY_ID` and `KOFRA_S3_SECRET_ACCESS_KEY` from Worker secrets. Trusted directory workspace IDs select separate `mail-<workspace_id>` buckets, in tenant 0 until storage tenancy is available. The adapter never provisions buckets or follows redirects. Ingress registers a raw digest before uploading to the assigned `raw/<sha256>/<generation>` key. PUTs sign the payload's SHA-256 hash so storage can verify the bytes. Do not put any real secret into checked-in files.

The dead-letter consumer records redacted alerts in D1 before acknowledging messages, and the reconciler retries posting them through `ALERTS` to `/v1/alert` until it receives a 2xx. No live service binding is configured. The receiver must support the `mail:*` sources at its bound entrypoint, and the SMTP status on Worker exceptions must be verified before enabling live ingress.

Mailbox content and search are derived from digest-verified raw MIME. Changes commit with a per-mailbox journal sequence. Alarms coalesce draft, label, filter and send-as edits for up to 60 seconds and flush changed flags within an hour. An earlier settings flush may also publish preceding flag entries so the journal stays contiguous.

Before indexing its first message, a new mailbox conditionally creates an empty baseline manifest in `MAIL_STATE`. Weekly snapshots and journal deltas record later changes. The manifest names the mailbox incarnation that owns it. Publication replaces it only if its ETag still matches. No lifecycle rule may expire anything a live manifest references. The mailbox sends alerts for stale backups and blocked restores. It deletes superseded backup generations itself, only after confirming a newer manifest. No R2 lifecycle rule may expire objects under `journal/`.

Restore runs in resumable alarm slices and requires both `MAIL_BACKEND_ENABLED` and `MAIL_RECOVERY_ENABLED` to be `on`. Start with an empty target; the RPC rejects a mailbox that is already `ready`, even when bootstrap is requested. It restores metadata from the snapshot and deltas first, then replays retained completed deliveries past the manifest cursor. It saves progress after each step. Search is rebuilt in the background after the mailbox becomes ready. If the manifest is missing and completed deliveries exist, the mailbox enters `missing`. An operator must explicitly request bootstrap via `restoreFromBackup(workspaceId, mailboxId, true)` to rebuild from the completed deliveries still retained.

The local-only Wrangler config wires the queues, one-minute reconciler and SQLite Durable Objects. Restore bumps the mailbox recovery epoch. Only the current lease owner can complete a delivery, and only if the claim's epoch still matches. A stale completion leaves the row pending for the reconciler. Only rejected mail spends one of the eight processing attempts. A mailbox that is not ready or a transient failure defers delivery with capped backoff and no attempt spent. The eighth rejection leaves the raw reference in place for investigation. The internal `MailAdmin.redriveDelivery(id)` entrypoint returns a failed row to pending and resets its attempt budget. The terminal failure's alert obligation is recorded with the transition to `failed` and remains in the alert queue until the alert service returns 2xx.

The workspace sweeper can delete only `raw` and `att` generations with zero holders for at least 35 days. It retires a generation before issuing DELETE, never writes it again, and retries with backoff until a 204 or a 404 with the S3 error `NoSuchKey`; a day after that first confirmed DELETE it deletes the generation once more, for an object a late PUT may have recreated, and drops its ledger row only then. Releases arm sweeps even when deletes are disabled, and the internal `rearm()` RPC restores missing alarms for older ledgers. Destructive sweeping requires `MAIL_SWEEP_ENABLED=on` in addition to enabling the backend. Drafts are not swept.
