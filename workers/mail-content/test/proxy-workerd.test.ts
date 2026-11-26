import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { images } from './proxy-fixtures.ts';

// The upstream is a Miniflare outbound service: every subrequest the Worker
// makes lands here, so nothing reaches the real network.
interface Seen { url: string; method: string; headers: [string, string][] }
const seen: Seen[] = [];
const routes = new Map<string, () => Response>();

let mf: Miniflare;
before(async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./proxy-fixture-worker.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', target: 'es2024',
  });
  mf = new Miniflare({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-07-30',
    outboundService: (request: Request) => {
      seen.push({ url: request.url, method: request.method, headers: [...request.headers] });
      const route = routes.get(request.url);
      return route ? route() : new Response('unexpected', { status: 599 });
    },
  });
});
after(() => mf?.dispose());

const incoming = {
  cookie: 'session=app-secret', referer: 'https://mail.suite.example/inbox/1', 'x-forwarded-for': '203.0.113.7',
  'x-real-ip': '203.0.113.7', forwarded: 'for=203.0.113.7', 'sec-ch-ua': '"Browser";v="1"', 'sec-ch-ua-platform': '"OS"',
  'user-agent': 'ReaderBrowser/1.0 (reader-device)', 'accept-language': 'nl-NL', authorization: 'Bearer reader',
  origin: 'https://mail.suite.example', dnt: '1',
};
const forbidden = /^(cookie|cookie2|referer|origin|authorization|forwarded|x-forwarded-.*|x-real-ip|true-client-ip|cf-connecting-ip|via|sec-ch-.*|sec-fetch-.*|dnt|save-data|accept-language)$/;

async function run(url: string) {
  const response = await mf.dispatchFetch('https://content.content-zone.example/fetch', {
    method: 'POST', headers: incoming, body: JSON.stringify({ url }),
  });
  return await response.json() as { ok: boolean; reason?: string; contentType?: string; length?: number; first?: number[] };
}

test('workerd: the guard refuses IP literals in every form under the runtime URL parser', async () => {
  const refused = ['http://127.0.0.1/', 'http://2130706433/', 'http://017700000001/', 'http://0x7f000001/', 'http://0x7f.1/',
    'http://127.1/', 'http://%31%32%37.0.0.1/', 'http://１２７.0.0.1/', 'http://127。0。0。1/', 'http://127.0.0.1./',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/', 'http://169.254.169.254/', 'http://0/',
    'http://localhost./', 'https://content.content-zone.example/', 'https://x.example-acct.workers.dev/',
    'https://sender.example:8080/', 'https://u:p@sender.example/'];
  const response = await mf.dispatchFetch('https://content.content-zone.example/guard', {
    method: 'POST', body: JSON.stringify({ urls: [...refused, 'https://Sender.EXAMPLE./a.png', 'https://bücher.example/a.png'] }),
  });
  const verdicts = await response.json() as Array<string | null>;
  assert.deepEqual(verdicts.slice(0, refused.length), refused.map(() => null));
  assert.deepEqual(verdicts.slice(refused.length), ['https://sender.example./a.png', 'https://xn--bcher-kva.example/a.png']);
});

test('workerd: three manual redirects are followed and no hop carries a cookie, Referer or forwarded header', async () => {
  seen.length = 0;
  routes.clear();
  routes.set('https://img.sender.example/start.png', () => new Response(null, { status: 302, headers: { location: '/next.png' } }));
  routes.set('https://img.sender.example/next.png', () => new Response(null, { status: 301, headers: { location: 'https://cdn.sender.example/a' } }));
  routes.set('https://cdn.sender.example/a', () => new Response(null, { status: 307, headers: { location: 'http://cdn.sender.example/final' } }));
  routes.set('http://cdn.sender.example/final', () => new Response(images['image/png'], {
    headers: { 'content-type': 'image/png', 'set-cookie': 'tracker=1' },
  }));
  const result = await run('https://img.sender.example/start.png');
  assert.deepEqual(result, { ok: true, contentType: 'image/png', length: 64, first: Array.from(images['image/png'].slice(0, 8)) });
  assert.deepEqual(seen.map(s => s.url), ['https://img.sender.example/start.png', 'https://img.sender.example/next.png',
    'https://cdn.sender.example/a', 'http://cdn.sender.example/final']);
  for (const hop of seen) {
    assert.equal(hop.method, 'GET');
    const names = hop.headers.map(([name]) => name);
    for (const name of names) assert.ok(!forbidden.test(name), `${hop.url} sent ${name}`);
    const values = hop.headers.map(([, value]) => value).join('\n');
    for (const leak of ['app-secret', '203.0.113.7', 'ReaderBrowser', 'reader-device', 'Bearer', 'nl-NL', 'mail.suite.example'])
      assert.ok(!values.includes(leak), `${hop.url} leaked ${leak}`);
    assert.equal(hop.headers.find(([n]) => n === 'accept')?.[1], 'image/avif,image/webp,image/png,image/*;q=0.8');
  }
});

test('workerd: a fourth redirect is refused and its target is never requested', async () => {
  seen.length = 0;
  routes.clear();
  for (let i = 0; i < 4; i++)
    routes.set(`https://r.sender.example/${i}`, () => new Response(null, { status: 302, headers: { location: `/${i + 1}` } }));
  routes.set('https://r.sender.example/4', () => new Response(images['image/png'], { headers: { 'content-type': 'image/png' } }));
  assert.deepEqual(await run('https://r.sender.example/0'), { ok: false, reason: 'redirect' });
  assert.equal(seen.length, 4);
  assert.ok(!seen.some(s => s.url.endsWith('/4')));
});

test('workerd: a redirect to an IP or an own domain is refused before any request is made', async () => {
  for (const location of ['http://127.0.0.1/', 'http://[::1]/', 'https://content.content-zone.example/v1/img/x', 'http://localhost/']) {
    seen.length = 0;
    routes.clear();
    routes.set('https://img.sender.example/r', () => new Response(null, { status: 302, headers: { location } }));
    assert.deepEqual(await run('https://img.sender.example/r'), { ok: false, reason: 'redirect' });
    assert.deepEqual(seen.map(s => s.url), ['https://img.sender.example/r']);
  }
});

test('workerd: an endless upstream body with no Content-Length is refused at 5 MiB', async () => {
  seen.length = 0;
  routes.clear();
  routes.set('https://big.sender.example/x.png', () => {
    let sent = 0;
    const chunk = new Uint8Array(256 * 1024);
    chunk.set(images['image/png']);
    return new Response(new ReadableStream({
      pull(controller) {
        sent += chunk.length;
        controller.enqueue(chunk);
        if (sent > 64 * 1024 * 1024) controller.close();
      },
    }), { headers: { 'content-type': 'image/png' } });
  });
  assert.deepEqual(await run('https://big.sender.example/x.png'), { ok: false, reason: 'size' });
});

test('workerd: a buffered image becomes a response with exactly the rebuilt headers and the same bytes', async () => {
  seen.length = 0;
  routes.clear();
  const whole = new Uint8Array(5 * 1024 * 1024);
  whole.set(images['image/jpeg']);
  for (let i = images['image/jpeg'].length; i < whole.length; i++) whole[i] = (i * 7) & 0xff;
  routes.set('https://img.sender.example/big.jpg', () => new Response(new ReadableStream({
    start(controller) {
      for (let at = 0; at < whole.length; at += 300_001) controller.enqueue(whole.slice(at, at + 300_001));
      controller.close();
    },
  }), { headers: { 'content-type': 'image/jpeg', 'set-cookie': 'tracker=1', 'access-control-allow-origin': '*' } }));
  const response = await mf.dispatchFetch('https://content.content-zone.example/image', {
    method: 'POST', headers: incoming, body: JSON.stringify({ url: 'https://img.sender.example/big.jpg' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual([...response.headers.keys()].sort(), ['cache-control', 'content-length', 'content-security-policy',
    'content-type', 'referrer-policy', 'x-content-type-options']);
  assert.equal(response.headers.get('content-length'), String(whole.length));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(whole)));
});
