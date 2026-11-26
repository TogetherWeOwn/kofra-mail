import { MAX_RAW_BYTES } from '../../mail-backend/src/bytes.ts';

type Release = () => void;
type Claim = () => Release;
type Waiter = { bytes: number; until: number; grant(release: Release): void; fail(reason: unknown): void };
const admissionMs = 2_000;
const waiting: Waiter[] = [];
let held = 0;
let peak = 0;

export class MimeBusy extends Error {
  constructor() { super('raw MIME capacity unavailable'); }
}

export function mimeBudgetUsage() { return { inFlight: held, peak }; }

function drain() {
  // Charge an aggregate of one maximum-sized raw message during processing,
  // not during transfer. Recheck the deadline even if a timer was delayed.
  while (waiting.length) {
    const waiter = waiting[0];
    if (Date.now() >= waiter.until) {
      waiting.shift();
      waiter.fail(new MimeBusy());
      continue;
    }
    if (held + waiter.bytes > MAX_RAW_BYTES) break;
    waiting.shift();
    held += waiter.bytes;
    peak = Math.max(peak, held);
    let released = false;
    waiter.grant(() => {
      if (released) return;
      released = true;
      held -= waiter.bytes;
      drain();
    });
  }
}

/** Grants queue space only; it never transfers a stream or I/O across requests. Claim immediately before reading. */
export async function reserveMime(bytes: number, signal: AbortSignal): Promise<Claim> {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_RAW_BYTES) throw new Error('invalid MIME size');
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<Claim>();
  const waiter: Waiter = {
    bytes, until: Date.now() + admissionMs, fail: reject,
    grant(release) {
      // Keep the charge revocable until the admitted request is about to allocate.
      signal.addEventListener('abort', release, { once: true });
      resolve(() => {
        signal.removeEventListener('abort', release);
        if (signal.aborted) { release(); throw signal.reason; }
        return release;
      });
    },
  };
  function withdraw(reason: unknown) {
    const index = waiting.indexOf(waiter);
    if (index === -1) return;
    waiting.splice(index, 1);
    waiter.fail(reason);
    drain();
  }
  function cancel() { withdraw(signal.reason); }
  const timer = setTimeout(() => withdraw(new MimeBusy()), admissionMs);
  signal.addEventListener('abort', cancel, { once: true });
  waiting.push(waiter);
  drain();
  try { return await promise; }
  finally {
    // Clear request-owned resources in the waiting request, not the releaser.
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
