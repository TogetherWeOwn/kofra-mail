import { ulid } from 'ulid';
import { LIMITS } from '../../../../contracts/mail-api/src/index.ts';
import type { Member } from '../../../../contracts/mail-api/src/wire.ts';
import { handleMailApi, type ContentClaims, type LocalPrincipal, type MailApiEnvironment } from '../../../../apps/web/src/lib/server/mail-api.ts';
import { deliver } from '../../src/deliver.ts';
import { lookupRecipient } from '../../src/directory.ts';
import { receive } from '../../src/inbound.ts';
import { kofra } from '../../src/kofra.ts';
import { Mailbox } from '../../src/mailbox-do.ts';
import { MailboxIndex } from '../../src/mailbox-index.ts';
import { JOURNAL_FLUSH, JOURNAL_FLUSH_REF, TIMER_HANDLER_BUDGET_MS, TimerTable, type TimerKind, type TimerRun } from '../../src/mailbox-timers.ts';
import { journalPrefix } from '../../src/journal-backup.ts';
import { Outbox } from '../../src/outbox.ts';
import { Sweeper as MailSweeper } from '../../src/sweeper-do.ts';
import { SweepLedger, type ConfirmEntry } from '../../src/sweep-ledger.ts';
import { mailboxName, type Env as BackendEnv } from '../../src/worker.ts';

// Only this test bundle exposes fixture provisioning or accepts a chosen principal.
export interface FixturePrincipal {
  userId: string; name: string; ws: string; role: 'member' | 'admin'; stale?: boolean;
  mailboxId?: string; address: string; status?: Member['status'];
}
interface FixtureEnv extends Omit<BackendEnv, 'MAILBOX'> {
  MAILBOX: DurableObjectNamespace<HttpMailbox>;
  SWEEPER: DurableObjectNamespace<Sweeper>;
  ACCOUNTS: Record<string, FixturePrincipal>;
  DEFAULT_ACCOUNT?: string;
  CSRF_KEY: string;
  INITIAL_TIME: number;
  CONTROL_KEY: string;
  CONTENT_PORT?: string;
  MAIL_DRAFT_UPLOADS_ENABLED?: string;
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
  private pauseKind?: string;
  private resumeExpiry?: PromiseWithResolvers<void>;
  private expiryCompletion?: PromiseWithResolvers<void>;
  private startedExpiry = 0;
  private failPublish = false;
  private failAlert = false;
  private realtimeHolderClock = false;
  private readonly emittedAlerts: string[] = [];

  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    let mailbox: HttpMailbox;
    const state = new Proxy(env.MAIL_STATE, { get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property === 'put') return (...args: Parameters<R2Bucket['put']>) => {
        if (mailbox.failPublish) throw new Error('Fixture publish failure');
        return target.put(...args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    let flag: string | undefined;
    try { flag = ctx.storage.sql.exec<{ flag: string }>('SELECT flag FROM fixture_upload_switch').toArray()[0]?.flag; }
    catch { /* no fixture override before the first toggle */ }
    super(ctx, { ...env, MAIL_STATE: state, MAIL_DRAFT_UPLOADS_ENABLED: flag ?? env.MAIL_DRAFT_UPLOADS_ENABLED,
      ALERTS: { fetch: async (input, init) => {
        const { source } = await new Request(input, init).json<{ source: string }>();
        if (mailbox.failAlert) return new Response(null, { status: 503 });
        mailbox.emittedAlerts.push(source);
        return new Response(null, { status: 204 });
      } } });
    mailbox = this;
  }
  publishFailure(failing: boolean) { this.failPublish = failing; }
  pauseExpiry(kind: string) {
    if (this.pauseKind) throw new Error('An expiry pause is already armed');
    this.pauseKind = kind;
    this.timerHandlerBudgetMs = 25;
    this.startedExpiry = 0;
  }
  expiryStarts() { return this.startedExpiry; }
  async finishExpiry() {
    if (!this.resumeExpiry) throw new Error('No expiry handler paused');
    this.resumeExpiry.resolve();
    try { await this.expiryCompletion?.promise; }
    finally {
      this.resumeExpiry = undefined;
      this.expiryCompletion = undefined;
      this.pauseKind = undefined;
      this.timerHandlerBudgetMs = TIMER_HANDLER_BUDGET_MS;
    }
  }
  protected override registerTimerKind(kind: string, handler: TimerKind) {
    super.registerTimerKind(kind, { ...handler, run: async timer => {
      if (kind === this.pauseKind) this.startedExpiry++;
      if (kind !== this.pauseKind || this.resumeExpiry) return handler.run(timer);
      const resume = this.resumeExpiry = Promise.withResolvers<void>();
      const done = this.expiryCompletion = Promise.withResolvers<void>();
      let first = true;
      const local = (async (step: Parameters<TimerRun['local']>[0]) => {
        const value = await timer.local(step);
        if (first) { first = false; await resume.promise; }
        return value;
      }) as TimerRun['local'];
      void done.promise.catch(() => {});
      try { await handler.run({ ...timer, local }); done.resolve(); }
      catch (error) { done.reject(error); throw error; }
    } });
  }
  eventCount(type: string) {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM journal WHERE json_extract(event, '$.type') = ?", type).one().n;
  }
  protected mailApiNow() { return now(this.env as FixtureEnv); }
  async advanceClock(value: number, alarms = 0) {
    time = value;
    if (alarms) await this.testAlarm(alarms);
  }
  async testAlarm(runs = 1) {
    const actual = Date.now;
    const start = actual(), simulated = this.mailApiNow();
    Date.now = this.pauseKind || this.realtimeHolderClock ? () => simulated + actual() - start : () => simulated;
    try { await Promise.all(Array.from({ length: runs }, () => this.alarm())); }
    finally { Date.now = actual; }
  }
  timers() {
    return this.ctx.storage.sql.exec('SELECT kind, ref, due_at FROM timers ORDER BY kind, ref').toArray();
  }
  pendingReleases() {
    return this.ctx.storage.sql.exec('SELECT seq, object_key, holder FROM mailbox_pending_releases ORDER BY seq, object_key, holder').toArray();
  }
  releaseRetryAt() {
    return this.ctx.storage.sql.exec<{ at: number | null }>('SELECT max(retry_at) AS at FROM mailbox_pending_releases').one().at;
  }
  shortenHolderBudget() { this.holderIoBudgetMs = 200; this.realtimeHolderClock = true; }
  expireUploadLease(key: string) {
    this.ctx.storage.sql.exec('UPDATE mailbox_api_in_progress SET expires_at = 0 WHERE key = ?', key);
  }
  hasIdempotency(key: string) {
    return this.ctx.storage.sql.exec('SELECT 1 FROM mailbox_api_idempotency WHERE key = ?', key).toArray().length === 1;
  }
  alerts() { return this.emittedAlerts; }
  alertFailure(failing: boolean) { this.failAlert = failing; }
  confirmations() {
    return this.ctx.storage.sql.exec('SELECT seq, object_key, holder FROM mailbox_pending_confirmations ORDER BY seq, object_key, holder').toArray();
  }
  private fixtureIndex(ws: string) {
    const refs = this.env.SWEEPER.getByName(ws);
    const objects = { ...kofra(this.env, ws),
      register: (kind: 'raw' | 'att', digest: string, holder: string) => refs.register(kind, digest, holder),
      holdProvisional: (...args: Parameters<MailSweeper['holdProvisional']>) => refs.holdProvisional(...args),
      hold: (key: string, holder: string) => refs.hold(key, holder), release: (key: string, holder: string) => refs.release(key, holder) };
    return new MailboxIndex(this.ctx.storage, objects, this.ctx.id.toString(), true);
  }
  async stageAndCrash(ws: string, marker: string) {
    await this.fixtureIndex(ws).prepareApiDraft(crypto.randomUUID(), new Uint8Array(encoder.encode('uncommitted fixture')), this.mailApiNow());
    await this.ctx.storage.put('fixtureStageCrash', marker);
    await this.ctx.storage.sync();
    this.ctx.abort();
  }
  async reachedStageCrash(marker: string) { return await this.ctx.storage.get('fixtureStageCrash') === marker; }
  async persistMaximumHolder(ws: string, draftKey: string) {
    const id = crypto.randomUUID();
    const holder = `draft:${'x'.repeat(250)}`;
    await this.env.SWEEPER.getByName(ws).holdProvisional({ key: draftKey }, holder);
    const index = this.fixtureIndex(ws);
    index.changeMany([{ type: 'draft', id, rawKey: draftKey, holder, revision: crypto.randomUUID(), updatedAt: this.mailApiNow(),
      uploadIds: [], attachmentKeys: [] }]);
    index.changeMany([{ type: 'draft_delete', id, deferRelease: true }]);
    return holder;
  }
  async purgeTrash(ws: string) {
    return this.workLane(async () => {
      const index = this.fixtureIndex(ws);
      // M2 expiry hides rows by timestamp; the existing physical purge selects
      // the legacy Trash label. Mark only the expired fixture rows for purge.
      index.setLabel('trash', 'Trash');
      const expired = this.ctx.storage.sql.exec<{ id: string; flags: number }>(`SELECT m.id, m.flags FROM messages m
        JOIN mailbox_api_expiry e ON e.id = m.id WHERE e.expires_at <= ?`, this.mailApiNow()).toArray();
      for (const { id, flags } of expired) index.setFlags(id, flags, ['trash']);
      return index.emptyTrash();
    });
  }
  async changeUploadSwitch(enabled: boolean) {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_upload_switch (id INTEGER PRIMARY KEY, flag TEXT NOT NULL)');
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO fixture_upload_switch VALUES (1, ?)', enabled ? 'on' : 'off');
    await this.ctx.storage.sync();
    this.ctx.abort();
  }
  async forceSnapshot(): Promise<boolean> {
    await this.workLane(async () => {
      this.ctx.storage.sql.exec("UPDATE lifecycle SET value = json_set(value, '$.nextSnapshotAt', 0) WHERE id = 1");
      new TimerTable(this.ctx.storage.sql).lower(JOURNAL_FLUSH, JOURNAL_FLUSH_REF, this.mailApiNow());
    });
    await this.testAlarm();
    const stored = await this.env.MAIL_STATE.get(`${journalPrefix(this.ctx.id.toString())}manifest.json`);
    const backup = stored && await stored.json<{ snapshot_key: string | null; delta_keys: string[] }>();
    return !!backup && backup.snapshot_key !== null && backup.delta_keys.length === 0;
  }
  async restoreFixture(ws: string, mb: string) {
    await this.ctx.storage.deleteAll();
    await this.restoreFromBackup(ws, mb);
    await this.testAlarm();
  }
  delivered(id: string) {
    const row = this.ctx.storage.sql.exec<{ thread_id: string }>('SELECT thread_id FROM messages WHERE id = ?', id).toArray()[0];
    if (!row) throw new Error('Fixture message was not indexed');
    return { threadId: row.thread_id, messageId: id };
  }
}
export class Sweeper extends MailSweeper {
  private failRelease = false;
  private failConfirm = false;
  private slowConfirm = false;
  private slowRelease?: string;
  stallConfirmation() { this.slowConfirm = true; }
  stallRelease(holder: string) { this.slowRelease = holder; }
  private async stalled() { await new Promise<void>(resolve => setTimeout(resolve, 16_000)); }
  private readonly confirmationBatches: number[] = [];
  private readonly releases: { key: string; holder: string }[] = [];
  setConfirmFailure(failing: boolean) { this.failConfirm = failing; }
  confirmBatches() { return this.confirmationBatches; }
  async confirm(entries: ConfirmEntry[]) {
    if (this.failConfirm) throw new Error('Fixture confirmation outage');
    if (this.slowConfirm) await this.stalled();
    this.confirmationBatches.push(entries.length);
    return super.confirm(entries);
  }
  holderDetails(key: string) {
    return this.ctx.storage.sql.exec('SELECT holder, state, expires_at FROM generation_holders WHERE key = ? ORDER BY holder', key).toArray();
  }
  async sweepAt(ws: string, now: number) {
    await new SweepLedger(this.ctx.storage).sweep(now, kofra(this.env, ws).deleteGeneration);
  }
  setReleaseFailure(failing: boolean) { this.failRelease = failing; }
  acknowledgedReleases() { return this.releases; }
  async release(key: string, holder: string) {
    if (this.failRelease) throw new Error('Fixture sweeper outage');
    if (holder === this.slowRelease) await this.stalled();
    await super.release(key, holder);
    this.releases.push({ key, holder });
  }
  holders(key: string) {
    return this.ctx.storage.sql.exec<{ holder: string }>('SELECT holder FROM generation_holders WHERE key = ? ORDER BY holder', key)
      .toArray().map(row => row.holder);
  }
}

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
      if (url.pathname === '/__fixture/holders') {
        const { workspace, key } = await req.json<{ workspace: string; key: string }>();
        return Response.json(await env.SWEEPER.getByName(workspace).holders(key));
      }
      if (url.pathname !== '/__fixture/advance') {
        const { ws, mailboxId } = env.ACCOUNTS.member;
        const box = env.MAILBOX.getByName(mailboxName(ws, mailboxId!));
        const refs = env.SWEEPER.getByName(ws);
        switch (url.pathname) {
          case '/__fixture/timers': return Response.json(await box.timers());
          case '/__fixture/has-idempotency': return Response.json(await box.hasIdempotency(await req.text()));
          case '/__fixture/events': return Response.json(await box.eventCount(await req.text()));
          case '/__fixture/expiry-starts': return Response.json(await box.expiryStarts());
          case '/__fixture/pause-expiry': await box.pauseExpiry(await req.text()); break;
          case '/__fixture/finish-expiry': await box.finishExpiry(); break;
          case '/__fixture/pending-releases': return Response.json(await box.pendingReleases());
          case '/__fixture/release-retry-at': return Response.json(await box.releaseRetryAt());
          case '/__fixture/confirmations': return Response.json(await box.confirmations());
          case '/__fixture/confirm-batches': return Response.json(await refs.confirmBatches());
          case '/__fixture/confirm-failure': await refs.setConfirmFailure(await req.text() === 'true'); break;
          case '/__fixture/stall-confirmation': await box.shortenHolderBudget(); await refs.stallConfirmation(); break;
          case '/__fixture/stall-release': await box.shortenHolderBudget(); await refs.stallRelease(await req.text()); break;
          case '/__fixture/expire-upload-lease': await box.expireUploadLease(await req.text()); break;
          case '/__fixture/holder-details': return Response.json(await refs.holderDetails(await req.text()));
          case '/__fixture/sweep-at': await refs.sweepAt(ws, Number(await req.text())); break;
          case '/__fixture/alerts': return Response.json(await box.alerts());
          case '/__fixture/alert-failure': await box.alertFailure(await req.text() === 'true'); break;
          case '/__fixture/release-holder': {
            const { key, holder } = await req.json<ConfirmEntry>();
            await refs.release(key, holder);
            break;
          }
          case '/__fixture/stage-crash': {
            const marker = crypto.randomUUID();
            try { await box.stageAndCrash(ws, marker); }
            catch (error) {
              const restarted = env.MAILBOX.getByName(mailboxName(ws, mailboxId!));
              if (await restarted.reachedStageCrash(marker)) return Response.json(true);
              throw error;
            }
            throw new Error('Fixture returned without aborting');
          }
          case '/__fixture/maximum-holder': return Response.json(await box.persistMaximumHolder(ws, await req.text()));
          case '/__fixture/acknowledged-releases': return Response.json(await refs.acknowledgedReleases());
          case '/__fixture/release-failure': await refs.setReleaseFailure(await req.text() === 'true'); break;
          case '/__fixture/publish-failure': await box.publishFailure(await req.text() === 'true'); break;
          case '/__fixture/purge-trash': return Response.json(await box.purgeTrash(ws));
          case '/__fixture/restore': await box.restoreFixture(ws, mailboxId!); break;
          case '/__fixture/snapshot': return Response.json(await box.forceSnapshot());
          case '/__fixture/upload-switch': {
            const enabled = await req.text() === 'true';
            try { await box.changeUploadSwitch(enabled); }
            catch { /* the fixture deliberately aborts the isolate after persisting the override */ }
            break;
          }
          default: return missing();
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/__fixture/advance') {
        const delta = Number(await req.text());
        if (!Number.isSafeInteger(delta) || delta < 0) return new Response(null, { status: 400 });
        time = now(env) + delta;
        const { results } = await env.DIRECTORY.prepare('SELECT id, workspace_id FROM mailboxes').all<{ id: string; workspace_id: string }>();
        const alarms = req.headers.get('x-fixture-parallel') === 'true' ? 2 : 1;
        await Promise.all(results.map(({ workspace_id, id }) => env.MAILBOX.getByName(mailboxName(workspace_id, id)).advanceClock(time!,
          env.MAIL_DRAFT_UPLOADS_ENABLED === 'on' && workspace_id === env.ACCOUNTS.member.ws && id === env.ACCOUNTS.member.mailboxId ? alarms : 0)));
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
      MAIL_LOCAL_API: 'on', MAIL_DRAFT_UPLOADS_ENABLED: env.MAIL_DRAFT_UPLOADS_ENABLED, MAILBOX: env.MAILBOX, DIRECTORY: env.DIRECTORY,
      MAIL_DEV_SESSION: { resolve, members: async (ws) => [...new Map(Object.values(env.ACCOUNTS).filter((p) => p.ws === ws).map((p) => [p.userId, p])).values()]
        .map((p) => ({ id: p.userId, name: p.name, email: p.address, status: p.status ?? 'active' })) },
      MAIL_CONTENT_ORIGIN: contentOrigin(url, env),
      MAIL_CONTENT: { mint: (purpose, claims) => mint(contentOrigin(url, env), purpose, claims, env) },
    };
    return handleMailApi(req, port);
  },
};
