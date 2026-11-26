import { MimeBusy, mimeAdmissionMs } from './mime-budget.ts';
import type { MailMime } from './object-reader.ts';

type Release = () => void;
type Purpose = 'body' | 'cid' | 'att';
type Flight = {
  key: string;
  sub: string;
  loading: boolean;
  members: number;
  bodies: number;
  parsed: PromiseWithResolvers<MailMime>;
  drained: PromiseWithResolvers<void>;
  release?: Release;
};
type Member = { flight: Flight; leader: boolean; purpose: Purpose; byteWaitMs: number };
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
    key: waiter.key, sub: waiter.sub, loading: true, members: 0, bodies: 0,
    parsed: Promise.withResolvers<MailMime>(), drained: Promise.withResolvers<void>(),
  };
  if (!existing) {
    flights.set(flight.key, flight);
    leaders.set(flight.sub, flight);
    // A leader can fail before anyone starts awaiting the parse.
    void flight.parsed.promise.catch(() => {});
  }
  flight.members++;
  if (waiter.purpose === 'body') flight.bodies++;
  return { flight, leader: !existing, purpose: waiter.purpose, byteWaitMs: waiter.until - now };
}

function leave({ flight, purpose }: Member) {
  if (purpose === 'body') flight.bodies--;
  if (--flight.members === 0) {
    flights.delete(flight.key);
    leaders.delete(flight.sub);
    flight.release?.();
    flight.drained.resolve();
  }
  drain();
}

function failLoad(flight: Flight, reason: unknown) {
  flight.loading = false;
  flight.parsed.reject(reason);
}

function drain() {
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
    if (member.leader) failLoad(member.flight, signal.reason);
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

/** Share only the verified parse. Each caller prepares its own scoped response. */
export async function shareMime<T>(key: string, sub: string, signal: AbortSignal,
    load: (install: (release: Release) => void, byteWaitMs: number) => Promise<MailMime>,
    prepare: (mail: MailMime) => T | Promise<T>, purpose: Purpose = 'body'): Promise<T> {
  const member = (await admit(key, sub, signal, purpose))();
  const { flight, leader, byteWaitMs } = member;
  const interrupted = Promise.withResolvers<never>();
  void interrupted.promise.catch(() => {});
  const abort = () => interrupted.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  let prepared: T;
  try {
    if (leader) {
      try {
        const mail = await load(release => { flight.release = release; }, byteWaitMs);
        // A completed verified parse may still serve live members if its leader cancelled.
        flight.loading = false;
        flight.parsed.resolve(mail);
      } catch (error) { failLoad(flight, error); }
    }
    const mail = await Promise.race([flight.parsed.promise, interrupted.promise]);
    signal.throwIfAborted();
    prepared = await prepare(mail);
  } finally {
    // Aborting a waiter can stop its wait for a parse, but cannot release a
    // charge for a load or preparation that has not settled yet.
    signal.removeEventListener('abort', abort);
    leave(member);
  }
  await flight.drained.promise;
  signal.throwIfAborted();
  return prepared;
}
