import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as LocalResponse, type Request as LocalRequest } from 'miniflare';
import { createHttpMailService } from '../../../../contracts/mail-api/src/http-client.ts';
import type { ConformanceHarness, Principal, TestMessage } from '../../../../contracts/mail-api/src/harness.ts';
import type { Address } from '../../../../contracts/mail-api/src/wire.ts';
import { migrateDirectory } from './directory-db.ts';
import type { FixturePrincipal } from './mail-http-worker.ts';

const entry = fileURLToPath(new NodeURL('./mail-http-worker.ts', import.meta.url));
const compiled = () => build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', external: ['cloudflare:workers'], write: false });
let bundle: ReturnType<typeof compiled> | undefined;
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

export async function startMailHttpFixture({ demo = false, startedAt = Date.now() }: { demo?: boolean; startedAt?: number } = {}) {
  const { outputFiles } = await (bundle ??= compiled());
  const contents = outputFiles[0].text;
  const objects = new Map<string, ArrayBuffer>();
  const control = crypto.randomUUID();
  let now = Math.floor(startedAt / 1000) * 1000;
  const mf = new Miniflare({
    host: '127.0.0.1', port: 0,
    modules: [{ type: 'ESModule', path: 'mail-http-worker.mjs', contents }],
    compatibilityDate: '2026-06-25',
    durableObjects: { SWEEPER: { className: 'Sweeper', useSQLite: true }, MAILBOX: { className: 'HttpMailbox', useSQLite: true } },
    r2Buckets: ['MAIL_STATE'], d1Databases: ['DIRECTORY'],
    bindings: { ACCOUNTS: accounts, CONTROL_KEY: control, CSRF_KEY: crypto.randomUUID(), INITIAL_TIME: now, ...(demo && { DEFAULT_ACCOUNT: 'demo' }),
      MAIL_BACKEND_ENABLED: 'on', MAIL_RECOVERY_ENABLED: 'on', MAIL_LOCAL_API: 'on',
      DELIVERY_QUEUE_NAME: 'mail-deliver-fixture', DEAD_LETTER_QUEUE_NAME: 'mail-dlq-fixture',
      KOFRA_S3_ENDPOINT: 'https://object-store.example.test', KOFRA_S3_ACCESS_KEY_ID: 'fixture', KOFRA_S3_SECRET_ACCESS_KEY: 'fixture' },
    outboundService: async (req: LocalRequest) => {
      const { host, pathname } = new NodeURL(req.url);
      assert.equal(host, 'object-store.example.test');
      switch (req.method) {
        case 'PUT': objects.set(pathname, await req.arrayBuffer()); return new LocalResponse(null, { status: 201 });
        case 'GET': {
          const object = objects.get(pathname);
          return object ? new LocalResponse(object, { headers: { 'content-length': String(object.byteLength) } })
            : new LocalResponse('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
        }
        case 'DELETE': objects.delete(pathname); return new LocalResponse(null, { status: 204 });
        default: throw new Error('Unexpected fixture object method');
      }
    },
  });
  try {
    const ready = await mf.ready;
    const origin = ready.origin;
    const contentOrigin = `http://localhost:${ready.port}`;
    const db = await mf.getD1Database('DIRECTORY') as unknown as D1Database;
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
    const advance = async (ms: number) => {
      const res = await call('advance', String(ms));
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
        html: '<p>Kitchen measurements revised.</p><p>Can you review it before Tuesday?</p><img src="https://fixture.test/demo-floor-plan">',
        attachments: [{ name: 'floor-plan-notes.txt', type: 'text/plain', bytes: new TextEncoder().encode('Kitchen measurements revised.') }],
      };
      const { threadId } = await deliver(message, 'demo');
      const additional = async (subject: string) => deliver({ ...message, subject, text: subject, html: undefined, attachments: undefined }, 'demo');
      await additional('Project schedule');
      const long = await deliver({ ...message, subject: 'Long plain message', html: undefined, attachments: undefined,
        text: `Preview of long plain message\n${'Message line.\n'.repeat(5_100)}\nUnique tail after the preview` }, 'demo');
      await mail.updateThreads({ ids: [long.threadId], set: { folder: 'archive' } });
      for (const [folder, subject] of [['trash', 'Discarded message'], ['spam', 'Unwanted message']] as const) {
        const item = await additional(subject);
        await mail.updateThreads({ ids: [item.threadId], set: { folder } });
      }
      assert.ok((await mail.getThread(threadId)).messages.length);
    }
    return { origin, contentOrigin, as, deliver, advance, m3: false, credentialEpoch: async () => 1,
      sentHeaders: async () => { throw new Error('M3 is not part of this backend'); }, close: () => mf.dispose() } satisfies ConformanceHarness & { origin: string };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
