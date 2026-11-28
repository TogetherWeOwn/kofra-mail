import type { AlertEvent } from './deliver.ts';
import type { HandoffStuckAlert } from './internal-handoff.ts';
import { isDeliveryId } from './outbox.ts';
import { isLinkId } from './file-links.ts';

export type LinkReportedAlert = { code: 'link_reported'; key: string };
import { dailySendAlert, dailySendAlertKey, type DailySendAlert, type SendEventCode } from './send-alert-events.ts';

const DLQ_PREFIX = 'delivery_dlq:';
const FAILED_PREFIX = 'delivery_failed:';
const STUCK_PREFIX = 'delivery_stuck:';
const HANDOFF_STUCK_PREFIX = 'handoff_stuck:';
const LINK_REPORTED_PREFIX = 'link_reported:';
const ALERT_PAGE = 12;
const PRUNE_PAGE = 100;

// The first occurrence keeps the plain key; later re-drives append their generation.
function occurrenceKey(prefix: string, deliveryId: string, redrives: number): string {
  return redrives > 0 ? `${prefix}${deliveryId}:${redrives}` : `${prefix}${deliveryId}`;
}

export class MailAlerts {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  // A terminal delivery's alert obligation, one per re-drive generation; it is
  // sent and retried like a DLQ alert.
  async recordFailed(deliveryId: string, redrives: number, now: number): Promise<void> {
    await this.db.prepare('INSERT OR IGNORE INTO mail_alerts (key, source, created_at) VALUES (?, ?, ?)')
      .bind(occurrenceKey(FAILED_PREFIX, deliveryId, redrives), 'mail:delivery_failed', now).run();
  }

  // Once per re-drive generation of a delivery that keeps retrying without
  // becoming terminal.
  async recordStuck(deliveryId: string, redrives: number, now: number): Promise<void> {
    await this.db.prepare('INSERT OR IGNORE INTO mail_alerts (key, source, created_at) VALUES (?, ?, ?)')
      .bind(occurrenceKey(STUCK_PREFIX, deliveryId, redrives), 'mail:delivery_stuck', now).run();
  }

  async recordDlq(deliveryId: string | null, queueId: string, now: number): Promise<void> {
    const key = DLQ_PREFIX + (deliveryId ?? `invalid:${queueId}`);
    await this.db.prepare('INSERT OR IGNORE INTO mail_alerts (key, source, created_at) VALUES (?, ?, ?)')
      .bind(key, 'mail:delivery_dlq', now).run();
  }

  async recordSend(environment: string, code: SendEventCode, now: number): Promise<void> {
    await this.db.prepare('INSERT OR IGNORE INTO mail_alerts (key, source, created_at) VALUES (?, ?, ?)')
      .bind(dailySendAlertKey(environment, code, now), `mail:${code}`, now).run();
  }

  async pending(now: number): Promise<Array<{ key: string; event?: AlertEvent | DailySendAlert | HandoffStuckAlert | LinkReportedAlert }>> {
    // One indexed range scan of the unsent outbox, also when the range is empty.
    const { results } = await this.db.withSession('first-primary').prepare(`SELECT key FROM mail_alerts
      WHERE sent_at IS NULL AND created_at BETWEEN 0 AND ? ORDER BY created_at, key LIMIT ?`).bind(now, ALERT_PAGE).all<{ key: string }>();
    return results.map(({ key }) => {
      if (key.startsWith('send-event:')) return { key, event: dailySendAlert(key) };
      // A stuck internal handoff, reported by its send id only.
      if (key.startsWith(HANDOFF_STUCK_PREFIX)) return { key, event: { code: 'handoff_stuck' as const, key: key.slice(key.lastIndexOf(':') + 1) } };
      // An abuse report (M3-13), carrying the reported link's id only.
      if (key.startsWith(LINK_REPORTED_PREFIX)) {
        const linkId = key.slice(LINK_REPORTED_PREFIX.length);
        return { key, event: isLinkId(linkId) ? { code: 'link_reported' as const, key: linkId } : undefined };
      }
      const prefix = [FAILED_PREFIX, STUCK_PREFIX, DLQ_PREFIX].find(p => key.startsWith(p)) ?? DLQ_PREFIX;
      const code = prefix === FAILED_PREFIX ? 'delivery_failed' : prefix === STUCK_PREFIX ? 'delivery_stuck' : 'delivery_dlq';
      const [id, generation] = key.slice(prefix.length).split(':');
      const occurrence = generation && /^[1-9][0-9]{0,8}$/.test(generation) ? Number(generation) : undefined;
      return { key, event: { code, deliveryId: isDeliveryId(id) ? id : undefined, ...(occurrence ? { occurrence } : {}) } };
    });
  }

  // Concurrent cron ticks must not both take the same send alert. A lost
  // acknowledgement can still redeliver it with the same endpoint key.
  async reserveSend(key: string, now: number): Promise<boolean> {
    const row = await this.db.prepare(`UPDATE mail_alerts SET created_at = ?
      WHERE key = ? AND sent_at IS NULL AND created_at <= ? RETURNING key`).bind(now + 60_000, key, now).first();
    return row !== null;
  }

  // A rejected alert moves behind the others, so one the receiver keeps refusing
  // cannot hold newer alerts out of the bounded scan.
  async deferred(key: string, now: number): Promise<void> {
    await this.db.prepare('UPDATE mail_alerts SET created_at = max(created_at, ?) WHERE key = ? AND sent_at IS NULL').bind(now, key).run();
  }

  async sent(key: string, now: number): Promise<void> {
    await this.db.prepare('UPDATE mail_alerts SET sent_at = ? WHERE key = ? AND sent_at IS NULL').bind(now, key).run();
  }

  async prune(before: number): Promise<void> {
    await this.db.prepare(`DELETE FROM mail_alerts WHERE key IN (
      SELECT key FROM mail_alerts WHERE sent_at < ? ORDER BY sent_at, key LIMIT ?
    )`).bind(before, PRUNE_PAGE).run();
  }
}
