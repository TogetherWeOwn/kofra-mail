import { isDeliveryId, type Outbox } from './outbox.ts';

export type DeliveryPorts = {
  outbox: Pick<Outbox, 'get' | 'complete'>;
  index(workspaceId: string, mailboxId: string, deliveryId: string): Promise<void>;
  release(workspaceId: string, rawKey: string, deliveryId: string): Promise<void>;
  now(): number;
};

export type AlertEvent = { code: 'delivery_dlq' | 'delivery_failed'; deliveryId?: string };
export type Alert = (event: AlertEvent) => Promise<void>;

export async function deliver(body: unknown, ports: DeliveryPorts): Promise<void> {
  if (!isDeliveryId(body)) throw new Error('Invalid queue delivery id');
  const row = await ports.outbox.get(body);
  if (!row || row.state === 'failed') return;
  // If completion succeeded but its release did not, a redelivery only retries
  // the idempotent holder release, never the indexing.
  if (row.state === 'done') {
    await ports.release(row.workspaceId, row.rawKey, row.id);
    return;
  }
  for (const mailboxId of row.mailboxIds) await ports.index(row.workspaceId, mailboxId, row.id);
  if (await ports.outbox.complete(row.id, ports.now())) {
    await ports.release(row.workspaceId, row.rawKey, row.id);
  }
}

export async function dlq(body: unknown, alert: Alert): Promise<void> {
  await alert(isDeliveryId(body) ? { code: 'delivery_dlq', deliveryId: body } : { code: 'delivery_dlq' });
}
