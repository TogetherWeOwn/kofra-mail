import type { Alert } from './deliver.ts';
import type { MailAlerts } from './mail-alerts.ts';
import { STUCK_RETRIES, type Outbox } from './outbox.ts';

export const RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

type ReconcilePorts = {
  outbox: Pick<Outbox, 'due' | 'reserve' | 'alertDue' | 'alerted'>;
  mailAlerts?: Pick<MailAlerts, 'pending' | 'sent' | 'deferred' | 'prune' | 'recordFailed' | 'recordStuck'>;
  now(): number;
  send(id: string): Promise<void>;
  alert: Alert;
};

export async function reconcile(ports: ReconcilePorts): Promise<{ enqueueErrors: number; alertErrors: number }> {
  const { outbox } = ports;
  const now = ports.now();
  let enqueueErrors = 0;
  let alertErrors = 0;
  for (const row of await outbox.due(now)) {
    if (row.retries >= STUCK_RETRIES) await ports.mailAlerts?.recordStuck(row.id, row.redrives, now);
    // Only rejected processing makes a delivery terminal; a due row is always re-driven.
    if (await outbox.reserve(row.id, row.lease, now)) {
      try { await ports.send(row.id); } catch { enqueueErrors++; }
      // Failed or ambiguous sends retain their reservation and become due again at the next deadline.
    }
  }
  const { mailAlerts } = ports;
  for (const { id, redrives } of await outbox.alertDue()) {
    if (mailAlerts) {
      // Move the obligation into the persisted, rotating alert queue.
      await mailAlerts.recordFailed(id, redrives, now);
    } else {
      try { await ports.alert({ code: 'delivery_failed', deliveryId: id }); }
      catch { alertErrors++; continue; }
    }
    await outbox.alerted(id, redrives, now);
  }
  if (mailAlerts) {
    for (const { key, event } of await mailAlerts.pending()) {
      try { await ports.alert(event); }
      catch { alertErrors++; await mailAlerts.deferred(key, ports.now()); continue; }
      await mailAlerts.sent(key, ports.now());
    }
    await mailAlerts.prune(now - RETENTION_MS);
  }
  // Completed deliveries are pruned by their mailbox after a confirmed backup.
  return { enqueueErrors, alertErrors };
}
