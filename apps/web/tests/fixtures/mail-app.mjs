import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sveltekit } from '@sveltejs/kit/vite';
import { createServer } from 'vite';
import config from '../../svelte.config.js';
/** @typedef {import('vite').ViteDevServer} ViteDevServer */

// Keep the Workerd test types in the backend project; the browser receives only the URLs.
const fixture = new URL('../../../../workers/mail-backend/test/fixtures/mail-http.ts', import.meta.url);
const { startMailHttpFixture } = await import(fixture.href);
let backend;
let contentHttp;

const scratch = await mkdtemp(join(tmpdir(), 'velmora-mail-e2e-'));
/** @type {ViteDevServer | undefined} */
let server;
/** @type {import('node:http').Server | undefined} */
let http;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  http?.close();
  http?.closeAllConnections();
  contentHttp?.close();
  contentHttp?.closeAllConnections();
  try { await server?.close(); }
  finally {
    try { await backend?.close(); }
    finally { await rm(scratch, { recursive: true }); }
  }
}
process.once('disconnect', () => { void close(); });
function terminate() { void close().finally(() => { if (process.connected) process.disconnect?.(); }); }
process.once('SIGTERM', terminate);
process.once('SIGINT', terminate);
try {
  http = createHttpServer((req, res) => {
    if (server) server.middlewares(req, res);
    else res.writeHead(503).end();
  }).listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Mail fixture app did not obtain a port.');
  const appOrigin = `http://127.0.0.1:${address.port}`;
  let realContent;
  const inlineCids = process.argv.includes('--inline-cids');
  if (process.argv.includes('--real-content')) {
    // Browser HTTP bridge only: the content response and its security headers
    // are owned by the Worker. No local certificate, DNS, or upstream network.
    contentHttp = createHttpServer(async (req, res) => {
      try {
        if (inlineCids && req.url === '/__fixture/raw-reads') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(backend?.contentRawReads()));
          return;
        }
        const reply = await backend?.fetchContent?.(req.url, req.method);
        if (!reply) { res.writeHead(503).end(); return; }
        res.writeHead(reply.status, Object.fromEntries(reply.headers));
        if (reply.body) await pipeline(Readable.fromWeb(reply.body), res);
        else res.end();
      } catch { res.destroy(); }
    }).listen(0, '127.0.0.1');
    await once(contentHttp, 'listening');
    const addr = contentHttp.address();
    if (!addr || typeof addr === 'string') throw new Error('Content fixture did not obtain a port.');
    realContent = { appOrigin, contentOrigin: `http://localhost:${addr.port}` };
  }
  backend = await startMailHttpFixture({ demo: true, realContent, inlineCids });
  process.env.MAIL_DEV_API_ORIGIN = backend.origin;
  process.env.MAIL_DEMO_CONTENT_ORIGIN = process.argv.includes('--plain') ? '' : backend.contentOrigin;

  // The loopback relay talks to the workerd fixture.
  const { kit, ...svelte } = config;
  server = await createServer({
    configFile: false,
    plugins: await sveltekit({ ...svelte, ...kit, adapter: undefined, outDir: join(scratch, 'svelte-kit') }),
    cacheDir: join(scratch, 'vite'),
    server: {
      middlewareMode: true, hmr: false, ws: false,
      // The production check/build owns this directory. Its rewrites must not invalidate this SSR module graph.
      watch: { ignored: [fileURLToPath(new URL('../../.svelte-kit', import.meta.url)), '**/.svelte-kit/**'] },
    },
  });
  if (process.send) process.send({ appOrigin, contentOrigin: backend.contentOrigin });
  else console.info(appOrigin);
} catch (cause) {
  await close();
  throw cause;
}
