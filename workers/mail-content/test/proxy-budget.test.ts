// The per-isolate in-flight byte budget (section 5, rule 4). Kept in its own
// file: node --test runs each file in its own process, so the module-level
// budget here is not shared with other tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchRemoteImage, remoteImageDefaults, remoteImageInFlight, type RemoteImageResult } from '../src/proxy.ts';
import { config, endless, image, images, redirect, upstream } from './proxy-fixtures.ts';

const MiB = 1024 * 1024;
const now = () => 0;
const flush = () => new Promise(resolve => setImmediate(resolve));

/** A PNG body whose stream stays open until `finish` (or `fail`) is called. */
function held(extra = 0) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; c.enqueue(images['image/png'].slice()); },
  });
  return {
    stream,
    finish() { if (extra > 0) controller.enqueue(new Uint8Array(extra)); controller.close(); },
    fail() { controller.error(new Error('reset')); },
  };
}

test('the default budget is 32 MiB and is the ceiling', () => {
  assert.equal(remoteImageDefaults.remoteImageInFlightBytes, 32 * MiB);
  assert.equal(config.remoteImageInFlightBytes, 32 * MiB);
});

test('concurrent reads past the budget fail as too large, and every reservation is released', async () => {
  const tight = { ...config, remoteImageInFlightBytes: 12 * MiB };
  const a = held();
  const b = held();
  const pa = fetchRemoteImage('https://a.sender.example/x', tight, upstream({ 'https://a.sender.example/x': image('image/png', a.stream) }).fetchImpl, now);
  const pb = fetchRemoteImage('https://b.sender.example/x', tight, upstream({ 'https://b.sender.example/x': image('image/png', b.stream) }).fetchImpl, now);
  await flush();
  // No declared length: each holds the full remoteImageBytes (5 MiB).
  assert.equal(remoteImageInFlight(), 10 * MiB);

  const c = endless();
  const third: RemoteImageResult = await fetchRemoteImage('https://c.sender.example/x', tight,
    upstream({ 'https://c.sender.example/x': image('image/png', c.stream) }).fetchImpl, now);
  assert.deepEqual(third, { ok: false, reason: 'size' });
  assert.equal(c.state.pulled, 0, 'a refused reservation must not read the body');
  assert.equal(remoteImageInFlight(), 10 * MiB);

  // A declared length reserves only that much, so a small image still fits.
  const small = await fetchRemoteImage('https://d.sender.example/x', tight, upstream({
    'https://d.sender.example/x': image('image/png', images['image/png'], { 'content-length': String(images['image/png'].length) }),
  }).fetchImpl, now);
  assert.ok(small.ok);
  assert.equal(remoteImageInFlight(), 10 * MiB);

  // A body that outgrows its declared length must extend its reservation; here the budget cannot.
  // A finite 1 MiB image declared as 100 bytes: within remoteImageBytes, but not within the remaining budget.
  const grown = new Uint8Array(1 * MiB);
  grown.set(images['image/png']);
  const liar = await fetchRemoteImage('https://e.sender.example/x', tight, upstream({
    'https://e.sender.example/x': image('image/png', grown, { 'content-length': '100' }),
  }).fetchImpl, now);
  assert.deepEqual(liar, { ok: false, reason: 'size' });
  assert.equal(remoteImageInFlight(), 10 * MiB);

  a.finish();
  b.fail();
  assert.ok((await pa).ok);
  assert.deepEqual(await pb, { ok: false, reason: 'network' });
  assert.equal(remoteImageInFlight(), 0);
});

test('a body that outgrows its declared length extends its reservation when the budget allows', async () => {
  const body = held(4096);
  const pending = fetchRemoteImage('https://a.sender.example/x', config, upstream({
    'https://a.sender.example/x': image('image/png', body.stream, { 'content-length': '64' }),
  }).fetchImpl, now);
  await flush();
  body.finish();
  const result = await pending;
  assert.ok(result.ok);
  assert.equal(result.length, 64 + 4096);
  assert.equal(remoteImageInFlight(), 0);
});

test('a budget smaller than remoteImageBytes refuses undeclared bodies and is read from configuration', async () => {
  const result = await fetchRemoteImage('https://a.sender.example/x', { ...config, remoteImageInFlightBytes: 1 * MiB },
    upstream({ 'https://a.sender.example/x': image('image/png', images['image/png']) }).fetchImpl, now);
  assert.deepEqual(result, { ok: false, reason: 'size' });
  assert.equal(remoteImageInFlight(), 0);
});

test('every path releases its reservation: success, refusals, size, timeouts and errors', async (t) => {
  const url = 'https://a.sender.example/x';
  let clock = 0;
  const slowBody = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(images['image/png'].slice()); },
    pull(c) { clock += 6_000; c.enqueue(new Uint8Array(1)); },
  });
  const erroring = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(images['image/png'].slice()); },
    pull(c) { c.error(new Error('reset')); },
  });
  const cases: Array<[string, Parameters<typeof upstream>[0], string | true, (() => number)?]> = [
    ['success', { [url]: image('image/png', images['image/png']) }, true],
    ['magic', { [url]: image('image/png', new TextEncoder().encode('<html></html>')) }, 'magic'],
    ['size while reading', { [url]: image('image/png', endless().stream) }, 'size'],
    ['size declared', { [url]: image('image/png', images['image/png'], { 'content-length': String(6 * MiB) }) }, 'size'],
    ['status', { [url]: image('image/png', images['image/png'], {}, 500) }, 'status'],
    ['type', { [url]: image('image/svg+xml', images['image/png']) }, 'type'],
    ['redirect', { [url]: redirect('http://127.0.0.1/') }, 'redirect'],
    ['network before body', { [url]: () => { throw new Error('down'); } }, 'network'],
    ['network during body', { [url]: image('image/png', erroring) }, 'network'],
    ['timeout during body', { [url]: image('image/png', slowBody) }, 'timeout', () => clock],
  ];
  for (const [name, routes, expected, clockFn] of cases) {
    const result = await fetchRemoteImage(url, config, upstream(routes).fetchImpl, clockFn ?? now);
    if (expected === true) assert.ok(result.ok, name);
    else assert.deepEqual(result, { ok: false, reason: expected }, name);
    assert.equal(remoteImageInFlight(), 0, `${name} kept a reservation`);
  }
  assert.deepEqual(await fetchRemoteImage('http://localhost/', config, upstream({}).fetchImpl, now), { ok: false, reason: 'url' });
  assert.equal(remoteImageInFlight(), 0);

  // The deadline firing while a body read is pending releases the reservation too.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stalled = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(images['image/png'].slice()); },
    pull() { return new Promise(() => {}); },
  });
  const pending = fetchRemoteImage(url, config, upstream({ [url]: image('image/png', stalled) }).fetchImpl, Date.now);
  await flush();
  assert.equal(remoteImageInFlight(), 5 * MiB);
  t.mock.timers.tick(10_000);
  assert.deepEqual(await pending, { ok: false, reason: 'timeout' });
  assert.equal(remoteImageInFlight(), 0);
});
