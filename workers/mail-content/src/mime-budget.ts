import { MAX_RAW_BYTES } from '../../mail-backend/src/bytes.ts';

type Release = () => void;
type Claim = () => Release;
type Waiter = { bytes: number; grant(release: Release): void };
const waiting: Waiter[] = [];
let held = 0;

export function mimeInFlight(): number { return held; }

function drain() {
  // Reserve an aggregate of one maximum-sized raw message. A decoded MIME
  // part must not outlive its charge; body, CID and att responses share it.
  while (waiting.length && held + waiting[0].bytes <= MAX_RAW_BYTES) {
    const waiter = waiting.shift()!;
    held += waiter.bytes;
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
export function reserveMime(bytes: number, signal: AbortSignal): Promise<Claim> {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_RAW_BYTES) return Promise.reject(new Error('invalid MIME size'));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { bytes, grant(release) {
      signal.removeEventListener('abort', cancel);
      // The waiting request may be cancelled before it resumes from the grant.
      // Keep the charge revocable until that request is about to allocate.
      signal.addEventListener('abort', release, { once: true });
      resolve(() => {
        signal.removeEventListener('abort', release);
        if (signal.aborted) { release(); throw signal.reason; }
        return release;
      });
    } };
    function cancel() {
      const index = waiting.indexOf(waiter);
      if (index === -1) return;
      waiting.splice(index, 1);
      reject(signal.reason);
      drain();
    }
    signal.addEventListener('abort', cancel, { once: true });
    waiting.push(waiter);
    drain();
  });
}
