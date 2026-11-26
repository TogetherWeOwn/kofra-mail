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
const reads: string[] = [];
const logs: string[] = [];
const tokenValues: string[] = [];
let upstreamReads = 0;
let mf: Miniflare;

before(async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./content-worker-fixture.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'],
  });
  mf = new Miniflare({
    name: 'content', compatibilityDate: '2026-07-30', modules: true, script: outputFiles[0].text,
    bindings: {
      MAIL_CONTENT_ENABLED: 'on', CONTENT_ORIGIN: origin, MAIL_APP_ORIGIN: 'https://mail.example',
      CONTENT_URL_KEYS: keysJson, CONTENT_S3_ENDPOINT: 'https://objects.example',
      CONTENT_S3_ACCESS_KEY_ID: crypto.randomUUID(), CONTENT_S3_SECRET_ACCESS_KEY: crypto.randomUUID(),
      CONTENT_WORKERS_DEV_DOMAIN: 'account-example.workers.dev', CONTENT_ACCOUNT_DOMAIN: 'account.example',
      CONTENT_ZONE: 'content.example', CONTENT_SUITE_DOMAIN: 'mail.example', CONTENT_STORAGE_DOMAIN: 'objects.example',
    },
    serviceBindings: {
      MAIL_LOOKUP: { name: 'content', entrypoint: 'ContentLookup' },
      ACCOUNT_EPOCH: { name: 'content', entrypoint: 'CredentialEpoch' },
      MINT: { name: 'content', entrypoint: 'ContentMint' },
    },
    handleStructuredLogs: ({ message }: { message: string }) => { logs.push(message); },
    outboundService(request: Request) {
      if (request.url === remote) {
        upstreamReads++;
        return new Response(png, { headers: { 'content-type': 'image/png', 'set-cookie': 'not-forwarded=true' } });
      }
      const url = new URL(request.url);
      reads.push(url.pathname);
      const bytes = store.get(url.pathname);
      if (url.origin !== 'https://objects.example' || request.method !== 'GET' || !request.headers.has('authorization') || !bytes) {
        return new Response(null, { status: 404 });
      }
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    },
  });
});
after(() => mf?.dispose());

async function set(name: string, value: unknown) {
  const res = await mf.dispatchFetch(`${origin}/__${name}`, { method: 'POST', body: JSON.stringify(value) });
  assert.equal(res.status, 200);
}
async function countCache() { return (await mf.dispatchFetch(`${origin}/__cache`)).json(); }
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
  assert.deepEqual(Object.keys(config).sort(), ['compatibility_date', 'main', 'name', 'preview_urls', 'services', 'vars', 'workers_dev']);
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
    await status(result.value.url, 200);
  }
  for (const method of ['mint', 'mintFromBody', 'signDerived', 'fetch']) assert.deepEqual(await rpc(method, 'body', { ...alpha, ri: false }), { refused: true });
  for (const purpose of ['cid', 'img']) assert.deepEqual(await rpc('mintForWeb', purpose, { ...alpha, part: 1 }), { refused: true });
});

test('raised credential epoch invalidates an HTTP body URL at the isolate cache TTL', async () => {
  await record(alpha, alternative(html));
  const sub = 'user-epoch';
  await set('owner', sub);
  const path = await sign('body', { ...alpha, sub, ri: false });
  try {
    await status(path, 200);
    await set('epoch', [sub, 2]);
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

test('signed image cache is read only after verification; expired or MAC-flipped cache hits are 404', async () => {
  await record(alpha, withParts(html), parts);
  const body = await get(await bodyUrl(true));
  assert.equal(body.status, 200);
  const img = (await body.text()).match(/src="(https:\/\/content\.example\/v1\/img\/[^\"]+)"/)?.[1];
  assert.ok(img);
  tokenValues.push(img.split('/').at(-1)!);
  const before = upstreamReads;
  await status(img, 200);
  await status(await imageUrl(), 200); // New token, same remote URL.
  assert.equal(upstreamReads, before + 1);
  const cacheReads = await countCache();
  const offset = img.lastIndexOf('.') + 1;
  await status(`${img.slice(0, offset)}${img[offset] === 'A' ? 'B' : 'A'}${img.slice(offset + 1)}`);
  await set('clock', 300_000);
  try { await status(img); }
  finally { await set('clock', 0); }
  assert.equal(await countCache(), cacheReads);
  assert.equal(upstreamReads, before + 1);
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

test('content logs contain only purpose, status, byte count and an eight-character SHA-256 prefix', async () => {
  await record(alpha, alternative(html));
  const path = await bodyUrl();
  await status(path, 200);
  const hash = (await sha(encode.encode(path.split('/').at(-1)!))).slice(0, 8);
  assert.ok(logs.some(line => {
    try { const value = JSON.parse(line); return value.purpose === 'body' && value.token === hash && value.bytes > 0 && value.status === 200; }
    catch { return false; }
  }));
  for (const line of logs) {
    for (const value of [...tokenValues, keysJson, remote, 'picture@example', 'safe body']) assert.ok(!line.includes(value), 'sensitive data reached logs');
    const parsed = JSON.parse(line);
    assert.deepEqual(Object.keys(parsed).sort(), ['bytes', 'purpose', 'status', 'token']);
    assert.match(parsed.token, /^[\da-f]{8}$/);
  }
});
