# Outbound mail Worker

`mail-send` handles the `send` and `send-dlq` queues. It has no HTTP route, workers.dev hostname or preview URL. The `send` queue carries only dispatch IDs and fenced result notices. Only a dispatch can call the provider. If a provider result cannot be recorded on the mailbox, the Worker inserts it into `send_results` before attempting a notice. A notice only asks the mailbox to record its exact stored result. A restoring mailbox defers the row and the notice is acknowledged; a dropped notice is recoverable through the mailbox drive row or the one-minute `mail-backend` reconciler.

The DLQ posts one redacted alert per queue message over `ALERTS` and acknowledges only on 2xx. It never changes send state. Mailbox and dispatch events use the separate, durable `mail_alerts` outbox, with one obligation per UTC day, environment and event code. Delivery is at-least-once; the endpoint receives a stable hashed key in both `key` and `Idempotency-Key` so it can deduplicate a replay after a lost response. Send-event payloads include the environment, the UTC bucket timestamp and a count of one; they do not contain mail content or addresses. Alerts derived from committed mailbox outcomes are staged in the same transaction; an event detected only in the consumer can be lost if it crashes before local staging.

## Deploy order and enablement

The checked-in production templates use placeholder resource names and IDs. Keep `MAIL_SEND_ENABLED=off` in both Workers until the outbound plan's enablement prerequisites pass. `mail-send` fails closed without the `SendQuota` binding; the quota fake exists only in the local test harness. The checked-in config never defines `send_email`.

For each environment, in order:

1. Create the `send` and `send-dlq` queues.
2. Apply the directory migrations, including `0009_send_results.sql`.
3. Deploy `mail-backend` with its `SEND` producer and, after M3-6, the `SendQuota` migration. Both Workers must target the same directory D1 database and alert service.
4. Use the sender allow-list job to deploy `mail-send`. The job adds the `EMAIL` binding; do not add it manually to the template. The job must inject the per-environment resource IDs, including `database_id`, into the config derived from `workers/mail-send/wrangler.jsonc` before deployment. That injection and the preflight check for the deployed `Mailbox` and `SendQuota` classes are a separate package after M3-6 and remain enablement blockers. Deploy mode refuses the placeholder template before any directory request.

Test locally from `workers/mail-backend` with `npm test`. The Miniflare suite uses the real mailbox implementation in a separate Worker, local D1, a local queue/DLQ and fake provider, quota and alert endpoints. No deploy or live service is needed.
