// Operator send events share one allow-list. Mailbox events use a UTC-day
// outbox key; the account quota object keys gate events by its quota day.
const TITLES = {
  send_outage: 'The outbound mail provider is unavailable',
  send_unknown_error: 'The outbound mail provider returned an unknown error',
  send_ambiguous_cap: 'An outbound send reached the ambiguous-result cap',
  send_deadline: 'An outbound send reached the provider retry deadline',
  send_held: 'An outbound send is held after repeated unfinished attempts',
  send_result_unapplied: 'A stored provider acceptance cannot be recorded',
  send_result_stuck: 'A stored provider result keeps failing to record',
  send_quota_release: 'The send quota object could not release a charge',
  send_quota_failed: 'The send quota object could not reserve or confirm a charge',
  send_quota_gate_hit: 'A mail account quota gate was reached',
  send_stale_release_failed: 'A stale send charge could not be released',
  send_request_invalid: 'An outbound request could not be built',
  send_stalled: 'An outbound send has stalled',
} as const;
export type SendEventCode = keyof typeof TITLES;
export const isSendEventCode = (value: unknown): value is SendEventCode => typeof value === 'string' && Object.hasOwn(TITLES, value);
export const sendEventTitle = (code: SendEventCode): string => TITLES[code];

const DAY = 86_400_000;

// Safe to call inside the transaction that commits the event's source fact.
export function stageSendEvent(sql: SqlStorage, code: SendEventCode, now: number): number {
  const day = Math.floor(now / DAY);
  sql.exec('INSERT OR IGNORE INTO mailbox_send_event_outbox (day, code, occurred_at) VALUES (?, ?, ?)', day, code, now);
  return day;
}

const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export function sendAlertEnvironment(value: string | undefined): string {
  if (!value || !ENVIRONMENT.test(value)) throw new Error('Invalid mail alert environment');
  return value;
}

export function dailySendAlertKey(environment: string, code: SendEventCode, now: number): string {
  return `send-event:${sendAlertEnvironment(environment)}:${code}:${Math.floor(now / DAY)}`;
}

export type DailySendAlert = { code: SendEventCode; environment: string; time: number; occurrence: string };
export function dailySendAlert(key: string): DailySendAlert | undefined {
  const [prefix, environment, code, day, extra] = key.split(':');
  if (prefix !== 'send-event' || extra !== undefined || !ENVIRONMENT.test(environment) || !isSendEventCode(code) || !/^\d{1,8}$/.test(day)) return;
  return { code, environment, time: Number(day) * DAY, occurrence: key };
}