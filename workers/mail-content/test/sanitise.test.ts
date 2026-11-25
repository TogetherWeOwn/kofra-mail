import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { checkOutput } from './check-output.ts';
import { vectors } from './corpus.ts';
import { createRuntime, render } from './runtime.ts';

let runtime: Awaited<ReturnType<typeof createRuntime>>;
before(async () => { runtime = await createRuntime(); });
after(() => runtime?.dispose());

test('corpus contains at least 150 distinct vectors', () => {
  assert.ok(vectors.length >= 150, `${vectors.length} vectors`);
  assert.equal(new Set(vectors.map(v => v.id)).size, vectors.length);
});

for (const vector of vectors) test(`allowlist: ${vector.id}`, async () => {
  const output = await render(runtime, vector);
  assert.ok(Number.isSafeInteger(output.version) && output.version > 0);
  assert.ok(!output.html.includes('/asset/'), 'cached HTML contains a minted URL');
  const doc = checkOutput(output.filled);
  assert.equal(output.unsafe, vector.unsafe);
  if (vector.refs !== undefined) assert.equal(output.refs.length, vector.refs);
  if (vector.hrefs !== undefined) assert.equal(doc.anchors.length, vector.hrefs);
  if (vector.anchorUrls !== undefined) assert.deepEqual(doc.anchors, vector.anchorUrls);
  if (vector.imageUrls !== undefined) assert.deepEqual(output.refs, vector.imageUrls.map(url => ({ kind: 'img', url })));
  if (vector.has !== undefined) assert.ok(output.html.includes(vector.has), `missing ${vector.has}`);
  if (vector.absent !== undefined) assert.ok(!output.html.includes(vector.absent), `unexpected ${vector.absent}`);
  if (vector.text !== undefined) assert.equal(doc.text, vector.text);
});

test('the checker rejects a serialized frame even if the DOM parser discards it', async () => {
  const { filled } = await render(runtime, { html: '<p>Keep</p>' });
  const withFrame = filled.replace('<body>', '<body><frame>');
  assert.throws(() => checkOutput(withFrame), /unpermitted serialized element frame/);
});

test('one CID slot is reused for 1,000 images with the same content ID', async () => {
  const output = await render(runtime, { html: '<img src="cid:logo">'.repeat(1_000) });
  assert.deepEqual(output.refs, [{ kind: 'cid', contentId: 'logo' }]);
  const { images } = checkOutput(output.filled);
  assert.equal(images.length, 1_000);
  assert.equal(new Set(images).size, 1);
});

test('interleaved CIDs and remote images each resolve to their own slot', async () => {
  const output = await render(runtime, {
    html: '<img src="cid:a"><img src="https://sender.example/x.png"><img src="cid:b"><img src="cid:a"><img src="https://sender.example/y.png">',
    ri: true,
  });
  const expected = [
    { kind: 'cid', contentId: 'a' }, { kind: 'img', url: 'https://sender.example/x.png' }, { kind: 'cid', contentId: 'b' },
    { kind: 'cid', contentId: 'a' }, { kind: 'img', url: 'https://sender.example/y.png' },
  ];
  const { images } = checkOutput(output.filled);
  assert.equal(images.length, expected.length);
  images.forEach((src, i) => {
    const match = /\/asset\/(cid|img)\/(\d+)\?/.exec(src);
    assert.ok(match, `unexpected image URL ${src}`);
    assert.equal(match[1], expected[i].kind);
    assert.deepEqual(output.refs[Number(match[2])], expected[i]);
  });
  assert.equal(output.refs.filter(r => r.kind === 'cid').length, 2);
});

test('refs keep the exact source URL and decoded CID; filling escapes attribute and raw CSS contexts', async () => {
  const url = 'https://sender.example/pixel%2Fimage?q=1&k=2';
  const encoded = url.replaceAll('&', '&amp;');
  const output = await render(runtime, {
    html: `<img src="cid:logo%40mail.example" alt="logo"><style>p{background:url('${url}')}</style><p style="background-image:url('${encoded}')">Notice</p>`,
    ri: true,
  });
  assert.deepEqual(output.refs, [{ kind: 'cid', contentId: 'logo@mail.example' }, { kind: 'img', url }, { kind: 'img', url }]);
  assert.ok(!output.html.includes('sender.example'));
  const doc = checkOutput(output.filled);
  assert.deepEqual(doc.images, [`https://content.example/asset/cid/0?s='"&x=1`]);
  assert.match(output.filled, /background: url\(/);
  assert.match(output.filled, /background-image: url\(/);
});

test('one body limit covers CSS and img references, without limiting CID', async () => {
  const output = await render(runtime, {
    html: `<div style="background:url(https://sender.example/first)"></div>${vectors.find(v => v.id === 'img-remote-cap')!.html}`,
    ri: true,
  });
  assert.equal(output.refs.filter(r => r.kind === 'img').length, 100);
  assert.equal(output.refs.filter(r => r.kind === 'cid').length, 1);
  assert.equal(checkOutput(output.filled).images.length, 100);
});

test('remote-image blocking leaves an empty placeholder and no source', async () => {
  const output = await render(runtime, { html: `<p>Before<img src="https://sender.example/image" alt="not displayed">After</p>` });
  const doc = checkOutput(output.filled);
  assert.equal(doc.text, 'BeforeAfter');
  assert.ok(!doc.tags.includes('img'));
  assert.ok(doc.tags.includes('span'));
  assert.ok(!output.html.includes('not displayed'));
  assert.deepEqual(output.refs, []);
});

test('inline data-image size is capped at 64 KiB of decoded bytes', async () => {
  const data = (bytes: number) => `data:image/png;base64,${Buffer.alloc(bytes).toString('base64')}`;
  const output = await render(runtime, { html: `<img src="${data(65536)}"><img src="${data(65537)}">` });
  assert.deepEqual(checkOutput(output.filled).images, [data(65536)]);
});

test('plain text takes the same wrapper path without interpreting markup', async () => {
  const text = '\n<iframe src="https://sender.example/frame"> & </pre>\nlong line';
  const output = await render(runtime, { html: text, plain: true, ri: true });
  const doc = checkOutput(output.filled);
  assert.equal(doc.text, text);
  assert.deepEqual(doc.tags, ['html', 'head', 'meta', 'style', 'body', 'pre']);
  assert.match(output.html, /font-family:\s*system-ui/);
  assert.match(output.html, /overflow-wrap:\s*anywhere/);
  assert.match(output.html, /img\s*{\s*max-width:\s*100%/);
  assert.deepEqual(output.refs, []);
});
