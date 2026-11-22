# Mail backend

Run from this directory with Node 24:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

This Worker is off unless `MAIL_BACKEND_ENABLED=on`. No deployment, domain, Email Routing rule or real S3 binding is part of the package. Tests use local workerd D1 and synthetic mail and storage fixtures.

Ingress performs a primary directory point lookup, holds a reference, uploads the unchanged raw message, commits an outbox row, and waits for the queue to accept the delivery ID. Only a successful directory miss permanently rejects a recipient. Group delivery is not enabled.

The object-store client takes `KOFRA_S3_ENDPOINT` from Worker configuration and `KOFRA_S3_ACCESS_KEY_ID` and `KOFRA_S3_SECRET_ACCESS_KEY` from Worker secrets. Trusted directory workspace IDs select separate `mail-<workspace_id>` buckets, in tenant 0 until storage tenancy is available. The adapter never provisions buckets or follows redirects. Ingress registers a raw digest before uploading to the assigned `raw/<sha256>/<generation>` key. Do not put any real secret into checked-in files.

The dead-letter consumer sends redacted alerts through the `ALERTS` service binding to `/v1/alert`, acknowledging the message only on 2xx. No live service binding is configured. The receiver must support the `mail:*` sources at its bound entrypoint, and the SMTP status on Worker exceptions must be verified before enabling live ingress.
