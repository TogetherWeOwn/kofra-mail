import { MAX_RAW_BYTES } from '../../mail-backend/src/bytes.ts';

type Release = () => void;
type Claim = () => Release;
type Waiter = { bytes: number; until: number; grant(release: Release): void; fail(reason: unknown): void };
export const mimeAdmissionMs = 2_000;
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
export async function reserveMime(bytes: number, signal: AbortSignal, waitMs = mimeAdmissionMs): Promise<Claim> {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_RAW_BYTES) throw new Error('invalid MIME size');
  signal.throwIfAborted();
  // A caller that already used its wait budget may still take immediately free bytes.
  if (waitMs === 0 && (waiting.length || held + bytes > MAX_RAW_BYTES)) throw new MimeBusy();
  const { promise, resolve, reject } = Promise.withResolvers<Claim>();
  let granted: Release | undefined;
  const waiter: Waiter = {
    bytes, until: waitMs === 0 ? Infinity : Date.now() + waitMs, fail: reject,
    grant(release) {
      // Grants may come from another request; only the owner touches its signal.
      granted = release;
      resolve(() => {
        signal.removeEventListener('abort', cancel);
        signal.throwIfAborted();
        granted = undefined;
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
  function cancel() {
    const release = granted;
    if (!release) { withdraw(signal.reason); return; }
    granted = undefined;
    release();
  }
  const timer = setTimeout(() => withdraw(new MimeBusy()), waitMs);
  signal.addEventListener('abort', cancel, { once: true });
  waiting.push(waiter);
  drain();
  try { return await promise; }
  finally {
    // Clear request-owned resources in the waiting request, not the releaser.
    clearTimeout(timer);
    if (!granted) signal.removeEventListener('abort', cancel);
  }
}
