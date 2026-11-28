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

const { DEPLOYMENT_LOCATION } = await import(fixture.href);
const { locationFingerprint } = await import(new URL('../../../../packages/link-storage/src/location.ts', import.meta.url).href);

// A file link (M3-13) sent from the demo mailbox, with a hostile file name and
// sender name, released so its page is live on the content bridge's host.
async function sendFileLink(fixture) {
  const rlo = String.fromCodePoint(0x202e);
  const name = `<img src=x onerror="window.pwned=1">${rlo}fdp.exe`;
  const senderName = `<script>window.pwned=2</script>${rlo}Alex`;
  const bytes = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7 + 3) & 0xff);
  const mail = fixture.as('demo');
  const { mailbox } = await mail.getSession();
  await fixture.activatePrimary(mailbox.primaryAddress);
  await fixture.directoryChange('INSERT OR REPLACE INTO mailbox_profiles (workspace_id, mailbox_id, display_name) VALUES (?, ?, ?)',
    'w1', mailbox.id, senderName);
  const key = `${DEPLOYMENT_LOCATION.prefix}ws/w1/${mailbox.id}/playwright`;
  fixture.links.put('deployment', key, bytes);
  const link = { location: { kind: 'deployment', id: 'links' }, key, fingerprint: await locationFingerprint(DEPLOYMENT_LOCATION) };
  const draft = await fixture.links.control('seedDraft', [{ from: mailbox.primaryAddress, to: ['friend@example.net'],
    links: [{ linkUploadId: 'playwright', name, size: bytes.byteLength, expiry: 30, link }] }], 'demo');
  await mail.sendDraft(draft.id, { idempotencyKey: 'playwright-file-link', ifMatch: draft.revision });
  await fixture.advance(10_000, 'all-mailboxes');
  const [sent] = (await mail.listLinks({})).items;
  if (sent?.state !== 'live') throw new Error('The fixture file link did not go live.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { path: new URL(sent.url).pathname, name, senderName, senderEmail: mailbox.primaryAddress, size: bytes.byteLength,
    sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') };
}

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
  const fileLinks = realContent && process.argv.includes('--file-links') ? { hosts: [new URL(realContent.contentOrigin).host] } : undefined;
  backend = await startMailHttpFixture({ demo: true, realContent, inlineCids, ...(fileLinks && { send: true, fileLinks }) });
  const fileLink = fileLinks ? await sendFileLink(backend) : undefined;
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
  if (process.send) process.send({ appOrigin, contentOrigin: backend.contentOrigin, ...(fileLink && { fileLink }) });
  else console.info(appOrigin);
} catch (cause) {
  await close();
  throw cause;
}
