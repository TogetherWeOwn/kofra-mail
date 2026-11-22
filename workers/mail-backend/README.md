# Mail backend

Run from this directory with Node 24:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```

This Worker is off unless `MAIL_BACKEND_ENABLED=on`. No deployment, domain, Email Routing rule or real S3 binding is part of the package. Tests use local workerd D1 and synthetic mail and storage fixtures.

Ingress performs a primary directory point lookup, holds a reference, uploads the unchanged raw message, commits an outbox row, and waits for the queue to accept the delivery ID. Only a successful directory miss permanently rejects a recipient. Group delivery is not enabled.

The object-store client takes `KOFRA_S3_ENDPOINT`, `KOFRA_MAIL_BUCKET` and `KOFRA_MAIL_WORKSPACE_ID` from Worker configuration, and `KOFRA_S3_ACCESS_KEY_ID` and `KOFRA_S3_SECRET_ACCESS_KEY` from Worker secrets. It refuses a different workspace or a non-HTTPS or redirected endpoint. The local adapter is scoped to one workspace; it does not infer how to allocate buckets for other workspaces. Do not put any real secret into checked-in files.

The queue handler recognizes only its configured delivery and dead-letter queues; it emits redacted `delivery_dlq` error events. A monitored alert destination and a verified temporary SMTP status on Worker exceptions are required before enabling live ingress.
