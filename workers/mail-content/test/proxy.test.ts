import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkRemoteImageUrl, fetchRemoteImage, logRemoteImage, remoteImageAccept, remoteImageConfig, remoteImageMethodAllowed,
  remoteImageLogLine, remoteImageResponseHeaders, remoteImageUserAgent, type RemoteImageResult,
} from '../src/proxy.ts';
import { config, endless, html, image, images, origins, ownDomains, redirect, svg, upstream } from './proxy-fixtures.ts';

const MiB = 1024 * 1024;
const refused = (url: string, cfg = config) => {
  const verdict = checkRemoteImageUrl(url, cfg);
  assert.equal(verdict.ok, false, `accepted ${url}`);
};
const accepted = (url: string, cfg = config) => {
  const verdict = checkRemoteImageUrl(url, cfg);
  assert.ok(verdict.ok, `refused ${url}`);
  return verdict.url;
};
const failed = (result: RemoteImageResult, reason?: string) => {
  assert.equal(result.ok, false, 'expected the failure result');
  if (reason !== undefined && !result.ok) assert.equal(result.reason, reason);
};

// ---- Rule 1: methods ----

test('methods: only GET is allowed; HEAD and everything else answer 405', () => {
  assert.equal(remoteImageMethodAllowed('GET'), true);
  for (const method of ['HEAD', 'get', 'POST', 'PUT', 'OPTIONS', 'DELETE', 'PATCH', 'TRACE', ''])
    assert.equal(remoteImageMethodAllowed(method), false, method);
});

// ---- Rule 2: the URL guard ----

test('guard: accepts http and https DNS names on ports 80 and 443 and returns the parsed URL', () => {
  assert.equal(accepted('https://images.sender.example/a.png').href, 'https://images.sender.example/a.png');
  assert.equal(accepted('http://sender.example/a.png').href, 'http://sender.example/a.png');
  assert.equal(accepted('HTTPS://Sender.EXAMPLE:443/a.png?x=1').href, 'https://sender.example/a.png?x=1');
  assert.equal(accepted('http://sender.example:80/').href, 'http://sender.example/');
  accepted('https://sender.example:80/a.png');
  accepted('http://sender.example:443/a.png');
  accepted('https://xn--bcher-kva.example/a.png');
  accepted('https://bücher.example/a.png');
  accepted('https://sender.example./a.png');
});

const ipForms = [
  // IPv4 dotted, integer, octal, hex, short and mixed forms
  'http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.1/',
  'http://8.8.8.8/', 'http://0.0.0.0/', 'http://0/', 'http://2130706433/', 'http://017700000001/',
  'http://0x7f000001/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://127.0.1/',
  'http://0x7f.1/', 'http://00000177.0x0.0.01/', 'http://4294967295/', 'http://127.0.0.1./', 'http://127.0.0.1:80/',
  'https://127.0.0.1:443/', 'http://%31%32%37.0.0.1/', 'http://%30x7f000001/', 'http://１２７.0.0.1/',
  'http://127。0。0。1/', 'http://1.1.1.1.', 'http://0X7F000001/',
  // IPv6 in every bracketed form
  'http://[::1]/', 'http://[::]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',
  'http://[fe80::1]/', 'http://[fd00::1]/', 'http://[2001:db8::1]/', 'https://[2606:4700:4700::1111]:443/',
  'http://[::127.0.0.1]/', 'http://[64:ff9b::7f00:1]/',
];

test('guard: refuses IP literals in every form, including forms URL parsing normalises into an IP', () => {
  for (const url of ipForms) refused(url);
});

test('guard: refuses names that cannot parse as hosts (trailing numeric labels, bad IPv4)', () => {
  for (const url of ['http://1.2.3.4.5/', 'http://example.123/', 'http://256.0.0.1/', 'http://0x100000000/',
    'http://[::1/', 'http://exa mple.example/', 'https://', 'not a url', '', '//sender.example/a.png'])
    refused(url);
});

test('guard: refuses private-looking names and their subdomains', () => {
  for (const url of ['http://localhost/', 'http://LOCALHOST./', 'http://localhost:80/', 'http://a.b.localhost/',
    'http://printer.local/', 'http://PRINTER.LOCAL./', 'http://metadata.google.internal/', 'http://svc.internal./x',
    'http://1.0.0.127.in-addr.arpa/', 'http://router.home.arpa/', 'http://arpa/', 'http://local/', 'http://internal/',
    // IDNA mapping and percent-decoding happen before the comparison
    'http://ｌｏｃａｌｈｏｓｔ/', 'http://ⓛocalhost/', 'http://localhost%2e/', 'http://printer%2elocal/', 'https://ｓｕｉｔｅ.example/', 'https://SUITE%2eEXAMPLE/'])
    refused(url);
});

test('guard: refuses single-label and malformed DNS names', () => {
  for (const url of ['http://intranet/', 'http://under_score.example/', `http://${'a'.repeat(64)}.example/`,
    'http://-lead.example/', 'http://trail-.example/', 'http://a..example/', 'http://sender.example../',
    `http://${Array(64).fill('abc').join('.')}.example/`, 'http://sender.0x7f/', 'http://sender.123/'])
    refused(url);
});

test('guard: refuses every configured own domain and its subdomains, after lowercasing and trailing-dot normalisation', () => {
  const own = [ownDomains.suiteDomain, ownDomains.contentDomain, ...ownDomains.storageDomains,
    ...ownDomains.accountDomains, ownDomains.workersDevSubdomain];
  for (const domain of own) {
    for (const host of [domain, `${domain}.`, domain.toUpperCase(), `content.${domain}`, `A.B.${domain.toUpperCase()}.`])
      refused(`https://${host}/a.png`);
  }
  // The content host itself, so the proxy can never fetch itself.
  refused(`${origins.contentOrigin}/v1/img/k.p.m`);
  refused('https://mail-content.example-acct.workers.dev/');
});

test('guard: suffix matching is label-aligned, not substring', () => {
  accepted('https://evilsuite.example/a.png');
  accepted('https://suite.example.sender.example/a.png');
  accepted('https://localhost.sender.example/a.png');
  accepted('https://other-acct.workers.dev/a.png');
  accepted('https://notlocal.example/a.png');
});

test('guard: refuses schemes other than http and https', () => {
  for (const url of ['ftp://sender.example/a.png', 'file:///etc/passwd', 'data:image/png;base64,AAAA',
    'javascript:alert(1)', 'ws://sender.example/', 'wss://sender.example/', 'blob:https://sender.example/x',
    'gopher://sender.example/', 'httpx://sender.example/'])
    refused(url);
});

test('guard: refuses ports other than 80 and 443', () => {
  for (const port of [0, 1, 22, 25, 81, 442, 444, 3000, 6379, 8080, 8443, 65535])
    for (const scheme of ['http', 'https']) refused(`${scheme}://sender.example:${port}/a.png`);
});

test('guard: refuses user information in any form', () => {
  for (const url of ['https://user@sender.example/a.png', 'https://user:pass@sender.example/a.png',
    'https://:pass@sender.example/a.png', 'http://sender.example@evil.example/', 'https://u%40x@sender.example/'])
    refused(url);
});

test('guard: allows at most 2,048 bytes, counted in UTF-8', () => {
  const base = 'https://sender.example/';
  accepted(base + 'a'.repeat(2048 - base.length));
  refused(base + 'a'.repeat(2049 - base.length));
  // Two-byte characters: 1,012 of them plus the base is 2,047 bytes but far fewer UTF-16 units.
  const wide = base + 'é'.repeat(Math.floor((2048 - base.length) / 2) + 1);
  assert.ok(wide.length < 2048 && new TextEncoder().encode(wide).length > 2048);
  refused(wide);
  // Percent-encoding expands non-ASCII paths: the parsed URL must also fit.
  const expands = base + 'é'.repeat(Math.floor((2048 - base.length) / 2) - 10);
  assert.ok(new TextEncoder().encode(expands).length <= 2048);
  assert.ok(new URL(expands).href.length > 2048);
  refused(expands);
});

test('guard: invalid configuration fails closed for every URL', async () => {
  const good = 'https://sender.example/a.png';
  const bad = [
    { ...ownDomains, suiteDomain: '' },
    { ...ownDomains, contentDomain: '127.0.0.1' },
    { ...ownDomains, storageDomains: ['ok.example', 'bad domain'] },
    { ...ownDomains, accountDomains: ['[::1]'] },
    { ...ownDomains, workersDevSubdomain: 'workers.dev' },
    { ...ownDomains, workersDevSubdomain: 'example-acct.example' },
  ];
  for (const own of bad) refused(good, remoteImageConfig(own));
  for (const limits of [{ remoteImageBytes: 0 }, { remoteImageRedirects: -1 }, { remoteImageTimeoutMs: Number.NaN },
    { maxUrlBytes: 1.5 }, { refusedZones: [''] }, { refusedZones: ['local', '1.2.3.4'] },
    // The spec's values are ceilings: configuration may tighten them, never loosen them.
    { maxUrlBytes: 2049 }, { remoteImageBytes: 2 ** 40 }, { remoteImageBytes: 5 * MiB + 1 }, { remoteImageRedirects: 4 },
    { remoteImageTimeoutMs: 10_001 }, { remoteImageTimeoutMs: 2 ** 31 }])
    refused(good, { ...config, ...limits });
  // An oversized limit is refused as configuration, before any fetch or allocation.
  const { fetchImpl, calls } = upstream({ [good]: image('image/png', images['image/png']) });
  failed(await fetchRemoteImage(good, { ...config, remoteImageBytes: 2 ** 40 }, fetchImpl, now), 'url');
  assert.equal(calls.length, 0);
  assert.ok((await fetchRemoteImage(good, { ...config, remoteImageBytes: 5 * MiB }, fetchImpl, now)).ok);
  // The configuration is read, not hard-coded: removing a zone changes the verdict.
  accepted('http://printer.local/', { ...config, refusedZones: ['localhost', 'internal', 'arpa'] });
});

// ---- Rules 3 to 5: the fetch ----

const target = 'https://img.sender.example/pixel.png';
const now = () => 0;

test('fetch: a 200 image with matching magic bytes succeeds and the type is normalised', async () => {
  const { fetchImpl, calls, unexpected } = upstream({
    [target]: image('Image/PNG; charset=binary', images['image/png'], { 'content-length': String(images['image/png'].length) }),
  });
  const result = await fetchRemoteImage(target, config, fetchImpl, now);
  assert.deepEqual(unexpected, []);
  assert.equal(calls.length, 1);
  assert.ok(result.ok);
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.length, images['image/png'].length);
  assert.deepEqual(result.bytes, images['image/png']);
});

test('fetch: every allowed type succeeds with its own magic bytes and fails with another type\'s', async () => {
  const types = Object.keys(images);
  for (const type of types) {
    const ok = await fetchRemoteImage(target, config, upstream({ [target]: image(type, images[type]) }).fetchImpl, now);
    assert.ok(ok.ok, `${type} refused`);
    assert.equal(ok.contentType, type);
    for (const other of types.filter(t => t !== type)) {
      const bad = await fetchRemoteImage(target, config, upstream({ [target]: image(type, images[other]) }).fetchImpl, now);
      failed(bad, 'magic');
    }
  }
});

test('fetch: AVIF needs an avif or avis brand in its ftyp box', async () => {
  const heic = images['image/avif'].slice();
  heic.set(new TextEncoder().encode('heic'), 8);
  heic.set(new TextEncoder().encode('heicmif1miaf'), 16);
  failed(await fetchRemoteImage(target, config, upstream({ [target]: image('image/avif', heic) }).fetchImpl, now), 'magic');
  const compatible = heic.slice();
  compatible.set(new TextEncoder().encode('avis'), 20);
  assert.ok((await fetchRemoteImage(target, config, upstream({ [target]: image('image/avif', compatible) }).fetchImpl, now)).ok);
});

test('fetch: a truncated header is refused even when its first bytes match', async () => {
  for (const [type, length] of [['image/x-icon', 21], ['image/x-icon', 5], ['image/bmp', 13], ['image/webp', 11], ['image/avif', 15]] as const)
    failed(await fetchRemoteImage(target, config, upstream({ [target]: image(type, images[type].slice(0, length)) }).fetchImpl, now), 'magic');
  assert.ok((await fetchRemoteImage(target, config, upstream({ [target]: image('image/x-icon', images['image/x-icon'].slice(0, 22)) }).fetchImpl, now)).ok);
});

test('fetch: a body in uneven chunks is assembled exactly, in one buffer with no slack', async () => {
  const whole = new Uint8Array(3 * MiB + 7);
  whole.set(images['image/png']);
  for (let i = images['image/png'].length; i < whole.length; i++) whole[i] = (i * 31) & 0xff;
  const sizes = [1, 7, 4096, 65_537, 1 << 20, 3, 2 * MiB];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let at = 0;
      for (const size of sizes) { controller.enqueue(whole.slice(at, Math.min(at + size, whole.length))); at += size; }
      controller.close();
    },
  });
  const result = await fetchRemoteImage(target, config, upstream({ [target]: image('image/png', body) }).fetchImpl, now);
  assert.ok(result.ok);
  assert.equal(result.length, whole.length);
  assert.equal(result.bytes.byteLength, whole.length);
  assert.equal(result.bytes.buffer.byteLength, whole.length);
  assert.ok(Buffer.from(result.bytes).equals(Buffer.from(whole)));
});

test('fetch: SVG is refused under any label, including image/png', async () => {
  for (const type of ['image/svg+xml', 'IMAGE/SVG+XML; charset=utf-8', 'image/svg'])
    failed(await fetchRemoteImage(target, config, upstream({ [target]: image(type, svg) }).fetchImpl, now), 'type');
  failed(await fetchRemoteImage(target, config, upstream({ [target]: image('image/png', svg) }).fetchImpl, now), 'magic');
});

test('fetch: an HTML body labelled image/png is refused by the magic-byte check', async () => {
  failed(await fetchRemoteImage(target, config, upstream({ [target]: image('image/png', html) }).fetchImpl, now), 'magic');
  failed(await fetchRemoteImage(target, config, upstream({ [target]: image('image/png', new Uint8Array(0)) }).fetchImpl, now), 'magic');
  failed(await fetchRemoteImage(target, config, upstream({ [target]: image('image/png', null) }).fetchImpl, now), 'magic');
});

test('fetch: content types outside the allowlist are refused', async () => {
  for (const type of ['text/html', 'image/jpg', 'image/tiff', 'image/heic', 'application/octet-stream', 'image/*', '', 'image/png, text/html'])
    failed(await fetchRemoteImage(target, config, upstream({ [target]: image(type, images['image/png']) }).fetchImpl, now), 'type');
  const untyped = () => new Response(images['image/png'], { status: 200 });
  const noType = upstream({ [target]: () => { const r = untyped(); r.headers.delete('content-type'); return r; } });
  failed(await fetchRemoteImage(target, config, noType.fetchImpl, now), 'type');
});

test('fetch: any status other than 200 is refused', async () => {
  for (const status of [201, 203, 204, 206, 226, 300, 304, 305, 400, 401, 403, 404, 410, 451, 500, 502, 503]) {
    const body = [204, 304].includes(status) ? null : images['image/png'];
    const result = await fetchRemoteImage(target, config, upstream({ [target]: image('image/png', body, {}, status) }).fetchImpl, now);
    failed(result, 'status');
  }
});

test('fetch: three redirect hops are followed, each Location resolved against the current URL', async () => {
  const { fetchImpl, calls, unexpected } = upstream({
    [target]: redirect('/hop/one.png', 301),
    'https://img.sender.example/hop/one.png': redirect('../two.png', 307),
    'https://img.sender.example/two.png': redirect('//cdn.sender.example/three.png?q=1', 308),
    'https://cdn.sender.example/three.png?q=1': image('image/gif', images['image/gif']),
  });
  const result = await fetchRemoteImage(target, config, fetchImpl, now);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(calls.map(c => c.url), [target, 'https://img.sender.example/hop/one.png',
    'https://img.sender.example/two.png', 'https://cdn.sender.example/three.png?q=1']);
  assert.ok(result.ok);
  assert.equal(result.contentType, 'image/gif');
});

test('fetch: a fourth redirect is refused and its target is never requested', async () => {
  const { fetchImpl, calls, unexpected } = upstream({
    [target]: redirect('https://a.sender.example/1'),
    'https://a.sender.example/1': redirect('https://a.sender.example/2', 303),
    'https://a.sender.example/2': redirect('https://a.sender.example/3'),
    'https://a.sender.example/3': redirect('https://a.sender.example/4'),
    'https://a.sender.example/4': image('image/png', images['image/png']),
  });
  failed(await fetchRemoteImage(target, config, fetchImpl, now), 'redirect');
  assert.deepEqual(unexpected, []);
  assert.equal(calls.length, 4);
  assert.ok(!calls.some(c => c.url === 'https://a.sender.example/4'));
});

test('fetch: the redirect limit is read from configuration', async () => {
  const routes = { [target]: redirect('https://a.sender.example/1'), 'https://a.sender.example/1': image('image/png', images['image/png']) };
  failed(await fetchRemoteImage(target, { ...config, remoteImageRedirects: 0 }, upstream(routes).fetchImpl, now), 'redirect');
  assert.ok((await fetchRemoteImage(target, { ...config, remoteImageRedirects: 1 }, upstream(routes).fetchImpl, now)).ok);
});

test('fetch: a redirect to a refused host, an IP or a bad URL is refused and never requested', async () => {
  const locations = [
    'http://127.0.0.1/a.png', 'http://2130706433/', 'http://[::1]/', '//169.254.169.254/latest', 'http://localhost/',
    'https://printer.local/', 'https://svc.internal/', `${origins.contentOrigin}/v1/img/x`, 'https://Suite.Example./',
    'https://bucket.storage.example/k', 'https://api.account.example/', 'https://w.example-acct.workers.dev/',
    'https://sender.example:8080/', 'https://user:pw@sender.example/', 'ftp://sender.example/a', 'javascript:alert(1)',
    'data:image/png;base64,iVBORw0KGgo=', 'http://[::1', `https://sender.example/${'a'.repeat(2048)}`,
  ];
  for (const location of locations) {
    const { fetchImpl, calls, unexpected } = upstream({ [target]: redirect(location) });
    failed(await fetchRemoteImage(target, config, fetchImpl, now), 'redirect');
    assert.equal(calls.length, 1, location);
    assert.deepEqual(unexpected, [], location);
  }
  const missing = upstream({ [target]: redirect(null) });
  failed(await fetchRemoteImage(target, config, missing.fetchImpl, now), 'redirect');
});

test('fetch: a refused starting URL never reaches the upstream', async () => {
  for (const url of ['http://127.0.0.1/', 'http://localhost/', 'https://sender.example:8443/', 'https://u@sender.example/']) {
    const { fetchImpl, calls } = upstream({});
    failed(await fetchRemoteImage(url, config, fetchImpl, now), 'url');
    assert.equal(calls.length, 0);
  }
});

const forbiddenHeaders = /^(cookie|cookie2|referer|origin|authorization|forwarded|x-forwarded-.*|x-real-ip|true-client-ip|cf-connecting-ip|via|sec-ch-.*|sec-fetch-.*|dnt|save-data|viewport-width|width|dpr|device-memory|downlink|ect|rtt)$/;

test('fetch: every hop sends only the fixed Accept and User-Agent, with GET, manual redirects and a signal', async () => {
  const { fetchImpl, calls } = upstream({
    [target]: redirect('https://b.sender.example/1', 302),
    'https://b.sender.example/1': redirect('https://c.sender.example/2', 301),
    'https://c.sender.example/2': image('image/webp', images['image/webp'], { 'set-cookie': 'a=b' }),
  });
  assert.ok((await fetchRemoteImage(target, config, fetchImpl, now)).ok);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.redirect, 'manual');
    assert.ok(call.hasSignal);
    assert.deepEqual(call.headers, [['accept', remoteImageAccept], ['user-agent', remoteImageUserAgent]]);
    for (const [name] of call.headers) assert.ok(!forbiddenHeaders.test(name), name);
  }
  assert.equal(remoteImageAccept, 'image/avif,image/webp,image/png,image/*;q=0.8');
  assert.ok(!/kofra|mail/i.test(remoteImageUserAgent));
});

test('fetch: a declared Content-Length over the limit is refused without reading the body', async () => {
  const { stream, state } = endless();
  const result = await fetchRemoteImage(target, config, upstream({
    [target]: image('image/png', stream, { 'content-length': String(5 * MiB + 1) }),
  }).fetchImpl, now);
  failed(result, 'size');
  assert.equal(state.pulled, 0);
});

test('fetch: a body with no Content-Length that grows past 5 MiB is refused and its stream cancelled', { timeout: 5_000 }, async () => {
  const { stream, state } = endless();
  const result = await fetchRemoteImage(target, config, upstream({ [target]: image('image/png', stream) }).fetchImpl, now);
  failed(result, 'size');
  assert.ok(state.cancelled);
  assert.ok(state.pulled <= 5 * MiB + 64 * 1024, `read ${state.pulled} bytes`);
});

test('fetch: a body longer than its declared Content-Length is still capped', { timeout: 5_000 }, async () => {
  const { stream, state } = endless();
  const result = await fetchRemoteImage(target, config, upstream({
    [target]: image('image/png', stream, { 'content-length': '100' }),
  }).fetchImpl, now);
  failed(result, 'size');
  assert.ok(state.cancelled);
});

test('fetch: exactly 5 MiB is accepted, one byte more is refused, and the limit is configuration', async () => {
  const exact = new Uint8Array(5 * MiB);
  exact.set(images['image/png']);
  const ok = await fetchRemoteImage(target, config, upstream({ [target]: image('image/png', exact) }).fetchImpl, now);
  assert.ok(ok.ok);
  assert.equal(ok.length, 5 * MiB);
  const over = new Uint8Array(5 * MiB + 1);
  over.set(images['image/png']);
  failed(await fetchRemoteImage(target, config, upstream({ [target]: image('image/png', over) }).fetchImpl, now), 'size');
  failed(await fetchRemoteImage(target, { ...config, remoteImageBytes: 63 }, upstream({ [target]: image('image/png', images['image/png']) }).fetchImpl, now), 'size');
});

test('fetch: an invalid Content-Length is refused', async () => {
  for (const value of ['-1', 'abc', '1e3', '10, 20'])
    failed(await fetchRemoteImage(target, config, upstream({
      [target]: image('image/png', images['image/png'], { 'content-length': value }),
    }).fetchImpl, now), 'size');
});

test('fetch: past the 10 s deadline on a fake clock, the result is the failure result', async () => {
  let clock = 1_000_000;
  const tick = (ms: number) => () => { clock += ms; return new Response(images['image/png'], { headers: { 'content-type': 'image/png' } }); };
  failed(await fetchRemoteImage(target, config, upstream({ [target]: tick(10_001) }).fetchImpl, () => clock), 'timeout');
  clock = 0;
  assert.ok((await fetchRemoteImage(target, config, upstream({ [target]: tick(9_999) }).fetchImpl, () => clock)).ok);
});

test('fetch: the 10 s deadline is total across hops, not per hop', async () => {
  let clock = 0;
  const slowRedirect = (location: string) => () => { clock += 4_000; return redirect(location)(); };
  const { fetchImpl, calls } = upstream({
    [target]: slowRedirect('https://a.sender.example/1'),
    'https://a.sender.example/1': slowRedirect('https://a.sender.example/2'),
    'https://a.sender.example/2': slowRedirect('https://a.sender.example/3'),
    'https://a.sender.example/3': image('image/png', images['image/png']),
  });
  failed(await fetchRemoteImage(target, config, fetchImpl, () => clock), 'timeout');
  assert.ok(calls.length <= 3);
});

test('fetch: the deadline covers reading the body', async () => {
  let clock = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(images['image/png'].slice(0, 16)); },
    pull(controller) { clock += 6_000; controller.enqueue(new Uint8Array(1024)); },
  });
  failed(await fetchRemoteImage(target, config, upstream({ [target]: image('image/png', body) }).fetchImpl, () => clock), 'timeout');
});

test('fetch: a hanging upstream is aborted by the signal at 10 s (mock timers)', { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false;
  const hang = () => new Promise<Response>((_, reject) => {
    // Never resolves on its own; ignores the signal, so the proxy must not rely on fetchImpl honouring it.
    void reject;
  });
  const listens = (signal: AbortSignal | undefined) => new Promise<Response>((_, reject) => {
    signal?.addEventListener('abort', () => { aborted = true; reject(signal.reason); });
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  for (const route of [hang, listens]) {
    let settled: RemoteImageResult | undefined;
    const pending = fetchRemoteImage(target, config, upstream({ [target]: route }).fetchImpl, Date.now).then(r => { settled = r; return r; });
    await flush();
    t.mock.timers.tick(9_999);
    await flush();
    assert.equal(settled, undefined, 'settled before 10 s');
    t.mock.timers.tick(1);
    failed(await pending, 'timeout');
  }
  assert.ok(aborted, 'the fetch signal was not aborted');
});

test('fetch: a body that stalls is aborted at the deadline (mock timers)', { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(images['image/png']); },
    pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; },
  });
  const pending = fetchRemoteImage(target, config, upstream({ [target]: image('image/png', body) }).fetchImpl, Date.now);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_000);
  failed(await pending, 'timeout');
  assert.ok(cancelled);
});

test('fetch: the timeout is read from configuration', async () => {
  let clock = 0;
  const route = () => { clock += 51; return new Response(images['image/png'], { headers: { 'content-type': 'image/png' } }); };
  failed(await fetchRemoteImage(target, { ...config, remoteImageTimeoutMs: 50 }, upstream({ [target]: route }).fetchImpl, () => clock), 'timeout');
});

test('fetch: a throwing upstream or garbage input yields the failure result, never an exception', async () => {
  const boom = upstream({ [target]: () => { throw new Error(`boom ${target}`); } });
  failed(await fetchRemoteImage(target, config, boom.fetchImpl, now), 'network');
  const rejecting: typeof boom.fetchImpl = async () => Promise.reject(new Error('reset'));
  failed(await fetchRemoteImage(target, config, rejecting, now), 'network');
  failed(await fetchRemoteImage('', config, rejecting, now), 'url');
  failed(await fetchRemoteImage(target, { ...config, remoteImageBytes: -1 }, rejecting, now), 'url');
});

// ---- Rule 4: outgoing headers are rebuilt from scratch (section 3.1) ----

test('headers: built from scratch with the section 3.1 set; no upstream header passes through', async () => {
  const upstreamHeaders = {
    'set-cookie': 'track=1', 'cache-control': 'public, max-age=86400', 'content-security-policy': "default-src *",
    'access-control-allow-origin': '*', 'x-tracking-id': 'abc', 'content-disposition': 'inline', 'etag': '"x"',
    'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT', 'link': '<https://sender.example/>; rel=preload',
    'refresh': '0; url=https://sender.example/', 'content-length': String(images['image/jpeg'].length),
  };
  const result = await fetchRemoteImage(target, config, upstream({
    [target]: image('IMAGE/JPEG ; q=1', images['image/jpeg'], upstreamHeaders),
  }).fetchImpl, now);
  assert.ok(result.ok);
  const headers = remoteImageResponseHeaders(result, origins);
  assert.deepEqual([...headers].sort(), [
    ['cache-control', 'private, no-store'],
    ['content-length', String(images['image/jpeg'].length)],
    ['content-security-policy', "default-src 'none'; img-src https://content.content-zone.example data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors https://mail.suite.example; sandbox allow-popups allow-popups-to-escape-sandbox"],
    ['content-type', 'image/jpeg'],
    ['referrer-policy', 'no-referrer'],
    ['x-content-type-options', 'nosniff'],
  ]);
  for (const name of Object.keys(upstreamHeaders).filter(n => n !== 'content-length' && n !== 'cache-control' && n !== 'content-security-policy'))
    assert.equal(headers.get(name), null, name);
});

test('headers: origins must be bare https origins', () => {
  const result = { ok: true as const, contentType: 'image/png', bytes: images['image/png'], length: images['image/png'].length };
  for (const bad of [
    { ...origins, contentOrigin: 'http://content.content-zone.example' },
    { ...origins, appOrigin: 'https://mail.suite.example/path' },
    { ...origins, appOrigin: 'https://u:p@mail.suite.example' },
    { ...origins, contentOrigin: "https://content.content-zone.example; script-src *" },
    { ...origins, contentOrigin: 'https://content.content-zone.example/' },
  ]) assert.throws(() => remoteImageResponseHeaders(result, bad), /origin/);
  assert.throws(() => remoteImageResponseHeaders({ ...result, contentType: 'image/svg+xml' }, origins), /type/);
  assert.throws(() => remoteImageResponseHeaders({ ...result, length: 3 }, origins), /length/);
});

// ---- Rule 7: logging ----

const tokenHash = 'ab12cd34'.padEnd(64, '9');

test('log line: only purpose, status, byte count and the first 8 hex characters of the token hash', async () => {
  const ok = await fetchRemoteImage(target, config, upstream({ [target]: image('image/png', images['image/png']) }).fetchImpl, now);
  assert.deepEqual(remoteImageLogLine(tokenHash, ok), { purpose: 'img', status: 200, bytes: 64, token: 'ab12cd34' });
  const bad = await fetchRemoteImage('http://127.0.0.1/', config, upstream({}).fetchImpl, now);
  assert.deepEqual(remoteImageLogLine(tokenHash, bad), { purpose: 'img', status: 404, bytes: 0, token: 'ab12cd34' });
  // Anything that is not a lowercase SHA-256 hex digest (for example a raw token) is never logged, even in part.
  for (const notHash of ['v1.eyJ2IjoxfQ.mac', tokenHash.toUpperCase(), tokenHash.slice(0, 63), `${tokenHash}0`, ''])
    assert.deepEqual(remoteImageLogLine(notHash, ok), { purpose: 'img', status: 200, bytes: 64, token: null });
});

test('logs: no URL, host or token appears in captured console output on any path', async (t) => {
  const captured: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const)
    t.mock.method(console, method, (...args: unknown[]) => { captured.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' ')); });
  const secretHost = 'secret-tracker.sender.example';
  const start = `https://${secretHost}/open?id=recipient-42`;
  const scenarios: Array<[string, Parameters<typeof upstream>[0]]> = [
    [start, { [start]: image('image/png', images['image/png']) }],
    [start, { [start]: image('image/svg+xml', svg) }],
    [start, { [start]: image('image/png', html) }],
    [start, { [start]: image('image/png', images['image/png'], {}, 500) }],
    [start, { [start]: redirect(`https://${secretHost}/r1`), [`https://${secretHost}/r1`]: redirect('http://127.0.0.1/x') }],
    [start, { [start]: redirect(null) }],
    [start, { [start]: () => { throw new Error(`failed ${start}`); } }],
    [start, { [start]: image('image/png', endless().stream) }],
    [`http://localhost/${secretHost}`, {}],
    [`https://u:p@${secretHost}/`, {}],
  ];
  for (const [url, routes] of scenarios) {
    const result = await fetchRemoteImage(url, config, upstream(routes).fetchImpl, now);
    logRemoteImage(tokenHash, result);
    logRemoteImage('v1.raw-token-text.mac', result);
  }
  assert.equal(captured.length, scenarios.length * 2, 'only the log helper writes to the console');
  for (const line of captured) {
    assert.ok(!line.includes(secretHost) && !line.includes('recipient-42') && !line.includes('://') && !line.includes('127.0.0.1'), line);
    assert.ok(!line.includes('raw-token') && !line.includes(tokenHash), line);
    assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['bytes', 'purpose', 'status', 'token']);
  }
});
