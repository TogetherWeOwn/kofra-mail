import type { Alert, AlertEvent } from './deliver.ts';

export type AlertBinding = Pick<Fetcher, 'fetch'>;

const TITLE: Record<AlertEvent['code'], string> = {
  delivery_dlq: 'Mail delivery dead-lettered',
  delivery_failed: 'Mail delivery exhausted its retries',
};

export function mailAlert(binding?: AlertBinding): Alert {
  return async event => {
    if (!binding) throw new Error('Mail alert binding missing');
    const response = await binding.fetch('https://alerts.internal/v1/alert', {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: `mail:${event.code}`, key: event.deliveryId ?? 'invalid-delivery', title: TITLE[event.code] }),
    });
    // Do not read or log a response from the alert service.
    void response.body?.cancel().catch(() => {});
    if (response.status < 200 || response.status >= 300) throw new Error(`Mail alert not accepted (${response.status})`);
  };
}
