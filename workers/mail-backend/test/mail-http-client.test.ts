import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { fetchOversizedRequest } from './fixtures/mail-http.ts';

test('an oversized fixture request fails if the server waits for the body without sending Continue', { timeout: 2_000 }, async (t) => {
  const abort = new AbortController();
  const server = createServer();
  server.on('checkContinue', (request, response) => {
    request.on('end', () => response.writeHead(422).end());
    request.resume();
    // Start the short deadline only after the stub receives the request headers.
    AbortSignal.timeout(25).addEventListener('abort', () => abort.abort(), { once: true });
  });
  server.listen(0, '127.0.0.1');
  t.after(() => { server.close(); server.closeAllConnections(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const body = new Blob(['the server will wait for these bytes']);
  const req = new Request(`http://127.0.0.1:${address.port}`, { method: 'POST', body });
  await assert.rejects(fetchOversizedRequest(req, body.size, abort.signal), {
    message: 'server neither answered nor sent 100 Continue for an oversized request',
  });
});
