import type { AlertEvent } from './deliver.ts';

export type AlertBinding = Pick<Fetcher, 'fetch'>;
export type MailboxAlertCode = 'backup_stale' | 'restore_blocked' | 'backup_conflict';
type Event = AlertEvent | { code: MailboxAlertCode; key: string };

const TITLE: Record<Event['code'], string> = {
  delivery_dlq: 'Mail delivery dead-lettered',
  delivery_failed: 'Mail delivery exhausted its retries',
  backup_stale: 'Mailbox backup is stale',
  restore_blocked: 'Mailbox restore is blocked',
  backup_conflict: 'Mailbox state diverged from its backup',
};

export function mailAlert(binding?: AlertBinding) {
  return async (event: Event): Promise<void> => {
    if (!binding) throw new Error('Mail alert binding missing');
    const key = 'key' in event ? event.key : event.deliveryId ?? 'invalid-delivery';
    const response = await binding.fetch('https://alerts.internal/v1/alert', {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: `mail:${event.code}`, key, title: TITLE[event.code] }),
    });
    // Do not read or log a response from the alert service.
    void response.body?.cancel().catch(() => {});
    if (response.status < 200 || response.status >= 300) throw new Error(`Mail alert not accepted (${response.status})`);
  };
}
