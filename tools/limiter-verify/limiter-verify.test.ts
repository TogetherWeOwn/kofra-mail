import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { checkConfig } from './check-config.ts';
import { isEntryPoint } from './cli.ts';
import { EXPECTED_BUCKETS, bucketNames, type Bucket, refusalBand } from './expected-buckets.ts';
import { checkHttp } from './http-check.ts';
import { checkProbe } from './probe-client.ts';
import probe from './probe-worker.ts';

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const settings = json('./fixtures/script-settings.json');
const variants = json('./fixtures/script-settings-variants.json') as Record<string, {
  op: 'remove' | 'replace'; index: number; bucket: Bucket; field?: 'limit' | 'period'; value?: number;
}[]>;
const account = '000000000000000000000000a11ce001';
const token = 'fixture-only-cf-token';
const probeSecret = 'fixture-only-probe-secret';
const session = { cookie: 'session=fixture-only-operator', csrf: 'fixture-only-csrf' };
const cfEnv = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token };
const verdicts = (...failures: Bucket[]) => bucketNames.map((bucket) => ({ bucket, pass: !failures.includes(bucket) }));

test('Cloudflare settings fixture passes for every bucket', async () => {
  let called = 0;
  const result = await checkConfig('fixture-mail-web', cfEnv, async (url, init) => {
    called++;
    assert.equal(String(url), `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/fixture-mail-web/settings`);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(init?.redirect, 'manual');
    return Response.json(settings);
  });
  assert.equal(called, 1);
  assert.deepEqual(result, verdicts());
});

for (const [name, patches] of Object.entries(variants)) {
  test(`Cloudflare settings fixture rejects ${name}`, async () => {
    const response = structuredClone(settings);
    for (const patch of patches) {
      if (patch.op === 'remove') response.result.bindings.splice(patch.index, 1);
      else response.result.bindings[patch.index].simple[patch.field!] = patch.value;
    }
    assert.deepEqual(await checkConfig('mail-web', cfEnv, async () => Response.json(response)),
      verdicts(...patches.map(({ bucket }) => bucket)));
  });
}

test('Cloudflare settings rejects missing and shared namespace IDs', async () => {
  const response = structuredClone(settings);
  const [reads, writes, uploads] = response.result.bindings.slice(1);
  writes.namespace_id = reads.namespace_id;
  delete uploads.namespace_id;
  assert.deepEqual(await checkConfig('mail-web', cfEnv, async () => Response.json(response)),
    verdicts('reads', 'writes', 'uploads'));
});

test('probe config uses exactly the validated mail-web binding names and namespace IDs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'r2-probe-config-'));
  t.after(() => rm(directory, { recursive: true }));
  const probeConfigPath = join(directory, 'probe.json');
  let calls = 0;
  const result = await checkConfig('mail-web', cfEnv, async () => {
    calls++;
    return Response.json(settings);
  }, { probeConfigPath });
  assert.equal(calls, 1);
  assert.deepEqual(result, verdicts());
  const config = JSON.parse(await readFile(probeConfigPath, 'utf8'));
  assert.equal(config.name, 'mail-web-r2-probe');
  assert.equal(config.account_id, account);
  assert.equal(resolve(directory, config.main), fileURLToPath(new URL('./probe-worker.ts', import.meta.url)));
  assert.deepEqual(config.ratelimits, settings.result.bindings
    .filter(({ type }: { type: string }) => type === 'ratelimit')
    .map(({ name, namespace_id, simple }: { name: string; namespace_id: string; simple: unknown }) => ({ name, namespace_id, simple })));
  assert.deepEqual(Object.keys(config).sort(), ['account_id', 'compatibility_date', 'compatibility_flags', 'main', 'name', 'preview_urls', 'ratelimits', 'workers_dev']);
  if (process.platform !== 'win32') assert.equal((await stat(probeConfigPath)).mode & 0o777, 0o600);
});

test('long source Worker names generate bounded distinct probe names', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'r2-probe-config-'));
  t.after(() => rm(directory, { recursive: true }));
  const names = [];
  for (const suffix of ['a', 'b']) {
    const probeConfigPath = join(directory, `${suffix}.json`);
    assert.deepEqual(await checkConfig(`${'m'.repeat(62)}${suffix}`, cfEnv,
      async () => Response.json(settings), { probeConfigPath }), verdicts());
    const { name } = JSON.parse(await readFile(probeConfigPath, 'utf8'));
    assert.match(name, /^[a-z0-9-]{1,63}$/);
    names.push(name);
  }
  assert.notEqual(names[0], names[1]);
});

test('probe config is not created on failed validation and never overwrites a file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'r2-probe-config-'));
  t.after(() => rm(directory, { recursive: true }));
  const probeConfigPath = join(directory, 'probe.json');
  const incomplete = structuredClone(settings);
  incomplete.result.bindings.pop();
  assert.deepEqual(await checkConfig('mail-web', cfEnv, async () => Response.json(incomplete), { probeConfigPath }),
    verdicts('admin_writes'));
  await assert.rejects(stat(probeConfigPath), { code: 'ENOENT' });

  await writeFile(probeConfigPath, 'existing file');
  assert.deepEqual(await checkConfig('mail-web', cfEnv, async () => Response.json(settings), { probeConfigPath }),
    verdicts(...bucketNames));
  assert.equal(await readFile(probeConfigPath, 'utf8'), 'existing file');
});

test('expected buckets match the local Wrangler configuration and gateway mapping', () => {
  const { config, error } = ts.parseConfigFileTextToJson('wrangler.local.jsonc',
    readFileSync(new URL('../../apps/web/wrangler.local.jsonc', import.meta.url), 'utf8'));
  assert.equal(error, undefined);
  assert.equal(config.ratelimits.length, bucketNames.length);
  assert.deepEqual(Object.fromEntries(config.ratelimits.map(({ name, simple }: { name: string; simple: unknown }) => [name, simple])),
    Object.fromEntries(Object.values(EXPECTED_BUCKETS).map(({ binding, limit, period }) => [binding, { limit, period }])));

  const source = ts.createSourceFile('mail-api.ts',
    readFileSync(new URL('../../apps/web/src/lib/server/mail-api.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.filter(ts.isVariableStatement)
    .flatMap(({ declarationList }) => [...declarationList.declarations])
    .find(({ name }) => ts.isIdentifier(name) && name.text === 'rateBindings');
  let mapping = declaration?.initializer;
  if (mapping && ts.isAsExpression(mapping)) mapping = mapping.expression;
  assert.ok(mapping && ts.isObjectLiteralExpression(mapping), 'expected an explicit rateBindings map');
  assert.deepEqual(Object.fromEntries(mapping.properties.map((property) => {
    assert.ok(ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && ts.isStringLiteral(property.initializer));
    return [property.name.text, property.initializer.text];
  })), Object.fromEntries(bucketNames.map((bucket) => [bucket, EXPECTED_BUCKETS[bucket].binding])));
});

function probeRequest(bucket: string, secret?: string) {
  return new Request(`https://probe.example.test/probe?bucket=${bucket}`, {
    method: 'POST', headers: secret ? { 'x-r2-probe-secret': secret } : {},
  });
}

test('probe calls only the requested binding with one fresh test key per request', async () => {
  const { limit, binding } = EXPECTED_BUCKETS.undo;
  const keys = new Map<string, number>();
  const env = { R2_PROBE_SECRET: probeSecret, [binding]: {
    async limit({ key }: { key: string }) {
      assert.match(key, /^r2-probe:[0-9a-f-]{36}$/);
      const calls = (keys.get(key) ?? 0) + 1;
      keys.set(key, calls);
      return { success: calls <= limit };
    },
  } };
  for (let i = 0; i < 2; i++) {
    const response = await probe.fetch(probeRequest('undo', probeSecret), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { allowed: limit, refused: true });
  }
  assert.deepEqual([...keys.values()], [limit + 1, limit + 1]);
});

test('probe reports a refusal on the last call it is allowed to make', async () => {
  const { limit, binding } = EXPECTED_BUCKETS.undo;
  const { max } = refusalBand(limit);
  let calls = 0;
  const env = { R2_PROBE_SECRET: probeSecret, [binding]: {
    async limit() { calls++; return { success: calls <= max }; },
  } };
  const response = await probe.fetch(probeRequest('undo', probeSecret), env);
  assert.deepEqual(await response.json(), { allowed: max, refused: true });
  assert.equal(calls, max + 1);
});

test('probe answers 404 without its configured secret and cannot address other bindings', async () => {
  const env = { R2_PROBE_SECRET: probeSecret, MAIL_RATE_UNDO: { limit() { assert.fail('must not call the binding'); } } };
  assert.equal((await probe.fetch(probeRequest('undo'), env)).status, 404);
  assert.equal((await probe.fetch(probeRequest('undo', 'wrong-secret'), env)).status, 404);
  assert.equal((await probe.fetch(probeRequest('undo', probeSecret), {})).status, 404);
  assert.equal((await probe.fetch(probeRequest('constructor', probeSecret), env)).status, 404);
});

test('probe caps unlimited bindings one call past the band and suppresses binding errors', async () => {
  const { limit, binding } = EXPECTED_BUCKETS.undo;
  const { max } = refusalBand(limit);
  let calls = 0;
  const env = { R2_PROBE_SECRET: probeSecret, [binding]: {
    async limit() { calls++; return { success: true }; },
  } };
  const response = await probe.fetch(probeRequest('undo', probeSecret), env);
  assert.deepEqual(await response.json(), { allowed: max + 1, refused: false });
  assert.equal(calls, max + 1);

  const failure = await probe.fetch(probeRequest('undo', probeSecret), {
    R2_PROBE_SECRET: probeSecret, [binding]: { async limit() { throw new Error(probeSecret); } },
  });
  assert.equal(failure.status, 503);
  assert.equal(await failure.text(), '');
});

test('probe client accepts the band edges and fails early refusals, late or no refusals and missing bindings', async () => {
  const seen: string[] = [];
  const waits: number[] = [];
  const result = await checkProbe('https://probe.example.test', probeSecret, async (url, init) => {
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('x-r2-probe-secret'), probeSecret);
    const bucket = new URL(String(url)).searchParams.get('bucket') as Bucket;
    seen.push(bucket);
    const { limit } = EXPECTED_BUCKETS[bucket];
    const { min, max } = refusalBand(limit);
    if (bucket === 'writes') return Response.json({ allowed: min - 1, refused: true });
    if (bucket === 'reads') return Response.json({ allowed: max + 1, refused: true });
    if (bucket === 'undo') return Response.json({ allowed: max + 1, refused: false });
    if (bucket === 'uploads') return new Response(null, { status: 503 });
    if (bucket === 'sends') return Response.json({ allowed: min, refused: true });
    if (bucket === 'admin_writes') return Response.json({ allowed: max, refused: true });
    if (bucket === 'undo_flood') return Response.json({ allowed: limit, refused: false });
    return Response.json({ allowed: limit, refused: true });
  }, async (ms) => { waits.push(ms); });
  // Late and missing refusals are retried once; an early refusal or a bad answer never is.
  assert.deepEqual([...new Set(seen)], bucketNames);
  const calls = Object.fromEntries(bucketNames.map((bucket) => [bucket, seen.filter((b) => b === bucket).length]));
  assert.deepEqual(calls, { reads: 2, writes: 1, uploads: 1, sends: 1, undo: 2, undo_flood: 2, admin_writes: 1 });
  assert.deepEqual(waits, [61_000, 61_000, 61_000]);
  assert.deepEqual(result, verdicts('reads', 'writes', 'undo', 'undo_flood', 'uploads'));
});

test('probe client rejects a fractional admission count', async () => {
  const result = await checkProbe('https://probe.example.test', probeSecret, async (url) => {
    const bucket = new URL(String(url)).searchParams.get('bucket') as Bucket;
    const { min } = refusalBand(EXPECTED_BUCKETS[bucket].limit);
    return Response.json({ allowed: min + 0.5, refused: true });
  }, async () => {});
  assert.deepEqual(result, verdicts(...bucketNames));
});

test('probe client retries a late refusal once after a full period, for a counter rollover', async () => {
  const waits: number[] = [];
  const attempts = new Map<string, number>();
  const result = await checkProbe('https://probe.example.test', probeSecret, async (url) => {
    const bucket = new URL(String(url)).searchParams.get('bucket') as Bucket;
    const n = (attempts.get(bucket) ?? 0) + 1;
    attempts.set(bucket, n);
    const { limit } = EXPECTED_BUCKETS[bucket];
    const { max } = refusalBand(limit);
    return Response.json(n === 1 ? { allowed: max + 1, refused: false } : { allowed: limit, refused: true });
  }, async (ms) => { waits.push(ms); });
  assert.deepEqual(result, verdicts());
  assert.deepEqual(waits, bucketNames.map((bucket) => (EXPECTED_BUCKETS[bucket].period + 1) * 1000));
});

test('probe client fails only the bucket whose retry wait fails and still checks the rest', async () => {
  const result = await checkProbe('https://probe.example.test', probeSecret, async (url) => {
    const bucket = new URL(String(url)).searchParams.get('bucket') as Bucket;
    const { limit } = EXPECTED_BUCKETS[bucket];
    return Response.json(bucket === 'reads' ? { allowed: limit, refused: false } : { allowed: limit, refused: true });
  }, async () => { throw new Error('timer'); });
  assert.deepEqual(result, verdicts('reads'));
});

test('HTTP check fails at the first bad answer and aborts the requests still in flight', async () => {
  let calls = 0;
  let aborted = 0;
  const waits: number[] = [];
  const started = Date.now();
  const result = await checkHttp('https://mail.example.test', ['reads'], session, async (_url, init) => {
    if (calls++ === 0) return new Response('{}', { status: 500 });
    // Every other request stalls until the attempt is aborted.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true });
    });
  }, async (ms) => { waits.push(ms); });
  assert.deepEqual(result, [{ bucket: 'reads', pass: false }]);
  assert.equal(calls, 8);
  assert.equal(aborted, 7);
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(waits, []);
});

test('HTTP check fails at the first failed request and aborts the requests still in flight', async () => {
  let calls = 0;
  let aborted = 0;
  const waits: number[] = [];
  const started = Date.now();
  const result = await checkHttp('https://mail.example.test', ['reads'], session, async (_url, init) => {
    if (calls++ === 0) throw new TypeError('fetch failed');
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true });
    });
  }, async (ms) => { waits.push(ms); });
  assert.deepEqual(result, [{ bucket: 'reads', pass: false }]);
  assert.equal(calls, 8);
  assert.equal(aborted, 7);
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(waits, []);
});

test('HTTP check fails a bad answer even in the batch with a valid refusal, or as the last request', async () => {
  // reads is a parallel bucket, so the bad answer and the refusal share a batch.
  for (const [bucket, badAt, refuseAt] of [['reads', 601, 600], ['writes', refusalBand(EXPECTED_BUCKETS.writes.limit).max, -1]] as const) {
    const { period } = EXPECTED_BUCKETS[bucket];
    let calls = 0;
    const waits: number[] = [];
    const result = await checkHttp('https://mail.example.test', [bucket], session, async () => {
      const index = calls++;
      if (index === badAt) return new Response('{}', { status: 500 });
      if (index === refuseAt) {
        return Response.json({ code: 'rate_limited', retryAfterSeconds: period }, { status: 429, headers: { 'retry-after': String(period) } });
      }
      return new Response(null, { status: bucket === 'reads' ? 404 : 428 });
    }, async (ms) => { waits.push(ms); });
    assert.deepEqual(result, [{ bucket, pass: false }], `${bucket}: bad answer at request ${badAt + 1}`);
    assert.deepEqual(waits, []);
  }
});

test('HTTP check sends a small bucket one request at a time, so it sees refusals in the limiter order', async () => {
  const { limit, period } = EXPECTED_BUCKETS.undo;
  let pending = 0;
  let peak = 0;
  let calls = 0;
  const result = await checkHttp('https://mail.example.test', ['undo'], session, async () => {
    peak = Math.max(peak, ++pending);
    await new Promise<void>((resolve) => setImmediate(resolve));
    pending--;
    if (calls++ === limit) {
      return Response.json({ code: 'rate_limited', retryAfterSeconds: period }, { status: 429, headers: { 'retry-after': String(period) } });
    }
    return new Response(null, { status: 428 });
  }, async () => {});
  assert.deepEqual(result, [{ bucket: 'undo', pass: true }]);
  assert.equal(peak, 1);
  assert.equal(calls, limit + 1);
});

test('HTTP check fails an attempt whose requests hang past its deadline', async () => {
  const started = Date.now();
  const result = await checkHttp('https://mail.example.test', ['reads'], session, async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    }), async () => {}, () => 50);
  assert.deepEqual(result, [{ bucket: 'reads', pass: false }]);
  assert.ok(Date.now() - started < 5_000);
});

test('the refusal band is 90% rounded up to 150% rounded down', () => {
  assert.deepEqual(refusalBand(EXPECTED_BUCKETS.writes.limit), { min: 108, max: 180 });
  assert.deepEqual(refusalBand(EXPECTED_BUCKETS.uploads.limit), { min: 58, max: 96 });
  assert.deepEqual(refusalBand(EXPECTED_BUCKETS.undo.limit), { min: 9, max: 15 });
});

const routes: [Bucket, string, RegExp, number][] = [
  ['reads', 'GET', /^\/api\/v1\/drafts\/[\w-]+$/, 404],
  ['writes', 'POST', /^\/api\/v1\/drafts$/, 428],
  ['uploads', 'POST', /^\/api\/v1\/uploads$/, 428],
  ['sends', 'POST', /^\/api\/v1\/drafts\/[\w-]+\/send$/, 428],
  ['undo', 'POST', /^\/api\/v1\/sends\/[\w-]+\/undo$/, 428],
  ['admin_writes', 'POST', /^\/api\/v1\/admin\/domains$/, 428],
];

type Mode = 'exact' | 'never' | 'early' | 'late' | 'band low' | 'band high' | 'wrong retry-after' | 'wrong body period' | 'rollover';
async function fakeServer(mode: Mode, buckets: Bucket[]) {
  const counts = new Map<string, number>();
  const undoPaths = new Set<string>();
  const requests: IncomingMessage[] = [];
  const hit = (key: string) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count;
  };
  const server = createServer((request, response) => {
    requests.push(request);
    const path = request.url ?? '';
    const route = routes.find(([, method, pattern]) => method === request.method && pattern.test(path));
    if (!route) { response.writeHead(400).end(); return; }
    if (request.headers.cookie !== session.cookie || request.headers['x-csrf-token'] !== session.csrf
      || request.headers.origin !== `http://${request.headers.host}`
      || request.headers['idempotency-key'] || request.headers['if-match']) { response.writeHead(403).end(); return; }
    const [bucket, , , baseline] = route;
    // The number of requests a bucket admits before its first refusal.
    const admits = (limit: number) => {
      const { min, max } = refusalBand(limit);
      return { exact: limit, never: limit, early: min - 1, late: max + 1, 'band low': min, 'band high': max, 'wrong retry-after': limit, 'wrong body period': limit, rollover: limit }[mode];
    };
    let limited = false;
    if (bucket === 'undo') {
      undoPaths.add(path);
      limited = hit('undo_flood') > admits(EXPECTED_BUCKETS.undo_flood.limit);
    }
    const count = hit(bucket === 'undo' ? path : bucket);
    // A rollover mid-run: the first attempt's max + 1 requests are all admitted,
    // then the counter starts again and refuses past the limit.
    const firstRun = refusalBand(EXPECTED_BUCKETS[bucket].limit).max + 1;
    limited ||= mode === 'rollover' ? count > firstRun && count - firstRun > admits(EXPECTED_BUCKETS[bucket].limit)
      : count > admits(EXPECTED_BUCKETS[bucket].limit);
    if (mode === 'never' || !limited) { response.writeHead(baseline).end('{}'); return; }
    const { period } = EXPECTED_BUCKETS[bucket];
    const header = mode === 'wrong retry-after' ? 10 : period;
    const body = mode === 'wrong body period' ? 10 : period;
    response.writeHead(429, { 'retry-after': String(header), 'content-type': 'application/problem+json' })
      .end(JSON.stringify({ code: 'rate_limited', retryAfterSeconds: body }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const waits: number[] = [];
    const result = await checkHttp(`http://127.0.0.1:${addr.port}`, buckets, session, fetch, async (ms) => { waits.push(ms); });
    return { result, counts, undoPaths, calls: requests.length, waits };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

test('HTTP check passes exact sequences on all enabled buckets and separates the undo keys', async () => {
  const buckets = bucketNames.filter((bucket) => bucket !== 'undo_flood');
  const normal = await fakeServer('exact', buckets);
  assert.deepEqual(normal.result, buckets.map((bucket) => ({ bucket, pass: true })));
  assert.equal(normal.undoPaths.size, 1);
  assert.ok((normal.counts.get('undo_flood') ?? 0) > EXPECTED_BUCKETS.undo.limit);
  const flood = await fakeServer('exact', ['undo_flood']);
  assert.deepEqual(flood.result, [{ bucket: 'undo_flood', pass: true }]);
  assert.ok(flood.undoPaths.size > EXPECTED_BUCKETS.undo_flood.limit);
});

for (const mode of ['never', 'early', 'late', 'wrong retry-after', 'wrong body period'] as const) {
  test(`HTTP check rejects ${mode} rate limiting`, async () => {
    const { limit } = EXPECTED_BUCKETS.writes;
    const { min, max } = refusalBand(limit);
    // A bucket this small goes one request at a time, and an attempt sends at most max + 1.
    const { result, calls, waits } = await fakeServer(mode, ['writes']);
    assert.deepEqual(result, [{ bucket: 'writes', pass: false }]);
    assert.equal(calls, { never: 2 * (max + 1), early: min, late: max + 1 + 1, 'wrong retry-after': limit + 1, 'wrong body period': limit + 1 }[mode]);
    // Only a late or missing refusal is retried, after one full period.
    assert.deepEqual(waits, mode === 'never' || mode === 'late' ? [61_000] : []);
  });
}

for (const mode of ['band low', 'band high'] as const) {
  test(`HTTP check accepts a first refusal at the ${mode === 'band low' ? 'low' : 'high'} edge of the band`, async () => {
    const { limit } = EXPECTED_BUCKETS.writes;
    const { min, max } = refusalBand(limit);
    const { result, calls, waits } = await fakeServer(mode, ['writes']);
    assert.deepEqual(result, [{ bucket: 'writes', pass: true }]);
    assert.equal(calls, (mode === 'band low' ? min : max) + 1);
    assert.deepEqual(waits, []);
  });
}

test('HTTP check passes after one retry when a counter rollover hides the refusal', async () => {
  const { result, waits } = await fakeServer('rollover', ['writes']);
  assert.deepEqual(result, [{ bucket: 'writes', pass: true }]);
  assert.deepEqual(waits, [61_000]);
});

test('HTTP check keeps at most eight requests in flight and stops after the batch with the first refusal', async () => {
  const { limit, period } = EXPECTED_BUCKETS.reads;
  let calls = 0;
  let pending = 0;
  let peak = 0;
  let refusalPending: number | undefined;
  const result = await checkHttp('https://mail.example.test', ['reads'], session, async () => {
    if (calls++ === limit) {
      refusalPending = pending;
      return Response.json({ code: 'rate_limited', retryAfterSeconds: period }, {
        status: 429, headers: { 'retry-after': String(period) },
      });
    }
    peak = Math.max(peak, ++pending);
    await new Promise<void>((resolve) => setImmediate(resolve));
    pending--;
    return new Response(null, { status: 404 });
  });
  assert.deepEqual(result, [{ bucket: 'reads', pass: true }]);
  assert.equal(calls, Math.ceil((limit + 1) / 8) * 8);
  assert.ok(refusalPending !== undefined && refusalPending < 8);
  assert.equal(peak, 8);
});

test('HTTP check rejects both undo checks in one invocation before sending requests', async () => {
  const result = await fakeServer('exact', ['undo', 'undo_flood']);
  assert.equal(result.calls, 0);
  assert.deepEqual(result.result, [{ bucket: 'undo', pass: false }, { bucket: 'undo_flood', pass: false }]);
});

test('CLI entry points can run on Node releases without import.meta.main', () => {
  assert.equal(isEntryPoint({ url: import.meta.url }), true);
  assert.equal(isEntryPoint({ url: new URL('check-config.ts', import.meta.url).href }), false);
});

test('CLI output contains only verdicts, even if upstream errors or bodies contain fixture secrets', () => {
  const namespaceIds: string[] = settings.result.bindings.flatMap(({ namespace_id }: { namespace_id?: string }) => namespace_id ? [namespace_id] : []);
  const sentinels = [account, token, probeSecret, session.cookie, session.csrf, ...namespaceIds];
  const message = sentinels.join(' ');
  const loadFixture = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = async () => {
    if (process.env.FIXTURE_MODE === 'throw') throw new Error(${JSON.stringify(message)});
    if (process.env.FIXTURE_MODE === 'settings') return Response.json(${JSON.stringify(settings)});
    return new Response(${JSON.stringify(message)}, { status: 403 });
  };`)}`;
  const env = { ...cfEnv, R2_PROBE_SECRET: probeSecret, R2_MAIL_COOKIE: session.cookie, R2_MAIL_CSRF: session.csrf };
  for (const [filename, argv, buckets] of [
    ['check-config.ts', ['fixture-mail-web'], bucketNames],
    ['probe-client.ts', ['https://probe.example.test'], bucketNames],
    ['http-check.ts', ['https://mail.example.test', 'writes'], ['writes']],
  ] as const) {
    for (const mode of filename === 'check-config.ts' ? ['response', 'throw', 'settings'] : ['response', 'throw']) {
      const result = spawnSync(process.execPath, ['--import', loadFixture, fileURLToPath(new URL(filename, import.meta.url)), ...argv],
        { env: { ...env, FIXTURE_MODE: mode }, encoding: 'utf8' });
      assert.ok(!sentinels.some((value) => (result.stdout + result.stderr).includes(value)), 'fixture secret leaked');
      const pass = mode === 'settings';
      assert.equal(result.status, pass ? 0 : 1);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, buckets.map((bucket) => `${bucket} ${pass ? 'PASS' : 'FAIL'}\n`).join(''));
    }
  }
});
