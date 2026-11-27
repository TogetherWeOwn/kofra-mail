import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { checkConfig } from './check-config.ts';
import { isEntryPoint } from './cli.ts';
import { EXPECTED_BUCKETS, bucketNames, type Bucket } from './expected-buckets.ts';
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

test('probe answers 404 without its configured secret and cannot address other bindings', async () => {
  const env = { R2_PROBE_SECRET: probeSecret, MAIL_RATE_UNDO: { limit() { assert.fail('must not call the binding'); } } };
  assert.equal((await probe.fetch(probeRequest('undo'), env)).status, 404);
  assert.equal((await probe.fetch(probeRequest('undo', 'wrong-secret'), env)).status, 404);
  assert.equal((await probe.fetch(probeRequest('undo', probeSecret), {})).status, 404);
  assert.equal((await probe.fetch(probeRequest('constructor', probeSecret), env)).status, 404);
});

test('probe caps unlimited bindings at limit plus one and suppresses binding errors', async () => {
  const { limit, binding } = EXPECTED_BUCKETS.undo;
  let calls = 0;
  const env = { R2_PROBE_SECRET: probeSecret, [binding]: {
    async limit() { calls++; return { success: true }; },
  } };
  const response = await probe.fetch(probeRequest('undo', probeSecret), env);
  assert.deepEqual(await response.json(), { allowed: limit + 1, refused: false });
  assert.equal(calls, limit + 1);

  const failure = await probe.fetch(probeRequest('undo', probeSecret), {
    R2_PROBE_SECRET: probeSecret, [binding]: { async limit() { throw new Error(probeSecret); } },
  });
  assert.equal(failure.status, 503);
  assert.equal(await failure.text(), '');
});

test('probe client fails early refusals, excess allowances and missing bindings', async () => {
  const seen: string[] = [];
  const result = await checkProbe('https://probe.example.test', probeSecret, async (url, init) => {
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('x-r2-probe-secret'), probeSecret);
    const bucket = new URL(String(url)).searchParams.get('bucket') as Bucket;
    seen.push(bucket);
    const { limit } = EXPECTED_BUCKETS[bucket];
    if (bucket === 'writes') return Response.json({ allowed: limit - 1, refused: true });
    if (bucket === 'undo') return Response.json({ allowed: limit + 1, refused: false });
    if (bucket === 'uploads') return new Response(null, { status: 503 });
    return Response.json({ allowed: limit, refused: true });
  });
  assert.deepEqual(seen, bucketNames);
  assert.deepEqual(result, verdicts('writes', 'undo', 'uploads'));
});

const routes: [Bucket, string, RegExp, number][] = [
  ['reads', 'GET', /^\/api\/v1\/drafts\/[\w-]+$/, 404],
  ['writes', 'POST', /^\/api\/v1\/drafts$/, 428],
  ['uploads', 'POST', /^\/api\/v1\/uploads$/, 428],
  ['sends', 'POST', /^\/api\/v1\/drafts\/[\w-]+\/send$/, 428],
  ['undo', 'POST', /^\/api\/v1\/sends\/[\w-]+\/undo$/, 428],
  ['admin_writes', 'POST', /^\/api\/v1\/admin\/domains$/, 428],
];

type Mode = 'exact' | 'never' | 'early' | 'wrong period';
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
    const offset = mode === 'early' ? -1 : 0;
    let limited = false;
    if (bucket === 'undo') {
      undoPaths.add(path);
      limited = hit('undo_flood') > EXPECTED_BUCKETS.undo_flood.limit + offset;
    }
    limited ||= hit(bucket === 'undo' ? path : bucket) > EXPECTED_BUCKETS[bucket].limit + offset;
    if (mode === 'never' || !limited) { response.writeHead(baseline).end('{}'); return; }
    const period = mode === 'wrong period' ? 10 : EXPECTED_BUCKETS[bucket].period;
    response.writeHead(429, { 'retry-after': String(period), 'content-type': 'application/problem+json' })
      .end(JSON.stringify({ code: 'rate_limited', retryAfterSeconds: period }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const result = await checkHttp(`http://127.0.0.1:${addr.port}`, buckets, session);
    return { result, counts, undoPaths, calls: requests.length };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

test('HTTP check passes exact sequences on all enabled buckets and separates the undo keys', async () => {
  const buckets = bucketNames.filter((bucket) => bucket !== 'undo_flood');
  const normal = await fakeServer('exact', buckets);
  assert.deepEqual(normal.result, buckets.map((bucket) => ({ bucket, pass: true })));
  assert.equal(normal.undoPaths.size, 1);
  assert.equal(normal.counts.get('undo_flood'), EXPECTED_BUCKETS.undo.limit + 1);
  const flood = await fakeServer('exact', ['undo_flood']);
  assert.deepEqual(flood.result, [{ bucket: 'undo_flood', pass: true }]);
  assert.equal(flood.undoPaths.size, EXPECTED_BUCKETS.undo_flood.limit + 1);
});

for (const mode of ['never', 'early', 'wrong period'] as const) {
  test(`HTTP check rejects ${mode} rate limiting`, async () => {
    const { result, calls } = await fakeServer(mode, ['writes']);
    assert.deepEqual(result, [{ bucket: 'writes', pass: false }]);
    assert.equal(calls, EXPECTED_BUCKETS.writes.limit + (mode === 'early' ? 0 : 1));
  });
}

test('HTTP check batches admissions but sends the refusal check only after they finish', async () => {
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
  assert.equal(calls, limit + 1);
  assert.equal(refusalPending, 0);
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
