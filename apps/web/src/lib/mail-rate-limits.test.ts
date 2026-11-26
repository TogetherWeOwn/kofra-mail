import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { API_PREFIX, LIMITS, ROUTES, createHttpMailService } from '@kofra/mail-contract';
import type { Draft, DraftInput, Operation, Upload } from '@kofra/mail-contract';
import { handleMailApi, type LocalPrincipal, type MailApiEnvironment } from './server/mail-api.ts';

const origin = 'http://127.0.0.1:4178';
const period = 60;
const limits = {
  MAIL_RATE_READS: 600,
  MAIL_RATE_WRITES: 120,
  MAIL_RATE_UPLOADS: 64,
  MAIL_RATE_SENDS: 20,
  MAIL_RATE_UNDO: 10,
  MAIL_RATE_UNDO_FLOOD: 600,
  MAIL_RATE_ADMIN_WRITES: 60,
};
type Binding = keyof typeof limits;
const alice: LocalPrincipal = { userId: 'user-a', name: 'Member', workspaceId: 'workspace-a', role: 'admin',
  authTime: Date.now(), credentialEpoch: 1, csrfToken: 'fixture-csrf' };
const bob = { ...alice, userId: 'user-b' };
const eve = { ...alice, userId: 'user-c', workspaceId: 'workspace-b' };
const mailboxId = (user: LocalPrincipal) => `mailbox-${user.userId}`;
const sendA = { sendId: 'send-a' };

type MailboxRpc = ReturnType<NonNullable<MailApiEnvironment['MAILBOX']>['getByName']>['mailApi'];

function fixture(dispatch: MailboxRpc = async () => ({ body: { state: 'ready' } })) {
  let now = 0;
  let mailboxCalls = 0;
  let directoryWrites = 0;
  const hits: { binding: Binding; key: string }[] = [];
  const binding = (name: Binding) => {
    let window = -1;
    const counts = new Map<string, number>();
    return { async limit({ key }: { key: string }) {
      hits.push({ binding: name, key });
      if (now !== window) { window = now; counts.clear(); }
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limits[name] };
    } };
  };
  const env: MailApiEnvironment = {
    ...Object.fromEntries((Object.keys(limits) as Binding[]).map((name) => [name, binding(name)])),
    MAIL_LOCAL_API: 'on', MAIL_DRAFT_UPLOADS_ENABLED: 'on', MAIL_SEND_ENABLED: 'on',
    MAIL_DEV_SESSION: { resolve: async () => alice },
    MAIL_CONTENT_ENABLED: 'on', MAIL_CONTENT_ORIGIN: 'http://localhost:4179',
    MAIL_CONTENT: { async mintForWeb() { return { url: 'http://localhost:4179/v1/body/fake', expiresAt: 'never' }; } },
    DIRECTORY: {
      prepare(sql) {
        let args: (string | number | null)[] = [];
        return { bind(...values) { args = values; return this; }, async first<T>() {
          if (sql.includes('WHERE workspace_id = ? AND user_id = ?')) {
            return { id: `mailbox-${args[1]}`, primary_address: 'owner@example.test' } as T;
          }
          if (sql.includes('m.id = ?')) return { id: args[1], primary_address: 'owner@example.test' } as T;
          return null;
        }, async all<T>() { return { results: [] as T[] }; } };
      },
      async batch() { directoryWrites++; return []; },
    },
    MAILBOX: { getByName: () => {
      mailboxCalls++;
      return { mailApi: dispatch };
    } },
  };
  return { env, hits, afterPeriod: () => { now += period; }, mailboxCalls: () => mailboxCalls, directoryWrites: () => directoryWrites };
}

function request(op: Operation, params: Record<string, string> = {}, init: RequestInit = {}) {
  const { method, path } = ROUTES[op];
  const headers = new Headers({ origin, 'x-csrf-token': alice.csrfToken });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return new Request(`${origin}${API_PREFIX}${path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(params[name] ?? 'fixture-id'))}`,
    { ...init, method, headers });
}

function asUser(env: MailApiEnvironment, user: LocalPrincipal | null): MailApiEnvironment {
  return { ...env, MAIL_DEV_SESSION: { resolve: async () => user } };
}

async function expectProblem(response: Response, status: number, code: string) {
  const body = await response.json();
  assert.deepEqual([response.status, body.code], [status, code]);
  return body;
}

async function expectLimited(response: Response) {
  const body = await expectProblem(response, 429, 'rate_limited');
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
  assert.equal(response.headers.get('retry-after'), String(period));
  assert.equal(body.retryAfterSeconds, period);
  assert.equal(response.headers.get('idempotency-replayed'), null);
}

const bucketCases = [
  ['MAIL_RATE_READS', 'getSession', 200, undefined, bob, alice.userId],
  ['MAIL_RATE_WRITES', 'createDraft', 428, undefined, bob, alice.userId],
  ['MAIL_RATE_UPLOADS', 'createUpload', 428, undefined, bob, alice.userId],
  ['MAIL_RATE_SENDS', 'sendDraft', 428, undefined, bob, mailboxId(alice)],
  ['MAIL_RATE_UNDO', 'undoSend', 428, sendA, bob, JSON.stringify([mailboxId(alice), sendA.sendId])],
  ['MAIL_RATE_UNDO_FLOOD', 'undoSend', 404, undefined, bob, alice.userId],
  ['MAIL_RATE_ADMIN_WRITES', 'addDomain', 428, undefined, eve, alice.workspaceId],
] as const satisfies readonly [Binding, Operation, number, Record<string, string> | undefined, LocalPrincipal, string][];

for (const [binding, op, admittedStatus, params, other, key] of bucketCases) {
  test(`${binding} enforces its own threshold and leaves other scopes alone`, async () => {
    const { env, hits, mailboxCalls, directoryWrites } = fixture(async (_, __, operation) => operation === 'undoSend'
      ? { error: { code: 'not_found' } } : { body: { state: 'ready' } });
    const attempt = (i: number, user = alice) => handleMailApi(binding === 'MAIL_RATE_UNDO_FLOOD'
      ? request(op, { sendId: `absent-${i}` }, { headers: { 'idempotency-key': `undo-${i}` } }) : request(op, params), asUser(env, user));
    for (let i = 0; i < limits[binding]; i++) assert.equal((await attempt(i)).status, admittedStatus);
    const before = mailboxCalls();
    await expectLimited(await attempt(limits[binding]));
    assert.equal(mailboxCalls(), before);
    assert.equal(directoryWrites(), 0);
    assert.equal(hits.filter((hit) => hit.binding === binding && hit.key === key).length, limits[binding] + 1);
    if (binding === 'MAIL_RATE_ADMIN_WRITES') await expectLimited(await attempt(0, bob));
    assert.equal((await attempt(limits[binding], other)).status, admittedStatus);
  });
}

const missingCases: [Binding, Operation[]][] = [
  ['MAIL_RATE_READS', ['getSession', 'listViews', 'listThreads', 'getThread', 'listLabels', 'listIdentities', 'getSettings',
    'listDrafts', 'getDraft', 'getSend', 'listSends', 'listDomains', 'listMailboxes', 'listMembers']],
  ['MAIL_RATE_WRITES', ['updateThreads', 'getBodyUrl', 'getAttachmentUrl', 'createLabel', 'renameLabel', 'deleteLabel',
    'updateSettings', 'createDraft', 'replaceDraft', 'deleteDraft', 'deleteUpload']],
  ['MAIL_RATE_UPLOADS', ['createUpload']],
  ['MAIL_RATE_SENDS', ['sendDraft']],
  ['MAIL_RATE_UNDO', ['undoSend']],
  ['MAIL_RATE_UNDO_FLOOD', ['undoSend']],
  ['MAIL_RATE_ADMIN_WRITES', ['addDomain', 'createMailbox', 'updateMailbox', 'createAlias', 'deleteAlias']],
];
for (const [binding, ops] of missingCases) {
  test(`${binding} is required on ${ops.join(', ')}`, async () => {
    const { env, hits, mailboxCalls, directoryWrites } = fixture();
    const missing = { ...env, [binding]: undefined, MAIL_RATE_LIMITS_ENABLED: 'off' };
    for (const op of ops) await expectProblem(await handleMailApi(request(op), missing), 503, 'unavailable');
    assert.equal(mailboxCalls(), 0);
    assert.equal(directoryWrites(), 0);
    assert.deepEqual(hits, []);
  });
}

test('a malformed binding response or a binding error fails closed without leaking details', async () => {
  for (const value of [{}, { async limit() { return { success: 'true' }; } },
    { async limit() { throw new Error('internal fixture detail'); } },
    { get limit() { throw new Error('internal fixture detail'); } }]) {
    const { env, mailboxCalls } = fixture();
    const response = await handleMailApi(request('getSession'), { ...env, MAIL_RATE_READS: value as unknown as MailApiEnvironment['MAIL_RATE_READS'] });
    const body = await expectProblem(response, 503, 'unavailable');
    assert.doesNotMatch(JSON.stringify(body), /internal fixture detail/);
    assert.equal(mailboxCalls(), 0);
  }
});

test('only bucket and count are logged for a denied request', async (t) => {
  const log = t.mock.method(console, 'warn', () => {});
  const { env } = fixture();
  const deny = { ...env, ...{ MAIL_RATE_UNDO: { async limit() { return { success: false }; } } } };
  await expectLimited(await handleMailApi(request('undoSend', sendA), deny));
  assert.deepEqual(log.mock.calls.map((call) => call.arguments), [[{ bucket: 'undo', count: 1 }]]);
});

test('authentication, CSRF, access, reauth and disabled features precede any limiting', async () => {
  const { env, hits, mailboxCalls } = fixture();
  const cases = [
    [request('getSession'), asUser(env, null), 401, 'unauthenticated'],
    [request('createDraft', {}, { headers: { 'x-csrf-token': 'wrong' } }), env, 403, 'csrf_failed'],
    [request('addDomain'), asUser(env, { ...alice, role: 'member' }), 403, 'forbidden'],
    [request('addDomain'), asUser(env, { ...alice, authTime: Date.now() - 601_000 }), 403, 'reauth_required'],
    [request('getDraft'), { ...env, DIRECTORY: { ...env.DIRECTORY!, prepare: () => ({ bind() { return this; }, async first() { return null; }, async all() { return { results: [] }; } }) } }, 403, 'forbidden'],
    [request('sendDraft'), { ...env, MAIL_SEND_ENABLED: undefined }, 501, 'not_implemented'],
    [request('createUpload'), { ...env, MAIL_DRAFT_UPLOADS_ENABLED: undefined }, 501, 'not_implemented'],
    [request('importFromDrive'), env, 501, 'feature_unavailable'],
    [request('getBodyUrl'), { ...env, MAIL_CONTENT: undefined }, 501, 'feature_unavailable'],
    [request('getAttachmentUrl'), { ...env, MAIL_CONTENT_ORIGIN: origin }, 501, 'feature_unavailable'],
  ] as const;
  const actual = [];
  for (const [req, config] of cases) {
    const response = await handleMailApi(req, config);
    actual.push([response.status, (await response.json()).code]);
  }
  assert.deepEqual(actual, cases.map(([, , status, code]) => [status, code]));
  assert.deepEqual(hits, []);
  assert.equal(mailboxCalls(), 0);
});

for (const [op, binding, type] of [['createDraft', 'MAIL_RATE_WRITES', 'application/json'], ['createUpload', 'MAIL_RATE_UPLOADS', 'application/octet-stream']] as const) {
  test(`denied ${op} does not validate headers, access the body or enter the mailbox key path`, async () => {
    const { env, mailboxCalls } = fixture();
    const deny = { ...env, [binding]: { async limit() { return { success: false }; } } };
    for (const key of ['valid-key', 'invalid key', undefined]) {
      let bodyAccesses = 0;
      const req = request(op, {}, { method: 'POST', headers: { 'content-type': type, ...(key && { 'idempotency-key': key }) }, body: 'fixture' });
      const body = req.body;
      Object.defineProperty(req, 'body', { get() { bodyAccesses++; return body; } });
      const response = await handleMailApi(req, deny);
      assert.deepEqual([response.status, bodyAccesses, req.bodyUsed, mailboxCalls()], [429, 0, false, 0]);
      await expectLimited(response);
    }
  });
}

test('a committed draft key is not replayed during throttling and still replays after the period', async () => {
  const committed = new Map<string, object>();
  const { env, afterPeriod, mailboxCalls } = fixture(async (_, __, ___, ____, _____, { idempotencyKey }) => {
    assert.ok(idempotencyKey);
    const prior = committed.get(idempotencyKey);
    if (prior) return { body: prior, replayed: true };
    const body = { id: 'committed-draft', revision: 'revision' };
    committed.set(idempotencyKey, body);
    return { body };
  });
  const create = () => handleMailApi(request('createDraft', {}, { headers: { 'idempotency-key': 'same-key' } }), env);
  for (let i = 0; i < limits.MAIL_RATE_WRITES - 1; i++) assert.equal((await handleMailApi(request('createDraft'), env)).status, 428);
  const first = await create();
  assert.equal(first.status, 201);
  const saved = await first.json();
  await expectLimited(await create());
  assert.equal(mailboxCalls(), 1);
  afterPeriod();
  const replay = await create();
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(await replay.json(), saved);
  assert.equal(committed.size, 1);
});

test('another pending send can be undone when sends and other per-send undo buckets are exhausted', async () => {
  const undoTargets: string[] = [];
  const { env, hits } = fixture(async (_, mb, op, params) => {
    assert.equal(mb, mailboxId(alice));
    if (op === 'sendDraft') return { body: { state: 'pending' } };
    assert.equal(op, 'undoSend');
    undoTargets.push(params.sendId);
    return params.sendId === 'pending-id' ? { body: { state: 'cancelled' } } : { error: { code: 'not_found' } };
  });
  const headers = { 'idempotency-key': 'fixture-key', 'if-match': 'fixture-rev' };
  const send = () => handleMailApi(request('sendDraft', {}, { headers }), env);
  const undo = (sendId: string) => handleMailApi(request('undoSend', { sendId }, { headers }), env);
  for (let i = 0; i < limits.MAIL_RATE_SENDS; i++) assert.equal((await send()).status, 202);
  await expectLimited(await send());
  for (const other of ['other/one', 'other:two']) {
    for (let i = 0; i < limits.MAIL_RATE_UNDO; i++) assert.equal((await undo(other)).status, 404);
    await expectLimited(await undo(other));
  }
  const pending = request('undoSend', { sendId: 'pending-id' }, { headers });
  const response = await handleMailApi(new Request(pending.url.replace('pending-id', '%70ending-id'), pending), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: 'cancelled' });
  assert.equal(undoTargets.at(-1), 'pending-id');
  assert.deepEqual(hits.at(-1), { binding: 'MAIL_RATE_UNDO', key: JSON.stringify([mailboxId(alice), 'pending-id']) });
});

test('a full 32-attachment compose workload uploads each file and saves every reference through the gateway', async () => {
  const uploaded = new Map<string, string>();
  const { env, hits } = fixture(async (_workspace, _mailbox, op, _params, _input, { httpWrite }) => {
    if (op === 'getSession') return { body: { state: 'ready' } };
    const body = new Response(httpWrite?.stream);
    if (op === 'createUpload') {
      const name = httpWrite?.query.find(([key]) => key === 'name')?.[1];
      assert.ok(name);
      const text = await body.text();
      uploaded.set(name, text);
      return { body: { id: name, name, type: httpWrite?.mediaType, size: text.length } satisfies Partial<Upload> };
    }
    assert.equal(op, 'createDraft');
    const draft: DraftInput = await body.json();
    const attachments = draft.attachments.map((ref) => {
      assert.equal(ref.kind, 'upload');
      assert.ok(uploaded.has(ref.uploadId));
      return { ...ref, name: ref.uploadId, type: 'text/plain', size: uploaded.get(ref.uploadId)!.length };
    });
    return { body: { ...draft, id: 'draft', revision: 'revision', attachments } satisfies Partial<Draft> };
  });
  const mail = createHttpMailService({ baseUrl: `${origin}${API_PREFIX}`, fetch: async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('origin', origin);
    return handleMailApi(new Request(url, { ...init, headers }), env);
  } });
  assert.equal(LIMITS.attachmentsPerMessage, 32);
  const files = Array.from({ length: LIMITS.attachmentsPerMessage }, (_, i) => [`file-${i}.txt`, `body-${i}`] as const);
  const attachments = await Promise.all(files.map(async ([name, text], i) => {
    const file = await mail.createUpload({ name, type: 'text/plain', bytes: new Blob([text]) }, { idempotencyKey: `upload-${i}` });
    return { kind: 'upload' as const, uploadId: file.id };
  }));
  const draft = await mail.createDraft({ from: 'owner@example.test', to: [], cc: [], bcc: [], subject: 'Attachments', body: '', attachments }, { idempotencyKey: 'draft-key' });
  assert.deepEqual(draft.attachments.map((attachment) => attachment.kind === 'upload' && attachment.uploadId),
    attachments.map(({ uploadId }) => uploadId));
  assert.deepEqual(uploaded, new Map(files));
  assert.equal(hits.filter(({ binding }) => binding === 'MAIL_RATE_UPLOADS').length, files.length);
});

test('only the local Wrangler config declares all seven namespaces and no config has an off switch', () => {
  const repo = new URL('../../../../', import.meta.url);
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0');
  const local = 'apps/web/wrangler.local.jsonc';
  const configs = tracked.filter((path) => /(?:^|\/)(?:wrangler\.[^/]+|\.env(?:\.[^/]+)?|\.dev\.vars(?:\.[^/]+)?)$/.test(path));
  assert.ok(configs.includes(local));
  for (const path of configs) {
    const source = readFileSync(new URL(path, repo), 'utf8');
    assert.doesNotMatch(source, /\b(?:MAIL_)?(?:RATE_?LIMITS?|THROTTL\w*)_(?:ENABLED|DISABLED|BYPASS|OFF)\b/i, path);
    if (path !== local) for (const binding of Object.keys(limits)) {
      assert.doesNotMatch(source, new RegExp(`\\b${binding}\\b`), path);
    }
  }
  const { config, error } = ts.parseConfigFileTextToJson(local, readFileSync(new URL(local, repo), 'utf8'));
  assert.equal(error, undefined);
  assert.deepEqual([config.workers_dev, config.preview_urls, config.vars.MAIL_LOCAL_API], [false, false, 'off']);
  assert.notEqual(config.vars.MAIL_SEND_ENABLED, 'on');
  assert.notEqual(config.vars.MAIL_DRAFT_UPLOADS_ENABLED, 'on');
  const buckets: { name: Binding; namespace_id: string; simple: { limit: number; period: number } }[] = config.ratelimits;
  assert.ok(buckets, 'expected configured rate limit bindings');
  assert.equal(buckets.length, Object.keys(limits).length);
  assert.equal(new Set(buckets.map(({ namespace_id }) => namespace_id)).size, buckets.length);
  for (const { namespace_id } of buckets) assert.match(namespace_id, /^\d+$/);
  assert.deepEqual(Object.fromEntries(buckets.map(({ name, simple }) => [name, simple])),
    Object.fromEntries(Object.entries(limits).map(([name, limit]) => [name, { limit, period }])));
});
