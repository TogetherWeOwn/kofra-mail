import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchRemoteImage, remoteImageInFlight } from '../src/proxy.ts';
import { config, image, images, upstream } from './proxy-fixtures.ts';

for (const end of ['finish', 'cancel'] as const) {
  test(`the image reservation stays held until the response body can ${end}`, async () => {
    const url = 'https://sender.example/image';
    const bytes = images['image/png'];
    const fetcher = upstream({ [url]: image('image/png', bytes) }).fetchImpl;
    const tight = { ...config, remoteImageInFlightBytes: config.remoteImageBytes };
    const result = await fetchRemoteImage(url, tight, fetcher, Date.now, 'response');
    assert.ok(result.ok);
    assert.equal(remoteImageInFlight(), bytes.length);
    const response = new Response(result.body);
    // No declared length: the concurrent fetch needs the whole budget.
    assert.deepEqual(await fetchRemoteImage(url, tight, fetcher), { ok: false, reason: 'size' });
    if (end === 'finish') assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    else await response.body!.cancel();
    assert.equal(remoteImageInFlight(), 0);
  });
}
