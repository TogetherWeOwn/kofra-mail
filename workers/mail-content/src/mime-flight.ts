import { MimeBusy, mimeAdmissionMs } from './mime-budget.ts';
import type { MailMime } from './object-reader.ts';

type Release = () => void;
type Purpose = 'body' | 'cid' | 'att';
type Flight = {
  key: string;
  sub: string;
  deadline: number;
  loading: boolean;
  started: boolean;
  loadActive: boolean;
  preparing: number;
  members: number;
  bodies: number;
  retired: boolean;
  outcome?: { mail: MailMime } | { error: unknown };
  stopLoad?: (reason: DOMException) => void;
  expired?: DOMException;
  notify: Set<() => void>;
  drained: Set<() => void>;
  release?: Release;
};
type Member = { flight: Flight; purpose: Purpose; byteWaitMs: number };
type KeepAlive = (work: Promise<void>) => void;
const watchdogMs = 75_000;
type Claim = () => Member;
type Waiter = {
  key: string; sub: string; purpose: Purpose; until: number;
  grant(member: Member): void;
  reject(reason: unknown): void;
};

const flights = new Map<string, Flight>();
const leaders = new Map<string, Flight>();
const waiting: Waiter[] = [];

function take(waiter: Waiter, now: number): Member | undefined {
  const lead = leaders.get(waiter.sub);
  if (lead && lead.key !== waiter.key) return;
  const existing = flights.get(waiter.key);
  if (existing && (!existing.loading || existing.members >= 16 || (waiter.purpose === 'body' && existing.bodies >= 2))) return;
  const flight: Flight = existing ?? {
    key: waiter.key, sub: waiter.sub, deadline: now + watchdogMs, loading: true, started: false, loadActive: false,
    preparing: 0, members: 0, bodies: 0, retired: false, notify: new Set(), drained: new Set(),
  };
  if (!existing) {
    flights.set(flight.key, flight);
    leaders.set(flight.sub, flight);
  }
  flight.members++;
  if (waiter.purpose === 'body') flight.bodies++;
  return { flight, purpose: waiter.purpose, byteWaitMs: waiter.until - now };
}

function retire(flight: Flight) {
  if (flight.retired) return;
  flight.retired = true;
  flights.delete(flight.key);
  leaders.delete(flight.sub);
  flight.release?.();
  flight.release = undefined;
  flight.stopLoad = undefined;
  flight.outcome = undefined;
  for (const notify of flight.notify) notify();
  flight.notify.clear();
  for (const done of flight.drained) done();
  flight.drained.clear();
}

function settle(flight: Flight) {
  if (!flight.members && !flight.loadActive && !flight.preparing) retire(flight);
  drain();
}

function leave({ flight, purpose }: Member) {
  if (purpose === 'body') flight.bodies--;
  if (--flight.members === 0 && flight.loadActive && !flight.retired) {
    flight.loading = false;
    flight.stopLoad?.(new DOMException('raw MIME flight has no readers', 'AbortError'));
  }
  settle(flight);
}

function expire(flight: Flight) {
  if (flight.retired) return;
  const error = new DOMException('raw MIME flight deadline exceeded', 'TimeoutError');
  flight.expired = error;
  flight.stopLoad?.(error);
  retire(flight);
  console.warn(JSON.stringify({ metric: 'mail_content_mime_flight_watchdog', count: 1 }));
}

function watch(flight: Flight): { drained: Promise<void>; detach: () => void; clear: () => void } {
  if (flight.retired) return { drained: Promise.resolve(), detach() {}, clear() {} };
  // A live follower has its own timer and settlement notification even if
  // the load's invocation disappears. Do not await its I/O-scoped promises.
  const done = Promise.withResolvers<void>();
  flight.drained.add(done.resolve);
  const timer = setTimeout(() => { expire(flight); drain(); }, Math.max(0, flight.deadline - Date.now()));
  return {
    drained: done.promise,
    detach() { flight.drained.delete(done.resolve); done.resolve(); },
    clear() { clearTimeout(timer); },
  };
}

function drain() {
  // If the runtime dropped all request-owned timers, reap expired flights
  // before the next admission; no new request waits on a stale charge.
  const nowMs = Date.now();
  for (const flight of flights.values()) if (nowMs >= flight.deadline) expire(flight);
  // Do not let a blocked key or subject sit in front of an independent mailbox.
  for (let i = 0; i < waiting.length;) {
    const waiter = waiting[i];
    const now = Date.now();
    if (now >= waiter.until) {
      waiting.splice(i, 1);
      waiter.reject(new MimeBusy());
      continue;
    }
    const member = take(waiter, now);
    if (!member) { i++; continue; }
    waiting.splice(i, 1);
    waiter.grant(member);
  }
}

async function admit(key: string, sub: string, signal: AbortSignal, purpose: Purpose): Promise<Claim> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<Claim>();
  let granted: Member | undefined;
  const waiter: Waiter = {
    key, sub, purpose, until: Date.now() + mimeAdmissionMs, reject,
    grant(member) {
      // Drain can run in another request. Share only JS state, never touch its signal there.
      granted = member;
      resolve(() => {
        signal.removeEventListener('abort', abort);
        signal.throwIfAborted();
        granted = undefined;
        return member;
      });
    },
  };
  function withdraw(reason: unknown) {
    const index = waiting.indexOf(waiter);
    if (index === -1) return;
    waiting.splice(index, 1);
    reject(reason);
    drain();
  }
  function abort() {
    const member = granted;
    if (!member) { withdraw(signal.reason); return; }
    // Revoke only an unclaimed grant; no load or preparation started.
    granted = undefined;
    leave(member);
  }
  const timer = setTimeout(() => withdraw(new MimeBusy()), mimeAdmissionMs);
  signal.addEventListener('abort', abort, { once: true });
  waiting.push(waiter);
  drain();
  try { return await promise; }
  finally {
    clearTimeout(timer);
    if (!granted) signal.removeEventListener('abort', abort);
  }
}

type Load = (install: (release: Release) => void, byteWaitMs: number, signal: AbortSignal) => Promise<MailMime>;

function startLoad(flight: Flight, load: Load, byteWaitMs: number, retain: (work: Promise<void>) => void) {
  flight.started = true;
  flight.loadActive = true;
  // The controller is owned by the flight, but only this invocation touches
  // it. Another request may settle stopLoad's plain JS promise.
  const controller = new AbortController();
  const stop = Promise.withResolvers<DOMException | undefined>();
  flight.stopLoad = stop.resolve;
  void stop.promise.then(reason => { if (reason) controller.abort(reason); }).catch(() => {});
  const work = (async () => {
    try {
      const mail = await load(release => {
        if (flight.retired) {
          release();
          throw new DOMException('raw MIME flight already expired', 'TimeoutError');
        }
        flight.release = release;
      }, byteWaitMs, controller.signal);
      if (!flight.retired) flight.outcome = { mail };
    } catch (error) {
      if (!flight.retired) flight.outcome = { error };
    } finally {
      flight.loading = false;
      flight.loadActive = false;
      flight.stopLoad = undefined;
      stop.resolve(undefined);
      for (const notify of flight.notify) notify();
      settle(flight);
    }
  })();
  retain(work);
}

/** Share only the verified parse. Each caller prepares its own scoped response. */
export async function shareMime<T>(key: string, sub: string, signal: AbortSignal, load: Load,
    prepare: (mail: MailMime) => T | Promise<T>, purpose: Purpose = 'body', keepAlive?: KeepAlive): Promise<T> {
  const member = (await admit(key, sub, signal, purpose))();
  const { flight, byteWaitMs } = member;
  const watchdog = watch(flight);
  let activeWork = 0;
  let detached = false;
  const retain = (work: Promise<unknown>) => {
    activeWork++;
    const settled = work.then(() => {}, () => {}).then(() => {
      if (--activeWork === 0 && detached) watchdog.clear();
    });
    keepAlive?.(settled);
  };
  const parsed = Promise.withResolvers<MailMime>();
  const interrupted = Promise.withResolvers<never>();
  void parsed.promise.catch(() => {});
  void interrupted.promise.catch(() => {});
  const abort = () => interrupted.reject(signal.reason);
  const notify = () => {
    if (flight.expired) interrupted.reject(flight.expired);
    else if (flight.outcome) {
      if ('mail' in flight.outcome) parsed.resolve(flight.outcome.mail);
      else parsed.reject(flight.outcome.error);
    }
  };
  signal.addEventListener('abort', abort, { once: true });
  if (!flight.retired) flight.notify.add(notify);
  notify();
  try {
    let prepared: T;
    try {
      // An unclaimed leader can cancel before any I/O exists. A live member
      // claims the load in its own invocation rather than failing the flight.
      if (!flight.started && !flight.retired) startLoad(flight, load, byteWaitMs, retain);
      const mail = await Promise.race([interrupted.promise, parsed.promise]);
      signal.throwIfAborted();
      if (flight.expired) throw flight.expired;
      flight.preparing++;
      const work = (async () => {
        try { return await prepare(mail); }
        finally { flight.preparing--; settle(flight); }
      })();
      retain(work);
      prepared = await Promise.race([interrupted.promise, work]);
    } finally { leave(member); }
    // All active work has really settled before a response starts transfer.
    await Promise.race([interrupted.promise, watchdog.drained]);
    signal.throwIfAborted();
    return prepared;
  } finally {
    flight.notify.delete(notify);
    // Settle this request's notifications here, not in a surviving member.
    // Its timer remains only while work owned by this invocation still runs.
    detached = true;
    watchdog.detach();
    if (activeWork === 0) watchdog.clear();
    parsed.reject(new DOMException('MIME response ended', 'AbortError'));
    signal.removeEventListener('abort', abort);
  }
}
