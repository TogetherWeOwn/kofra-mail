import { API_PREFIX, ROUTES } from '../../contracts/mail-api/src/routes.ts';
import { failures, isEntryPoint, isRecord, report, targetOrigin, type Verdict } from './cli.ts';
import { EXPECTED_BUCKETS, isBucket, refusalBand, type Bucket } from './expected-buckets.ts';

const operationByBucket = {
  reads: 'getDraft',
  writes: 'createDraft',
  uploads: 'createUpload',
  sends: 'sendDraft',
  undo: 'undoSend',
  undo_flood: 'undoSend',
  admin_writes: 'addDomain',
} as const satisfies Record<Bucket, keyof typeof ROUTES>;
const baseBuckets: Bucket[] = ['reads', 'writes', 'admin_writes'];
// Buckets up to this many requests per attempt go one at a time, so the client
// sees refusals in the limiter's own order. Larger ones (the 600 buckets) go
// eight at a time to fit inside one period; reordering inside a batch is at most
// seven positions, well under their band's 60-request margin below the limit.
const sequentialUpTo = 200;
const parallel = 8;
type Session = { cookie?: string; csrf?: string };

type Outcome = 'pass' | 'late' | 'fail';
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function checkHttp(baseUrl: string | undefined, buckets: readonly Bucket[], session: Session,
  request = fetch, sleep = wait, attemptMs?: (period: number) => number): Promise<Verdict[]> {
  const origin = targetOrigin(baseUrl);
  if (!origin || !session.cookie || !session.csrf) return failures(buckets);
  // Every undo request also spends the account user's flood budget. Do not let
  // one test prime that counter and invalidate the other test's threshold.
  if (buckets.includes('undo') && buckets.includes('undo_flood')) return failures(buckets);
  const headers = { cookie: session.cookie, 'x-csrf-token': session.csrf, origin };
  const verdicts: Verdict[] = [];
  for (const bucket of buckets) {
    let pass = false;
    try {
      const { limit, period } = EXPECTED_BUCKETS[bucket];
      const route = ROUTES[operationByBucket[bucket]];
      const read = route.method === 'GET';
      // Fail without sending a write if the contract loses its precondition.
      if (!read && route.idempotency !== 'required' && route.ifMatch !== 'required') {
        verdicts.push({ bucket, pass });
        continue;
      }
      const notFoundId = crypto.randomUUID();
      const { min, max } = refusalBand(limit);
      const batchSize = max + 1 <= sequentialUpTo ? 1 : parallel;
      // One attempt sends at most max + 1 requests, up to eight at a time, so a
      // 600-request bucket finishes well inside one period. The counters are
      // approximate and an attempt can straddle a counter window, so the check
      // only confirms enforcement: at least one admission, then a refusal by
      // max. Anything else (no admission, a refusal after max, or none) can come
      // from a window boundary or a saturated window, and gets one retry after a
      // full period; the retry decides.
      const attempt = async (): Promise<Outcome> => {
        // A bad answer or a failed request ends the attempt at once: it aborts the
        // requests still in flight instead of waiting for the batch.
        const stop = new AbortController();
        const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(attemptMs?.(period) ?? period * 1000)]);
        const send = () => {
          const id = bucket === 'undo_flood' ? crypto.randomUUID() : notFoundId;
          const path = route.path.replaceAll(/\{[a-zA-Z]+\}/g, id);
          // Deliberately no body, Idempotency-Key or If-Match.
          return request(new URL(`${API_PREFIX}${path}`, origin), { method: route.method, headers, redirect: 'manual', signal });
        };
        const classify = async (response: Response): Promise<'admitted' | 'refused' | 'bad'> => {
          if (response.status === (read ? 404 : 428)) { await response.body?.cancel(); return 'admitted'; }
          if (response.status !== 429 || response.headers.get('retry-after') !== String(period)) {
            await response.body?.cancel();
            return 'bad';
          }
          const result: unknown = await response.json();
          return isRecord(result) && result.code === 'rate_limited' && result.retryAfterSeconds === period ? 'refused' : 'bad';
        };
        let admitted = 0;
        let sent = 0;
        while (sent <= max) {
          const batch = await Promise.allSettled(Array.from({ length: Math.min(batchSize, max + 1 - sent) }, async () => {
            try {
              const verdict = await classify(await send());
              if (verdict === 'bad') stop.abort();
              return verdict;
            } catch (error) {
              stop.abort();
              throw error;
            }
          }));
          sent += batch.length;
          if (batch.some((result) => result.status === 'rejected' || result.value === 'bad')) return 'fail';
          const values = batch.map((result) => (result as PromiseFulfilledResult<'admitted' | 'refused'>).value);
          // Inside a parallel batch the limiter's order is unknown, so the
          // admission that must precede the refusal has to come from an earlier
          // batch; an admission only inside the refusal's batch is ambiguous and
          // retried. Every admission in that batch still counts towards the cap.
          const before = admitted;
          admitted += values.filter((value) => value === 'admitted').length;
          if (values.includes('refused')) return before < min || admitted > max ? 'late' : 'pass';
        }
        return 'late';
      };
      let outcome = await attempt();
      if (outcome === 'late') {
        await sleep((period + 1) * 1000);
        outcome = await attempt();
      }
      pass = outcome === 'pass';
    } catch {
      // Never print a session, response, URL or thrown request error.
    }
    verdicts.push({ bucket, pass });
  }
  return verdicts;
}

if (isEntryPoint(import.meta)) {
  const [baseUrl, ...selected] = process.argv.slice(2);
  const buckets = [...new Set(selected.filter(isBucket))];
  report(selected.every(isBucket) ? await checkHttp(baseUrl, buckets.length ? buckets : baseBuckets, {
    cookie: process.env.R2_MAIL_COOKIE, csrf: process.env.R2_MAIL_CSRF,
  }) : failures());
}
