import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse, type Request as LocalRequest, type WorkerOptions } from 'miniflare';
import { createHttpMailService } from '../../../../contracts/mail-api/src/http-client.ts';
import type { Principal, TestMessage } from '../../../../contracts/mail-api/src/harness.ts';
import type { Address } from '../../../../contracts/mail-api/src/wire.ts';
import { migrateDirectory } from './directory-db.ts';
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

const CRLF = '\r\n';
const base64 = (bytes: string | Uint8Array) => Buffer.from(bytes).toString('base64').replace(/.{1,76}/g, `$&${CRLF}`).trimEnd();
const word = (value: string) => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
const recipients = (addrs: Address[]) => addrs.map((a) => a.name ? `${word(a.name)} <${a.email}>` : a.email).join(', ');
function buildMime(message: TestMessage, sentAt: number, msgId: string, parent?: string): string {
  const boundary = `mixed-${crypto.randomUUID()}`, alternate = `alternative-${crypto.randomUUID()}`;
  const plain = `Content-Type: text/plain; charset=utf-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${base64(message.text)}`;
  const html = message.html === undefined ? undefined : [`Content-Type: multipart/alternative; boundary="${alternate}"`, '',
    `--${alternate}`, plain, `--${alternate}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64(message.html), `--${alternate}--`].join(CRLF);
  const header = [`From: ${recipients([message.from])}`, `To: ${recipients(message.to)}`,
    ...(message.cc?.length ? [`Cc: ${recipients(message.cc)}`] : []), `Subject: ${word(message.subject)}`, `Message-ID: ${msgId}`,
    ...(parent ? [`In-Reply-To: ${parent}`, `References: ${parent}`] : []), `Date: ${new Date(sentAt).toUTCString()}`, 'MIME-Version: 1.0'];
  if (!message.attachments?.length) return [...header, html ?? plain, ''].join(CRLF);
  const parts = message.attachments.map((part, index) => [
    `Content-Type: ${part.type}`, `Content-Disposition: ${part.inline ? 'inline' : 'attachment'}; filename="${word(part.name)}"`,
    ...(part.inline ? [`Content-ID: <part-${index}@fixture.test>`] : []), 'Content-Transfer-Encoding: base64', '', base64(part.bytes),
  ].join(CRLF));
  return [...header, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...[html ?? plain, ...parts].flatMap((part) => [`--${boundary}`, part]), `--${boundary}--`, ''].join(CRLF);
}

interface FixtureOptions {
  demo?: boolean;
  draftsUploads?: boolean;
  startedAt?: number;
  realContent?: { appOrigin: string; contentOrigin: string };
  inlineCids?: boolean;
  // The send path (M3-3) with fake SEND and EMAIL bindings and manual alarms.
  send?: boolean;
}

export async function startMailHttpFixture({ demo = false, draftsUploads: uploads = false, startedAt = Date.now(), realContent, inlineCids = false,
  send = false }: FixtureOptions = {}) {
  const draftsUploads = uploads || send;
  const { outputFiles } = await (bundle ??= compiled());
  const contents = outputFiles[0].text;
  const objects = new Map<string, ArrayBuffer>();
  // Object paths whose GET answers 503, a transient object store failure.
  const failingReads = new Set<string>();
  const writes: { key: string; holders: string[] }[] = [];
  let inspectPut: ((pathname: string) => Promise<void>) | undefined;
  let nextPut: { start: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void> } | undefined;
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
    durableObjects: { SWEEPER: { className: 'Sweeper', useSQLite: true }, MAILBOX: { className: 'HttpMailbox', useSQLite: true } },
    r2Buckets: ['MAIL_STATE'], d1Databases: ['DIRECTORY'],
    bindings: { ACCOUNTS: accounts, CONTROL_KEY: control, CSRF_KEY: crypto.randomUUID(), INITIAL_TIME: now, ...(demo && { DEFAULT_ACCOUNT: 'demo' }),
      MAIL_BACKEND_ENABLED: 'on', MAIL_RECOVERY_ENABLED: 'on', MAIL_LOCAL_API: 'on',
      ...(draftsUploads && { MAIL_DRAFT_UPLOADS_ENABLED: 'on' }),
      ...(send && { MAIL_SEND_ENABLED: 'on', MANUAL_ALARMS: 'on' }),
      DELIVERY_QUEUE_NAME: 'mail-deliver-fixture', DEAD_LETTER_QUEUE_NAME: 'mail-dlq-fixture',
      KOFRA_S3_ENDPOINT: 'https://object-store.example.test', KOFRA_S3_ACCESS_KEY_ID: 'fixture', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture',
      ...(realContent && { MAIL_CONTENT_ENABLED: 'on', REAL_CONTENT_ORIGIN: realContent.contentOrigin }) },
    ...(realContent && { serviceBindings: { MAIL_CONTENT: { name: 'mail-content', entrypoint: 'ContentMint' } } }),
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
      },
      serviceBindings: {
        MAIL_LOOKUP: { name: 'mail-backend', entrypoint: 'ContentLookup' },
        ACCOUNT_EPOCH: { name: 'account', entrypoint: 'CredentialEpoch' },
      },
      outboundService: async (req: LocalRequest) => {
        const { host, pathname } = new NodeURL(req.url);
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
  const mf = new Miniflare({ host: '127.0.0.1', port: 0, workers, ...(inlineCids && {
    handleStructuredLogs: ({ message }: { message: string }) => {
      if (message === cidAdmissionMarker && ++cidAdmissions === 6) cidBurst.resolve();
    },
  }) });
  try {
    const ready = await mf.ready;
    const origin = ready.origin;
    const contentOrigin = realContent?.contentOrigin ?? `http://localhost:${ready.port}`;
    const contentWorker = realContent && await mf.getWorker('mail-content');
    const db = await mf.getD1Database('DIRECTORY', 'mail-backend') as unknown as D1Database;
    await migrateDirectory(db);
    const sql = await readFile(new NodeURL('../../migrations/0008_local_mail_api.sql', import.meta.url), 'utf8');
    await db.batch(sql.split(/;\s*\n(?=\s*(?:CREATE |--|$))/).filter((s) => s.trim()).map((s) => db.prepare(s)));
    await db.batch(['w1:example.com', 'w2:example.net'].map((row) => {
      const [ws, domain] = row.split(':');
      return db.prepare("INSERT INTO domains VALUES (?, ?, ?, 'primary', NULL, 'active', 'active')").bind(ws, ws, domain);
    }));
    for (const principal of Object.values(accounts).filter((a) => a.mailboxId && !a.stale)) {
      await db.batch([
        db.prepare('INSERT INTO mailboxes (id, workspace_id, user_id, primary_address) VALUES (?, ?, ?, ?)').bind(principal.mailboxId, principal.ws, principal.userId, principal.address),
        db.prepare('INSERT INTO mailbox_profiles VALUES (?, ?, ?)').bind(principal.ws, principal.mailboxId, principal.name),
        db.prepare("INSERT INTO addresses VALUES (?, ?, 'mailbox', ?, 'primary', 'active')").bind(principal.address, principal.ws, principal.mailboxId),
      ]);
    }
    const call = (name: string, body: string, extra: Record<string, string> = {}) => fetch(`${origin}/__fixture/${name}`, {
      method: 'POST', headers: { 'x-fixture-control': control, ...extra }, body,
    });
    const holders = async (key: string, workspace = accounts.member.ws): Promise<string[]> => {
      const res = await call('holders', JSON.stringify({ workspace, key }));
      assert.equal(res.status, 200);
      return res.json() as Promise<string[]>;
    };
    const readControl = async <T>(path: string, body = ''): Promise<T> => {
      const res = await call(path, body);
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
    const hasIdempotency = (key: string) => readControl<boolean>('has-idempotency', key);
    const confirmations = () => readControl<{ seq: number; object_key: string; holder: string }[]>('confirmations');
    const holderDetails = (key: string) => readControl<{ holder: string; state: string; expires_at: number | null }[]>('holder-details', key);
    const confirmFailure = (failing: boolean) => controlAction('confirm-failure', String(failing));
    const stallConfirmation = () => controlAction('stall-confirmation');
    const stallRelease = (holder: string) => controlAction('stall-release', holder);
    const expireUploadLease = (key: string) => controlAction('expire-upload-lease', key);
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
      builds: () => readControl<{ version: number; parts: number[] }[]>('mime-builds'),
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
      forceLost: (holder: string) => controlAction('force-lost', holder),
      stallPublish: () => controlAction('stall-publish'),
      publishStalled: () => controlAction('publish-stalled'),
      resumePublish: () => controlAction('resume-publish'),
      shortBarrier: (ms = 200) => controlAction('short-barrier', String(ms)),
      holdPublishLane: () => controlAction('hold-publish-lane'),
      coverHeld: () => controlAction('cover-held'),
      releaseHeld: () => controlAction('release-held'),
      dropBuilder: (dropped: boolean) => controlAction('drop-builder', String(dropped)),
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
    const ids = new Map<string, string>();
    const clients = new Map<string, ReturnType<typeof createHttpMailService>>();
    const as = (principal: keyof typeof accounts) => {
      const cached = clients.get(principal);
      if (cached) return cached;
      const client = createHttpMailService({ baseUrl: `${origin}/api/v1`, fetch: (input, init) => {
        const req = new Request(input, init);
        req.headers.set('x-fixture-account', principal);
        if (req.method !== 'GET') req.headers.set('origin', origin);
        return fetch(req);
      } });
      clients.set(principal, client);
      return client;
    };
    const advance = async (ms: number, parallel = false) => {
      const res = await call('advance', String(ms), { 'x-fixture-parallel': String(parallel) });
      if (!res.ok) throw new Error(`Fixture advance HTTP ${res.status}: ${await res.text()}`);
      now += ms;
    };
    const deliver = async (message: TestMessage, to: keyof typeof accounts = 'member') => {
      const msgId = message.messageId ?? `<${crypto.randomUUID()}@fixture.test>`;
      const parent = message.inReplyTo ? ids.get(message.inReplyTo) : undefined;
      const mime = buildMime(message, now, msgId, parent);
      const res = await call('deliver', mime, { 'x-fixture-to': accounts[to].address, 'x-fixture-from': message.from.email });
      if (!res.ok) throw new Error(`Fixture delivery HTTP ${res.status}: ${await res.text()}`);
      const result = await res.json() as { threadId: string; messageId: string };
      assert.ok(result.threadId && result.messageId);
      ids.set(result.messageId, msgId);
      return result;
    };
    if (demo) {
      await db.prepare("INSERT INTO addresses VALUES ('hello@example.com', 'w1', 'mailbox', 'mailbox-demo', 'alias', 'active')").run();
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
    return { origin, contentOrigin, directoryDb: db, as, deliver, advance, objects, failingReads, writes, holders, timers, pendingReleases, releaseRetryAt, restore,
      forceSnapshot, uploadSwitch, sends,
      publishFailure, releaseFailure, acknowledgedReleases, purgeTrash, pauseExpiry, expiryStarts, finishExpiry, eventCount,
      startedAt: startTime, hasIdempotency, confirmations, holderDetails, confirmFailure, confirmBatches, releaseHolder, sweepAt, alerts, alertFailure, stageAndCrash, persistMaximumHolder,
      stallConfirmation, stallRelease, expireUploadLease, pauseNextPut,
      watchBodyRead: () => (watchedBody = Promise.withResolvers<void>()).promise,
      failNextConfirmation: () => controlAction('fail-next-confirmation'),
      blockLaterDelta: (after: number) => controlAction('block-later-delta', String(after)),
      exposesLegacyWriter: () => readControl<boolean>('exposes-legacy-writer'),
      seedLegacyLabel: () => readControl<{ id: string; name: string }>('seed-legacy-label'),
      m3: false, credentialEpoch: async () => 1,
      contentRawReads: () => contentRawReads,
      fetchContent: contentWorker ? (path: string, method = 'GET') => contentWorker.fetch(`${contentOrigin}${path}`, { method }) : undefined,
      sentHeaders: async () => { throw new Error('M3 is not part of this backend'); }, close: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
