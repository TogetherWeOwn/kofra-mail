import { LIMITS } from '../../../contracts/mail-api/src/limits.ts';
import type { Label, Upload } from '../../../contracts/mail-api/src/wire.ts';
import type { Operation } from '../../../contracts/mail-api/src/service.ts';
import { sha256 } from './bytes.ts';
import { canonical, fail, invalid, isId, utf8 } from './mailbox-api-input.ts';
import { readDraft, type DraftObjectRef } from './mailbox-api-drafts.ts';
import type { MailboxIndex } from './mailbox-index.ts';
import type { JournalEvent } from './mail-journal.ts';
import { IDEM_EXPIRY, IN_PROGRESS_TTL_MS } from './mailbox-upload.ts';
import type { TimerTable } from './mailbox-timers.ts';

export type Committed = { label: Label } | { draft: DraftObjectRef } | { upload: Upload };
export type IdempotentRow = { fingerprint: string; result: string; expiresAt: number };
export const RESULT_TTL_MS = LIMITS.idempotencyRetentionSeconds * 1000;
export const fingerprintOf = (operation: Operation, params: Record<string, string>, input: unknown) =>
  sha256(utf8(canonical([operation, params, input])));

export function apiKey(key: string | undefined): string {
  if (key === undefined || key === '') return fail('precondition_required');
  if (!isId(key)) return invalid('/Idempotency-Key');
  return key;
}

export function committedKey(sql: SqlStorage, key: string): IdempotentRow | undefined {
  return sql.exec<IdempotentRow>('SELECT fingerprint, result, expires_at AS expiresAt FROM mailbox_api_idempotency WHERE key = ?', key).toArray()[0];
}

export function reserveApiKey(sql: SqlStorage, key: string, now: number): { row: IdempotentRow } | { token: string; expiresAt: number } {
  const row = committedKey(sql, key);
  if (row && row.expiresAt > now) return { row };
  const token = crypto.randomUUID();
  const expiresAt = now + IN_PROGRESS_TTL_MS;
  const marker = sql.exec(`INSERT INTO mailbox_api_in_progress VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
    WHERE mailbox_api_in_progress.expires_at <= ?`, key, token, expiresAt, now);
  if (!marker.rowsWritten) return fail('idempotency_in_progress', { retryAfterSeconds: 1 });
  return { token, expiresAt };
}

export function ownsApiKey(sql: SqlStorage, key: string, token: string, now: number): boolean {
  return sql.exec('SELECT 1 FROM mailbox_api_in_progress WHERE key = ? AND token = ? AND expires_at > ?', key, token, now).toArray().length === 1;
}

export function clearApiKey(sql: SqlStorage, key: string, token: string): void {
  sql.exec('DELETE FROM mailbox_api_in_progress WHERE key = ? AND token = ?', key, token);
}

export function resultEvent(key: string, fingerprint: string, value: Committed, now: number, identifyStatus: boolean):
  Extract<JournalEvent, { type: 'api_result' }> {
  // All three create routes answer 201. Keep legacy rows readable after a restore.
  const result = identifyStatus ? JSON.stringify({ status: 201, body: value, createdAt: now }) : JSON.stringify(value);
  return { type: 'api_result', key, fingerprint, expiresAt: now + RESULT_TTL_MS, result };
}

export const scheduleResult = (timers: TimerTable, event: Extract<JournalEvent, { type: 'api_result' }>) =>
  timers.set(IDEM_EXPIRY, event.key, event.expiresAt);

export async function replayApiKey(index: MailboxIndex, row: IdempotentRow, fingerprint: string) {
  if (row.fingerprint !== fingerprint) return fail('idempotency_key_reused');
  const stored = JSON.parse(row.result) as Committed | { status: number; body: Committed };
  const value = 'status' in stored ? stored.body : stored;
  return { body: 'label' in value ? value.label : 'upload' in value ? value.upload : await readDraft(index, value.draft),
    replayed: true, ...('status' in stored && { status: stored.status }) };
}
