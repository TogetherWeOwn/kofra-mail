import type { AlertEvent } from './deliver.ts';
import { isDeliveryId } from './outbox.ts';

const DLQ_PREFIX = 'delivery_dlq:';
const FAILED_PREFIX = 'delivery_failed:';
const STUCK_PREFIX = 'delivery_stuck:';
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

  async pending(): Promise<Array<{ key: string; event: AlertEvent }>> {
    // The timestamp range gives SQLite an indexed seek even on an empty table.
    const { results } = await this.db.withSession('first-primary').prepare(`SELECT key FROM mail_alerts
      WHERE sent_at IS NULL AND created_at >= 0 ORDER BY created_at, key LIMIT ?`).bind(ALERT_PAGE).all<{ key: string }>();
    return results.map(({ key }) => {
      const prefix = [FAILED_PREFIX, STUCK_PREFIX, DLQ_PREFIX].find(p => key.startsWith(p)) ?? DLQ_PREFIX;
      const code = prefix === FAILED_PREFIX ? 'delivery_failed' : prefix === STUCK_PREFIX ? 'delivery_stuck' : 'delivery_dlq';
      const [id, generation] = key.slice(prefix.length).split(':');
      const occurrence = generation && /^[1-9][0-9]{0,8}$/.test(generation) ? Number(generation) : undefined;
      return { key, event: { code, deliveryId: isDeliveryId(id) ? id : undefined, ...(occurrence ? { occurrence } : {}) } };
    });
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
