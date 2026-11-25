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
// Each handler of another kind is raced against the earlier of this and the
// next journal_flush deadline; one that loses keeps running, but the alarm
// moves on and runs journal_flush when it is due.
export const TIMER_HANDLER_BUDGET_MS = 30_000;
// After this much of one alarm call, rows not yet started wait for an
// immediate re-arm, keeping a call well inside the platform's alarm limits.
export const TIMER_RUN_BUDGET_MS = 60_000;
// The mailbox journal's backup and restore lane: one row that carries the
// lane's next deadline (delta publication, snapshots, restore slices, backoff).
export const JOURNAL_FLUSH = 'journal_flush';
export const JOURNAL_FLUSH_REF = 'lane';

export type TimerRow = { due_at: number; kind: string; ref: string };

export type TimerRun = {
  ref: string;
  now: number;
  // Runs one synchronous storage step inside the mailbox work lane, in a
  // transaction, then re-arms the alarm. This is the handler's only way into
  // the work lane, so it can never hold the lane across a remote call.
  local<T>(step: (timers: TimerTable) => T): Promise<T>;
};

export type TimerKind = {
  // Runs one due row, outside the mailbox work lane: every storage read or
  // write goes through `timer.local`, and remote calls happen between steps.
  // The row is claimed at now + TIMER_RETRY_MS when the call starts. The
  // handler re-arms its own row (moves or deletes it) in its first step,
  // before it acts; a row it leaves in place waits for that claim, and a
  // handler that throws without moving it waits TIMER_RETRY_MS from the throw.
  // A call that outlives its race keeps the due time it set and is not
  // started again in this isolate until it settles.
  run(timer: TimerRun): Promise<void>;
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

  // Due rows in run order (optionally without one kind), bounded by the timers_due index.
  dueRows(now: number, limit = TIMER_BATCH, exceptKind = ''): TimerRow[] {
    return this.sql.exec<TimerRow>(`SELECT due_at, kind, ref FROM timers WHERE due_at <= ? AND kind <> ?
      ORDER BY due_at, kind, ref LIMIT ?`, now, exceptKind, limit).toArray();
  }
}
