import { ulid } from 'ulid';
import { LIMITS } from '../../../../contracts/mail-api/src/index.ts';
import type { Member } from '../../../../contracts/mail-api/src/wire.ts';
import { handleMailApi, type ContentClaims, type LocalPrincipal, type MailApiEnvironment } from '../../../../apps/web/src/lib/server/mail-api.ts';
import { deliver } from '../../src/deliver.ts';
import { lookupRecipient } from '../../src/directory.ts';
import { receive } from '../../src/inbound.ts';
import { kofra } from '../../src/kofra.ts';
import { Mailbox } from '../../src/mailbox-do.ts';
import { Outbox } from '../../src/outbox.ts';
import { Sweeper } from '../../src/sweeper-do.ts';
import { mailboxName, type Env as BackendEnv } from '../../src/worker.ts';

// Only this test bundle exposes fixture provisioning or accepts a chosen principal.
export interface FixturePrincipal {
  userId: string; name: string; ws: string; role: 'member' | 'admin'; stale?: boolean;
  mailboxId?: string; address: string; status?: Member['status'];
}
interface FixtureEnv extends Omit<BackendEnv, 'MAILBOX'> {
  MAILBOX: DurableObjectNamespace<HttpMailbox>;
  ACCOUNTS: Record<string, FixturePrincipal>;
  DEFAULT_ACCOUNT?: string;
  CSRF_KEY: string;
  INITIAL_TIME: number;
  CONTROL_KEY: string;
  CONTENT_PORT?: string;
}

const encoder = new TextEncoder();
let time: number | undefined;
let signingKey: Promise<CryptoKey> | undefined;
function key(env: FixtureEnv) {
  return signingKey ??= crypto.subtle.importKey('raw', encoder.encode(env.CONTROL_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const de64 = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
function now(env: FixtureEnv) { return time ?? (env.DEFAULT_ACCOUNT ? Date.now() : env.INITIAL_TIME); }

export class HttpMailbox extends Mailbox {
  protected mailApiNow() { return now(this.env as FixtureEnv); }
  advanceClock(value: number) { time = value; }
  delivered(id: string) {
    const row = this.ctx.storage.sql.exec<{ thread_id: string }>('SELECT thread_id FROM messages WHERE id = ?', id).toArray()[0];
    if (!row) throw new Error('Fixture message was not indexed');
    return { threadId: row.thread_id, messageId: id };
  }
}
export { Sweeper };

const signedBytes = (purpose: string, payload: string) => encoder.encode(`kofra-mail-content/v1\n${purpose}\n${payload}`);
function contentOrigin(url: URL, env: FixtureEnv) { return `http://localhost:${env.CONTENT_PORT || url.port}`; }
async function mint(origin: string, purpose: 'body' | 'att', claims: ContentClaims, env: FixtureEnv) {
  const iat = Math.round(now(env) / 1000), exp = iat + LIMITS.contentUrlSeconds;
  const payload = b64(encoder.encode(JSON.stringify({ v: 1, ...claims, iat, exp })));
  const mac = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), signedBytes(purpose, payload))));
  return { url: `${origin}/v1/${purpose}/fixture.${payload}.${mac}`, expiresAt: new Date(exp * 1000).toISOString() };
}
const missing = () => new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
const escape = (text: string) => text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!);

async function content(url: URL, env: FixtureEnv): Promise<Response> {
  if (url.pathname === '/healthz') return new Response(null);
  if (url.pathname === '/fixture-image.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>', { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } });
  const match = /^\/v1\/(body|att)\/fixture\.([A-Za-z0-9_-]{1,5462})\.([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  if (!match) return missing();
  try {
    const [, purpose, payload, mac] = match;
    if (!await crypto.subtle.verify('HMAC', await key(env), de64(mac), signedBytes(purpose, payload))) return missing();
    const claims: ContentClaims & { v: number; iat: number; exp: number } = JSON.parse(new TextDecoder().decode(de64(payload)));
    if (claims.v !== 1 || claims.ep !== 1 || now(env) >= claims.exp * 1000) return missing();
    const owner = await env.DIRECTORY.prepare('SELECT user_id FROM mailboxes WHERE workspace_id = ? AND id = ?').bind(claims.ws, claims.mb).first<string>('user_id');
    if (owner !== claims.sub) return missing();
    const result = await env.MAILBOX.getByName(mailboxName(claims.ws, claims.mb)).mailContent(claims.ws, claims.mb, claims.msg, claims.part);
    if (result.error || !result.body) return missing();
    const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
    if (purpose === 'att' && 'stream' in result.body) {
      headers.set('content-type', 'application/octet-stream');
      headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.body.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`);
      return new Response(result.body.stream, { headers });
    }
    if (!('text' in result.body) && !('html' in result.body)) return missing();
    // The fixture never evaluates or sends user HTML. It renders safe text and one
    // static local image for the browser's sandbox/opt-in-image acceptance checks.
    const body = result.body.html === undefined
      ? (result.body.text ?? '') : result.body.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const image = claims.ri && result.body.html?.includes('demo-floor-plan') ? '<img alt="Demo floor plan" src="/fixture-image.svg">' : '';
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.set('content-security-policy', "default-src 'none'; img-src 'self'; sandbox");
    return new Response(`<!DOCTYPE html><html lang="en"><title>Message preview</title><main><p>${escape(body)}</p>${image}</main></html>`, { headers });
  } catch { return missing(); }
}

async function incoming(req: Request, env: FixtureEnv, to: string, from: string): Promise<Response> {
  const bytes = await req.arrayBuffer();
  let delivery: string | undefined;
  const insert = new Outbox(env.DIRECTORY);
  await receive({ to, from, rawSize: bytes.byteLength, raw: new Response(bytes).body!, setReject: () => { throw new Error('Unknown fixture recipient'); } }, {
    lookup: (address) => lookupRecipient(env.DIRECTORY, address),
    register: (ws, digest, id) => env.SWEEPER.getByName(ws).register('raw', digest, `delivery:${id}`),
    put: (ws, key, data) => kofra(env, ws).put(key, data),
    insert: (row) => insert.insert(row),
    send: async (id) => { delivery = id; },
    newId: ulid, now: () => now(env),
  });
  if (!delivery) throw new Error('No fixture delivery was queued');
  const row = await insert.get(delivery);
  if (!row) throw new Error('No fixture outbox record');
  await deliver(delivery, {
    outbox: insert,
    index: (ws, mb, id) => env.MAILBOX.getByName(mailboxName(ws, mb)).deliver(id),
    release: (ws, rawKey, id) => env.SWEEPER.getByName(ws).release(rawKey, `delivery:${id}`),
    now: () => now(env),
  }, delivery);
  const box = env.MAILBOX.getByName(mailboxName(row.workspaceId, row.mailboxIds[0]));
  return Response.json(await box.delivered(delivery));
}

export default {
  async fetch(req: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.hostname === 'localhost') return content(url, env);
    if (url.hostname !== '127.0.0.1') return missing();
    if (url.pathname === '/healthz') return new Response(null);
    if (url.pathname.startsWith('/__fixture/')) {
      if (req.method !== 'POST' || req.headers.get('x-fixture-control') !== env.CONTROL_KEY) return missing();
      if (url.pathname === '/__fixture/deliver') return incoming(req, env, req.headers.get('x-fixture-to')!, req.headers.get('x-fixture-from')!);
      if (url.pathname === '/__fixture/advance') {
        const delta = Number(await req.text());
        if (!Number.isSafeInteger(delta) || delta < 0) return new Response(null, { status: 400 });
        time = now(env) + delta;
        const { results } = await env.DIRECTORY.prepare('SELECT id, workspace_id FROM mailboxes').all<{ id: string; workspace_id: string }>();
        await Promise.all(results.map(({ workspace_id, id }) => env.MAILBOX.getByName(mailboxName(workspace_id, id)).advanceClock(time!)));
        return new Response(null, { status: 204 });
      }
      return missing();
    }
    const authKey = await crypto.subtle.importKey('raw', encoder.encode(env.CSRF_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const resolve = async (request: Request): Promise<LocalPrincipal | null> => {
      const account = request.headers.get('x-fixture-account') ?? env.DEFAULT_ACCOUNT;
      const principal = account && Object.hasOwn(env.ACCOUNTS, account) ? env.ACCOUNTS[account] : undefined;
      if (!principal) return null;
      return { userId: principal.userId, name: principal.name, workspaceId: principal.ws, role: principal.role, credentialEpoch: 1,
        authTime: (env.DEFAULT_ACCOUNT ? Date.now() : env.INITIAL_TIME) - (principal.stale ? 660_000 : 0),
        csrfToken: b64(new Uint8Array(await crypto.subtle.sign('HMAC', authKey, encoder.encode(account!)))), };
    };
    const port: MailApiEnvironment = {
      MAIL_LOCAL_API: 'on', MAILBOX: env.MAILBOX, DIRECTORY: env.DIRECTORY,
      MAIL_DEV_SESSION: { resolve, members: async (ws) => [...new Map(Object.values(env.ACCOUNTS).filter((p) => p.ws === ws).map((p) => [p.userId, p])).values()]
        .map((p) => ({ id: p.userId, name: p.name, email: p.address, status: p.status ?? 'active' })) },
      MAIL_CONTENT_ORIGIN: contentOrigin(url, env),
      MAIL_CONTENT: { mint: (purpose, claims) => mint(contentOrigin(url, env), purpose, claims, env) },
    };
    return handleMailApi(req, port);
  },
};
