import { API_PREFIX, ROUTES } from '../../contracts/mail-api/src/routes.ts';
import { failures, isEntryPoint, isRecord, report, targetOrigin, type Verdict } from './cli.ts';
import { EXPECTED_BUCKETS, isBucket, type Bucket } from './expected-buckets.ts';

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
const batchSize = 8;
type Session = { cookie?: string; csrf?: string };

export async function checkHttp(baseUrl: string | undefined, buckets: readonly Bucket[], session: Session,
  request = fetch): Promise<Verdict[]> {
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
      const signal = AbortSignal.timeout(period * 1000);
      const notFoundId = crypto.randomUUID();
      const send = () => {
        const id = bucket === 'undo_flood' ? crypto.randomUUID() : notFoundId;
        const path = route.path.replaceAll(/\{[a-zA-Z]+\}/g, id);
        // Deliberately no body, Idempotency-Key or If-Match.
        return request(new URL(`${API_PREFIX}${path}`, origin), { method: route.method, headers, redirect: 'manual', signal });
      };
      let admitted = true;
      for (let i = 0; admitted && i < limit; i += batchSize) {
        const batch = await Promise.allSettled(Array.from({ length: Math.min(batchSize, limit - i) }, async () => {
          const response = await send();
          await response.body?.cancel();
          return response.status === (read ? 404 : 428);
        }));
        admitted = batch.every((result) => result.status === 'fulfilled' && result.value);
      }
      if (admitted) {
        const response = await send();
        if (response.status === 429 && response.headers.get('retry-after') === String(period)) {
          const result: unknown = await response.json();
          pass = isRecord(result) && result.code === 'rate_limited' && result.retryAfterSeconds === period;
        } else await response.body?.cancel();
      }
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
