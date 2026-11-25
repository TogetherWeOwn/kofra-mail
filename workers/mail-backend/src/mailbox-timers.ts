import { TIMERS_SCHEMA } from './mailbox-schema.ts';

// One mailbox object has one Durable Object alarm. Every scheduled job is a row
// here, and the alarm is armed at the earliest row.
//
// Timers are local scheduling state: they are not journalled and not copied
// into snapshots. Every kind's rows must be rebuildable from journalled state;
// a restore clears them and each kind's `rebuild` recreates them in the
// transaction that finishes the restore.

// Rows one alarm call runs at most; any further due rows wake the next call at once.
export const TIMER_BATCH = 64;
// A row its handler did not move (or whose handler threw) waits this long.
export const TIMER_RETRY_MS = 60_000;
// The mailbox journal's backup and restore lane: one row that carries the
// lane's next deadline (delta publication, snapshots, restore slices, backoff).
export const JOURNAL_FLUSH = 'journal_flush';
export const JOURNAL_FLUSH_REF = 'lane';

export type TimerRow = { due_at: number; kind: string; ref: string };

export type TimerKind = {
  // Runs one due row inside the mailbox work lane. It must move (set) or
  // delete its own row; a row left in place waits TIMER_RETRY_MS. A handler
  // that changes state should move its row in the same transaction.
  run(ref: string, now: number): Promise<void>;
  // Recreates this kind's rows from restored, journalled state. Runs
  // synchronously inside the transaction that finishes a restore.
  rebuild?(timers: TimerTable, now: number): void;
};

const KIND = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_REF = 256;

export function validTimerKind(kind: unknown): kind is string { return typeof kind === 'string' && KIND.test(kind); }

function check(kind: string, ref: string, at?: number) {
  if (!validTimerKind(kind) || typeof ref !== 'string' || !ref.length || ref.length > MAX_REF ||
      (at !== undefined && !Number.isSafeInteger(at))) {
    throw new Error('Invalid mailbox timer');
  }
}

// Synchronous row operations, usable inside a storage transaction. Changing a
// row does not arm the alarm; the caller re-arms in the same work-lane step.
export class TimerTable {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(TIMERS_SCHEMA);
  }

  due(kind: string, ref: string): number | null {
    const row = this.sql.exec<{ due_at: number }>('SELECT due_at FROM timers WHERE kind = ? AND ref = ?', kind, ref).toArray()[0];
    return row?.due_at ?? null;
  }

  set(kind: string, ref: string, at: number): void {
    check(kind, ref, at);
    this.sql.exec(`INSERT INTO timers (due_at, kind, ref) VALUES (?, ?, ?)
      ON CONFLICT(kind, ref) DO UPDATE SET due_at = excluded.due_at`, at, kind, ref);
  }

  // Never moves an existing row later.
  lower(kind: string, ref: string, at: number): void {
    check(kind, ref, at);
    this.sql.exec(`INSERT INTO timers (due_at, kind, ref) VALUES (?, ?, ?)
      ON CONFLICT(kind, ref) DO UPDATE SET due_at = min(due_at, excluded.due_at)`, at, kind, ref);
  }

  delete(kind: string, ref: string): void {
    check(kind, ref);
    this.sql.exec('DELETE FROM timers WHERE kind = ? AND ref = ?', kind, ref);
  }

  earliest(): number | null {
    const row = this.sql.exec<{ due_at: number }>('SELECT due_at FROM timers ORDER BY due_at, kind, ref LIMIT 1').toArray()[0];
    return row?.due_at ?? null;
  }

  // Due rows in run order, bounded by the timers_due index.
  dueRows(now: number, limit = TIMER_BATCH): TimerRow[] {
    return this.sql.exec<TimerRow>('SELECT due_at, kind, ref FROM timers WHERE due_at <= ? ORDER BY due_at, kind, ref LIMIT ?',
      now, limit).toArray();
  }
}
