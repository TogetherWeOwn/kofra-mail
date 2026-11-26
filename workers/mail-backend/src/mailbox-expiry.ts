import { committedKey, storedCreateOperation } from './mailbox-api-idempotency.ts';
import type { MailboxIndex } from './mailbox-index.ts';
import { TIMER_RETRY_MS, type TimerKind, type TimerTable } from './mailbox-timers.ts';
import { IDEM_EXPIRY, UPLOAD_EXPIRY, uploadReferenced, uploadRow } from './mailbox-upload.ts';

type ExpiryPorts = {
  sql: SqlStorage;
  ready(): { incarnation: string; index: MailboxIndex } | undefined;
  journalDue(timers: TimerTable): void;
};

export function uploadExpiry({ sql, ready, journalDue }: ExpiryPorts): TimerKind {
  return {
    async run(timer) {
      const read = await timer.local(timers => {
        const life = ready();
        const row = life && uploadRow(sql, timer.ref);
        if (!life || !row || uploadReferenced(sql, timer.ref)) { timers.delete(UPLOAD_EXPIRY, timer.ref); return; }
        if (row.expiresAt > timer.now) { timers.set(UPLOAD_EXPIRY, timer.ref, row.expiresAt); return; }
        timers.set(UPLOAD_EXPIRY, timer.ref, timer.now + TIMER_RETRY_MS);
        return { row, incarnation: life.incarnation };
      });
      if (!read) return;
      await timer.local(timers => {
        const life = ready();
        const row = life?.incarnation === read.incarnation ? uploadRow(sql, timer.ref) : undefined;
        if (!life || !row || row.objectKey !== read.row.objectKey || row.holder !== read.row.holder ||
            row.expiresAt !== read.row.expiresAt || uploadReferenced(sql, timer.ref)) return;
        // The journal tail releases this immutable holder only after publication.
        life.index.commitEvents([{ type: 'api_upload_delete', id: row.id, objectKey: row.objectKey }]);
        timers.delete(UPLOAD_EXPIRY, timer.ref);
        journalDue(timers);
      });
    },
    rebuild(timers) {
      for (const { id, expires_at } of sql.exec<{ id: string; expires_at: number }>(`SELECT u.id, u.expires_at
        FROM mailbox_api_uploads u WHERE NOT EXISTS (SELECT 1 FROM mailbox_api_draft_uploads r WHERE r.upload_id = u.id)`)) {
        timers.set(UPLOAD_EXPIRY, id, expires_at);
      }
      return undefined;
    },
  };
}

export function idemExpiry({ sql, ready, journalDue }: ExpiryPorts, outboundEnabled: boolean, parkedMs: number): TimerKind {
  return {
    async run(timer) {
      const read = await timer.local(timers => {
        const life = ready();
        const row = life && committedKey(sql, timer.ref);
        if (!life || !row) { timers.delete(IDEM_EXPIRY, timer.ref); return; }
        if (row.expiresAt > timer.now) { timers.set(IDEM_EXPIRY, timer.ref, row.expiresAt); return; }
        if (!outboundEnabled && storedCreateOperation(row.result) === 'createUpload') {
          timers.set(IDEM_EXPIRY, timer.ref, timer.now + parkedMs);
          return;
        }
        timers.set(IDEM_EXPIRY, timer.ref, timer.now + TIMER_RETRY_MS);
        return { row, incarnation: life.incarnation };
      });
      if (!read) return;
      await timer.local(timers => {
        const life = ready();
        const row = life?.incarnation === read.incarnation ? committedKey(sql, timer.ref) : undefined;
        if (!life || !row || row.expiresAt !== read.row.expiresAt || row.fingerprint !== read.row.fingerprint || row.result !== read.row.result) return;
        life.index.commitEvents([{ type: 'api_result_expire', key: timer.ref, expiresAt: row.expiresAt }]);
        timers.delete(IDEM_EXPIRY, timer.ref);
        journalDue(timers);
      });
    },
    rebuild(timers) {
      for (const { key, expires_at } of sql.exec<{ key: string; expires_at: number }>('SELECT key, expires_at FROM mailbox_api_idempotency')) {
        timers.set(IDEM_EXPIRY, key, Math.max(1, expires_at));
      }
      return undefined;
    },
  };
}
