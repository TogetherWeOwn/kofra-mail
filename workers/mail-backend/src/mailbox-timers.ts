import { TIMERS_SCHEMA } from './mailbox-schema.ts';

// One mailbox object has one Durable Object alarm. Every scheduled job is a row
// here, and the alarm is armed at the earliest row.
//
// Timers are local scheduling state: they are not journalled and not copied
// into snapshots. Every kind's rows must be rebuildable from journalled state;
// a restore clears them and each kind's `rebuild` recreates them in the
// transaction that finishes the restore.

// Rows one alarm call dispatches at most, journal_flush runs included; any
// further due rows wake the next call at once.
export const TIMER_BATCH = 64;
// A row its handler did not move (or whose handler threw) waits this long.
export const TIMER_RETRY_MS = 60_000;
// Each handler of another kind is raced against the earlier of this and the
// next journal_flush deadline; one that loses keeps running, but the alarm
// moves on and runs journal_flush when it is due.
export const TIMER_HANDLER_BUDGET_MS = 30_000;
// After this much of one alarm call, rows not yet started wait for an
// immediate re-arm. The bound is soft: a handler started just before it may
// race for TIMER_HANDLER_BUDGET_MS more, and journal_flush runs are not cut.
export const TIMER_RUN_BUDGET_MS = 60_000;
// A call still running blocks a new start of the same (kind, ref) in this
// isolate until it settles or this long has passed since it started.
export const TIMER_LEASE_MS = 5 * 60_000;
// The mailbox journal's backup and restore lane: one row that carries the
// lane's next deadline (delta publication, snapshots, restore slices, backoff).
export const JOURNAL_FLUSH = 'journal_flush';
export const JOURNAL_FLUSH_REF = 'lane';

export type TimerRow = { due_at: number; kind: string; ref: string; claim?: string | null };

// A step that returns a promise is a type error (and refused at run time):
// it would hold the work lane open across I/O.
type SyncStep<T> = T extends PromiseLike<unknown> ? [never] : [];

export type TimerRun = {
  ref: string;
  now: number;
  // Runs one synchronous storage step inside the mailbox work lane, in a
  // transaction, then re-arms the alarm. This is the handler's only way into
  // the work lane, so it can never hold the lane across a remote call. The
  // TimerTable it gets stops working when the step returns.
  local<T>(step: (timers: TimerTable) => T, ...sync: SyncStep<T>): Promise<T>;
};

export type TimerKind = {
  // Runs one due row, outside the mailbox work lane: every storage read or
  // write goes through `timer.local`, and remote calls happen between steps.
  // The row is claimed at now + TIMER_RETRY_MS when the call starts. The
  // handler re-arms its own row (moves or deletes it) in its first step,
  // before it acts; a row it leaves in place waits for that claim. A handler
  // that throws while the row is still claimed for it, even after losing its
  // race, is retried TIMER_RETRY_MS after the throw; one that already moved
  // its row keeps that schedule. A call that outlives its race keeps running
  // and is not started again in this isolate until it settles or
  // TIMER_LEASE_MS has passed.
  run(timer: TimerRun): Promise<void>;
  // Recreates this kind's rows from restored, journalled state. Runs
  // synchronously inside the transaction that finishes a restore; a rebuild
  // that returns a promise is a type error and fails the restore step, and
  // its table is revoked when the transaction ends.
  rebuild?(timers: TimerTable, now: number): undefined;
};

const KIND = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_REF = 256;

export function validTimerKind(kind: unknown): kind is string { return typeof kind === 'string' && KIND.test(kind); }

function check(kind: string, ref: string, at?: number) {
  if (!validTimerKind(kind) || typeof ref !== 'string' || !ref.length || ref.length > MAX_REF ||
      // The platform alarm takes only positive times; anything due now is armed as overdue.
      (at !== undefined && (!Number.isSafeInteger(at) || at < 1))) {
    throw new Error('Invalid mailbox timer');
  }
}

// Synchronous row operations, usable inside a storage transaction. Changing a
// row does not arm the alarm; the caller re-arms in the same work-lane step.
// Every write except a claim clears the row's claim, so an alarm call can tell
// that a row it claimed was replaced, even at the same due time.
export class TimerTable {
  private revoked = false;

  constructor(private readonly sql: SqlStorage) {
    sql.exec(TIMERS_SCHEMA);
  }

  // Stops this writer: a step's table cannot be used after the step returns.
  revoke(): void { this.revoked = true; }

  private live(): SqlStorage {
    if (this.revoked) throw new Error('Mailbox timer step has ended');
    return this.sql;
  }

  due(kind: string, ref: string): number | null {
    const row = this.live().exec<{ due_at: number }>('SELECT due_at FROM timers WHERE kind = ? AND ref = ?', kind, ref).toArray()[0];
    return row?.due_at ?? null;
  }

  set(kind: string, ref: string, at: number): void {
    check(kind, ref, at);
    this.live().exec(`INSERT INTO timers (due_at, kind, ref, claim, requested) VALUES (?, ?, ?, NULL, NULL)
      ON CONFLICT(kind, ref) DO UPDATE SET due_at = excluded.due_at, claim = NULL, requested = NULL`, at, kind, ref);
  }

  // Never moves an existing row later. A lower that changes nothing keeps the
  // claim; on a claimed row it is recorded as `requested`, so the claim's
  // temporary fallback time never hides it.
  lower(kind: string, ref: string, at: number): void {
    check(kind, ref, at);
    this.live().exec(`INSERT INTO timers (due_at, kind, ref, claim, requested) VALUES (?, ?, ?, NULL, NULL)
      ON CONFLICT(kind, ref) DO UPDATE SET
        due_at = min(due_at, excluded.due_at),
        claim = CASE WHEN excluded.due_at < due_at THEN NULL ELSE claim END,
        requested = CASE WHEN excluded.due_at < due_at THEN NULL WHEN claim IS NULL THEN requested
          ELSE min(coalesce(requested, excluded.due_at), excluded.due_at) END`, at, kind, ref);
  }

  delete(kind: string, ref: string): void {
    check(kind, ref);
    this.live().exec('DELETE FROM timers WHERE kind = ? AND ref = ?', kind, ref);
  }

  // Claims a row for one alarm call: moves it to `at` under `token`. A
  // requested deadline is kept for when the claim settles.
  claim(kind: string, ref: string, at: number, token: string): void {
    check(kind, ref, at);
    this.live().exec(`INSERT INTO timers (due_at, kind, ref, claim) VALUES (?, ?, ?, ?)
      ON CONFLICT(kind, ref) DO UPDATE SET due_at = excluded.due_at, claim = excluded.claim`, at, kind, ref, token);
  }

  owned(kind: string, ref: string, token: string): boolean {
    return this.live().exec('SELECT 1 FROM timers WHERE kind = ? AND ref = ? AND claim = ?', kind, ref, token).toArray().length === 1;
  }

  // Moves a row only while it is still claimed under `token`, to `at` or an earlier requested deadline.
  setIfOwned(kind: string, ref: string, token: string, at: number): void {
    check(kind, ref, at);
    this.live().exec(`UPDATE timers SET due_at = min(?, coalesce(requested, ?)), claim = NULL, requested = NULL
      WHERE kind = ? AND ref = ? AND claim = ?`, at, at, kind, ref, token);
  }

  // Ends a claim under `token`: the row keeps a deadline requested during the claim, or takes `fallback`.
  settleIfOwned(kind: string, ref: string, token: string, fallback: number): void {
    check(kind, ref, fallback);
    this.live().exec(`UPDATE timers SET due_at = coalesce(requested, ?), claim = NULL, requested = NULL
      WHERE kind = ? AND ref = ? AND claim = ?`, fallback, kind, ref, token);
  }

  // Deletes a row claimed under `token`, unless a deadline was requested during the claim.
  deleteIfOwned(kind: string, ref: string, token: string): void {
    this.live().exec(`UPDATE timers SET due_at = requested, claim = NULL, requested = NULL
      WHERE kind = ? AND ref = ? AND claim = ? AND requested IS NOT NULL`, kind, ref, token);
    this.live().exec('DELETE FROM timers WHERE kind = ? AND ref = ? AND claim = ?', kind, ref, token);
  }

  earliest(): number | null {
    const row = this.live().exec<{ due_at: number }>('SELECT due_at FROM timers ORDER BY due_at, kind, ref LIMIT 1').toArray()[0];
    return row?.due_at ?? null;
  }

  // Due rows in run order (optionally without one kind), bounded by the timers_due index.
  dueRows(now: number, limit = TIMER_BATCH, exceptKind = ''): TimerRow[] {
    return this.live().exec<TimerRow>(`SELECT due_at, kind, ref, claim FROM timers WHERE due_at <= ? AND kind <> ?
      ORDER BY due_at, kind, ref LIMIT ?`, now, exceptKind, limit).toArray();
  }
}
