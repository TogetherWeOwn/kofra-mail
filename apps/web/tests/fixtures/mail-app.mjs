import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { createServer } from 'vite';
import config from '../../svelte.config.js';
/** @typedef {import('vite').ViteDevServer} ViteDevServer */

// Keep the Workerd test types in the backend project; the browser receives only the URLs.
const fixture = new URL('../../../../workers/mail-backend/test/fixtures/mail-http.ts', import.meta.url);
const { startMailHttpFixture } = await import(fixture.href);
const backend = await startMailHttpFixture({ demo: true });
process.env.MAIL_DEV_API_ORIGIN = backend.origin;
process.env.MAIL_DEMO_CONTENT_ORIGIN = process.argv.includes('--plain') ? '' : backend.contentOrigin;

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
  try { await server?.close(); }
  finally {
    try { await backend.close(); }
    finally { await rm(scratch, { recursive: true }); }
  }
}
process.once('disconnect', () => { void close(); });
function terminate() { void close().finally(() => { if (process.connected) process.disconnect?.(); }); }
process.once('SIGTERM', terminate);
process.once('SIGINT', terminate);
try {
  // The loopback relay uses the real backend fixture. No second Cloudflare emulator or shared SQLite is necessary for the front end.
  const { kit, ...svelte } = config;
  server = await createServer({
    configFile: false,
    plugins: await sveltekit({ ...svelte, ...kit, adapter: undefined, outDir: join(scratch, 'svelte-kit') }),
    cacheDir: join(scratch, 'vite'),
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  });
  http = createHttpServer(server.middlewares).listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Mail fixture app did not obtain a port.');
  const appOrigin = `http://127.0.0.1:${address.port}`;
  if (process.send) process.send({ appOrigin, contentOrigin: backend.contentOrigin });
  else console.info(appOrigin);
} catch (cause) {
  await close();
  throw cause;
}
