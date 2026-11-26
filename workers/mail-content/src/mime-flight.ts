import { MimeBusy } from './mime-budget.ts';
import type { MailMime } from './object-reader.ts';

type Release = () => void;
type Flight = {
  loading: boolean;
  members: number;
  parsed: PromiseWithResolvers<MailMime>;
  drained: PromiseWithResolvers<void>;
  release?: Release;
};
type Subject = { flight: Flight; members: number; canJoinOnce: boolean };

const flights = new Map<string, Flight>();
const subjects = new Map<string, Subject>();

/** Share only the verified parse; network I/O and response preparation remain in their own requests. */
export async function shareMime<T>(key: string, sub: string, signal: AbortSignal,
    load: (install: (release: Release) => void) => Promise<MailMime>, prepare: (mail: MailMime) => T | Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const existing = flights.get(key);
  const prior = subjects.get(sub);
  if ((existing && !existing.loading) || (prior && (prior.flight !== existing || !prior.canJoinOnce))) throw new MimeBusy();

  const flight: Flight = existing ?? {
    loading: true, members: 0, parsed: Promise.withResolvers<MailMime>(), drained: Promise.withResolvers<void>(),
  };
  const leader = !existing;
  if (leader) {
    flights.set(key, flight);
    // The leader may fail before any participant starts awaiting the parse.
    void flight.parsed.promise.catch(() => {});
  }
  const subject = prior ?? { flight, members: 0, canJoinOnce: leader };
  if (prior) subject.canJoinOnce = false;
  subjects.set(sub, subject);
  subject.members++;
  flight.members++;

  let joined = true;
  const leave = () => {
    if (!joined) return;
    joined = false;
    if (--subject.members === 0) subjects.delete(sub);
    if (--flight.members === 0) {
      flights.delete(key);
      flight.release?.();
      flight.drained.resolve();
    }
  };
  const failLoad = (reason: unknown) => {
    if (!flight.loading) return;
    flight.loading = false;
    flight.parsed.reject(reason);
  };
  const interrupted = Promise.withResolvers<never>();
  void interrupted.promise.catch(() => {});
  const abandon = () => {
    if (leader) failLoad(signal.reason);
    interrupted.reject(signal.reason);
    leave();
  };
  signal.addEventListener('abort', abandon, { once: true });
  let prepared: T;
  try {
    if (leader) {
      try {
        const mail = await load(release => {
          if (signal.aborted) { release(); throw signal.reason; }
          flight.release = release;
        });
        signal.throwIfAborted();
        flight.loading = false;
        flight.parsed.resolve(mail);
      } catch (error) { failLoad(error); }
    }
    const mail = await Promise.race([flight.parsed.promise, interrupted.promise]);
    signal.throwIfAborted();
    prepared = await prepare(mail);
  } finally {
    signal.removeEventListener('abort', abandon);
    leave();
  }
  // A coalesced parse is released before any of its responses starts transfer.
  await flight.drained.promise;
  signal.throwIfAborted();
  return prepared;
}
