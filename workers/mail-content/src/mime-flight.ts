import { MimeBusy, mimeAdmissionMs } from './mime-budget.ts';
import type { MailMime } from './object-reader.ts';

type Release = () => void;
type Purpose = 'body' | 'cid' | 'att';
type Flight = {
  key: string;
  sub: string;
  loadStartedAt?: number;
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
const loadTimeoutMs = 25_000;
const followerTimeoutMs = 27_000;
const watchdogMs = 30_000;
class SharedLoadUnavailable extends Error {}
type Claim = () => Member;
type Waiter = {
  key: string; sub: string; purpose: Purpose; until: number;
  grant(member: Member): void;
  reject(reason: unknown): void;
};

const flights = new Map<string, Flight>();
// Includes stale generations that are no longer advertised to new members.
const activeLoads = new Set<Flight>();
const leaders = new Map<string, Flight>();
const waiting: Waiter[] = [];

function take(waiter: Waiter, now: number): Member | undefined {
  const lead = leaders.get(waiter.sub);
  if (lead && lead.key !== waiter.key) return;
  let existing = flights.get(waiter.key);
  if (existing?.loadActive && now - existing.loadStartedAt! >= followerTimeoutMs) {
    closeStale(existing);
    existing = undefined;
  }
  if (existing && (!existing.loading || existing.members >= 16 || (waiter.purpose === 'body' && existing.bodies >= 2))) return;
  const flight: Flight = existing ?? {
    key: waiter.key, sub: waiter.sub, loading: true, started: false, loadActive: false,
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
  if (flights.get(flight.key) === flight) flights.delete(flight.key);
  if (leaders.get(flight.sub) === flight) leaders.delete(flight.sub);
  activeLoads.delete(flight);
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

function closeStale(flight: Flight) {
  if (!flight.loadActive || flight.retired) return;
  // Close admission, not accounting: a successor uses the ordinary byte
  // gate while this generation retains its charge until settlement/watchdog.
  flight.loading = false;
  if (flights.get(flight.key) === flight) flights.delete(flight.key);
}

function expire(flight: Flight) {
  // The watchdog is only for a lost loader. A settled load's prepares keep
  // the charge, even if they run longer than the load watchdog deadline.
  if (flight.retired || !flight.loadActive) return;
  const error = new DOMException('raw MIME load watchdog expired', 'TimeoutError');
  flight.expired = error;
  flight.stopLoad?.(error);
  retire(flight);
  console.warn(JSON.stringify({ metric: 'mail_content_mime_flight_watchdog', count: 1 }));
}

function watch(flight: Flight, retry?: () => void): { drained: Promise<void>; arm: () => void; detach: () => void; clear: () => void } {
  if (flight.retired) return { drained: Promise.resolve(), arm() {}, detach() {}, clear() {} };
  // A live follower owns its timers and settlement notification. They must
  // still work after the producer's request and I/O context disappear.
  const done = Promise.withResolvers<void>();
  flight.drained.add(done.resolve);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let follower: ReturnType<typeof setTimeout> | undefined;
  return {
    drained: done.promise,
    arm() {
      const started = flight.loadStartedAt;
      if (!flight.loadActive || started === undefined) return;
      const elapsed = Date.now() - started;
      watchdog = setTimeout(() => { expire(flight); drain(); }, Math.max(0, watchdogMs - elapsed));
      if (retry) follower = setTimeout(() => {
        if (!flight.loadActive || flight.retired) return;
        closeStale(flight);
        retry();
      }, Math.max(0, followerTimeoutMs - elapsed));
    },
    detach() { clearTimeout(follower); flight.drained.delete(done.resolve); done.resolve(); },
    clear() { clearTimeout(watchdog); },
  };
}

function drain() {
  // Recover even if the runtime dropped the producer's request-owned timers.
  const nowMs = Date.now();
  for (const flight of activeLoads) {
    const elapsed = nowMs - flight.loadStartedAt!;
    if (elapsed >= watchdogMs) expire(flight);
    else if (elapsed >= followerTimeoutMs) closeStale(flight);
  }
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
  const startedAt = Date.now();
  flight.started = true;
  flight.loadActive = true;
  flight.loadStartedAt = startedAt;
  activeLoads.add(flight);
  // The controller is owned by the flight, but only this invocation touches
  // it. Another request may settle stopLoad's plain JS promise.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('raw MIME load timed out', 'TimeoutError')), loadTimeoutMs);
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
      controller.signal.throwIfAborted();
      if (Date.now() - startedAt >= loadTimeoutMs) throw new DOMException('raw MIME load timed out', 'TimeoutError');
      if (!flight.retired) flight.outcome = { mail };
    } catch (error) {
      if (!flight.retired) flight.outcome = { error };
    } finally {
      clearTimeout(timeout);
      activeLoads.delete(flight);
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

/** Share only the verified parse. A failed shared load gets at most one independent attempt. */
export async function shareMime<T>(key: string, sub: string, signal: AbortSignal, load: Load,
    prepare: (mail: MailMime) => T | Promise<T>, purpose: Purpose = 'body', keepAlive?: KeepAlive): Promise<T> {
  try {
    return await useFlight(key, sub, signal, load, prepare, purpose, keepAlive);
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof SharedLoadUnavailable)) throw error;
  }
  // Use the same admission gate. Multiple recovering followers join the
  // same successor when it is open, not one replacement per requester.
  try { return await useFlight(key, sub, signal, load, prepare, purpose, keepAlive); }
  catch {
    signal.throwIfAborted();
    throw new MimeBusy();
  }
}

async function useFlight<T>(key: string, sub: string, signal: AbortSignal, load: Load,
    prepare: (mail: MailMime) => T | Promise<T>, purpose: Purpose, keepAlive?: KeepAlive): Promise<T> {
  const member = (await admit(key, sub, signal, purpose))();
  const { flight, byteWaitMs } = member;
  const producer = !flight.started && !flight.retired;
  const parsed = Promise.withResolvers<MailMime>();
  const interrupted = Promise.withResolvers<never>();
  const watchdog = watch(flight, producer ? undefined : () => interrupted.reject(new SharedLoadUnavailable()));
  let activeWork = 0;
  let detached = false;
  const retain = (work: Promise<unknown>) => {
    activeWork++;
    const settled = work.then(() => {}, () => {}).then(() => {
      if (--activeWork === 0 && detached) watchdog.clear();
    });
    keepAlive?.(settled);
  };
  void parsed.promise.catch(() => {});
  void interrupted.promise.catch(() => {});
  const abort = () => interrupted.reject(signal.reason);
  const loadError = (error: unknown) => producer ? error : new SharedLoadUnavailable();
  const notify = () => {
    if (flight.expired) interrupted.reject(loadError(flight.expired));
    else if (flight.outcome) {
      if ('mail' in flight.outcome) parsed.resolve(flight.outcome.mail);
      else parsed.reject(loadError(flight.outcome.error));
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
      if (producer) startLoad(flight, load, byteWaitMs, retain);
      watchdog.arm();
      const mail = await Promise.race([interrupted.promise, parsed.promise]);
      signal.throwIfAborted();
      if (flight.expired) throw loadError(flight.expired);
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
