import type { Idempotent } from '@kofra/mail-contract';

/** Retain the key if a user retries the same action after an ambiguous failure. */
export function mailAction() {
  let attempt: { fingerprint: string; options: Idempotent } | undefined;
  return {
    options(input: unknown): Idempotent {
      const fingerprint = JSON.stringify(input);
      if (!attempt || attempt.fingerprint !== fingerprint) {
        attempt = { fingerprint, options: { idempotencyKey: crypto.randomUUID() } };
      }
      return attempt.options;
    },
    clear() { attempt = undefined; },
  };
}
