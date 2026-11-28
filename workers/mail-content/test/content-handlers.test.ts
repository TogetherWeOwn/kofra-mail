import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { loadContentUrlKeys } from '../src/keys.ts';
import { mint, type MintClaims, type Purpose } from '../src/tokens.ts';
import { images } from './proxy-fixtures.ts';

const origin = 'https://content.example';
const remote = 'https://sender.example/pixel.png?private=canary';
const closeImage = 'https://sender.example/close.png';
const deadlineImage = 'https://sender.example/deadline.png';
const deadlineImageBytes = 4 * 1024 * 1024;
const gen = '01Z00000000000000000000000';
const alpha = { ws: 'alpha', mb: 'a', sub: 'user-a', msg: 'm', ep: 1 };
const beta = { ws: 'beta', mb: 'b', sub: 'user-b', msg: 'm', ep: 1 };
const png = images['image/png'];
const encode = { encode: (text: string) => new Uint8Array(Buffer.from(text)) };
const sha = async (bytes: Uint8Array<ArrayBuffer>) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
const objectPath = (ws: string, key: string) => `/mail-${ws}/${key}`;
const ambiguous = '<p>Before</p><select><xmp><img src="cid:hidden"></xmp></select><p>After</p>';
const keysJson = JSON.stringify({ current: 'fixture', keys: { fixture: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') } });
const fixtureKeys = await loadContentUrlKeys(keysJson);
const store = new Map<string, Uint8Array<ArrayBuffer>>();
const objectResponses = new Map<string, () => Response | Promise<Response>>();
const reads: string[] = [];
const logs: { level: string; message: string }[] = [];
const tokenValues: string[] = [];
let upstreamReads = 0;
let mf: Miniflare;
const control = crypto.randomUUID();
const bundle = (name: string) => build({
  entryPoints: [fileURLToPath(new URL(name, import.meta.url))], bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'],
}).then(({ outputFiles }) => outputFiles[0].text);

before(async () => {
  const [content, account] = await Promise.all([bundle('./content-worker-fixture.ts'), bundle('./account-worker.ts')]);
  mf = new Miniflare({
    handleStructuredLogs: ({ level, message }: { level: string; message: string }) => { logs.push({ level, message }); },
    workers: [{
      name: 'content', compatibilityDate: '2026-07-30', compatibilityFlags: ['enable_request_signal'], modules: true, script: content,
      bindings: {
        MAIL_CONTENT_ENABLED: 'on', CONTENT_ORIGIN: origin, MAIL_APP_ORIGIN: 'https://mail.example',
        CONTENT_URL_KEYS: keysJson, CONTENT_S3_ENDPOINT: 'https://objects.example',
        CONTENT_S3_ACCESS_KEY_ID: crypto.randomUUID(), CONTENT_S3_SECRET_ACCESS_KEY: crypto.randomUUID(),
        CONTENT_WORKERS_DEV_DOMAIN: 'account-example.workers.dev', CONTENT_ACCOUNT_DOMAIN: 'account.example',
        CONTENT_ZONE: 'content.example', CONTENT_SUITE_DOMAIN: 'mail.example', CONTENT_STORAGE_DOMAIN: 'objects.example',
      },
      serviceBindings: {
        MAIL_LOOKUP: { name: 'content', entrypoint: 'ContentLookup' },
        ACCOUNT_EPOCH: { name: 'account', entrypoint: 'CredentialEpoch' },
        MINT: { name: 'content', entrypoint: 'ContentMint' },
      },
      outboundService(request: Request) {
        if (request.url === remote || request.url === closeImage || request.url === deadlineImage) {
          upstreamReads++;
          const bytes = request.url === deadlineImage ? new Uint8Array(deadlineImageBytes) : png;
          if (bytes !== png) bytes.set(png);
          return new Response(bytes, { headers: { 'content-type': 'image/png', 'set-cookie': 'not-forwarded=true' } });
        }
        const url = new URL(request.url);
        reads.push(url.pathname);
        const bytes = store.get(url.pathname);
        if (url.origin !== 'https://objects.example' || request.method !== 'GET' || !request.headers.has('authorization') || !bytes) {
          return new Response(null, { status: 404 });
        }
        const override = objectResponses.get(url.pathname);
        return override ? override() : new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
      },
    }, {
      name: 'account', compatibilityDate: '2026-07-30', modules: true, script: account,
      bindings: { USERS: ['user-a', 'user-b', 'user-epoch'], CONTROL: control },
    }],
  });
});
after(() => mf?.dispose());

async function set(name: string, value: unknown) {
  const res = await mf.dispatchFetch(`${origin}/__${name}`, { method: 'POST', body: JSON.stringify(value) });
  assert.equal(res.status, 200);
}
async function sign<P extends Purpose>(purpose: P, claims: MintClaims<P>) {
  const token = await mint(fixtureKeys, purpose, claims, Date.now() / 1000);
  tokenValues.push(token);
  return `/v1/${purpose}/${token}`;
}
const bodyUrl = (ri = false) => sign('body', { ...alpha, ri });
const attUrl = (part: number) => sign('att', { ...alpha, part });
const cidUrl = (part: number) => sign('cid', { ...alpha, part });
const imageUrl = () => sign('img', { ...alpha, u: remote });
const get = (path: string, method = 'GET') => mf.dispatchFetch(new URL(path, origin), { method });
async function status(path: string, wanted = 404) {
  const res = await get(path);
  const length = (await res.arrayBuffer()).byteLength;
  assert.equal(res.status, wanted);
  if (wanted === 404) assert.equal(length, 0);
}
async function record(claims: typeof alpha, raw: string, attachments: unknown[] = [], verdict: unknown = 'none') {
  const bytes = encode.encode(raw);
  const rawKey = `raw/${await sha(bytes)}/${gen}`;
  store.set(objectPath(claims.ws, rawKey), bytes);
  await set('record', [`${claims.ws}/${claims.mb}/${claims.msg}`, { rawKey, attachments, verdict }]);
  return rawKey;
}
function alternative(html: string, text = '<safe> & plain') {
  return `Content-Type: multipart/alternative; boundary="alt"\r\n\r\n--alt\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n--alt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--alt--\r\n`;
}
function withParts(html: string, name = 'a%2Fb%5Cc%09%22%3B%F0%9F%8C%B1%27.txt', attachment = 'download data') {
  return `Content-Type: multipart/mixed; boundary="parts"\r\n\r\n--parts\r\nContent-Type: text/html\r\n\r\n${html}\r\n--parts\r\nContent-Type: image/png\r\nContent-Disposition: inline\r\nContent-ID: <picture@example>\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(png).toString('base64')}\r\n--parts\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename*=utf-8''${name}\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(attachment).toString('base64')}\r\n--parts--\r\n`;
}
const parts = [{ part: 2, objectKey: null }, { part: 1, objectKey: null }];
const html = `<p>safe body</p><img src="cid:picture@example"><img src="cid:absent@example"><img src="${remote}"><a href="https://sender.example/link">read</a>`;

test('local Wrangler config has exactly the two named service bindings and no storage bindings', async () => {
  const source = await readFile(new URL('../wrangler.local.jsonc', import.meta.url), 'utf8').catch(() => '{}');
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(config.services, [
    { binding: 'MAIL_LOOKUP', service: 'mail-backend-local', entrypoint: 'ContentLookup' },
    { binding: 'ACCOUNT_EPOCH', service: 'account-local', entrypoint: 'CredentialEpoch' },
  ]);
  assert.equal(config.observability?.logs?.invocation_logs, false, 'signed request URLs must not enter invocation logs');
  assert.deepEqual(Object.keys(config).sort(), ['compatibility_date', 'compatibility_flags', 'main', 'name', 'observability', 'preview_urls', 'ratelimits',
    'services', 'vars', 'workers_dev']);
  // File links (M3-13): the link host's flood bucket is the only rate limit; link URLs carry tokens, so invocation logs stay off.
  assert.deepEqual(config.ratelimits, [{ name: 'LINK_FLOOD', namespace_id: '2001', simple: { limit: 120, period: 60 } }]);
  assert.deepEqual(config.compatibility_flags, ['enable_request_signal']);
  assert.equal(config.vars.MAIL_CONTENT_ENABLED, 'off');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
});

test('named mint RPC signs only body and att with the loaded keys', async () => {
  async function rpc(method: string, ...args: unknown[]) {
    return (await mf.dispatchFetch(`${origin}/__mint`, { method: 'POST', body: JSON.stringify([method, ...args]) })).json() as Promise<{ value?: { url: string }; refused?: boolean }>;
  }
  await record(alpha, withParts(html), parts);
  for (const [purpose, extra] of [['body', { ri: false }], ['att', { part: 2 }]] as const) {
    const result = await rpc('mintForWeb', purpose, { ...alpha, ...extra });
    assert.ok(result.value);
    assert.ok(result.value.url.startsWith(`${origin}/v1/${purpose}/`));
    tokenValues.push(new URL(result.value.url).pathname.split('/').at(-1)!);
    await status(result.value.url, 200);
  }
  for (const method of ['mint', 'mintFromBody', 'signDerived', 'fetch']) assert.deepEqual(await rpc(method, 'body', { ...alpha, ri: false }), { refused: true });
  for (const [purpose, extra] of [
    ['cid', { part: 1 }], ['img', { u: remote }], ['lnk', { linkId: 'published-file' }],
  ] as const) assert.deepEqual(await rpc('mintForWeb', purpose, { ...alpha, ...extra }), { refused: true }, purpose);
});

test('raised credential epoch invalidates an HTTP body URL at the isolate cache TTL', async () => {
  await record(alpha, alternative(html));
  const sub = 'user-epoch';
  await set('owner', sub);
  const path = await sign('body', { ...alpha, sub, ri: false });
  try {
    await status(path, 200);
    const account = await mf.getWorker('account');
    const changed = await account.fetch('https://account.example/__epoch', {
      method: 'POST', headers: { 'x-fixture-control': control }, body: JSON.stringify([sub, 2]),
    });
    assert.equal(changed.status, 204);
    await set('clock', 60_000);
    await status(path);
  } finally { await set('owner', 'user-a'); await set('clock', 0); }
});

test('mailbox reassignment refuses an otherwise valid HTTP body token', async () => {
  await record(alpha, alternative(html));
  const path = await bodyUrl();
  await status(path, 200);
  await set('owner', 'new-owner');
  try { await status(path); }
  finally { await set('owner', 'user-a'); }
});

test('message deletion refuses an otherwise valid HTTP body token', async () => {
  await record(alpha, alternative(html));
  const path = await bodyUrl();
  await status(path, 200);
  await set('record', ['alpha/a/m', null]);
  await status(path);
});

test('mailbox A token never reads mailbox B even when its payload is spliced into the path', async () => {
  const keyA = await record(alpha, alternative('A'));
  await record(beta, alternative('B'));
  const a = await bodyUrl(), b = await sign('body', { ...beta, ri: false });
  reads.length = 0;
  await status(a, 200);
  await status(a.replace(a.split('.')[1], b.split('.')[1]));
  assert.deepEqual(reads, [objectPath('alpha', keyA)]);
});

test('malformed raw and attachment records and nonexistent parts never reach storage', async () => {
  const key = await record(alpha, alternative(html));
  const body = await bodyUrl(), att = await attUrl(1), cid = await cidUrl(1);
  await status(body, 200);
  reads.length = 0;
  for (const [rawKey, attachments, verdict] of [
    ['raw/wrong/path', [], 'none'], [key, {}, 'none'], [key, [null], 'none'],
    [key, [{ part: 1.5, objectKey: null }], 'none'], [key, [{ part: 1, objectKey: key }], 'none'],
    [key, [{ part: 1, objectKey: undefined }], 'none'], [key, [parts[1], parts[1]], 'none'],
  ]) {
    await set('record', ['alpha/a/m', { rawKey, attachments, verdict }]);
    await status(body);
  }
  await record(alpha, alternative(html));
  await status(att);
  await status(cid);
  assert.deepEqual(reads, []);
});

test('body verifies raw MIME digest before rendering', async () => {
  const key = await record(alpha, alternative('correct'));
  const path = await bodyUrl();
  await status(path, 200);
  store.set(objectPath('alpha', key), encode.encode(alternative('wrong')));
  await status(path);
});

test('an unknown verdict fails closed as phishing and strips links and remote images', async () => {
  await record(alpha, withParts(html), parts, 'future-verdict');
  const res = await get(await bodyUrl(true));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('safe body'));
  assert.ok(!text.includes('href=') && !text.includes('/v1/img/'));
});

test('ambiguous markup uses the escaped plain-text part or a neutral notice', async () => {
  for (const raw of [alternative(ambiguous), `Content-Type: text/html\r\n\r\n${ambiguous}`]) {
    await record(alpha, raw);
    const res = await get(await bodyUrl());
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('<pre>') && !text.includes('Before') && !text.includes('hidden'));
    assert.ok(raw.includes('text/plain') ? text.includes('&lt;safe&gt; &amp; plain') : text.includes('This message cannot be displayed.'));
  }
});

test('body mints CID only for a real MIME part and serves its matching raster bytes inline', async () => {
  await record(alpha, withParts(html), parts);
  const res = await get(await bodyUrl());
  assert.equal(res.status, 200);
  const text = await res.text();
  const urls = [...text.matchAll(/src="(https:\/\/content\.example\/v1\/cid\/[^\"]+)"/g)];
  assert.equal(urls.length, 1);
  assert.ok(!text.includes('absent@example') && !text.includes('/v1/img/'));
  tokenValues.push(urls[0][1].split('/').at(-1)!);
  const inline = await get(urls[0][1]);
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get('content-type'), 'image/png');
  assert.equal(inline.headers.get('content-disposition'), 'inline');
  assert.deepEqual(new Uint8Array(await inline.arrayBuffer()), png);
  await status(await cidUrl(2)); // MIME claims image/png, bytes are not PNG.
});

test('oversized CID expansion falls back before emitting a body over 8 MiB', async () => {
  const ref = '<img src="cid:picture@example">';
  const raw = withParts(ref.repeat(54_000)).replace('--parts\r\nContent-Type: text/html\r\n\r\n',
    '--parts\r\nContent-Type: text/plain\r\n\r\n<private>&fallback\r\n--parts\r\nContent-Type: text/html\r\n\r\n');
  await record(alpha, raw, parts);
  const res = await get(await bodyUrl());
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(Buffer.byteLength(body) <= 8 * 1024 * 1024, `emitted ${Buffer.byteLength(body)} HTML bytes`);
  assert.ok(body.includes('&lt;private&gt;&amp;fallback'));
});

test('oversized kept markup without CID references falls back to escaped text', async () => {
  const paragraph = `<p title='${'"'.repeat(8 * 1024)}'>large attribute</p>`;
  await record(alpha, alternative(paragraph.repeat(175), '<private>&fallback'));
  const res = await get(await bodyUrl());
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('&lt;private&gt;&amp;fallback'));
  assert.ok(!body.includes('large attribute'));
});

test('one token cannot queue twenty MIME admissions or hold up another mailbox', async () => {
  const key = await record(alpha, alternative('<p>coalesced MIME</p>'));
  const betaKey = await record(beta, alternative('<p>independent MIME</p>'));
  const path = objectPath('alpha', key);
  const arrived = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const declined = Promise.withResolvers<void>();
  const refusalMs: number[] = [];
  objectResponses.set(path, async () => {
    arrived.resolve();
    await release.promise;
    return new Response(store.get(path)!, { headers: { 'content-length': String(store.get(path)!.length) } });
  });
  const url = await bodyUrl();
  const start = reads.length;
  const wave = Promise.all(Array.from({ length: 20 }, async () => {
    const started = performance.now();
    const res = await get(url);
    const text = await res.text();
    if (res.status === 503) {
      assert.equal(text, '');
      assert.equal(res.headers.get('retry-after'), '1');
      refusalMs.push(performance.now() - started);
      if (refusalMs.length === 18) declined.resolve();
    } else {
      assert.equal(res.status, 200);
      assert.ok(text.includes('coalesced MIME'));
    }
    return res.status;
  }));
  const timeout = setTimeout(declined.resolve, 4_000);
  try {
    await arrived.promise;
    await status(await sign('body', { ...beta, ri: false }), 200);
    await declined.promise;
  } finally { clearTimeout(timeout); release.resolve(); objectResponses.delete(path); }
  const results = await wave;
  assert.deepEqual(results.sort(), [...Array(2).fill(200), ...Array(18).fill(503)]);
  assert.ok(refusalMs.every(ms => ms >= 1_950), 'overflow waited for the two-second admission deadline');
  const rawReads = reads.slice(start).filter(read => read === path || read === objectPath('beta', betaKey));
  assert.deepEqual(rawReads, [path, objectPath('beta', betaKey)]);
});

for (const count of [6, 3]) test(`${count} concurrent CIDs all succeed on one ${count === 3 ? 'small' : 'large'} raw read`, async () => {
  const ids = Array.from({ length: count }, (_, i) => `image-${i}@content.example`);
  const images = ids.map(id => `--parts\r\nContent-Type: image/png\r\nContent-ID: <${id}>\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(png).toString('base64')}\r\n`);
  const filler = count === 6 ? `--parts\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.alloc(17 * 1024 * 1024, 65).toString('base64')}\r\n` : '';
  const raw = `Content-Type: multipart/mixed; boundary=parts\r\n\r\n--parts\r\nContent-Type: text/html\r\n\r\n${ids.map(id => `<img src="cid:${id}">`).join('')}\r\n`
    + images.join('') + filler + '--parts--\r\n';
  const rawKey = await record(alpha, raw, ids.map((_, i) => ({ part: i + 1, objectKey: null })));
  try {
    if (count === 6) assert.ok(Buffer.byteLength(raw) * count > 128 * 1024 * 1024, 'independent raw copies would exceed the Worker limit');
    const body = await get(await bodyUrl());
    assert.equal(body.status, 200);
    const urls = [...(await body.text()).matchAll(/src="(https:\/\/content\.example\/v1\/cid\/[^"]+)"/g)].map(match => match[1]);
    assert.equal(urls.length, ids.length);
    for (const url of urls) tokenValues.push(new URL(url).pathname.split('/').at(-1)!);
    const path = objectPath('alpha', rawKey);
    // Hold the storage response briefly so the HTTP requests overlap the load.
    objectResponses.set(path, async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
      const bytes = store.get(path)!;
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    });
    const start = reads.length;
    const statuses = await Promise.all(urls.map(async url => {
      const res = await get(url);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (res.ok) assert.deepEqual(bytes, png);
      return res.status;
    }));
    assert.deepEqual(statuses, Array(count).fill(200));
    assert.deepEqual(reads.slice(start).filter(read => read === path), [path]);
    const budget = await (await get('/__mime-budget')).json() as { peak: number; inFlight: number };
    assert.equal(budget.inFlight, 0);
    assert.ok(budget.peak >= Buffer.byteLength(raw) && budget.peak <= 25 * 1024 * 1024);
  } finally { objectResponses.delete(objectPath('alpha', rawKey)); store.delete(objectPath('alpha', rawKey)); }
});

test('workerd still serves a live CID follower after the stalled read leader cancels', { timeout: 10_000 }, async () => {
  const rawKey = await record(alpha, withParts(html), parts);
  const rawPath = objectPath('alpha', rawKey);
  const arrived = Promise.withResolvers<void>();
  const unblock = Promise.withResolvers<void>();
  objectResponses.set(rawPath, async () => {
    arrived.resolve();
    await unblock.promise;
    const bytes = store.get(rawPath)!;
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  });
  const path = await cidUrl(1);
  const start = reads.length;
  const leader = mf.dispatchFetch(new URL(path, origin), { headers: { 'x-fixture-cancel-leader': '1' } });
  try {
    assert.equal(await Promise.race([arrived.promise.then(() => 'origin entered'), leader.then(r => `leader returned ${r.status}`)]), 'origin entered');
    const follower = get(path).then(async live => ({ live, body: new Uint8Array(await live.arrayBuffer()) }));
    // The body read can reject before we await it below.
    void follower.catch(() => {});
    // The origin remains blocked while the second HTTP request joins the flight.
    await new Promise(resolve => setTimeout(resolve, 200));
    await set('cancel-flight-leader', null);
    unblock.resolve();
    const stopped = await leader;
    assert.equal(stopped.status, 404);
    void stopped.body?.cancel().catch(() => {});
    const { live, body } = await follower;
    assert.equal(live.status, 200);
    assert.deepEqual(body, png);
    assert.deepEqual(reads.slice(start).filter(read => read === rawPath), [rawPath]);
    assert.equal((await (await get('/__mime-budget')).json() as { inFlight: number }).inFlight, 0);
  } finally {
    unblock.resolve();
    objectResponses.delete(rawPath);
  }
});

for (const recovered of [true, false]) test(`a CID follower ${recovered ? 'recovers from a failed shared load' : 'gets a secured 503 after its own attempt fails'}`, async () => {
  const rawKey = await record(alpha, withParts(html), parts);
  const rawPath = objectPath('alpha', rawKey);
  const arrived = Promise.withResolvers<void>();
  const failLeader = Promise.withResolvers<void>();
  let attempts = 0;
  objectResponses.set(rawPath, async () => {
    if (++attempts === 1) {
      arrived.resolve();
      await failLeader.promise;
      return new Response(null, { status: 502 });
    }
    if (!recovered) return new Response(null, { status: 502 });
    const bytes = store.get(rawPath)!;
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  });
  const path = await cidUrl(1);
  const leader = get(path);
  try {
    const failedLeader = leader.then(async failed => ({ failed, length: (await failed.arrayBuffer()).byteLength }));
    // The body reads can reject before we await them below.
    void failedLeader.catch(() => {});
    assert.equal(await Promise.race([arrived.promise.then(() => 'origin entered'), leader.then(r => `leader returned ${r.status}`)]), 'origin entered');
    const follower = get(path).then(async replacement => ({ replacement, body: new Uint8Array(await replacement.arrayBuffer()) }));
    void follower.catch(() => {});
    // Keep the source blocked while the real Workerd follower opts into the flight.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(attempts, 1);
    failLeader.resolve();
    const [{ failed, length }, { replacement, body }] = await Promise.all([failedLeader, follower]);
    assert.equal(failed.status, 404);
    assert.equal(length, 0);
    assert.equal(replacement.status, recovered ? 200 : 503);
    if (recovered) assert.deepEqual(body, png);
    else {
      assert.equal(body.byteLength, 0);
      assert.equal(replacement.headers.get('retry-after'), '1');
      assert.equal(replacement.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
      assert.match(replacement.headers.get('content-security-policy') ?? '', /sandbox/);
    }
    assert.equal(attempts, 2);
    assert.equal((await (await get('/__mime-budget')).json() as { inFlight: number }).inFlight, 0);
  } finally { failLeader.resolve(); objectResponses.delete(rawPath); }
});

test('an unread large CID has no MIME charge and does not delay another mailbox', async () => {
  const large = new Uint8Array(17 * 1024 * 1024);
  large.set(png);
  const key = `att/${await sha(large)}/${gen}`;
  const raw = `Content-Type: multipart/mixed; boundary=parts\r\n\r\n--parts\r\nContent-Type: text/plain\r\n\r\nbody\r\n`
    + `--parts\r\nContent-Type: image/png\r\nContent-ID: <large@content.example>\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(large).toString('base64')}\r\n--parts--\r\n`;
  const rawKey = await record(alpha, raw, [{ part: 1, objectKey: key }]);
  const otherKey = await record(beta, alternative('<p>other mailbox</p>', 'x'.repeat(8 * 1024 * 1024)));
  store.set(objectPath('alpha', key), large);
  assert.ok(store.get(objectPath('alpha', rawKey))!.byteLength + store.get(objectPath('beta', otherKey))!.byteLength > 25 * 1024 * 1024);
  const start = reads.length;
  const image = await get(await cidUrl(1));
  // Miniflare wraps Undici's response around the same stream. Lock it without
  // reading so Undici cannot cancel it when the original response is collected.
  const reader = image.body?.getReader();
  let drained = 0;
  try {
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.ok(reader);
    const budget = await (await get('/__mime-budget')).json() as { inFlight: number };
    assert.equal(budget.inFlight, 0, 'returning response headers ends the raw MIME reservation');
    assert.deepEqual(reads.slice(start), [objectPath('alpha', rawKey), objectPath('alpha', key)]);
    await status(await sign('body', { ...beta, ri: false }), 200);
    assert.equal(image.bodyUsed, false, 'the CID must stay unread through the other mailbox request');
  } finally {
    try {
      // Drain the first stream rather than testing cancel propagation by accident.
      if (reader) {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          drained += chunk.value.byteLength;
        }
      }
    } finally {
      reader?.releaseLock();
      for (const path of [objectPath('alpha', rawKey), objectPath('alpha', key), objectPath('beta', otherKey)]) store.delete(path);
    }
  }
  assert.equal(drained, large.byteLength);
});

test('saturated raw MIME admission returns 503 with Retry-After and the complete security headers', async () => {
  await record(alpha, alternative('queued'));
  await set('hold-mime', null);
  const started = performance.now();
  const request = get(await bodyUrl());
  const watchdog = setTimeout(() => { void set('release-mime', null); }, 4_000);
  try {
    const res = await request;
    assert.equal(res.status, 503);
    assert.ok(performance.now() - started < 4_000, 'admission must finish before the watchdog');
    assert.equal((await res.arrayBuffer()).byteLength, 0);
    assert.equal(res.headers.get('retry-after'), '1');
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('content-security-policy'),
      "default-src 'none'; img-src https://content.example data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors https://mail.example; sandbox allow-popups allow-popups-to-escape-sandbox");
  } finally {
    clearTimeout(watchdog);
    await set('release-mime', null);
  }
  await status(await bodyUrl(), 200);
});

test('a normally consumed proxy image releases its transfer reservation', async () => {
  await status(await sign('img', { ...alpha, u: closeImage }), 200);
  assert.equal(await (await get('/__image-budget')).json(), 0);
});

test('downloads decode raw-only parts and stream external objects with safe filename parameters', async () => {
  const path = await attUrl(2);
  await record(alpha, withParts(html), parts);
  const res = await get(path);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="abc___'.txt"; filename*=UTF-8''abc%22%3B%F0%9F%8C%B1%27.txt`);
  assert.equal(await res.text(), 'download data');
  const external = 'A'.repeat(256 * 1024);
  const bytes = encode.encode(external), key = `att/${await sha(bytes)}/${gen}`;
  store.set(objectPath('alpha', key), bytes);
  await record(alpha, withParts(html, `%C3%A9${'%C3%A9'.repeat(150)}`, external), [parts[1], { part: 2, objectKey: key }]);
  reads.length = 0;
  const download = await get(path);
  assert.equal(download.status, 200);
  const full = download.headers.get('content-disposition')!.split("filename*=UTF-8''")[1];
  assert.equal(encode.encode(decodeURIComponent(full)).byteLength, 254);
  assert.equal((await download.arrayBuffer()).byteLength, external.length);
  assert.equal(reads.at(-1), objectPath('alpha', key));
});

test('workerd completes a verified 1 MiB transfer lasting over 61 seconds with no idle gap over 30 seconds', { timeout: 75_000 }, async () => {
  const data = encode.encode('L'.repeat(1024 * 1024));
  data.set(png);
  const key = `att/${await sha(data)}/${gen}`;
  const path = objectPath('alpha', key);
  // ASCII base64 inside MIME, including the raster magic bytes.
  const raw = withParts(html, 'inline').replace(Buffer.from('download data').toString('base64'), Buffer.from(data).toString('base64'));
  await record(alpha, raw, [parts[1], { part: 2, objectKey: key }]);
  store.set(path, data);
  let offset = 0;
  objectResponses.set(path, () => new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset) await new Promise(resolve => setTimeout(resolve, 20_500));
      controller.enqueue(data.slice(offset, offset + 256 * 1024));
      offset += 256 * 1024;
      if (offset === data.length) controller.close();
    },
  }, { highWaterMark: 0 }), { headers: { 'content-length': String(data.length) } }));
  try {
    const started = performance.now();
    const response = await get(await cidUrl(2));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data);
    assert.ok(performance.now() - started >= 61_000);
  } finally { objectResponses.delete(path); store.delete(path); }
});

test('workerd aborts a verified attachment when the upstream body is idle for 30 seconds', { timeout: 45_000 }, async () => {
  const plain = 'I'.repeat(1024 * 1024);
  const data = encode.encode(plain);
  const key = `att/${await sha(data)}/${gen}`;
  const path = objectPath('alpha', key);
  await record(alpha, withParts(html, 'stalled', plain), [parts[1], { part: 2, objectKey: key }]);
  store.set(path, data);
  const release = Promise.withResolvers<void>();
  objectResponses.set(path, () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data.slice(0, 256 * 1024));
      void release.promise.then(() => controller.close()).catch(() => {});
    },
  }), { headers: { 'content-length': String(data.length) } }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await get(await attUrl(2));
    assert.equal(response.status, 200);
    const started = performance.now();
    const result = await Promise.race([
      response.arrayBuffer().then(() => 'completed', () => 'aborted'),
      new Promise(resolve => { timer = setTimeout(() => resolve('still stalled'), 36_000); }),
    ]);
    assert.equal(result, 'aborted');
    assert.ok(performance.now() - started >= 29_000);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    release.resolve();
    objectResponses.delete(path);
    store.delete(path);
  }
});

test('legacy synthetic attachment rows do not name downloadable MIME parts', async () => {
  const raw = 'Content-Type: multipart/mixed; boundary=parts\r\n\r\n'
    + '--parts\r\nContent-Type: text/plain\r\n\r\nbody\r\n'
    + '--parts\r\nContent-Type: image/png\r\nContent-Disposition: attachment\r\n\r\npart\r\n'.repeat(513)
    + '--parts--\r\n';
  await record(alpha, raw, [{ part: 512, objectKey: null }]);
  await status(await attUrl(512));
});

test('external attachment key must be the digest of the corresponding raw MIME part', async () => {
  const bytes = encode.encode('B'.repeat(256 * 1024));
  const differentKey = `att/${await sha(bytes)}/${gen}`;
  store.set(objectPath('alpha', differentKey), bytes);
  await record(alpha, withParts(html, 'file', 'A'.repeat(bytes.byteLength)), [parts[1], { part: 2, objectKey: differentKey }]);
  reads.length = 0;
  await status(await attUrl(2));
  assert.ok(!reads.includes(objectPath('alpha', differentKey)));
});

test('same-length corruption in external attachment storage is not downloaded', async () => {
  const clean = encode.encode('A'.repeat(256 * 1024));
  const key = `att/${await sha(clean)}/${gen}`;
  const corrupt = clean.slice();
  corrupt[corrupt.length - 1]++;
  await record(alpha, withParts(html, 'file', 'A'.repeat(clean.byteLength)), [parts[1], { part: 2, objectKey: key }]);
  const path = await attUrl(2);
  const object = objectPath('alpha', key);
  store.set(object, clean);
  const control = await get(path);
  assert.equal(control.status, 200);
  assert.equal(await sha(new Uint8Array(await control.arrayBuffer())), await sha(clean));
  store.set(object, corrupt);
  let delivered = false;
  try {
    const response = await get(path);
    if (response.ok) delivered = (await response.arrayBuffer()).byteLength === clean.byteLength;
  } catch { /* workerd aborts a truncated fixed-length HTTP body */ }
  assert.equal(delivered, false);
});

test('every verified image request fetches upstream; expired or MAC-flipped tokens return 404 first', async () => {
  await record(alpha, withParts(html), parts);
  const body = await get(await bodyUrl(true));
  assert.equal(body.status, 200);
  const img = (await body.text()).match(/src="(https:\/\/content\.example\/v1\/img\/[^\"]+)"/)?.[1];
  assert.ok(img);
  tokenValues.push(img.split('/').at(-1)!);
  const before = upstreamReads;
  await status(img, 200);
  const another = await sign('img', { ...alpha, ep: 2, u: remote });
  assert.ok(new URL(img).pathname !== another, 'the second token must differ');
  await status(another, 200); // New token, same remote URL.
  assert.equal(upstreamReads, before + 2);
  const offset = img.lastIndexOf('.') + 1;
  await status(`${img.slice(0, offset)}${img[offset] === 'A' ? 'B' : 'A'}${img.slice(offset + 1)}`);
  await set('clock', 300_000);
  try { await status(img); }
  finally { await set('clock', 0); }
  assert.equal(upstreamReads, before + 2);
});

test('HSTS and every §3.1 header cover successes, empty 404, and img method 405', async () => {
  await record(alpha, withParts(html), parts);
  for (const [path, method, wanted] of [
    [await bodyUrl(), 'GET', 200], [await attUrl(2), 'GET', 200], [await cidUrl(1), 'GET', 200],
    [await imageUrl(), 'GET', 200], ['/v1/body/no-token', 'GET', 404], ['/not-found', 'GET', 404], [await imageUrl(), 'HEAD', 405],
  ] as const) {
    const res = await get(path, method);
    const bytes = (await res.arrayBuffer()).byteLength;
    assert.equal(res.status, wanted);
    if (wanted !== 200) assert.equal(bytes, 0);
    if (wanted === 405) assert.equal(res.headers.get('allow'), 'GET');
    if (wanted === 200 && path.startsWith('/v1/img/')) assert.equal(res.headers.get('content-length'), String(png.byteLength));
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('content-security-policy'),
      "default-src 'none'; img-src https://content.example data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors https://mail.example; sandbox allow-popups allow-popups-to-escape-sandbox");
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
});

test('an unread proxy response in workerd releases at its transfer deadline', { timeout: 70_000 }, async () => {
  const body = await sign('img', { ...alpha, u: deadlineImage });
  const probe = await mf.dispatchFetch(`${origin}/__unread-image`, { method: 'POST', body });
  assert.deepEqual(await probe.json(), { status: 200, before: deadlineImageBytes, after: 0 });
});

test('content logs contain only purpose, status, byte count and an eight-character SHA-256 prefix', async () => {
  await record(alpha, alternative(html));
  const path = await bodyUrl();
  await status(path, 200);
  const hash = (await sha(encode.encode(path.split('/').at(-1)!))).slice(0, 8);
  let wroteBody = false;
  for (const { level, message } of logs) {
    for (const value of [...tokenValues, keysJson, remote, 'picture@example', 'safe body']) assert.ok(!message.includes(value), 'sensitive data reached logs');
    // A transport abort is reported by workerd, not by our application logger.
    if (level === 'error' && message.startsWith('Uncaught exception:')) continue;
    const parsed = JSON.parse(message);
    assert.deepEqual(Object.keys(parsed).sort(), ['bytes', 'purpose', 'status', 'token']);
    assert.match(parsed.token, /^[\da-f]{8}$/);
    if (parsed.purpose === 'body' && parsed.token === hash && parsed.bytes > 0 && parsed.status === 200) wroteBody = true;
  }
  assert.ok(wroteBody);
});
