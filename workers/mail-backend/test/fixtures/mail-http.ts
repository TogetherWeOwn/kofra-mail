import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { arrayBuffer } from 'node:stream/consumers';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse, type Request as LocalRequest, type WorkerOptions } from 'miniflare';
import { createHttpMailService } from '../../../../contracts/mail-api/src/http-client.ts';
import type { Principal, TestMessage } from '../../../../contracts/mail-api/src/harness.ts';
import { isSafeMessageId } from '../../../../contracts/mail-api/src/headers.ts';
import { LIMITS } from '../../../../contracts/mail-api/src/limits.ts';
import type { Address } from '../../../../contracts/mail-api/src/wire.ts';
import { directoryMigrationBatches } from './directory-db.ts';
import { fakeS3 } from '../../../../packages/link-storage/test/fake-s3.ts';
import { linkKek } from '../../../../packages/link-storage/src/kek.ts';
import { S3Credentials } from '../../../../packages/link-storage/src/credentials.ts';
import { LinkStorageStore, type LinkDatabase } from '../../../../packages/link-storage/src/store.ts';
import type { LinkLocationFields } from '../../../../packages/link-storage/src/location.ts';
import type { FixturePrincipal } from './mail-http-worker.ts';

const entry = fileURLToPath(new NodeURL('./mail-http-worker.ts', import.meta.url));
const contentEntry = fileURLToPath(new NodeURL('../../../mail-content/src/entry.ts', import.meta.url));
const accountEntry = fileURLToPath(new NodeURL('../../../mail-content/test/account-worker.ts', import.meta.url));
const compiled = (entryPoint = entry) => build({ entryPoints: [entryPoint], bundle: true, platform: 'browser', format: 'esm', external: ['cloudflare:workers'], write: false });
let bundle: ReturnType<typeof compiled> | undefined;
let contentBundle: ReturnType<typeof compiled> | undefined;
let accountBundle: ReturnType<typeof compiled> | undefined;
const accounts: Record<Principal | 'invited' | 'demo', FixturePrincipal> = {
  member: { userId: 'member', name: 'Jordan Member', ws: 'w1', role: 'member', mailboxId: 'mailbox-a', address: 'member@example.com' },
  other: { userId: 'other', name: 'Casey Other', ws: 'w1', role: 'member', mailboxId: 'mailbox-b', address: 'other@example.com' },
  admin: { userId: 'admin', name: 'Admin', ws: 'w1', role: 'admin', mailboxId: 'mailbox-c', address: 'admin@example.com' },
  staleAdmin: { userId: 'admin', name: 'Admin', ws: 'w1', role: 'admin', mailboxId: 'mailbox-c', address: 'admin@example.com', stale: true },
  newAdmin: { userId: 'new-admin', name: 'New admin', ws: 'w1', role: 'admin', address: 'new-admin@example.com' },
  foreignAdmin: { userId: 'foreign-admin', name: 'Foreign admin', ws: 'w2', role: 'admin', mailboxId: 'mailbox-z', address: 'foreign@example.net' },
  invited: { userId: 'invited', name: 'An invitee', ws: 'w1', role: 'member', address: 'invited@example.com', status: 'invited' },
  demo: { userId: 'demo', name: 'Alex Morgan', ws: 'w1', role: 'admin', mailboxId: 'mailbox-demo', address: 'alex@example.com' },
};
// Two mailboxes whose workspace and mailbox ids have the longest supported lengths (58 and 128).
export const LONG_WS = `long-${'w'.repeat(53)}`;
const longMailbox = (n: number) => `mailbox-${'m'.repeat(119)}${n}`;
const longAccounts: Record<'longSender' | 'longRecipient', FixturePrincipal> = {
  longSender: { userId: 'long-sender', name: 'Long Sender', ws: LONG_WS, role: 'member', mailboxId: longMailbox(1), address: 'sender@long.example' },
  longRecipient: { userId: 'long-recipient', name: 'Long Recipient', ws: LONG_WS, role: 'member', mailboxId: longMailbox(2), address: 'recipient@long.example' },
};

const CRLF = '\r\n';
const base64 = (bytes: string | Uint8Array) => Buffer.from(bytes).toString('base64').replace(/.{1,76}/g, `$&${CRLF}`).trimEnd();
const word = (value: string) => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
const recipients = (addrs: Address[]) => addrs.map((a) => a.name ? `${word(a.name)} <${a.email}>` : a.email).join(', ');
const foldFixtureId = (id: string) => id.replace(/(?:\r\n|[\r\n])[ \t]*/g, `${CRLF} `);
function buildMime(message: TestMessage, sentAt: number, msgId: string, ancestry: readonly string[]): string {
  const boundary = `mixed-${crypto.randomUUID()}`, alternate = `alternative-${crypto.randomUUID()}`;
  const plain = `Content-Type: text/plain; charset=utf-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${base64(message.text)}`;
  const html = message.html === undefined ? undefined : [`Content-Type: multipart/alternative; boundary="${alternate}"`, '',
    `--${alternate}`, plain, `--${alternate}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64(message.html), `--${alternate}--`].join(CRLF);
  const parent = ancestry.at(-1);
  const references = ancestry.filter(isSafeMessageId);
  const header = [`From: ${recipients([message.from])}`, `To: ${recipients(message.to)}`,
    ...(message.cc?.length ? [`Cc: ${recipients(message.cc)}`] : []), `Subject: ${word(message.subject)}`, `Message-ID: ${foldFixtureId(msgId)}`,
    ...(parent ? [`In-Reply-To: ${foldFixtureId(parent)}`] : []),
    ...(references.length ? [`References: ${references.join(`${CRLF} `)}`] : []),
    `Date: ${new Date(sentAt).toUTCString()}`, 'MIME-Version: 1.0'];
  if (!message.attachments?.length) return [...header, html ?? plain, ''].join(CRLF);
  const parts = message.attachments.map((part, index) => [
    `Content-Type: ${part.type}`, `Content-Disposition: ${part.inline ? 'inline' : 'attachment'}; filename="${word(part.name)}"`,
    ...(part.inline ? [`Content-ID: <part-${index}@fixture.test>`] : []), 'Content-Transfer-Encoding: base64', '', base64(part.bytes),
  ].join(CRLF));
  return [...header, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...[html ?? plain, ...parts].flatMap((part) => [`--${boundary}`, part]), `--${boundary}--`, ''].join(CRLF);
}

// Local workerd closes without a half-close after an early answer, unlike the
// Cloudflare edge (see PR verification). Wait for 100 Continue before streaming
// so an eager write cannot reset the socket before we see the final response.
export async function fetchOversizedRequest(req: Request, size: number): Promise<Response> {
  const signal = AbortSignal.timeout(30_000);
  assert.ok(req.body instanceof NodeReadableStream);
  const body = Readable.fromWeb(req.body);
  const headers = new Headers(req.headers);
  headers.set('content-length', String(size));
  headers.set('expect', '100-continue');
  const request = httpRequest(req.url, { method: req.method, headers: Object.fromEntries(headers), agent: false, signal });
  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      request.once('response', (reply) => {
        body.unpipe(request);
        body.destroy();
        resolve(reply);
      });
      let continued = false;
      request.once('error', (error) => {
        reject(!continued && signal.aborted
          ? new Error('server neither answered nor sent 100 Continue for an oversized request', { cause: error }) : error);
      });
      body.once('error', reject);
      // Local workerd doesn't send Continue for these oversized requests.
      request.once('continue', () => {
        continued = true;
        body.pipe(request);
      });
      request.flushHeaders();
    });
    const responseHeaders = new Headers();
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
    }
    const bytes = await arrayBuffer(response);
    return new Response(bytes.byteLength ? bytes : null, {
      status: response.statusCode, statusText: response.statusMessage, headers: responseHeaders,
    });
  } finally {
    // Destroying ClientRequest earlier would also close the socket we are reading.
    body.destroy();
    request.destroy();
  }
}

export type SendStateView = {
  row: { state: string; terminal_seq: number | null; finish_pending: number } | null;
  ledger: { idx: number; kind: string; state: string; reason: string | null }[];
  dispatch: Record<string, number | string | null> | null;
  fences: { epoch: number; attempt: number; lease_until: number; marked: number; authorized: number; outcome: string | null }[];
  marks: { epoch: number; attempt: number; idx: number; outcome: string | null; provider_id: string | null }[];
  release: { epoch: number; attempt: number }[];
  drive: number[];
  flushed: { flushed: number; modseq: number };
};

interface FixtureOptions {
  demo?: boolean;
  draftsUploads?: boolean;
  startedAt?: number;
  realContent?: { appOrigin: string; contentOrigin: string };
  inlineCids?: boolean;
  // The send path (M3-3) with fake SEND and EMAIL bindings and manual alarms.
  send?: boolean;
  configureWorkers?: (backend: WorkerOptions, workers: WorkerOptions[]) => void;
  realQuota?: { daily?: string; monthly?: string; reset?: string };
  fixedSendId?: string;
  // Adds the longSender and longRecipient accounts.
  longIds?: boolean;
  // File links (M3-13): the link host on the real content Worker, a deployment and a
  // workspace link location on local fake S3 endpoints, and a controllable flood bucket.
  fileLinks?: FileLinkOptions;
}

export type FileLinkOptions = {
  // Extra hosts the content Worker serves links on (the Playwright bridge's host).
  hosts?: string[];
  hourlyFactor?: number;
  totalFactor?: number;
  // Extra headers the fake providers add to every object GET.
  objectHeaders?: Record<string, string>;
  // mail-content's LINK_REFUSED_ZONES (a JSON array); null leaves the binding out.
  refusedZones?: string | null;
};
export const LINK_HOST = 'files.example.test';
const LINK_READ = { accessKeyId: 'link-reader-0001', secretAccessKey: 'link-reader-secret-0001' };
const LINK_WS_READ = { accessKeyId: 'ws-reader-0001', secretAccessKey: 'ws-reader-secret-0001' };
const LINK_WS_WRITE = { accessKeyId: 'ws-writer-0001', secretAccessKey: 'ws-writer-secret-0001' };
const LINK_KEK = JSON.stringify({ current: '1', keys: { 1: Buffer.alloc(32, 7).toString('base64') } });
export const DEPLOYMENT_LOCATION: LinkLocationFields = { endpoint: 'https://links.example.test', region: 'auto', bucket: 'riaklo-links', prefix: 'files/', pathStyle: true };
export const WORKSPACE_LOCATION: LinkLocationFields = { endpoint: 'https://ws-links.example.test', region: 'auto', bucket: 'workspace-files', prefix: '', pathStyle: true };
export const WORKSPACE_LOCATION_ID = 'abcdefghijklmnopqrstuvwxyz';
// The flood bucket: a cap per key that a test sets, and every key it was asked about.
const FLOOD_WORKER = `import { WorkerEntrypoint } from 'cloudflare:workers';
let cap = Infinity; const counts = new Map(); const calls = [];
export class Flood extends WorkerEntrypoint {
  async limit({ key }) { calls.push(key); const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return { success: n <= cap }; }
}
export default { async fetch(req) {
  const { pathname } = new URL(req.url);
  if (pathname === '/cap') { cap = Number(await req.text()); counts.clear(); return new Response(null); }
  if (pathname === '/calls') return Response.json(calls);
  return new Response(null, { status: 404 });
} };`;
// The operator alert Worker: records what each alert POST carries.
const ALERT_WORKER = `const received = [];
export default { async fetch(req) {
  const { pathname } = new URL(req.url);
  if (pathname === '/v1/alert' && req.method === 'POST') { received.push(await req.json()); return new Response(null, { status: 204 }); }
  if (pathname === '/received') return Response.json(received);
  return new Response(null, { status: 404 });
} };`;

export async function startMailHttpFixture({ demo = false, draftsUploads: uploads = false, startedAt = Date.now(), realContent: content, inlineCids = false,
  send = false, configureWorkers, realQuota, fixedSendId, longIds = false, fileLinks }: FixtureOptions = {}) {
  // File links are served by the real content Worker.
  const realContent = content ?? (fileLinks ? { appOrigin: 'https://mail.example', contentOrigin: 'https://content.example' } : undefined);
  const linkStores = fileLinks && {
    deployment: fakeS3({ host: 'links.example.test', bucket: DEPLOYMENT_LOCATION.bucket, objectHeaders: fileLinks.objectHeaders,
      keys: { [LINK_READ.accessKeyId]: { secret: LINK_READ.secretAccessKey, ops: new Set(['GetObject']) } } }),
    workspace: fakeS3({ host: 'ws-links.example.test', bucket: WORKSPACE_LOCATION.bucket, objectHeaders: fileLinks.objectHeaders,
      keys: { [LINK_WS_READ.accessKeyId]: { secret: LINK_WS_READ.secretAccessKey, ops: new Set(['GetObject']) } } }),
  };
  const principals = { ...accounts, ...(longIds ? longAccounts : {}) } as typeof accounts & Partial<typeof longAccounts>;
  const draftsUploads = uploads || send;
  const { outputFiles } = await (bundle ??= compiled());
  let contents = outputFiles[0].text;
  if (fixedSendId) {
    // Force two independently created sends to collide, without adding a production injection point.
    const generator = /const (\w+) = ulid\(at\);(?=\s*const mimeId = \1\.toLowerCase\(\);)/g;
    assert.equal([...contents.matchAll(generator)].length, 1, 'expected exactly one send ID generator');
    contents = contents.replace(generator, (_, name: string) => `const ${name} = ${JSON.stringify(fixedSendId)};`);
  }
  const objects = new Map<string, ArrayBuffer>();
  // Object paths whose GET answers 503, a transient object store failure.
  const failingReads = new Set<string>();
  const watchedReads = new Map<string, number>();
  const writes: { key: string; holders: string[] }[] = [];
  let inspectPut: ((pathname: string) => Promise<void>) | undefined;
  let nextPut: { start: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void> } | undefined;
  // Holds the next object GET whose path matches, until released.
  let nextGet: { match: RegExp; start: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void> } | undefined;
  let watchedBody: PromiseWithResolvers<void> | undefined;
  let contentRawReads = 0;
  let cidAdmissions = 0;
  const cidBurst = Promise.withResolvers<void>();
  const cidAdmissionMarker = 'fixture:cid-member-admitted';
  const control = crypto.randomUUID();
  const startTime = Math.floor(startedAt / 1000) * 1000;
  let now = startTime;
  const backend: WorkerOptions = {
    name: 'mail-backend',
    modules: [{ type: 'ESModule', path: 'mail-http-worker.mjs', contents }],
    compatibilityDate: '2026-06-25',
    durableObjects: { SWEEPER: { className: 'Sweeper', useSQLite: true }, MAILBOX: { className: 'HttpMailbox', useSQLite: true },
      SEND_QUOTA: { className: realQuota ? 'RealSendQuota' : 'FakeSendQuota', useSQLite: true },
      SEND_CONSUMER: { className: 'SendConsumer', useSQLite: true } },
    r2Buckets: ['MAIL_STATE'], d1Databases: ['DIRECTORY'],
    bindings: { ACCOUNTS: principals, CONTROL_KEY: control, CSRF_KEY: crypto.randomUUID(), INITIAL_TIME: now, ...(demo && { DEFAULT_ACCOUNT: 'demo' }),
      MAIL_BACKEND_ENABLED: 'on', MAIL_RECOVERY_ENABLED: 'on', MAIL_LOCAL_API: 'on',
      ...(draftsUploads && { MAIL_DRAFT_UPLOADS_ENABLED: 'on' }),
      ...(send && { MAIL_SEND_ENABLED: 'on', MAIL_ENVIRONMENT: 'test', MANUAL_ALARMS: 'on' }),
      ...(realQuota && { MAIL_SEND_DAILY_QUOTA: realQuota.daily ?? '1000', MAIL_SEND_MONTHLY_CEILING: realQuota.monthly ?? '3000',
        MAIL_SEND_DAILY_RESET_UTC: realQuota.reset ?? '15:00' }),
      DELIVERY_QUEUE_NAME: 'mail-deliver-fixture', DEAD_LETTER_QUEUE_NAME: 'mail-dlq-fixture',
      KOFRA_S3_ENDPOINT: 'https://object-store.example.test', KOFRA_S3_ACCESS_KEY_ID: 'fixture', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture',
      ...(realContent && { MAIL_CONTENT_ENABLED: 'on', REAL_CONTENT_ORIGIN: realContent.contentOrigin }),
      ...(fileLinks && { LINK_HOST, LINK_CRED_KEK: LINK_KEK,
        ...(fileLinks.hourlyFactor && { LINK_HOURLY_FACTOR: String(fileLinks.hourlyFactor) }),
        ...(fileLinks.totalFactor && { LINK_TOTAL_FACTOR: String(fileLinks.totalFactor) }) }) },
    ...(realContent && { serviceBindings: { MAIL_CONTENT: { name: 'mail-content', entrypoint: 'ContentMint' },
      ...(fileLinks && { ALERTS: { name: 'link-alerts' } }) } }),
    outboundService: async (req: LocalRequest) => {
      const { host, pathname } = new NodeURL(req.url);
      assert.equal(host, 'object-store.example.test');
      if (pathname === '/fixture-body-read' && req.method === 'POST') {
        watchedBody?.resolve();
        return new LocalResponse(null, { status: 204 });
      }
      switch (req.method) {
        case 'PUT': {
          await inspectPut?.(pathname);
          const held = nextPut;
          nextPut = undefined;
          if (held) { held.start.resolve(); await held.resume.promise; }
          objects.set(pathname, await req.arrayBuffer());
          return new LocalResponse(null, { status: 201 });
        }
        case 'GET': {
          const held = nextGet && nextGet.match.test(pathname) ? nextGet : undefined;
          if (held) {
            nextGet = undefined;
            held.start.resolve();
            await held.resume.promise;
          }
          const reads = watchedReads.get(pathname);
          if (reads !== undefined) watchedReads.set(pathname, reads + 1);
          if (failingReads.has(pathname)) return new LocalResponse('<Error><Code>ServiceUnavailable</Code></Error>', { status: 503 });
          const object = objects.get(pathname);
          return object ? new LocalResponse(object, { headers: { 'content-length': String(object.byteLength) } })
            : new LocalResponse('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
        }
        case 'DELETE': objects.delete(pathname); return new LocalResponse(null, { status: 204 });
        default: throw new Error('Unexpected fixture object method');
      }
    },
  };
  const workers = [backend];
  if (realContent) {
    const [content, account] = await Promise.all([contentBundle ??= compiled(contentEntry), accountBundle ??= compiled(accountEntry)]);
    let contentScript = content.outputFiles[0].text;
    if (inlineCids) {
      // Instrument only the browser test bundle. The storage stub waits for
      // six actual admissions, not a guess at browser or runner timing.
      const admission = 'const member = (await admit(key, sub, signal, purpose))();';
      assert.equal(contentScript.split(admission).length, 2, 'expected one MIME admission instrumentation point');
      contentScript = contentScript.replace(admission,
        `${admission}\nif (purpose === 'cid') console.log(${JSON.stringify(cidAdmissionMarker)});`);
    }
    workers.push({
      name: 'account', compatibilityDate: '2026-07-30',
      modules: [{ type: 'ESModule', path: 'account.mjs', contents: account.outputFiles[0].text }],
      bindings: { USERS: [...new Set(Object.values(accounts).map(({ userId }) => userId))] },
    }, {
      name: 'mail-content', compatibilityDate: '2026-07-30', compatibilityFlags: ['enable_request_signal'],
      modules: [{ type: 'ESModule', path: 'mail-content.mjs', contents: contentScript }],
      bindings: {
        MAIL_CONTENT_ENABLED: 'on', CONTENT_LOCAL_LOOPBACK: 'on', CONTENT_ORIGIN: realContent.contentOrigin,
        MAIL_APP_ORIGIN: realContent.appOrigin,
        CONTENT_URL_KEYS: JSON.stringify({ current: 'browser', keys: { browser: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') } }),
        CONTENT_S3_ENDPOINT: 'https://object-store.example.test', CONTENT_S3_ACCESS_KEY_ID: crypto.randomUUID(), CONTENT_S3_SECRET_ACCESS_KEY: crypto.randomUUID(),
        CONTENT_ZONE: 'content.example', CONTENT_SUITE_DOMAIN: 'mail.example', CONTENT_ACCOUNT_DOMAIN: 'account.example',
        CONTENT_STORAGE_DOMAIN: 'object-store.example.test', CONTENT_WORKERS_DEV_DOMAIN: 'account-example.workers.dev',
        ...(fileLinks && { LINK_HOSTS: [LINK_HOST, ...fileLinks.hosts ?? []].join(' '),
          LINK_LOCATIONS: JSON.stringify({ current: 'links', locations: { links: DEPLOYMENT_LOCATION } }),
          LINK_READ_CREDENTIALS: JSON.stringify({ links: LINK_READ }),
          ...(fileLinks.refusedZones !== null && { LINK_REFUSED_ZONES: fileLinks.refusedZones ?? JSON.stringify(['mail.example', 'content.example', LINK_HOST]) }) }),
      },
      serviceBindings: {
        MAIL_LOOKUP: { name: 'mail-backend', entrypoint: 'ContentLookup' },
        ACCOUNT_EPOCH: { name: 'account', entrypoint: 'CredentialEpoch' },
        ...(fileLinks && { LINK_FLOOD: { name: 'link-flood', entrypoint: 'Flood' } }),
      },
      outboundService: async (req: LocalRequest) => {
        const { host, pathname } = new NodeURL(req.url);
        const store = host === 'links.example.test' ? linkStores?.deployment : host === 'ws-links.example.test' ? linkStores?.workspace : undefined;
        if (store) {
          const answer = await store.fetch(new Request(req.url, { method: req.method, headers: Object.fromEntries(req.headers),
            ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: await req.arrayBuffer() }) }));
          return new LocalResponse(answer.body, { status: answer.status, headers: Object.fromEntries(answer.headers) });
        }
        if (req.method !== 'GET' || host !== 'object-store.example.test' || !req.headers.has('authorization')) {
          return new LocalResponse(null, { status: 404 });
        }
        if (pathname.includes('/raw/')) {
          contentRawReads++;
          if (inlineCids && contentRawReads > 1) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([cidBurst.promise, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Only ${cidAdmissions} CID requests reached admission`)), 5_000);
              })]);
            } finally { clearTimeout(timer); }
          }
        }
        const bytes = objects.get(pathname);
        return bytes ? new LocalResponse(bytes, { headers: { 'content-length': String(bytes.byteLength) } }) : new LocalResponse(null, { status: 404 });
      },
    });
  }
  if (fileLinks) {
    workers.push({ name: 'link-flood', compatibilityDate: '2026-07-30', modules: [{ type: 'ESModule', path: 'flood.mjs', contents: FLOOD_WORKER }] },
      { name: 'link-alerts', compatibilityDate: '2026-07-30', modules: [{ type: 'ESModule', path: 'alerts.mjs', contents: ALERT_WORKER }] });
  }
  configureWorkers?.(backend, workers);
  // The send path's structured log events (alert codes and metrics), recorded for assertions.
  const logs: string[] = [];
  const mf = new Miniflare({ host: '127.0.0.1', port: 0, workers, ...((inlineCids || send || fileLinks) && {
    handleStructuredLogs: ({ message }: { message: string }) => {
      if (send || fileLinks) logs.push(message);
      if (message === cidAdmissionMarker && ++cidAdmissions === 6) cidBurst.resolve();
    },
  }) });
  try {
    const ready = await mf.ready;
    const origin = ready.origin;
    const contentOrigin = realContent?.contentOrigin ?? `http://localhost:${ready.port}`;
    const contentWorker = realContent && await mf.getWorker('mail-content');
    const call = (name: string, body: string, extra: Record<string, string> = {}) => fetch(`${origin}/__fixture/${name}`, {
      method: 'POST', headers: { 'x-fixture-control': control, ...extra }, body,
    });
    const holders = async (key: string, workspace = accounts.member.ws): Promise<string[]> => {
      const res = await call('holders', JSON.stringify({ workspace, key }));
      assert.equal(res.status, 200);
      return res.json() as Promise<string[]>;
    };
    const readControl = async <T>(path: string, body = '', extra?: Record<string, string>): Promise<T> => {
      const res = await call(path, body, extra);
      assert.equal(res.status, 200);
      return res.json() as Promise<T>;
    };
    const timers = () => readControl<{ kind: string; ref: string; due_at: number }[]>('timers');
    const pendingReleases = () => readControl<{ seq: number; object_key: string; holder: string }[]>('pending-releases');
    const releaseRetryAt = () => readControl<number | null>('release-retry-at');
    const controlAction = async (path: string, body = '') => {
      const res = await call(path, body);
      assert.equal(res.status, 204, res.status === 204 ? undefined : await res.text());
    };
    // Wait for native D1 setup in the fixture worker rather than going through
    // Miniflare's synchronous Node binding proxy for each prepared statement.
    await controlAction('seed-directory', JSON.stringify(await directoryMigrationBatches({ localApi: true })));
    // A workspace link location of w1 (M3-15a's row, sealed under the fixture KEK).
    if (fileLinks) {
      const kek = await linkKek(LINK_KEK);
      const db = await mf.getD1Database('DIRECTORY', 'mail-backend');
      await db.batch(await new LinkStorageStore(db as unknown as LinkDatabase).createStatements(kek!, accounts.member.ws, WORKSPACE_LOCATION_ID,
        WORKSPACE_LOCATION, { read: S3Credentials.from(LINK_WS_READ)!, write: S3Credentials.from(LINK_WS_WRITE)! }, startTime) as unknown as D1PreparedStatement[]);
    }
    const directoryChange = (statement: string, ...binds: unknown[]) => controlAction('directory-change', JSON.stringify({ statement, binds }));
    const directoryRows = (statement: string, ...binds: unknown[]) => readControl<Record<string, unknown>[]>('directory-rows', JSON.stringify({ statement, binds }));
    const hasIdempotency = (key: string) => readControl<boolean>('has-idempotency', key);
    const confirmations = () => readControl<{ seq: number; object_key: string; holder: string }[]>('confirmations');
    const holderDetails = (key: string) => readControl<{ holder: string; state: string; expires_at: number | null }[]>('holder-details', key);
    const confirmFailure = (failing: boolean) => controlAction('confirm-failure', String(failing));
    const stallConfirmation = () => controlAction('stall-confirmation');
    const stallRelease = (holder: string) => controlAction('stall-release', holder);
    const expireUploadLease = (key: string) => controlAction('expire-upload-lease', key);
    const pauseNextGet = (match: RegExp) => {
      const gate = nextGet = { match, start: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
      return { started: gate.start.promise, release: gate.resume.resolve };
    };
    const pauseNextPut = () => {
      const gate = nextPut = { start: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
      return { started: gate.start.promise, release: gate.resume.resolve };
    };
    const confirmBatches = () => readControl<number[]>('confirm-batches');
    const releaseHolder = (key: string, holder: string) => controlAction('release-holder', JSON.stringify({ key, holder }));
    const sweepAt = (time: number) => controlAction('sweep-at', String(time));
    const alerts = () => readControl<string[]>('alerts');
    const alertFailure = (failing: boolean) => controlAction('alert-failure', String(failing));
    const stageAndCrash = () => readControl<boolean>('stage-crash');
    const persistMaximumHolder = (key: string) => readControl<string>('maximum-holder', key);
    const restore = () => controlAction('restore');
    const forceSnapshot = () => readControl<boolean>('snapshot');
    const uploadSwitch = (enabled: boolean) => controlAction('upload-switch', String(enabled));
    const publishFailure = (failing: boolean) => controlAction('publish-failure', String(failing));
    const releaseFailure = (failing: boolean) => controlAction('release-failure', String(failing));
    const acknowledgedReleases = () => readControl<{ key: string; holder: string }[]>('acknowledged-releases');
    const purgeTrash = () => readControl<number>('purge-trash');
    const pauseExpiry = (kind: string) => controlAction('pause-expiry', kind);
    const expiryStarts = () => readControl<number>('expiry-starts');
    const eventCount = (kind: string) => readControl<number>('events', kind);
    const finishExpiry = () => controlAction('finish-expiry');
    const sends = {
      queue: () => readControl<{ kind: string; ws: string; mb: string; sendId: string }[]>('send-queue'),
      emailCalls: () => readControl<number>('email-calls'),
      crashAfter: (step: 'released' | 'stored' | 'queued' | 'enqueued') => controlAction('crash-after', step),
      failNextEpilogue: () => controlAction('fail-next-epilogue'),
      bumpBuilder: () => controlAction('bump-builder'),
      builds: () => readControl<{ version: number; parts: number[]; types: string[]; inReplyTo?: string }[]>('mime-builds'),
      // The builder version of each send() request built through the MIME builder port.
      requests: () => readControl<number[]>('mime-requests'),
      shortHandlerBudget: () => controlAction('short-handler-budget'),
      row: (id: string) => readControl<{ id: string; state: string; undo_until: number; created_seq: number; release_seq: number | null;
        queued_seq: number | null; terminal_seq: number | null; message_id: string | null; reason: string | null; finish_pending: number;
        record: string } | null>('send-row', id),
      lifecycle: async () => { const value = await readControl<string | null>('lifecycle'); return value === null ? null : JSON.parse(value) as Record<string, unknown>; },
      setReplyTo: (replyTo: unknown) => controlAction('set-reply-to', JSON.stringify(replyTo)),
      registration: (sendId: string) => readControl<{ digest: string | null; key: string | null; raw_holder: string | null;
        index_holder: string | null; released: string | null } | null>('send-registration', sendId),
      generation: (key: string) => readControl<{ key: string; holder_count: number; retry_at: number | null; deleted_at: number | null } | null>('generation', key),
      activateAlias: (address: string) => controlAction('activate-alias', address),
      // Runs one directory statement on the next sendDraft, after the API layer's reads and before the mailbox's.
      beforeMailboxSend: (statement: string, ...binds: unknown[]) => controlAction('before-mailbox-send', JSON.stringify({ statement, binds })),
      forceLost: (holder: string) => controlAction('force-lost', holder),
      stallPublish: () => controlAction('stall-publish'),
      publishStalled: () => controlAction('publish-stalled'),
      resumePublish: () => controlAction('resume-publish'),
      shortBarrier: (ms = 200) => controlAction('short-barrier', String(ms)),
      holdPublishLane: () => controlAction('hold-publish-lane'),
      coverHeld: () => controlAction('cover-held'),
      releaseHeld: () => controlAction('release-held'),
      dropBuilder: (dropped: boolean) => controlAction('drop-builder', String(dropped)),
      refuseMime: (phase: 'size' | 'build', code: 'invalid_header' | 'message_too_large' | 'invalid_wire') =>
        controlAction('refuse-mime', JSON.stringify({ phase, code })),
      ids: () => readControl<string[]>('send-ids'),
      rateCap: (binding: 'MAIL_RATE_SENDS' | 'MAIL_RATE_UNDO' | 'MAIL_RATE_UNDO_FLOOD', cap: number) =>
        controlAction('rate-cap', JSON.stringify({ binding, cap })),
      releaseFailure: (failing: boolean) => controlAction('send-release-failure', String(failing)),
      driver: (id: string) => readControl<{ send_id: string; backoff: number; held: number } | null>('send-driver', id),
      // Holds the next publishThrough(seq) of a send run before it starts.
      pausePublishThrough: (seq: number) => controlAction('pause-publish-through', String(seq)),
      publishThroughPaused: () => controlAction('publish-through-paused'),
      resumePublishThrough: () => controlAction('resume-publish-through'),
      // Waits for every send_drive run in the mailbox's isolate, also one the alarm returned from.
      driveIdle: () => controlAction('drive-idle'),
      // Persists MAIL_SEND_ENABLED for the mailbox and restarts it, like a deploy that changes the flag.
      switchPath: (enabled: boolean) => controlAction('send-switch', String(enabled)),
      activeAlerts: () => readControl<string[]>('active-alerts'),
      breaches: () => readControl<string[]>('send-breaches'),
      changePartDigest: (sendId: string) => controlAction('change-part-digest', sendId),
      failLaneWakeup: (failing: boolean) => controlAction('fail-lane-wakeup', String(failing)),
      gateLaneWakeup: () => controlAction('gate-lane-wakeup'),
      laneWakeupEntered: () => controlAction('lane-wakeup-entered'),
      openLaneWakeup: () => controlAction('open-lane-wakeup'),
      setRecipientState: (sendId: string, idx: number, state: string) =>
        controlAction('set-recipient-state', JSON.stringify({ sendId, idx, state })),
      setUndoUntil: (sendId: string, undoUntil: number) => controlAction('set-send-undo-until', JSON.stringify({ sendId, undoUntil })),
      setDraftKey: (sendId: string, rawKey: string) => controlAction('set-send-draft-key', JSON.stringify({ sendId, rawKey })),
      changeAttachmentSize: (messageId: string, part: number, delta: number) =>
        controlAction('change-attachment-size', JSON.stringify({ messageId, part, delta })),
      dropSyntheticMark: (messageId: string) => controlAction('drop-synthetic-mark', messageId),
      changeAttachmentMeta: (messageId: string, part: number, name: string, type: string) =>
        controlAction('change-attachment-meta', JSON.stringify({ messageId, part, name, type })),
      // The fixture's clock as API calls read it; an advance moves it before its alarms run.
      now: () => readControl<number>('now'),
      seedForwardDraft: (input: { from: string; messageId: string; part: number; delta: number; to?: string[] }) =>
        readControl<{ id: string; revision: string }>('seed-forward-draft', JSON.stringify(input)),
      seedLegacyDraft: (draft: unknown) => readControl<{ id: string; revision: string; rawKey: string; holder: string }>('seed-legacy-api-draft',
        JSON.stringify(draft)),
    };
    if (draftsUploads) inspectPut = async (pathname) => {
      const path = /^\/mail-([^/]+)\/(.+)$/.exec(pathname);
      assert.ok(path, 'expected a workspace-scoped PUT');
      const [, workspace, key] = path;
      writes.push({ key, holders: await holders(key, workspace) });
    };
    const ancestryById = new Map<string, string[]>();
    const clients = new Map<string, ReturnType<typeof createHttpMailService>>();
    const as = (principal: keyof typeof principals) => {
      const cached = clients.get(principal);
      if (cached) return cached;
      const client = createHttpMailService({ baseUrl: `${origin}/api/v1`, fetch: (input, init) => {
        const req = new Request(input, init);
        req.headers.set('x-fixture-account', principal);
        if (req.method !== 'GET') req.headers.set('origin', origin);
        if (init?.body instanceof Blob && init.body.size > LIMITS.uploadBytes) {
          return fetchOversizedRequest(req, init.body.size);
        }
        return fetch(req);
      } });
      clients.set(principal, client);
      return client;
    };
    const advance = async (ms: number, parallel: boolean | 'clock-only' | 'all-mailboxes' = false, alarms = true) => {
      const res = await call('advance', String(ms), { 'x-fixture-parallel': String(parallel), 'x-fixture-alarms': String(alarms) });
      if (!res.ok) throw new Error(`Fixture advance HTTP ${res.status}: ${await res.text()}`);
      now += ms;
    };
    const deliver = async (message: TestMessage, to: keyof typeof accounts = 'member') => {
      const msgId = message.messageId ?? `<${crypto.randomUUID()}@fixture.test>`;
      const ancestry = ancestryById.get(message.inReplyTo ?? '') ?? [];
      const mime = buildMime(message, now, msgId, ancestry);
      const res = await call('deliver', mime, { 'x-fixture-to': accounts[to].address, 'x-fixture-from': message.from.email });
      if (!res.ok) throw new Error(`Fixture delivery HTTP ${res.status}: ${await res.text()}`);
      const result = await res.json() as { threadId: string; messageId: string };
      assert.ok(result.threadId && result.messageId);
      ancestryById.set(result.messageId, [...ancestry, msgId]);
      return result;
    };
    if (demo) {
      const mail = as('demo');
      for (const name of ['Finance', 'Projects']) await mail.createLabel({ name }, { idempotencyKey: crypto.randomUUID() });
      const message: TestMessage = { from: { name: 'Mira Chen', email: 'mira@example.net' }, to: [{ name: 'Alex Morgan', email: 'hello@example.com' }],
        subject: 'Floor plan revisions', text: 'I’ve attached the latest floor plan. Can you review it before Tuesday?',
        html: '<p>Kitchen measurements revised.</p><p>Can you review it before Tuesday?</p><img src="https://fixture.test/demo-floor-plan">'
          + (realContent ? '<script>globalThis.messageScriptRan = true;</script>' : ''),
        attachments: [{ name: 'floor-plan-notes.txt', type: 'text/plain', bytes: new TextEncoder().encode('Kitchen measurements revised.') }],
      };
      const { threadId } = await deliver(message, 'demo');
      const additional = async (subject: string) => deliver({ ...message, subject, text: subject, html: undefined, attachments: undefined }, 'demo');
      await additional('Project schedule');
      if (inlineCids) {
        const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgZGL+DwABFAEG1rmmRQAAAABJRU5ErkJggg==', 'base64'));
        const parts = Array.from({ length: 6 }, (_, i) => i);
        await deliver({ ...message, subject: 'Six local inline images', text: 'Six local inline images.',
          html: parts.map(i => `<img src="cid:part-${i}@fixture.test" alt="Inline image ${i + 1}">`).join(''),
          attachments: parts.map(i => ({ name: `inline-${i + 1}.png`, type: 'image/png', bytes: png, inline: true })),
        }, 'demo');
      }
      const long = await deliver({ ...message, subject: 'Long plain message', html: undefined, attachments: undefined,
        text: `Preview of long plain message\n${'Message line.\n'.repeat(5_100)}\nUnique tail after the preview` }, 'demo');
      await mail.updateThreads({ ids: [long.threadId], set: { folder: 'archive' } });
      for (const [folder, subject] of [['trash', 'Discarded message'], ['spam', 'Unwanted message']] as const) {
        const item = await additional(subject);
        await mail.updateThreads({ ids: [item.threadId], set: { folder } });
      }
      assert.ok((await mail.getThread(threadId)).messages.length);
    }
    return { origin, contentOrigin, directoryChange, directoryRows, as, deliver, advance, objects, failingReads, writes, holders, timers, pendingReleases, releaseRetryAt, restore,
      activatePrimary: (address: string) => controlAction('activate-primary', address),
      forceSnapshot, uploadSwitch, sends,
      publishFailure, releaseFailure, acknowledgedReleases, purgeTrash, pauseExpiry, expiryStarts, finishExpiry, eventCount,
      startedAt: startTime, hasIdempotency, confirmations, holderDetails, confirmFailure, confirmBatches, releaseHolder, sweepAt, alerts, alertFailure, stageAndCrash, persistMaximumHolder,
      stallConfirmation, stallRelease, expireUploadLease, pauseNextPut, pauseNextGet,
      watchBodyRead: () => (watchedBody = Promise.withResolvers<void>()).promise,
      watchObjectReads(path: string) {
        watchedReads.set(path, 0);
        return () => watchedReads.get(path)!;
      },
      failNextConfirmation: () => controlAction('fail-next-confirmation'),
      blockLaterDelta: (after: number) => controlAction('block-later-delta', String(after)),
      exposesLegacyWriter: () => readControl<boolean>('exposes-legacy-writer'),
      seedLegacyLabel: () => readControl<{ id: string; name: string }>('seed-legacy-label'),
      // The mailbox's send consumer RPCs (M3-5a), the fake quota object, and the stored consumer state.
      sendRpc: <T>(method: string, ...args: unknown[]) => readControl<T>('send-rpc', JSON.stringify({ method, args })),
      // The same call with another mailbox's scope, on the member mailbox's object.
      sendRpcAs: (mb: string, method: string, ...args: unknown[]) => call('send-rpc', JSON.stringify({ method, args, mb })),
      pauseSenderCheck: (phase: 'before' | 'after' = 'before') => controlAction('pause-sender-check', phase),
      senderCheckPaused: () => controlAction('sender-check-paused'),
      resumeSenderCheck: () => controlAction('resume-sender-check'),
      failRecordOnce: (attempt: number, times = 1) => controlAction('fail-record-once', `${attempt},${times}`),
      crashAfterRecordCommit: () => controlAction('crash-after-record-commit'),
      crashAfterClaimRelease: () => controlAction('crash-after-claim-release'),
      crashAfterResultDelete: () => controlAction('crash-after-result-delete'),
      // Holds the next pass through a seam ('select', or 'record:<attempt>') until resumed.
      pauseAt: (point: string) => controlAction('pause-at', point),
      armArrival: (method: string) => controlAction('arm-arrival', method),
      arrived: (method: string) => controlAction('arrived', method),
      crashAfterRecheckTake: () => controlAction('crash-after-recheck-take'),
      pausedAt: (point: string) => controlAction('paused-at', point),
      resumeAt: (point: string) => controlAction('resume-at', point),
      quota: <T>(method: string, ...args: unknown[]) => readControl<T>('quota', JSON.stringify({ method, args })),
      // The send consumer's dispatch core (M3-5b) in the fixture worker, and its fakes.
      consumer: <T>(method: string, ...args: unknown[]) => readControl<T>('consumer', JSON.stringify({ method, args })),
      // Structured log lines of the send fixture, in order.
      logs: () => [...logs],
      sendState: (id: string, mb?: string) => readControl<SendStateView>('send-state', id, mb && { 'x-fixture-send-mailbox': mb } || undefined),
      pauseNextEnqueue: () => controlAction('pause-enqueue'),
      enqueuePaused: () => controlAction('enqueue-paused'),
      resumeEnqueue: () => controlAction('resume-enqueue'),
      restoreAfter: async (ms: number) => { await controlAction('restore-after', String(ms)); now += ms; },
      m3: send, credentialEpoch: async () => 1,
      worker: (name: string) => mf.getWorker(name),
      queue: (binding: string, name: string) => mf.getQueueProducer(binding, name),
      beginRestore: (principal: 'member' | 'other' = 'member') => controlAction('begin-restore', principal),
      failClaims: (count: number) => controlAction('fail-claims', String(count)),
      failedClaims: () => readControl<number>('failed-claims'),
      backendCron: () => controlAction('backend-cron'),
      sendEvent: (code: string, principal: 'member' | 'other' = 'member') => controlAction('send-event', JSON.stringify({ code, principal })),
      contentRawReads: () => contentRawReads,
      links: linkStores && {
        stores: linkStores,
        // Puts a link object at `key` (the full key, prefix included) in a location's fake bucket.
        put: (kind: 'deployment' | 'workspace', key: string, bytes: Uint8Array<ArrayBuffer>) => { linkStores[kind].objects.set(key, bytes); },
        // A request to the link host, as a recipient's browser makes it.
        fetch: (path: string, init: RequestInit & { ip?: string } = {}) => {
          const headers = new Headers(init.headers);
          headers.set('cf-connecting-ip', init.ip ?? '192.0.2.1');
          return contentWorker!.fetch(`https://${LINK_HOST}${path}`, { ...init, headers } as never);
        },
        floodCap: async (cap: number) => { await (await mf.getWorker('link-flood')).fetch('http://flood/cap', { method: 'POST', body: String(cap) }); },
        floodCalls: async () => (await (await mf.getWorker('link-flood')).fetch('http://flood/calls')).json() as Promise<string[]>,
        // Every operator alert the backend posted.
        alerts: async () => (await (await mf.getWorker('link-alerts')).fetch('http://alerts/received')).json() as Promise<Record<string, unknown>[]>,
        control: <T>(method: string, args: unknown[] = [], principal?: string) => readControl<T>('links', JSON.stringify({ method, args, principal })),
      },
      fetchContent: contentWorker ? (path: string, method = 'GET') => contentWorker.fetch(`${contentOrigin}${path}`, { method }) : undefined,
      sentHeaders: (messageId: string) => readControl<Record<string, string>>('sent-headers', messageId),
      // Internal delivery (M3-8): the pipeline's queue consumer for every pending delivery, the reconciler's
      // handoff part (with a bound on each call), a second expander, a principal's mailbox and a workspace's sweeper.
      runDeliveries: () => readControl<string[]>('run-deliveries'),
      handoffCron: (callMs?: number, failTake?: number) => readControl<{ errors: number }>('handoff-cron',
        `${callMs ?? ''}${failTake === undefined ? '' : `,${failTake}`}`),
      expand: (key: string) => readControl<string>('expand', key),
      box: <T>(principal: keyof typeof principals, method: string, ...args: unknown[]) => readControl<T>('box', JSON.stringify({ principal, method, args })),
      sweeper: <T>(workspace: string, method: string, ...args: unknown[]) => readControl<T>('sweeper', JSON.stringify({ workspace, method, args })),
      deliverRaw: async (mime: string, to: keyof typeof principals, from: string) => {
        const res = await call('deliver', mime, { 'x-fixture-to': principals[to]!.address, 'x-fixture-from': from });
        if (!res.ok) throw new Error(`Fixture delivery HTTP ${res.status}: ${await res.text()}`);
        return res.json() as Promise<{ threadId: string; messageId: string }>;
      },
      close: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
