import type { MailJournal, JournalRow } from './mail-journal.ts';
import { JOURNAL_PAGE_SIZE } from './mail-journal.ts';
import type { MailboxIndex } from './mailbox-index.ts';

const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const formatted = (n: number) => n.toString().padStart(16, '0');
export const INCARNATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DELTA = /^deltas\/([0-9a-f-]{36})\/(\d{16})-(\d{16})\.json$/;

export function journalPrefix(scope: string): string {
  if (!scope.length || scope.length > 128 || /[^a-zA-Z0-9_-]/.test(scope)) throw new Error('Invalid journal scope');
  return `journal/${scope}/`;
}

// Delta keys carry the writing incarnation, so a later incarnation can never
// overwrite a segment that an older manifest still references.
export function deltaRange(prefix: string, key: string): { incarnation: string; from: number; last: number } | null {
  if (!key.startsWith(prefix)) return null;
  const match = DELTA.exec(key.slice(prefix.length));
  if (!match || !INCARNATION.test(match[1])) return null;
  const from = Number(match[2]);
  const last = Number(match[3]);
  return Number.isSafeInteger(from) && Number.isSafeInteger(last) && from >= 1 && from <= last
    ? { incarnation: match[1], from, last } : null;
}

export async function writeDelta(journal: MailJournal, bucket: Pick<R2Bucket, 'put'>, prefix: string, incarnation: string,
  after: number, through?: number) {
  if (!INCARNATION.test(incarnation)) throw new Error('Invalid mailbox incarnation');
  const rows = journal.page(after, through);
  if (!rows.length) return null;
  if (rows[0].seq !== after + 1) throw new Error('Mailbox journal gap');
  const last = rows[rows.length - 1].seq;
  const key = `${prefix}deltas/${incarnation}/${formatted(rows[0].seq)}-${formatted(last)}.json`;
  const body = JSON.stringify({ version: 1, rows });
  if (new TextEncoder().encode(body).byteLength > MAX_SEGMENT_BYTES) throw new Error('Oversized mailbox journal segment');
  await bucket.put(key, body, { httpMetadata: { contentType: 'application/json' } });
  return { key, last };
}

export async function readDelta(bucket: Pick<R2Bucket, 'get'>, key: string, range: { from: number; last: number }): Promise<JournalRow[]> {
  const object = await bucket.get(key);
  if (!object || object.size > MAX_SEGMENT_BYTES) throw new Error('Missing or oversized mailbox journal segment');
  const payload = await object.json<{ version: number; rows: JournalRow[] }>();
  if (payload.version !== 1 || !Array.isArray(payload.rows) || payload.rows.length !== range.last - range.from + 1 ||
      payload.rows.length > JOURNAL_PAGE_SIZE ||
      payload.rows.some((row, i) => !row || row.seq !== range.from + i || typeof row.event !== 'string')) {
    throw new Error('Invalid mailbox journal segment');
  }
  return payload.rows;
}

export async function replayJournal(index: MailboxIndex, bucket: Pick<R2Bucket, 'get'>, prefix: string, key: string): Promise<void> {
  const range = deltaRange(prefix, key);
  if (!range) throw new Error('Invalid mailbox journal segment key');
  for (const row of await readDelta(bucket, key, range)) await index.replay(row);
}
