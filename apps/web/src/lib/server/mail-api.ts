import { API_PREFIX, LIMITS, ROUTES, MailApiError, problem } from '@kofra/mail-contract';
import type { ContentUrl, MailErrorCode, Member, Operation, Problem, RouteSpec, Session } from '@kofra/mail-contract';
import { contentFrameUrl, separateContentOrigin } from '../content-origin.ts';
import { Directory, type DirectoryDatabase } from './mail-directory.ts';

export interface LocalPrincipal {
  userId: string;
  name: string;
  workspaceId: string;
  role: 'member' | 'admin';
  authTime: number;
  credentialEpoch: number;
  csrfToken: string;
}
export interface ContentClaims {
  ws: string; mb: string; msg: string; sub: string; ep: number; ri?: boolean; part?: number;
}
export type OperationResult = {
  body?: unknown;
  status?: number;
  replayed?: boolean;
  error?: { code: MailErrorCode } & Pick<Partial<Problem>, 'errors' | 'limit' | 'retryAfterSeconds'>;
};
const rateBindings = {
  reads: 'MAIL_RATE_READS',
  writes: 'MAIL_RATE_WRITES',
  uploads: 'MAIL_RATE_UPLOADS',
  sends: 'MAIL_RATE_SENDS',
  undo: 'MAIL_RATE_UNDO',
  undo_flood: 'MAIL_RATE_UNDO_FLOOD',
  admin_writes: 'MAIL_RATE_ADMIN_WRITES',
} as const;
type RateBucket = keyof typeof rateBindings;
interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}
type RateLimitBindings = Partial<Record<(typeof rateBindings)[RateBucket], RateLimitBinding>>;

export interface MailApiEnvironment extends RateLimitBindings {
  MAIL_LOCAL_API?: string;
  MAIL_DRAFT_UPLOADS_ENABLED?: string;
  MAIL_SEND_ENABLED?: string;
  MAIL_DEV_SESSION?: {
    resolve(request: Request): Promise<LocalPrincipal | null>;
    members?(workspaceId: string): Promise<Omit<Member, 'hasMailbox'>[]>;
  };
  DIRECTORY?: DirectoryDatabase;
  MAILBOX?: { getByName(name: string): {
    mailApi(ws: string, mb: string, operation: Operation, params: Record<string, string>, input: unknown,
      options: { idempotencyKey?: string; ifMatch?: string; canSendAs: string[]; cursorScope?: string; userId?: string;
        httpWrite?: { stream: ReadableStream<Uint8Array> | null; mediaType: string; contentLength: string | null;
          query: [string, string][] } }): Promise<OperationResult>;
  } };
  MAIL_CONTENT_ENABLED?: string;
  MAIL_CONTENT_ORIGIN?: string;
  MAIL_CONTENT?: { mintForWeb(purpose: 'body' | 'att', claims: ContentClaims): Promise<ContentUrl> };
}

const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const m3 = new Set<Operation>(['sendDraft', 'listSends', 'getSend', 'undoSend']);
const uploads = new Set<Operation>(['createUpload', 'deleteUpload']);
const drive = new Set<Operation>(['saveAttachmentToDrive', 'importFromDrive']);
const matchers = (Object.entries(ROUTES) as [Operation, RouteSpec][]).map(([op, route]) => ({
  op, route, pattern: new RegExp(`^${API_PREFIX}${route.path.replace(/\{([A-Za-z]+)\}/g, '(?<$1>[^/]+)')}$`),
}));
// Keep this in sync with the local Wrangler namespaces' configured period.
const rateLimitPeriodSeconds = 60;
const keyPattern = /^[A-Za-z0-9_-]{1,64}$/;
const jsonFields: Partial<Record<Operation, readonly string[]>> = {
  updateThreads: ['ids', 'set'], getBodyUrl: ['remoteImages'],
  createLabel: ['name'], renameLabel: ['name'], updateSettings: ['signature', 'defaultFrom', 'undoSeconds', 'replyFromReceivedAddress'],
  createDraft: ['from', 'to', 'cc', 'bcc', 'subject', 'body', 'attachments', 'inReplyTo', 'forwardOf'],
  addDomain: ['name', 'kind', 'aliasOf'], createMailbox: ['primaryAddress', 'displayName', 'ownerUserId'],
  updateMailbox: ['displayName', 'ownerUserId'], createAlias: ['mailboxId', 'address', 'sendAs'],
};
jsonFields.replaceDraft = jsonFields.createDraft;

export function fail(code: MailErrorCode, extra: Omit<Partial<Problem>, 'code' | 'status' | 'type'> = {}): never {
  throw new MailApiError(problem(code, extra));
}

function rateBinding(env: MailApiEnvironment, bucket: RateBucket): RateLimitBinding {
  try {
    const binding = env[rateBindings[bucket]];
    if (typeof binding?.limit === 'function') return binding;
  } catch {
    // An unusable binding must not admit a request or expose its error.
  }
  return fail('unavailable');
}

async function checkRate(binding: RateLimitBinding, bucket: RateBucket, key: string): Promise<void> {
  let success: unknown;
  try {
    success = (await binding.limit({ key }))?.success;
  } catch {
    fail('unavailable');
  }
  if (success === true) return;
  if (success !== false) fail('unavailable');
  console.warn({ bucket, count: 1 });
  fail('rate_limited', { retryAfterSeconds: rateLimitPeriodSeconds });
}

function parsePath(pattern: RegExp, pathname: string): Record<string, string> {
  const raw = pattern.exec(pathname)?.groups ?? {};
  try { return Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, decodeURIComponent(value)])); }
  catch { return fail('not_found'); }
}

const pageQuery = (key: string, value: string): unknown => {
  if (key !== 'limit') return value;
  if (!/^\d{1,3}$/.test(value)) fail('invalid_request', { errors: [{ field: '/limit', code: 'invalid' }] });
  const limit = Number(value);
  if (limit < 1 || limit > LIMITS.pageSizeMax) fail('invalid_request', { errors: [{ field: '/limit', code: 'invalid' }] });
  return limit;
};

function parseQuery(url: URL, route: RouteSpec): Record<string, unknown> {
  // Only route-approved keys are set. A plain object is required by DO RPC.
  const result: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (!route.query.includes(key)) fail('unknown_field');
    if (Object.hasOwn(result, key)) fail('invalid_request', { errors: [{ field: `/${key}`, code: 'invalid' }] });
    result[key] = pageQuery(key, value);
  }
  return result;
}

async function readJson(request: Request, op: Operation): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') fail('unsupported_media_type');
  // JSON may use six-byte escape sequences for one byte of draft text.
  const max = LIMITS.bodyBytes * 6 + 512 * 1024;
  if (Number(request.headers.get('content-length')) > max) fail('payload_too_large', { limit: max });
  if (!request.body) fail('invalid_request');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let text = '';
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        void reader.cancel().catch(() => {});
        fail('payload_too_large', { limit: max });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const input: unknown = JSON.parse(text);
    // Only decode here: the mailbox checks the resource and revision before
    // inspecting any replacement fields (including the top-level shape).
    if (op === 'replaceDraft') return input as Record<string, unknown>;
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_request');
    const fields = jsonFields[op];
    // A committed key is resolved by the datastore before field validation.
    if (ROUTES[op].idempotency !== 'required' && fields && Object.keys(input).some((key) => !fields.includes(key))) fail('unknown_field');
    return input as Record<string, unknown>;
  } catch (error) {
    if (error instanceof MailApiError) throw error;
    return fail('invalid_request');
  } finally {
    reader.releaseLock();
  }
}

export async function handleMailApi(request: Request, env: MailApiEnvironment = {}): Promise<Response> {
  const headers = new Headers({ 'cache-control': 'no-store', 'x-request-id': crypto.randomUUID(), 'x-content-type-options': 'nosniff' });
  const respond = (body: unknown, status: number) => {
    if (status === 204) return new Response(null, { status, headers });
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(body), { status, headers });
  };
  try {
    const url = new URL(request.url);
    if (env.MAIL_LOCAL_API !== 'on' || !loopback.has(url.hostname) || !env.MAIL_DEV_SESSION) fail('not_found');
    const origin = request.headers.get('origin');
    if (request.method === 'GET' && origin && origin !== url.origin) fail('forbidden');
    const matched = matchers.find(({ route, pattern }) => request.method === route.method && pattern.test(url.pathname));
    if (!matched) fail('not_found');
    const { route, op, pattern } = matched;
    const principal = await env.MAIL_DEV_SESSION.resolve(request);
    if (!principal) fail('unauthenticated');
    if (request.method !== 'GET' && (origin !== url.origin || !principal.csrfToken || request.headers.get('x-csrf-token') !== principal.csrfToken)) fail('csrf_failed');
    if (route.access === 'admin' && principal.role !== 'admin') fail('forbidden');
    if (route.reauth && Date.now() - principal.authTime > 600_000) fail('reauth_required', { maxAgeSeconds: 600 });
    if (!env.DIRECTORY || !env.MAILBOX) fail('unavailable');
    const directory = new Directory(env.DIRECTORY, principal.workspaceId, env.MAIL_DEV_SESSION.members?.bind(env.MAIL_DEV_SESSION));
    const mailbox = await directory.byUser(principal.userId);
    if (route.access !== 'admin' && op !== 'getSession' && !mailbox) fail('forbidden');
    const sendEnabled = env.MAIL_SEND_ENABLED === 'on';
    if ((m3.has(op) && !sendEnabled) || (uploads.has(op) && env.MAIL_DRAFT_UPLOADS_ENABLED !== 'on')) fail('not_implemented');
    if (drive.has(op)) fail('feature_unavailable');
    const contentOrigin = env.MAIL_CONTENT_ENABLED === 'on' ? separateContentOrigin(env.MAIL_CONTENT_ORIGIN, url, true) : undefined;
    const content = contentOrigin ? env.MAIL_CONTENT : undefined;
    const contentUrl = op === 'getBodyUrl' || op === 'getAttachmentUrl';
    if (contentUrl && !content) fail('feature_unavailable');

    let undoParams: Record<string, string> | undefined;
    if (op === 'sendDraft' || op === 'undoSend') {
      if (!mailbox) fail('forbidden');
      if (op === 'sendDraft') await checkRate(rateBinding(env, 'sends'), 'sends', mailbox.id);
      else {
        // Require both bindings up front. Check the flood guard before allocating a counter for a send id.
        const undo = rateBinding(env, 'undo');
        await checkRate(rateBinding(env, 'undo_flood'), 'undo_flood', principal.userId);
        undoParams = parsePath(pattern, url.pathname);
        await checkRate(undo, 'undo', JSON.stringify([mailbox.id, undoParams.sendId]));
      }
    } else {
      const bucket = route.method === 'GET' ? 'reads' : route.access === 'admin' ? 'admin_writes'
        : op === 'createUpload' ? 'uploads' : 'writes';
      await checkRate(rateBinding(env, bucket), bucket, bucket === 'admin_writes' ? principal.workspaceId : principal.userId);
    }

    const idempotencyKey = request.headers.get('idempotency-key') ?? undefined;
    const ifMatch = request.headers.get('if-match') ?? undefined;
    if ((route.idempotency === 'required' && !idempotencyKey) || (route.ifMatch === 'required' && !ifMatch)) fail('precondition_required');
    if (idempotencyKey !== undefined && !keyPattern.test(idempotencyKey)) fail('invalid_request', { errors: [{ field: '/Idempotency-Key', code: 'invalid' }] });
    if (ifMatch !== undefined && !keyPattern.test(ifMatch)) fail('invalid_request', { errors: [{ field: '/If-Match', code: 'invalid' }] });
    // Mailbox creates reserve their key inside the mailbox before consuming
    // the HTTP body or validating operation-specific query fields.
    const keyedMailbox = op === 'createDraft' || op === 'createLabel' || op === 'createUpload';
    const httpWrite = keyedMailbox ? { stream: request.body, mediaType: request.headers.get('content-type') ?? '',
      contentLength: request.headers.get('content-length'), query: [...url.searchParams] } : undefined;
    const query = httpWrite ? {} : parseQuery(url, route);
    const params = undoParams ?? parsePath(pattern, url.pathname);
    const input = !httpWrite && route.body === 'json' ? await readJson(request, op) : query;
    if (op === 'getBodyUrl' && (!('remoteImages' in input) || typeof input.remoteImages !== 'boolean')) fail('invalid_request', { errors: [{ field: '/remoteImages', code: 'invalid' }] });

    let result: OperationResult;
    if (route.access === 'admin') {
      result = await directory.run(op, params, input, idempotencyKey);
    } else if (op === 'listIdentities' && mailbox) {
      result = { body: { items: await directory.identities(mailbox.id) } };
    } else {
      if (mailbox) {
        const draftWrite = op === 'createDraft' || op === 'replaceDraft';
        const canSendAs = draftWrite || op === 'sendDraft' || op === 'getSettings' || op === 'updateSettings'
          ? (await directory.identities(mailbox.id)).filter((identity) => draftWrite || identity.sendAs === 'active').map((identity) => identity.email) : [];
        result = await env.MAILBOX.getByName(JSON.stringify([principal.workspaceId, mailbox.id])).mailApi(
          principal.workspaceId, mailbox.id, op,
          { ...Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])), ...params }, input,
          { idempotencyKey, ifMatch, canSendAs, cursorScope: principal.userId, userId: principal.userId, ...(httpWrite && { httpWrite }) },
        );
      } else result = { body: { state: 'unprovisioned' } };
      if (!result.error && op === 'getSession') {
        const session: Session = {
          user: { id: principal.userId, name: principal.name }, mailbox: mailbox ? { id: mailbox.id, primaryAddress: mailbox.primary_address } : undefined,
          workspace: { id: principal.workspaceId, role: principal.role }, csrfToken: principal.csrfToken,
          authTime: new Date(principal.authTime).toISOString(), limits: LIMITS,
          features: { drive: false, htmlContent: Boolean(content), m3: sendEnabled },
          state: (result.body as { state: string }).state,
        };
        result = { body: session };
      }
      if (!result.error && mailbox && contentUrl && content) {
        const value = await content.mintForWeb(op === 'getBodyUrl' ? 'body' : 'att', {
          ws: principal.workspaceId, mb: mailbox.id, msg: params.messageId,
          sub: principal.userId, ep: principal.credentialEpoch,
          ...(op === 'getBodyUrl' ? { ri: input.remoteImages as boolean } : { part: Number(params.part) }),
        });
        const signedUrl = contentFrameUrl(value.url, contentOrigin);
        if (!signedUrl) fail('unavailable');
        result = { body: { url: signedUrl, expiresAt: value.expiresAt } };
      }
    }
    if (result.error) {
      const { code, ...fields } = result.error;
      fail(code, fields);
    }
    if (result.replayed) headers.set('idempotency-replayed', 'true');
    if (result.status !== undefined && result.status !== route.success) fail('unavailable');
    return respond(result.body, result.status ?? route.success);
  } catch (error) {
    const value = error instanceof MailApiError ? error.problem : problem('internal');
    if (value.retryAfterSeconds !== undefined || value.status === 429 || value.status === 503) headers.set('retry-after', String(value.retryAfterSeconds ?? 1));
    headers.set('content-type', 'application/problem+json');
    return new Response(JSON.stringify({ ...value, ...((value.status === 429 || value.status === 503) && value.retryAfterSeconds === undefined ? { retryAfterSeconds: 1 } : {}), requestId: headers.get('x-request-id') }), { status: value.status, headers });
  }
}
