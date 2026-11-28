import { sha256 } from './bytes.ts';
import type { AlertEvent } from './deliver.ts';
import { sendEventTitle, type DailySendAlert } from './send-alert-events.ts';

export type AlertBinding = Pick<Fetcher, 'fetch'>;
export type MailboxAlertCode = 'backup_stale' | 'restore_blocked' | 'restore_skipped' | 'backup_conflict' |
  'holder_confirm_stale' | 'holder_source_lost' | 'send_invariant';
type Event = AlertEvent | { code: MailboxAlertCode; key: string };
type GateAlert = { code: 'send_quota_gate_hit'; key: string; environment: string; time: number };
type SendAlert = DailySendAlert | { code: 'send_dlq'; environment: string; time: number; occurrence: string };

const TITLE: Record<Event['code'], string> = {
  delivery_dlq: 'Mail delivery dead-lettered',
  delivery_failed: 'Mail delivery exhausted its retries',
  delivery_stuck: 'Mail delivery is still retrying',
  restore_skipped: 'Mailbox restore skipped deliveries with missing mail',
  backup_stale: 'Mailbox backup is stale',
  restore_blocked: 'Mailbox restore is blocked',
  backup_conflict: 'Mailbox state diverged from its backup',
  holder_confirm_stale: 'A published mailbox holder is still unconfirmed',
  holder_source_lost: 'A mailbox source object is missing',
  send_invariant: 'A send is held after a release invariant failed',
};

export function mailAlert(binding?: AlertBinding) {
  return async (event: Event | SendAlert | GateAlert, signal?: AbortSignal): Promise<void> => {
    if (!binding) throw new Error('Mail alert binding missing');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const source = `mail:${event.code}`;
    let body: Record<string, string | number>;
    if (event.code === 'send_quota_gate_hit' && 'key' in event) {
      headers['idempotency-key'] = event.key;
      body = { source, key: event.key, title: sendEventTitle(event.code), environment: event.environment, time: event.time };
    } else if ('environment' in event) {
      const key = await sha256(new Uint8Array(new TextEncoder().encode(event.occurrence)));
      headers['idempotency-key'] = key;
      body = { source, key, title: event.code === 'send_dlq' ? 'Outbound mail queue message dead-lettered' : sendEventTitle(event.code),
        environment: event.environment, count: 1, time: event.time };
    } else {
      const key = 'key' in event ? event.key
        : event.deliveryId ? (event.occurrence ? `${event.deliveryId}:${event.occurrence}` : event.deliveryId) : 'invalid-delivery';
      body = { source, key, title: TITLE[event.code] };
    }
    const response = await binding.fetch('https://alerts.internal/v1/alert', {
      method: 'POST', redirect: 'manual', headers, body: JSON.stringify(body), signal,
    });
    // Do not read or log a response from the alert service.
    void response.body?.cancel().catch(() => {});
    signal?.throwIfAborted();
    if (response.status < 200 || response.status >= 300) throw new Error(`Mail alert not accepted (${response.status})`);
  };
}
