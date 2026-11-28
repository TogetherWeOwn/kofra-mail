import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { linkHosts, parseRange, serveFileLink, type FileLinkEnv } from '../src/file-link.ts';
import { escapeHtml, LINK_PAGE_CSP, linkDisposition, linkPage, visibleText } from '../src/link-page.ts';

// The link host's page and routing (docs/m3-outbound-plan.md, M3-13), without
// workerd: escaping, bidi removal, headers, ranges, and that the flood bucket
// runs before any lookup. The end-to-end acceptance runs in
// workers/mail-backend/test/file-links.test.ts against the real mailbox.

const RLO = String.fromCodePoint(0x202e), LRI = String.fromCodePoint(0x2066), PDI = String.fromCodePoint(0x2069), ALM = String.fromCodePoint(0x061c);
const TOKEN = 'abcdefghijklmnopqrstuA';
type Node = DefaultTreeAdapterMap['childNode'];
type Parent = DefaultTreeAdapterMap['parentNode'];

function walk(node: Parent | Node, visit: (node: Parent | Node) => void) {
  visit(node);
  for (const child of 'childNodes' in node ? node.childNodes : []) walk(child, visit);
  if ('content' in node && node.content) walk(node.content, visit);
}
function elements(html: string) {
  const names: string[] = [];
  const attributes: string[] = [];
  let text = '';
  walk(parse(html), node => {
    if ('tagName' in node) {
      names.push(node.tagName);
      for (const { name } of node.attrs) attributes.push(`${node.tagName}.${name}`);
    }
    if (node.nodeName === '#text' && 'value' in node) text += node.value;
  });
  return { names, attributes, text };
}

test('a malicious file name or sender name renders as text, with bidi controls removed', () => {
  const name = `<img src=x onerror=alert(1)>${RLO}gpj.exe"'&`;
  const sender = { name: `</dd><script>alert(2)</script>${LRI}Boss${PDI}`, email: `a"<b>@example.com${ALM}` };
  const html = linkPage({ token: TOKEN, name, size: 2048, sender, expiresAt: Date.UTC(2026, 11, 28, 14, 30) });
  const parsed = elements(html);
  assert.deepEqual([...new Set(parsed.names)].sort(), ['a', 'body', 'button', 'dd', 'dl', 'dt', 'form', 'h1', 'head', 'html', 'main', 'meta', 'p', 'style', 'title']);
  assert.ok(!parsed.attributes.some(attribute => attribute.endsWith('.onerror') || attribute.endsWith('.src')), 'no attribute comes from a name');
  assert.ok(parsed.text.includes(`<img src=x onerror=alert(1)>gpj.exe"'&`), 'the file name is text, without its bidi control');
  assert.ok(parsed.text.includes(`</dd><script>alert(2)</script>Boss <a"<b>@example.com>`), 'the sender is text');
  for (const control of [RLO, LRI, PDI, ALM]) assert.ok(!html.includes(control));
  assert.ok(parsed.text.includes('Until 2026-12-28 14:30 UTC'));
  assert.ok(parsed.text.includes('2.0 KB'));
  assert.ok(html.includes(`href="/f/${TOKEN}/download"`) && html.includes(`action="/f/${TOKEN}/report"`));
  assert.ok(!/<script/i.test(html.replaceAll('&lt;script', '')), 'no script element');
});

test('a never-expiring link says so; a sender without a name shows the address', () => {
  const parsed = elements(linkPage({ token: TOKEN, name: 'a.txt', size: 1, sender: { name: `${RLO}`, email: 'x@example.com' }, expiresAt: null }));
  assert.ok(parsed.text.includes('No expiry date'));
  assert.ok(parsed.text.includes('1 byte'));
  assert.ok(parsed.text.includes('Fromx@example.com'));
});

test('escaping covers every character that can end text or an attribute', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(visibleText(`a${RLO}b\u0000c\u0085d`), 'abcd');
  assert.throws(() => linkPage({ token: '"><x', name: 'a', size: 1, sender: { name: '', email: 'e' }, expiresAt: null }));
});

test('the download name cannot add or end a disposition parameter', () => {
  assert.equal(linkDisposition(`re"port;${RLO}\\x/y.html`), `attachment; filename="re_port_xy.html"; filename*=UTF-8''re%22port%3Bxy.html`);
  assert.equal(linkDisposition('naïve.txt'), `attachment; filename="na_ve.txt"; filename*=UTF-8''na%C3%AFve.txt`);
  assert.equal(linkDisposition(`${RLO}/`), `attachment; filename="download"; filename*=UTF-8''download`);
  assert.ok(new TextEncoder().encode(decodeURIComponent(linkDisposition('é'.repeat(300)).split("''")[1])).byteLength <= 255);
});

test('one byte range or the whole file', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-10', 1000), { start: 990, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=10-5000', 1000), { start: 10, end: 999 });
  for (const header of [null, 'bytes=0-1,5-6', 'items=0-1', 'bytes=-', 'bytes=9-1', 'bytes=1-2-3', `bytes=${'9'.repeat(17)}-`]) {
    assert.equal(parseRange(header, 1000), 'none', String(header));
  }
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
});

test('link hosts are host names, optionally with a port; anything else serves none', () => {
  assert.deepEqual(linkHosts('Files.Mail-Links.Example, files.example.test localhost:8787'), ['files.mail-links.example', 'files.example.test', 'localhost:8787']);
  assert.deepEqual(linkHosts(undefined), []);
  assert.deepEqual(linkHosts('files.example.test https://evil.example'), []);
});

function stubEnv(admit: boolean | 'missing' | 'throws') {
  const calls: string[] = [];
  const env: FileLinkEnv = {
    MAIL_CONTENT_ENABLED: 'on',
    ...(admit !== 'missing' && { LINK_FLOOD: { async limit({ key }) {
      calls.push(`flood:${key}`);
      if (admit === 'throws') throw new Error('limiter down');
      return { success: admit };
    } } }),
    MAIL_LOOKUP: {
      async fileLink() { calls.push('lookup'); return { status: 'gone' }; },
      async reportFileLink() { calls.push('report'); return 'gone'; },
      async chargeFileLink() { calls.push('charge'); return 'gone'; },
      async linkReadCredential() { calls.push('credential'); return null; },
    },
  };
  return { env, calls };
}

test('the flood bucket runs before any lookup, keyed by the client IP, and fails closed', async () => {
  const request = (path: string, method = 'GET') => new Request(`https://files.example.test${path}`, { method, headers: { 'cf-connecting-ip': '203.0.113.9' } });
  for (const [path, method] of [[`/f/${TOKEN}`, 'GET'], [`/f/${TOKEN}/download`, 'GET'], [`/f/${TOKEN}/report`, 'POST'], ['/f/x', 'GET']] as const) {
    const refused = stubEnv(false);
    const response = await serveFileLink(request(path, method), refused.env);
    assert.equal(response.status, 429, path);
    assert.deepEqual(refused.calls, ['flood:203.0.113.9'], `${path}: nothing is looked up`);
    for (const failure of ['missing', 'throws'] as const) {
      const closed = stubEnv(failure);
      assert.equal((await serveFileLink(request(path, method), closed.env)).status, 503);
      assert.ok(!closed.calls.some(call => !call.startsWith('flood:')), `${failure}: nothing is looked up`);
    }
  }
  const admitted = stubEnv(true);
  assert.equal((await serveFileLink(request(`/f/${TOKEN}`), admitted.env)).status, 404);
  assert.deepEqual(admitted.calls, ['flood:203.0.113.9', 'lookup']);
});

test('every link answer carries the page policy, nosniff, no-referrer and no-store', async () => {
  const { env } = stubEnv(true);
  for (const path of [`/f/${TOKEN}`, '/f/bad', '/other']) {
    const response = await serveFileLink(new Request(`https://files.example.test${path}`), env);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-security-policy'), LINK_PAGE_CSP);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});
