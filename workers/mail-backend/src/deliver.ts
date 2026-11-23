import { isDeliveryId, type Outbox } from './outbox.ts';

export type MailboxOutcome = 'indexed' | 'deferred' | 'rejected';

export type DeliveryPorts = {
  outbox: Pick<Outbox, 'get' | 'claim' | 'complete' | 'defer' | 'reject'>;
  index(workspaceId: string, mailboxId: string, deliveryId: string): Promise<MailboxOutcome>;
  release(workspaceId: string, rawKey: string, deliveryId: string): Promise<void>;
  now(): number;
};

// `occurrence` distinguishes alerts for the same delivery after an operator re-drive.
export type AlertEvent = { code: 'delivery_dlq' | 'delivery_failed' | 'delivery_stuck'; deliveryId?: string; occurrence?: number };
export type Alert = (event: AlertEvent) => Promise<void>;

// The outbox row, not the queue message, carries every retry: once an outcome is
// recorded in D1 the queue message is acknowledged and the reconciler re-drives.
// Only a failure to record an outcome throws, so the queue retries it.
export async function deliver(body: unknown, ports: DeliveryPorts, queueMessageId: string): Promise<void> {
  if (!isDeliveryId(body)) throw new Error('Invalid queue delivery id');
  const row = await ports.outbox.claim(body, ports.now(), queueMessageId);
  if (!row) {
    // A retry after completion only reprises the idempotent holder release.
    const completed = await ports.outbox.get(body);
    if (completed?.state === 'done') await ports.release(completed.workspaceId, completed.rawKey, completed.id);
    return;
  }
  let outcome: MailboxOutcome;
  try {
    // Single-recipient deliveries only (group delivery is not enabled).
    outcome = await ports.index(row.workspaceId, row.mailboxIds[0], row.id);
  } catch {
    // Transient: mailbox, storage or network unavailable, or the reply was lost.
    outcome = 'deferred';
  }
  if (outcome === 'deferred') {
    await ports.outbox.defer(row.id, row.lease, queueMessageId, ports.now());
  } else if (outcome === 'rejected') {
    await ports.outbox.reject(row.id, row.lease, queueMessageId, ports.now());
  } else if (await ports.outbox.complete(row.id, row.lease, ports.now(), queueMessageId)) {
    await ports.release(row.workspaceId, row.rawKey, row.id);
  }
}

// The consumer records this redacted descriptor before it acknowledges the queue item.
export async function dlq(body: unknown, record: Alert): Promise<void> {
  await record(isDeliveryId(body) ? { code: 'delivery_dlq', deliveryId: body } : { code: 'delivery_dlq' });
}
