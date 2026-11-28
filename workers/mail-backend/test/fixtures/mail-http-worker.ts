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
import { fingerprintOf, RESULT_TTL_MS } from '../../src/mailbox-api-idempotency.ts';
import { MailboxRecovery, SETTINGS_FLUSH_MS, type ReadyLife } from '../../src/mailbox-recovery.ts';
import { JOURNAL_FLUSH, JOURNAL_FLUSH_REF, TIMER_HANDLER_BUDGET_MS, TimerTable, type TimerKind, type TimerRun } from '../../src/mailbox-timers.ts';
import { deltaRange, journalPrefix } from '../../src/journal-backup.ts';
import { Outbox } from '../../src/outbox.ts';
import { Sweeper as MailSweeper } from '../../src/sweeper-do.ts';
import { SweepLedger, type ConfirmEntry } from '../../src/sweep-ledger.ts';
import { handleScheduled, handoffPorts, mailboxName, releaseDeliveryHolder, type Env as BackendEnv, type SendDispatch } from '../../src/worker.ts';
import { expandHandoff, reconcileHandoffs, type HandoffStep } from '../../src/internal-handoff.ts';
import { SEND_DRIVE } from '../../src/mailbox-send-store.ts';
import type { SendStep } from '../../src/mailbox-send.ts';
import { SendMimeError } from '../../src/send-mime.ts';
import { builds, fixtureBuilders, requests as mimeRequests } from './send-mime.ts';
import { legacyFixtureObjects } from './legacy-draft.ts';
import { sha256 } from '../../src/bytes.ts';
import { encodeDraftObject } from '../../src/mailbox-api-drafts.ts';
import { decodedAttachment, readMailMime } from '../../src/parse-mail.ts';
import { FakeSendQuota } from './send-quota-fake.ts';
import { quotaFixture } from './send-quota-worker.ts';
import { sendConsumerFixture } from './send-consumer.ts';
import { ContentLookup as RealContentLookup } from '../../src/content-lookup.ts';
import { revokeFileLink } from '../../src/admin.ts';
import { fileLinkUsage, type StoredFileLink } from '../../src/file-links.ts';
import type { LinkExpiry } from '../../../../contracts/mail-api/src/wire.ts';

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
  SEND_PROBE?: Fetcher;
  CONTENT_PORT?: string;
  MAIL_DRAFT_UPLOADS_ENABLED?: string;
  REAL_CONTENT_ORIGIN?: string;
  MAIL_CONTENT?: MailApiEnvironment['MAIL_CONTENT'];
  // Only the fixture's alarm calls run the mailbox timers, so a real alarm
  // never releases a send on the wall clock in the middle of a test.
  MANUAL_ALARMS?: string;
  // A stand-in for the send_email binding; the send path before M3-5 never calls it.
  EMAIL?: { send(message: unknown): Promise<unknown> };
  // The recording stand-in for the account quota object (M3-6).
  SEND_QUOTA: DurableObjectNamespace<FakeSendQuota>;
  // The send consumer's dispatch core (M3-5b), run against this mailbox and quota fake.
  SEND_CONSUMER: DurableObjectNamespace;
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
  private blockedDeltaAfter?: number;
  blockLaterDelta(after: number) { this.blockedDeltaAfter = after; }
  private failAlert = false;
  private realtimeHolderClock = false;
  private crashStep?: SendStep;
  private stallPuts?: PromiseWithResolvers<void>;
  private stalledPut = Promise.withResolvers<void>();
  private failEpilogue = false;
  private readonly emittedAlerts: string[] = [];
  // Holds the next queue send of a drive run until resumed.
  enqueueGate?: { reached: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void> };
  pauseNextEnqueue() { this.enqueueGate = { reached: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() }; this.pausedEnqueue = this.enqueueGate; }
  private pausedEnqueue?: { reached: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void> };
  async enqueuePaused() { await this.pausedEnqueue!.reached.promise; }
  resumeEnqueue() { this.pausedEnqueue?.resume.resolve(); this.pausedEnqueue = undefined; }
  // Holds the next authorizeDispatch inside the lane, before or after its directory statement.
  private senderGate?: { phase: string; reached: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void> };
  pauseSenderCheck(phase: string) { this.senderGate = { phase, reached: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() }; }
  async senderCheckPaused() { await this.senderGate!.reached.promise; }
  resumeSenderCheck() { const gate = this.senderGate; this.senderGate = undefined; gate?.resume.resolve(); }
  protected override async sendSenderCheckpoint(phase: 'before' | 'after') {
    const gate = this.senderGate;
    if (gate?.phase === phase) { gate.reached.resolve(); await gate.resume.promise; }
  }
  // Fails the mailbox once between a claim's release-only quota call and the removal of those fences.
  private crashRelease = false;
  crashAfterClaimRelease() { this.crashRelease = true; }
  protected override async sendReleaseCheckpoint() {
    if (!this.crashRelease) return;
    this.crashRelease = false;
    throw new Error('Fixture crash after the release call');
  }
  // Fails the mailbox once right after a stored result's row is deleted.
  private crashDelete = false;
  crashAfterResultDelete() { this.crashDelete = true; }
  protected override async sendResultDeleteCheckpoint() {
    if (!this.crashDelete) return;
    this.crashDelete = false;
    throw new Error('Fixture crash after the result delete');
  }
  // Fails recordResult `times` times for one fence attempt.
  private failRecordAttempt?: number;
  private failRecordTimes = 0;
  private crashCommittedRecord = false;
  crashAfterRecordCommit() { this.crashCommittedRecord = true; }
  protected override async sendRecordCommittedCheckpoint() {
    if (!this.crashCommittedRecord) return;
    this.crashCommittedRecord = false;
    throw new Error('Fixture crash after record commit');
  }
  private claimFailures = 0;
  private claimsFailed = 0;
  failClaims(count: number) { this.claimFailures = count; }
  failedClaims() { return this.claimsFailed; }
  override async claimSend(...args: Parameters<Mailbox['claimSend']>) {
    if (this.claimFailures > 0) {
      this.claimFailures--;
      this.claimsFailed++;
      throw new Error('Fixture claim unavailable');
    }
    return super.claimSend(...args);
  }
  async beginFixtureRestore(ws: string, mb: string) {
    await this.ctx.storage.deleteAll();
    await this.restoreFromBackup(ws, mb);
  }
  failRecordOnce(attempt: number, times = 1) { this.failRecordAttempt = attempt; this.failRecordTimes = times; }
  // Holds the next record of one fence attempt, or the next poll right after its select, until resumed.
  // Each pauseAt arms one gate for one pass through the seam, in order; resumeAt releases the oldest waiting pass.
  private gates = new Map<string, { taken: boolean; resumed: boolean; reached: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void> }[]>();
  pauseAt(point: string) {
    const list = this.gates.get(point) ?? [];
    list.push({ taken: false, resumed: false, reached: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() });
    this.gates.set(point, list);
  }
  async pausedAt(point: string) { await this.gates.get(point)!.at(-1)!.reached.promise; }
  resumeAt(point: string) {
    const gate = this.gates.get(point)?.find(entry => entry.taken && !entry.resumed);
    if (gate) { gate.resumed = true; gate.resume.resolve(); }
  }
  private async gate(point: string) {
    const gate = this.gates.get(point)?.find(entry => !entry.taken);
    if (!gate) return;
    gate.taken = true;
    gate.reached.resolve();
    await gate.resume.promise;
  }
  protected override async sendStoredSelectCheckpoint() { await this.gate('select'); }
  // Fails the mailbox once right after a poll took a flagged row's recheck, before any backoff is written.
  private crashTake = false;
  crashAfterRecheckTake() { this.crashTake = true; }
  protected override async sendRecheckTakeCheckpoint() {
    if (!this.crashTake) return;
    this.crashTake = false;
    throw new Error('Fixture crash after the recheck take');
  }
  protected override async sendRecordCheckpoint(fence: { attempt: number }) {
    await this.gate(`record:${fence.attempt}`);
    if (fence.attempt !== this.failRecordAttempt || this.failRecordTimes <= 0) return;
    this.failRecordTimes--;
    throw new Error('Fixture record failure');
  }
  // The internal handoff (M3-8): a pause or a crash at a step, and an outbox (D1) outage for its statements.
  private handoffCrash?: { step: string; times: number };
  crashAtHandoff(step: string, times = 1) { this.handoffCrash = times > 0 ? { step, times } : undefined; }
  private outboxDown = false;
  setOutboxDown(down: boolean) { this.outboxDown = down; }
  shortenHandoffBound(ms: number) { this.handoffCallMs = ms; }
  protected override async handoffCheckpoint(step: HandoffStep) {
    await this.gate(step);
    const crash = this.handoffCrash;
    if (step !== crash?.step) return;
    if (--crash.times <= 0) this.handoffCrash = undefined;
    throw new Error(`Fixture crash at ${step}`);
  }
  protected override handoffDatabase(): D1Database {
    return downable(super.handoffDatabase(), () => this.outboxDown, query => this.statementGate(query));
  }
  // Holds the next handoff statement whose SQL contains `fragment` at the D1 boundary, just before it runs.
  private statementHold?: { fragment: string; reached: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void> };
  private armedStatement?: { reached: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void> };
  pauseStatement(fragment: string) {
    const hold = { fragment, reached: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
    this.statementHold = this.armedStatement = hold;
  }
  async statementPaused() { await this.armedStatement!.reached.promise; }
  resumeStatement() { this.armedStatement?.resume.resolve(); }
  private async statementGate(query: string) {
    const hold = this.statementHold;
    if (!hold || !query.includes(hold.fragment)) return;
    this.statementHold = undefined;
    hold.reached.resolve();
    await hold.resume.promise;
  }
  // The mailbox's messages as stored, for copy counts, folders and verdicts.
  messageRows() {
    return this.ctx.storage.sql.exec(`SELECT id, raw_key, flags, folder_rev, auth, indexed, subject FROM messages ORDER BY id`).toArray();
  }
  receipts() { return this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM receipts ORDER BY id').toArray().map(row => row.id); }
  async rawText(ws: string, id: string) {
    const row = this.ctx.storage.sql.exec<{ raw_key: string }>('SELECT raw_key FROM messages WHERE id = ?', id).one();
    return new TextDecoder().decode(await this.fixtureIndex(ws).readObject(row.raw_key));
  }
  // A repeated filing of a file_sent child, as a redelivery or a replay would make it.
  fileSentAgain(ws: string, id: string, messageId: string, folderRev: number) {
    return this.workLane(async () => this.fixtureIndex(ws).fileSent(id, messageId, folderRev));
  }
  // The consumer's side of one send, as stored (M3-5a).
  sendState(id: string) {
    const sql = this.ctx.storage.sql;
    return {
      row: sql.exec('SELECT state, terminal_seq, finish_pending FROM mailbox_sends WHERE id = ?', id).toArray()[0] ?? null,
      ledger: sql.exec('SELECT idx, kind, state, reason FROM mailbox_send_recipients WHERE send_id = ? ORDER BY idx', id).toArray(),
      dispatch: sql.exec('SELECT * FROM mailbox_send_dispatch WHERE send_id = ?', id).toArray()[0] ?? null,
      fences: sql.exec('SELECT epoch, attempt, lease_until, marked, authorized, outcome FROM mailbox_send_fences WHERE send_id = ? ORDER BY epoch, attempt', id).toArray(),
      marks: sql.exec('SELECT epoch, attempt, idx, outcome, provider_id FROM mailbox_send_marks WHERE send_id = ? ORDER BY epoch, attempt, idx', id).toArray(),
      release: sql.exec('SELECT epoch, attempt FROM mailbox_send_release_list WHERE send_id = ? ORDER BY epoch, attempt', id).toArray(),
      drive: sql.exec("SELECT due_at FROM timers WHERE kind = 'send_drive' AND ref = ?", id).toArray().map(row => row.due_at),
      flushed: sql.exec<{ flushed: number; modseq: number }>('SELECT flushed, modseq FROM state WHERE id = 1').one(),
    };
  }
  // Resolves when the next call of a method reaches this object, before it waits for anything.
  private arrivals = new Map<string, PromiseWithResolvers<void>>();
  armArrival(method: string) { this.arrivals.set(method, Promise.withResolvers<void>()); }
  async arrived(method: string) { await this.arrivals.get(method)!.promise; }
  async sendRpc(ws: string, mb: string, method: string, args: unknown[]) {
    this.arrivals.get(method)?.resolve();
    const allowed = ['claimSend', 'markSend', 'sendRequest', 'authorizeDispatch', 'recordResult', 'delaySend', 'abandonClaim', 'recordStoredResults'];
    if (!allowed.includes(method)) throw new Error('Unknown fixture send RPC');
    return (this as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>)[method](ws, mb, ...args);
  }
  // A restore that takes `ms`: the mailbox becomes ready that much later on the fixture clock.
  async restoreAfter(ws: string, mb: string, at: number) {
    await this.ctx.storage.deleteAll();
    await this.restoreFromBackup(ws, mb);
    time = at;
    await this.testAlarm();
  }

  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    let mailbox: HttpMailbox;
    const state = new Proxy(env.MAIL_STATE, { get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property === 'get') return (key: string, options?: R2GetOptions) => {
        const range = mailbox.blockedDeltaAfter === undefined ? null : deltaRange(journalPrefix(ctx.id.toString()), key);
        if (range && range.from > mailbox.blockedDeltaAfter!) throw new Error('Fixture later delta unreadable');
        return target.get(key, options);
      };
      if (property === 'put') return async (...args: Parameters<R2Bucket['put']>) => {
        if (mailbox.failPublish) throw new Error('Fixture publish failure');
        const stall = mailbox.stallPuts;
        if (stall) { mailbox.stalledPut.resolve(); await stall.promise; }
        return target.put(...args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    let flag: string | undefined;
    try { flag = ctx.storage.sql.exec<{ flag: string }>('SELECT flag FROM fixture_upload_switch').toArray()[0]?.flag; }
    catch { /* no fixture override before the first toggle */ }
    let sendFlag: string | undefined;
    try { sendFlag = ctx.storage.sql.exec<{ flag: string }>('SELECT flag FROM fixture_send_switch').toArray()[0]?.flag; }
    catch { /* no fixture override before the first toggle */ }
    const record = (table: string, body: unknown) => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (n INTEGER PRIMARY KEY, body TEXT NOT NULL)`);
      ctx.storage.sql.exec(`INSERT INTO ${table} (body) VALUES (?)`, JSON.stringify(body));
    };
    super(ctx, { ...env, MAIL_STATE: state, MAIL_DRAFT_UPLOADS_ENABLED: flag ?? env.MAIL_DRAFT_UPLOADS_ENABLED,
      MAIL_SEND_ENABLED: sendFlag ?? env.MAIL_SEND_ENABLED,
      SEND: { send: async (body: SendDispatch) => {
        const gate = mailbox.enqueueGate;
        if (gate) { mailbox.enqueueGate = undefined; gate.reached.resolve(); await gate.resume.promise; }
        record('fixture_send_queue', body);
      } },
      ...{ EMAIL: { send: async (message: unknown) => { record('fixture_email', { kind: typeof message }); return {}; } } },
      // The delivery queue: child deliveries of a handoff are recorded; the fixture's pipeline runs them.
      DELIVER: { send: async (id: string) => { record('fixture_deliver_queue', id); } } as unknown as Queue<string>,
      ALERTS: { fetch: async (input, init) => {
        const { source } = await new Request(input, init).json<{ source: string }>();
        if (mailbox.failAlert) return new Response(null, { status: 503 });
        mailbox.emittedAlerts.push(source);
        return new Response(null, { status: 204 });
      } } });
    mailbox = this;
    let bumped = false;
    try { bumped = ctx.storage.sql.exec('SELECT 1 FROM fixture_builder').toArray().length > 0; }
    catch { /* never bumped */ }
    this.sendMime = fixtureBuilders(bumped ? 'bumped' : 'base');
  }
  stallPublish() { this.stallPuts = Promise.withResolvers<void>(); this.stalledPut = Promise.withResolvers<void>(); }
  async publishStalled() { await this.stalledPut.promise; }
  resumePublish() { const stall = this.stallPuts; this.stallPuts = undefined; stall?.resolve(); }
  shortenBarrier(ms: number) { this.barrierBudgetMs = ms; }
  // Holds the publish lane as the backup lane does across snapshot work: on
  // cover-now it publishes every committed delta, then keeps holding.
  private held?: { cover: PromiseWithResolvers<void>; covered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> };
  holdPublishLane(ws: string) {
    const held = this.held = { cover: Promise.withResolvers<void>(), covered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    void this.publishes.run(async () => {
      await held.cover.promise;
      const index = this.fixtureIndex(ws);
      await new MailboxRecovery(index, this.env.MAIL_STATE, this.ctx.id.toString())
        .publish(index.lifecycle<ReadyLife>()!, Date.now(), async () => { throw new Error('Fixture publishes deltas only'); }, undefined, { deltasOnly: true });
      held.covered.resolve();
      await held.release.promise;
    }).catch(error => held.covered.reject(error));
  }
  async coverHeld() { this.held!.cover.resolve(); await this.held!.covered.promise; }
  releaseHeld() { this.held?.release.resolve(); this.held = undefined; }
  dropBuilder(dropped: boolean) { this.sendMime = fixtureBuilders(dropped ? 'dropped' : 'base'); }
  refuseMime({ phase, code }: { phase: 'size' | 'build'; code: 'invalid_header' | 'message_too_large' | 'invalid_wire' }) {
    const original = this.sendMime;
    this.sendMime = { current: original.current, get(version) {
      const builder = original.get(version);
      if (!builder) return undefined;
      return phase === 'size' ? { ...builder, encodedSize(message) {
        if (code === 'invalid_wire') return builder.encodedSize({ ...message, boundary: 'not-a-safe-boundary' });
        throw new SendMimeError({ code });
      } } : { ...builder, build(message, parts) {
        if (code === 'invalid_wire') return builder.build({ ...message, boundary: 'not-a-safe-boundary' }, parts);
        throw new SendMimeError({ code });
      } };
    } };
  }
  sendIds() { return this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM mailbox_sends ORDER BY id').toArray().map(row => row.id); }
  publishFailure(failing: boolean) { this.failPublish = failing; }
  private recorded(table: string): unknown[] {
    try { return this.ctx.storage.sql.exec<{ body: string }>(`SELECT body FROM ${table} ORDER BY n`).toArray().map(row => JSON.parse(row.body)); }
    catch { return []; }
  }
  sendQueue() { return this.recorded('fixture_send_queue'); }
  emailCalls() { return this.recorded('fixture_email').length; }
  crashAfter(step: SendStep) { this.crashStep = step; }
  failNextEpilogue() { this.failEpilogue = true; }
  bumpBuilder() {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_builder (id INTEGER PRIMARY KEY)');
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO fixture_builder VALUES (1)');
    this.sendMime = fixtureBuilders('bumped');
  }
  mimeBuilds() { return builds; }
  mimeRequests() { return mimeRequests; }
  async sentHeaders(workspaceId: string, messageId: string): Promise<Record<string, string>> {
    const row = this.ctx.storage.sql.exec<{ raw_key: string }>('SELECT raw_key FROM messages WHERE id = ?', messageId).toArray()[0];
    if (!row) throw new Error('Stored sent copy is missing');
    const raw = new TextDecoder().decode(await this.fixtureIndex(workspaceId).readObject(row.raw_key));
    const headers: Record<string, string> = Object.create(null);
    let current: string | undefined;
    for (const line of raw.slice(0, raw.indexOf('\r\n\r\n')).split('\r\n')) {
      if (/^[ \t]/.test(line)) {
        if (current) headers[current] += ` ${line.trim()}`;
        continue;
      }
      const separator = line.indexOf(':');
      if (separator < 1) continue;
      current = line.slice(0, separator).toLowerCase();
      // Every top-level field the sent-copy builder writes is a singleton.
      if (Object.hasOwn(headers, current)) throw new Error('Duplicate stored sent header');
      headers[current] = line.slice(separator + 1).trim();
    }
    return { ...headers };
  }
  shortenHandlerBudget() { this.timerHandlerBudgetMs = 25; this.realtimeHolderClock = true; }
  sendRow(id: string) {
    return this.ctx.storage.sql.exec(`SELECT id, state, undo_until, created_seq, release_seq, queued_seq, terminal_seq, message_id, reason,
      finish_pending, record FROM mailbox_sends WHERE id = ?`, id).toArray()[0] ?? null;
  }
  lifecycle() { return this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM lifecycle WHERE id = 1').toArray()[0]?.value ?? null; }
  async setReplyTo(ws: string, mb: string, replyTo: unknown) {
    return this.mutate(ws, mb, SETTINGS_FLUSH_MS, index => {
      const row = this.ctx.storage.sql.exec<{ definition: string }>('SELECT definition FROM mailbox_api_settings WHERE id = 1').toArray()[0];
      const settings = { signature: '', undoSeconds: 10, defaultFrom: '', replyFromReceivedAddress: true,
        ...(row ? JSON.parse(row.definition) as object : {}), replyTo };
      index.changeMany([{ type: 'api_settings', definition: JSON.stringify(settings) }]);
    });
  }
  // Holds the next publishThrough(seq) call before it starts, until resumed.
  private publishGate?: { seq: number; armed: boolean; reached: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void> };
  pausePublishThrough(seq: number) {
    this.publishGate = { seq, armed: true, reached: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
  }
  async publishThroughPaused() { await this.publishGate!.reached.promise; }
  resumePublishThrough() { this.publishGate?.resume.resolve(); }
  protected override sendPorts() {
    const ports = super.sendPorts();
    const publishThrough = ports.publishThrough;
    ports.publishThrough = async seq => {
      const gate = this.publishGate;
      if (gate?.armed && gate.seq === seq) {
        gate.armed = false;
        gate.reached.resolve();
        await gate.resume.promise;
      }
      return publishThrough(seq);
    };
    return ports;
  }
  // Every send_drive run still running in this isolate, including one the alarm returned from.
  private readonly driveRuns = new Set<Promise<unknown>>();
  async driveIdle() { while (this.driveRuns.size) await Promise.allSettled([...this.driveRuns]); }
  sendDriver(id: string) {
    return this.ctx.storage.sql.exec('SELECT * FROM mailbox_send_drivers WHERE send_id = ?', id).toArray()[0] ?? null;
  }
  activeAlerts() { return this.ctx.storage.sql.exec<{ code: string }>('SELECT code FROM mailbox_alerts ORDER BY code').toArray().map(row => row.code); }
  sendBreaches() { return this.ctx.storage.sql.exec<{ id: string }>('SELECT send_id AS id FROM mailbox_send_breaches').toArray().map(row => row.id); }
  // Stands in for a parser change since the part was attached: the frozen digest no longer matches.
  // Makes the barrier's work-lane wake-up throw inside the lane, as a failed alarm update would.
  private wakeupFailure = false;
  failLaneWakeup(failing: boolean) { this.wakeupFailure = failing; }
  // Holds the next barrier wake-up inside the work lane, until the test opens it.
  private wakeupGate?: { entered: PromiseWithResolvers<void>; open: PromiseWithResolvers<void> };
  gateLaneWakeup() { this.wakeupGate = { entered: Promise.withResolvers<void>(), open: Promise.withResolvers<void>() }; }
  async laneWakeupEntered() { await this.wakeupGate?.entered.promise; }
  openLaneWakeup() { const gate = this.wakeupGate; this.wakeupGate = undefined; gate?.open.resolve(); }
  protected override async wakeCoveredWork() {
    if (this.wakeupFailure) throw new Error('Fixture lane wake-up failure');
    const gate = this.wakeupGate;
    if (gate) { gate.entered.resolve(); await gate.open.promise; }
    return super.wakeCoveredWork();
  }
  // A recipient row in the state the M3-5 consumer writes while it calls the provider.
  setRecipientState(sendId: string, idx: number, state: string) {
    this.ctx.storage.sql.exec('UPDATE mailbox_send_recipients SET state = ? WHERE send_id = ? AND idx = ?', state, sendId, idx);
  }
  // Moves a send row's undo deadline, as a corrupt snapshot row would carry it.
  setSendUndoUntil(sendId: string, undoUntil: number) {
    this.ctx.storage.sql.exec('UPDATE mailbox_sends SET undo_until = ? WHERE id = ?', undoUntil, sendId);
  }
  // Points a send's frozen draft revision at another stored object.
  setSendDraftKey(sendId: string, rawKey: string) {
    this.ctx.storage.sql.exec(`UPDATE mailbox_sends SET record = json_set(record, '$.draft.rawKey', ?) WHERE id = ?`, rawKey, sendId);
  }
  changePartDigest(sendId: string) {
    this.ctx.storage.sql.exec(`UPDATE mailbox_sends SET record = json_set(record, '$.parts[0].digest', ?) WHERE id = ?`, '0'.repeat(64), sendId);
  }
  // Stands in for a part indexed before names were cleaned, or with an odd type.
  changeAttachmentMeta(messageId: string, part: number, name: string, type: string) {
    this.ctx.storage.sql.exec('UPDATE attachments SET name = ?, mime_type = ? WHERE message_id = ? AND part = ?', name, type, messageId, part);
  }
  // Stands in for an index row whose size no longer matches what the parser decodes.
  changeAttachmentSize(messageId: string, part: number, delta: number) {
    this.ctx.storage.sql.exec('UPDATE attachments SET size = size + ? WHERE message_id = ? AND part = ?', delta, messageId, part);
  }
  // A message indexed before its display recorded which part is the synthetic "(N more attachments)" row.
  dropSyntheticMark(messageId: string) {
    this.ctx.storage.sql.exec("UPDATE mailbox_api_display SET data = json_remove(data, '$.syntheticPart') WHERE id = ?", messageId);
  }
  // A draft revision forwarding a small part whose stored fingerprint is what the parser decodes,
  // while its laid-out size differs by `delta`: the state a draft saved before the size check could hold.
  async seedForwardDraft(ws: string, mb: string, input: { from: string; messageId: string; part: number; delta: number; to?: string[] }) {
    const sql = this.ctx.storage.sql;
    const message = sql.exec<{ raw: string }>('SELECT raw_key AS raw FROM messages WHERE id = ?', input.messageId).one();
    const row = sql.exec<{ name: string; type: string; size: number }>(
      'SELECT name, mime_type AS type, size FROM attachments WHERE message_id = ? AND part = ?', input.messageId, input.part).one();
    return this.mutate(ws, mb, SETTINGS_FLUSH_MS, async index => {
      const parsed = await readMailMime(await index.readObject(message.raw), message.raw);
      const bytes = decodedAttachment(parsed.attachments[input.part - 1].content);
      const draft = { version: 1 as const,
        fields: { from: input.from, to: (input.to ?? ['friend@example.net']).map(email => ({ email })), cc: [], bcc: [], subject: 'Forwarded', body: 'See attached',
          forwardOf: input.messageId },
        attachments: [{ wire: { kind: 'message' as const, messageId: input.messageId, part: input.part, name: row.name, type: row.type, size: row.size + input.delta },
          key: message.raw, part: { digest: await sha256(bytes), size: bytes.byteLength } }] };
      const ref = await index.prepareApiDraft(crypto.randomUUID(), encodeDraftObject(draft), this.mailApiNow(), [message.raw]);
      index.changeMany([{ type: 'draft', ...ref, attachmentKeys: [message.raw], uploadIds: [] }]);
      return { id: ref.id, revision: ref.revision };
    });
  }
  // A draft revision as the M2 API wrote it, under a prefix-less drafts/<sha256> key.
  async seedLegacyApiDraft(ws: string, mb: string, draft: unknown) {
    const bytes = new Uint8Array(encoder.encode(JSON.stringify(draft)));
    const rawKey = `drafts/${await sha256(bytes)}`;
    const id = crypto.randomUUID(), revision = crypto.randomUUID(), holder = `draft:${crypto.randomUUID()}`;
    const objects = legacyFixtureObjects(this.env, ws);
    await objects.hold(rawKey, holder);
    await objects.put(rawKey, bytes);
    await this.mutate(ws, mb, SETTINGS_FLUSH_MS, index => {
      index.changeMany([{ type: 'draft', id, rawKey, holder, revision, updatedAt: this.mailApiNow(), attachmentKeys: [], uploadIds: [] }]);
    });
    return { id, revision, rawKey, holder };
  }
  // A draft with file links (M3-13), in the form the link upload path (M3-15b) attaches them.
  async seedFileLinkDraft(ws: string, mb: string, input: { from: string; to: string[]; subject?: string; body?: string;
    links: { linkUploadId: string; name: string; size: number; expiry: LinkExpiry; link: StoredFileLink }[] }) {
    return this.mutate(ws, mb, SETTINGS_FLUSH_MS, async index => {
      const draft = { version: 1 as const, fields: { from: input.from, to: input.to.map(email => ({ email })), cc: [], bcc: [],
        subject: input.subject ?? 'Files for you', body: input.body ?? 'Here are the files.' },
        attachments: input.links.map(({ link, ...wire }) => ({ wire: { kind: 'file_link' as const, ...wire }, link })) };
      const ref = await index.prepareApiDraft(crypto.randomUUID(), encodeDraftObject(draft), this.mailApiNow(), []);
      index.changeMany([{ type: 'draft', ...ref, attachmentKeys: [], uploadIds: [] }]);
      return { id: ref.id, revision: ref.revision };
    });
  }
  // Points a frozen link at another object key, as a corrupt record could.
  setLinkKey(sendId: string, idx: number, key: string) {
    if (!Number.isSafeInteger(idx) || idx < 0) throw new Error('Invalid fixture link index');
    this.ctx.storage.sql.exec(`UPDATE mailbox_sends SET record = json_set(record, '$.links[${idx}].key', ?) WHERE id = ?`, key, sendId);
  }
  // Calls to the mailbox's link capability, for the flood bucket ordering test.
  linkTargetCalls = 0;
  override async fileLinkTarget(...args: Parameters<Mailbox['fileLinkTarget']>) {
    this.linkTargetCalls++;
    return super.fileLinkTarget(...args);
  }
  linkCalls() { return this.linkTargetCalls; }
  // An outage of the routing table at release step 4b.
  private linkRoutesDown = false;
  setLinkRoutesDown(down: boolean) { this.linkRoutesDown = down; }
  protected override linkRouteDatabase(): D1Database {
    return this.linkRoutesDown ? downable(this.env.DIRECTORY, () => true) : this.env.DIRECTORY;
  }
  async changeSendSwitch(enabled: boolean) {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_send_switch (id INTEGER PRIMARY KEY, flag TEXT NOT NULL)');
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO fixture_send_switch VALUES (1, ?)', enabled ? 'on' : 'off');
    await this.ctx.storage.sync();
    this.ctx.abort();
  }
  protected override async sendCheckpoint(step: SendStep) {
    if (step !== this.crashStep) return;
    this.crashStep = undefined;
    throw new Error(`Fixture crash after ${step}`);
  }
  // In manual mode every platform alarm is refused, even during an explicit
  // advance: one admitted then could resume after testAlarm restored Date.now.
  override async alarm() {
    if ((this.env as FixtureEnv).MANUAL_ALARMS === 'on') return;
    return super.alarm();
  }
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
    const rebuild = handler.rebuild;
    if (kind === SEND_DRIVE && rebuild) handler = { ...handler, rebuild: (timers, now) => {
      if (this.failEpilogue) {
        this.failEpilogue = false;
        throw new Error('Fixture crash during the restore epilogue');
      }
      return rebuild(timers, now);
    } };
    super.registerTimerKind(kind, { ...handler, run: async timer => {
      if (kind === SEND_DRIVE) {
        const run = handler.run(timer);
        this.driveRuns.add(run);
        try { return await run; } finally { this.driveRuns.delete(run); }
      }
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
    try { await Promise.all(Array.from({ length: runs }, () => super.alarm())); }
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
  async seedLegacyLabel(ws: string, mb: string) {
    return this.mutate(ws, mb, SETTINGS_FLUSH_MS, async index => {
      const label = { id: crypto.randomUUID(), name: 'Legacy' };
      index.changeMany([{ type: 'label', ...label }, { type: 'api_result', key: 'legacy',
        fingerprint: await fingerprintOf('createLabel', {}, { name: label.name }),
        expiresAt: this.mailApiNow() + RESULT_TTL_MS, result: JSON.stringify({ label }) }]);
      return label;
    });
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
  private failOneConfirm = false;
  failNextConfirmation() { this.failOneConfirm = true; }
  private slowConfirm = false;
  private slowRelease?: string;
  stallConfirmation() { this.slowConfirm = true; }
  stallRelease(holder: string) { this.slowRelease = holder; }
  private async stalled() { await new Promise<void>(resolve => setTimeout(resolve, 16_000)); }
  private readonly confirmationBatches: number[] = [];
  private readonly releases: { key: string; holder: string }[] = [];
  setConfirmFailure(failing: boolean) { this.failConfirm = failing; }
  confirmBatches() { return this.confirmationBatches; }
  private lostHolder?: string;
  private failSendRelease = false;
  forceLost(holder: string) { this.lostHolder = holder; }
  setSendReleaseFailure(failing: boolean) { this.failSendRelease = failing; }
  async confirm(entries: ConfirmEntry[]) {
    if (this.failConfirm || this.failOneConfirm) {
      this.failOneConfirm = false;
      throw new Error('Fixture confirmation outage');
    }
    if (this.slowConfirm) await this.stalled();
    this.confirmationBatches.push(entries.length);
    const answers = await super.confirm(entries);
    // The sweeper's answer for a source whose object a test declares lost.
    return answers.map((answer, i) => entries[i].holder === this.lostHolder ? 'lost' as const : answer);
  }
  // Tombstoning releases that never answer, for a workspace whose sweeper keeps timing out.
  private stallTombstone = false;
  stallTombstones(stalled: boolean) { this.stallTombstone = stalled; }
  private failTombstone = false;
  failTombstones(failing: boolean) { this.failTombstone = failing; }
  readonly tombstoned: { key: string; holder: string }[] = [];
  override async releaseTombstoned(key: string, holder: string) {
    if (this.stallTombstone) await new Promise<void>(() => {});
    if (this.failTombstone) throw new Error('Fixture sweeper outage');
    await super.releaseTombstoned(key, holder);
    this.tombstoned.push({ key, holder });
  }
  tombstones() { return this.tombstoned; }
  // Holds that always fail, for a workspace sweeper that is down for good.
  private failHold = false;
  failHolds(failing: boolean) { this.failHold = failing; }
  override async hold(key: string, holder: string) {
    if (this.failHold) throw new Error('Fixture sweeper outage');
    return super.hold(key, holder);
  }
  // registerSend commits, then its reply is lost.
  private loseRegisterReply = false;
  loseNextRegisterReply() { this.loseRegisterReply = true; }
  override async registerSend(...args: Parameters<MailSweeper['registerSend']>) {
    const result = await super.registerSend(...args);
    if (this.loseRegisterReply) { this.loseRegisterReply = false; throw new Error('Fixture lost registration reply'); }
    return result;
  }
  override async releaseSend(...args: Parameters<MailSweeper['releaseSend']>) {
    if (this.failSendRelease) throw new Error('Fixture sweeper outage');
    return super.releaseSend(...args);
  }
  registration(mailbox: string, sendId: string) {
    try {
      return this.ctx.storage.sql.exec('SELECT digest, key, raw_holder, index_holder, released FROM send_registrations WHERE mailbox = ? AND send_id = ?',
        mailbox, sendId).toArray()[0] ?? null;
    } catch { return null; }
  }
  generation(key: string) {
    return this.ctx.storage.sql.exec('SELECT key, holder_count, retry_at, deleted_at FROM generations WHERE key = ?', key).toArray()[0] ?? null;
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
// The content Worker's lookup, counting the link lookups it serves (M3-13: the flood bucket runs before any).
let linkLookups = 0;
export class ContentLookup extends RealContentLookup {
  override async fileLink(tokenHash: unknown) { linkLookups++; return super.fileLink(tokenHash); }
  override async reportFileLink(tokenHash: unknown) { linkLookups++; return super.reportFileLink(tokenHash); }
}
export { LinkUsage } from '../../src/entry.ts';
export { FakeSendQuota };
export const RealSendQuota = quotaFixture((env: FixtureEnv) => now(env));
// The consumer reads the mailbox's clock through the same fixture time.
export const SendConsumer = sendConsumerFixture((env: FixtureEnv) => now(env));

// Request rate limits with per-key counters that a test can cap, per binding.
const rateCaps = new Map<string, number>();
const rateCounts = new Map<string, number>();
const limiter = (binding: string) => ({ async limit({ key }: { key: string }) {
  const cap = rateCaps.get(binding);
  if (cap === undefined) return { success: true };
  const counted = (rateCounts.get(`${binding}\n${key}`) ?? 0) + 1;
  rateCounts.set(`${binding}\n${key}`, counted);
  return { success: counted <= cap };
} });

// A directory change that commits after the API layer read the session's
// mailbox and identities and before the mailbox runs sendDraft: the window in
// which only the mailbox's own sender check can see it.
let beforeMailboxSend: { statement: string; binds: unknown[] } | undefined;
type MailboxPort = NonNullable<MailApiEnvironment['MAILBOX']>;
type MailApiCall = ReturnType<MailboxPort['getByName']>['mailApi'];
const mailboxPort = (env: FixtureEnv): MailboxPort => ({
  getByName(name: string) {
    const stub: ReturnType<MailboxPort['getByName']> = env.MAILBOX.getByName(name);
    return {
      async mailApi(...args: Parameters<MailApiCall>) {
        const change = args[2] === 'sendDraft' ? beforeMailboxSend : undefined;
        if (change) {
          beforeMailboxSend = undefined;
          await env.DIRECTORY.prepare(change.statement).bind(...change.binds).run();
        }
        return stub.mailApi(...args);
      },
    };
  },
});

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

// A D1 database whose statements fail while `down()` holds: an outbox outage.
function downable(db: D1Database, down: () => boolean, before: (query: string) => Promise<void> = async () => {}): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const outage = () => { throw new Error('Fixture outbox outage'); };
  const statement = (inner: D1PreparedStatement, query: string): D1PreparedStatement => {
    const wrapped = new Proxy(inner, { get(target, property) {
      if (property === 'bind') return (...values: unknown[]) => statement(target.bind(...values), query);
      if (property === 'run' || property === 'first' || property === 'all' || property === 'raw') {
        return async (...args: unknown[]) => {
          await before(query);
          if (down()) outage();
          return (target[property] as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    real.set(wrapped, inner);
    return wrapped;
  };
  const prepared = (source: { prepare(query: string): D1PreparedStatement }) => (query: string) => statement(source.prepare(query), query);
  return new Proxy(db, { get(target, property) {
    if (property === 'prepare') return prepared(target);
    if (property === 'batch') return async (list: D1PreparedStatement[]) => {
      if (down()) outage();
      return target.batch(list.map(item => real.get(item) ?? item));
    };
    if (property === 'withSession') return (constraint: D1SessionConstraint) => {
      const session = target.withSession(constraint);
      return new Proxy(session, { get(inner, key) {
        if (key === 'prepare') return prepared(inner);
        const value: unknown = Reflect.get(inner, key);
        return typeof value === 'function' ? value.bind(inner) : value;
      } });
    };
    const value: unknown = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

// The delivery pipeline's queue consumer for every pending delivery, on the
// fixture clock: the real deliver() with the Worker's own holder release.
async function runDeliveries(env: FixtureEnv): Promise<string[]> {
  const outbox = new Outbox(env.DIRECTORY);
  const { results } = await env.DIRECTORY.prepare("SELECT id FROM deliveries WHERE state = 'pending' ORDER BY id").all<{ id: string }>();
  for (const { id } of results) {
    await deliver(id, {
      outbox,
      index: (ws, mb, delivery) => env.MAILBOX.getByName(mailboxName(ws, mb)).deliver(delivery),
      release: (ws, rawKey, delivery, source) => releaseDeliveryHolder(env.SWEEPER.getByName(ws), rawKey, delivery, source),
      now: () => now(env),
    }, crypto.randomUUID());
  }
  return results.map(({ id }) => id);
}

// The handoff ports of the backend Worker, as the reconciler and the queue use them.
const pipelinePorts = (env: FixtureEnv) => handoffPorts(env as unknown as BackendEnv);

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
    release: (ws, rawKey, id, source) => releaseDeliveryHolder(env.SWEEPER.getByName(ws), rawKey, id, source),
    now: () => now(env),
  }, delivery);
  const box = env.MAILBOX.getByName(mailboxName(row.workspaceId, row.mailboxIds[0]));
  return Response.json(await box.delivered(delivery));
}

async function activatePrimary(db: D1Database, address: string): Promise<void> {
  await db.prepare("UPDATE addresses SET send_as_policy = 'active' WHERE address_norm = ? AND kind = 'primary' AND send_as_policy = 'pending'")
    .bind(address).run();
}

async function seedHttpDirectory(env: FixtureEnv, migrations: string[][]): Promise<void> {
  const db = env.DIRECTORY;
  for (const statements of migrations) await db.batch(statements.map(statement => db.prepare(statement)));
  await db.batch([['w1', 'example.com'], ['w2', 'example.net']].map(([ws, domain]) =>
    db.prepare("INSERT INTO domains VALUES (?, ?, ?, 'primary', NULL, 'active', 'active')").bind(ws, ws, domain)));
  // Any other workspace's domain comes from its accounts' addresses.
  const others = new Map(Object.values(env.ACCOUNTS).filter(a => a.mailboxId && a.ws !== 'w1' && a.ws !== 'w2')
    .map(a => [a.ws, a.address.slice(a.address.lastIndexOf('@') + 1)]));
  for (const [ws, domain] of others) await db.prepare("INSERT INTO domains VALUES (?, ?, ?, 'primary', NULL, 'active', 'active')").bind(ws, ws, domain).run();
  for (const principal of Object.values(env.ACCOUNTS).filter(a => a.mailboxId && !a.stale)) {
    await db.batch([
      db.prepare('INSERT INTO mailboxes (id, workspace_id, user_id, primary_address) VALUES (?, ?, ?, ?)').bind(principal.mailboxId, principal.ws, principal.userId, principal.address),
      db.prepare('INSERT INTO mailbox_profiles VALUES (?, ?, ?)').bind(principal.ws, principal.mailboxId, principal.name),
      db.prepare("INSERT INTO addresses VALUES (?, ?, 'mailbox', ?, 'primary', 'pending')").bind(principal.address, principal.ws, principal.mailboxId),
    ]);
    // Seeded mailboxes represent provisioned fixtures, unlike those created through the API.
    await activatePrimary(db, principal.address);
  }
  if (env.DEFAULT_ACCOUNT === 'demo') {
    await db.prepare("INSERT INTO addresses VALUES ('hello@example.com', 'w1', 'mailbox', 'mailbox-demo', 'alias', 'active')").run();
  }
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
      if (url.pathname === '/__fixture/now') return Response.json(now(env));
      if (url.pathname === '/__fixture/send-event') {
        const { code, principal } = await req.json<{ code: string; principal: string }>();
        const { ws, mailboxId } = env.ACCOUNTS[principal];
        await env.MAILBOX.getByName(mailboxName(ws, mailboxId!)).recordSendEvent(ws, mailboxId!, code);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/__fixture/backend-cron') {
        const probe = env.SEND_PROBE!;
        await handleScheduled({ cron: '* * * * *', scheduledTime: now(env), noRetry() {} }, {
          ...env, SEND: { send: body => probe.fetch('https://fixture.internal/notice', { method: 'POST', body: JSON.stringify(body) }),
            async sendBatch(batch) {
              const response = await probe.fetch('https://fixture.internal/notice', { method: 'POST', body: JSON.stringify([...batch].map(({ body }) => body)) });
              if (!response.ok) throw new Error('Fixture result notice queue unavailable');
            } },
        }, () => now(env));
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/__fixture/rate-cap') {
        const { binding, cap } = await req.json<{ binding: string; cap: number }>();
        rateCaps.set(binding, cap);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/__fixture/before-mailbox-send') {
        beforeMailboxSend = await req.json<{ statement: string; binds: unknown[] }>();
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/__fixture/seed-directory') {
        await seedHttpDirectory(env, await req.json<string[][]>());
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/__fixture/activate-primary') {
        await activatePrimary(env.DIRECTORY, await req.text());
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/__fixture/directory-change' || url.pathname === '/__fixture/directory-rows') {
        const { statement, binds } = await req.json<{ statement: string; binds: unknown[] }>();
        const query = env.DIRECTORY.prepare(statement).bind(...binds);
        if (url.pathname === '/__fixture/directory-rows') return Response.json((await query.all()).results);
        await query.run();
        return new Response(null, { status: 204 });
      }
      // M3-8: the pipeline, the reconciler's handoff part, a second expander, and stored state.
      if (url.pathname === '/__fixture/run-deliveries') return Response.json(await runDeliveries(env));
      if (url.pathname === '/__fixture/handoff-cron') {
        // `callMs`, or `callMs,failTake`: the failTake-th take of release rows fails.
        const [callMs, failTake] = (await req.text()).split(',').map(value => Number(value) || undefined);
        const ports = pipelinePorts(env);
        let takes = 0;
        if (failTake) ports.db = downable(ports.db, () => false, async query => {
          if (query.includes('INDEXED BY internal_handoffs_release') && ++takes === failTake) throw new Error('Fixture take failure');
        });
        return Response.json(await reconcileHandoffs(ports, now(env), callMs));
      }
      if (url.pathname === '/__fixture/expand') return Response.json(await expandHandoff(pipelinePorts(env), await req.text(), now(env)));
      // File links (M3-13): seeding a draft, the operator's revoke, the usage port and the lookup count.
      if (url.pathname === '/__fixture/links') {
        const { method, args, principal = 'member' } = await req.json<{ method: string; args: unknown[]; principal?: string }>();
        const { ws, mailboxId } = env.ACCOUNTS[principal];
        const box = env.MAILBOX.getByName(mailboxName(ws, mailboxId!));
        switch (method) {
          case 'seedDraft': return Response.json(await box.seedFileLinkDraft(ws, mailboxId!, args[0] as Parameters<HttpMailbox['seedFileLinkDraft']>[2]));
          case 'operatorRevoke': return Response.json(await revokeFileLink(env, args[0] as { linkId: string }));
          case 'inUse': return Response.json(await fileLinkUsage(env.DIRECTORY).inUse(args[0] as { workspaceId: string; locationId: string }));
          case 'lookups': return Response.json({ lookups: linkLookups, targets: await box.linkCalls() });
          case 'routesDown': await box.setLinkRoutesDown(args[0] === true); return Response.json(null);
          case 'setKey': await box.setLinkKey(args[0] as string, args[1] as number, args[2] as string); return Response.json(null);
          default: throw new Error('Unknown fixture link method');
        }
      }
      if (url.pathname === '/__fixture/box') {
        const { principal, method, args } = await req.json<{ principal: string; method: string; args: unknown[] }>();
        const allowed = ['pauseAt', 'pausedAt', 'resumeAt', 'crashAtHandoff', 'setOutboxDown', 'shortenHandoffBound', 'pauseStatement',
          'statementPaused', 'resumeStatement', 'messageRows', 'receipts', 'rawText', 'fileSentAgain',
          'sendState', 'sendIds', 'publishFailure', 'timers', 'restoreFixture'];
        if (!allowed.includes(method)) throw new Error('Unknown fixture mailbox method');
        const { ws, mailboxId } = env.ACCOUNTS[principal];
        const target = env.MAILBOX.getByName(mailboxName(ws, mailboxId!)) as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>;
        const scoped = ['rawText', 'fileSentAgain'].includes(method) ? [ws, ...args] : method === 'restoreFixture' ? [ws, mailboxId, ...args] : args;
        return Response.json(await target[method](...scoped) ?? null);
      }
      if (url.pathname === '/__fixture/sweeper') {
        const { workspace, method, args } = await req.json<{ workspace: string; method: string; args: unknown[] }>();
        if (!['stallTombstones', 'failTombstones', 'failHolds', 'tombstones', 'loseNextRegisterReply', 'holderDetails', 'generation', 'sweepAt', 'registration'].includes(method)) {
          throw new Error('Unknown fixture sweeper method');
        }
        const refs = env.SWEEPER.getByName(workspace) as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>;
        return Response.json(await refs[method](...(method === 'sweepAt' ? [workspace, ...args] : args)) ?? null);
      }
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
          case '/__fixture/seed-legacy-label': return Response.json(await box.seedLegacyLabel(ws, mailboxId!));
          case '/__fixture/events': return Response.json(await box.eventCount(await req.text()));
          case '/__fixture/expiry-starts': return Response.json(await box.expiryStarts());
          case '/__fixture/pause-expiry': await box.pauseExpiry(await req.text()); break;
          case '/__fixture/finish-expiry': await box.finishExpiry(); break;
          case '/__fixture/pending-releases': return Response.json(await box.pendingReleases());
          case '/__fixture/release-retry-at': return Response.json(await box.releaseRetryAt());
          case '/__fixture/confirmations': return Response.json(await box.confirmations());
          case '/__fixture/confirm-batches': return Response.json(await refs.confirmBatches());
          case '/__fixture/confirm-failure': await refs.setConfirmFailure(await req.text() === 'true'); break;
          case '/__fixture/fail-next-confirmation': await refs.failNextConfirmation(); break;
          case '/__fixture/block-later-delta': await box.blockLaterDelta(Number(await req.text())); break;
          case '/__fixture/exposes-legacy-writer': return Response.json(Object.hasOwn(Mailbox.prototype, 'saveDraft'));
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
          case '/__fixture/begin-restore': {
            const target = env.ACCOUNTS[await req.text()];
            await env.MAILBOX.getByName(mailboxName(target.ws, target.mailboxId!)).beginFixtureRestore(target.ws, target.mailboxId!);
            break;
          }
          case '/__fixture/fail-claims': await box.failClaims(Number(await req.text())); break;
          case '/__fixture/failed-claims': return Response.json(await box.failedClaims());
          case '/__fixture/restore-after': {
            time = now(env) + Number(await req.text());
            await box.restoreAfter(ws, mailboxId!, time);
            break;
          }
          case '/__fixture/send-rpc': {
            const { method, args, mb } = await req.json<{ method: string; args: unknown[]; mb?: string }>();
            return Response.json(await box.sendRpc(ws, mb ?? mailboxId!, method, args) ?? null);
          }
          case '/__fixture/pause-sender-check': await box.pauseSenderCheck(await req.text() || 'before'); break;
          case '/__fixture/sender-check-paused': await box.senderCheckPaused(); break;
          case '/__fixture/resume-sender-check': await box.resumeSenderCheck(); break;
          case '/__fixture/crash-after-record-commit': await box.crashAfterRecordCommit(); break;
          case '/__fixture/fail-record-once': {
            const [attempt, times] = (await req.text()).split(',').map(Number);
            await box.failRecordOnce(attempt, times || 1);
            break;
          }
          case '/__fixture/crash-after-claim-release': await box.crashAfterClaimRelease(); break;
          case '/__fixture/crash-after-result-delete': await box.crashAfterResultDelete(); break;
          case '/__fixture/pause-at': await box.pauseAt(await req.text()); break;
          case '/__fixture/arm-arrival': await box.armArrival(await req.text()); break;
          case '/__fixture/arrived': await box.arrived(await req.text()); break;
          case '/__fixture/crash-after-recheck-take': await box.crashAfterRecheckTake(); break;
          case '/__fixture/paused-at': await box.pausedAt(await req.text()); break;
          case '/__fixture/resume-at': await box.resumeAt(await req.text()); break;
          case '/__fixture/quota': {
            const { method, args } = await req.json<{ method: string; args: unknown[] }>();
            const quota = env.SEND_QUOTA.getByName('account') as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>;
            return Response.json(await quota[method](...args) ?? null);
          }
          case '/__fixture/send-state': {
            const mb = req.headers.get('x-fixture-send-mailbox') ?? mailboxId!;
            return Response.json(await env.MAILBOX.getByName(mailboxName(ws, mb)).sendState(await req.text()));
          }
          case '/__fixture/consumer': {
            const { method, args } = await req.json<{ method: string; args: unknown[] }>();
            const consumer = env.SEND_CONSUMER.getByName('consumer') as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>;
            return Response.json(await consumer[method](...args) ?? null);
          }
          case '/__fixture/pause-enqueue': await box.pauseNextEnqueue(); break;
          case '/__fixture/enqueue-paused': await box.enqueuePaused(); break;
          case '/__fixture/resume-enqueue': await box.resumeEnqueue(); break;
          case '/__fixture/send-queue': return Response.json(await box.sendQueue());
          case '/__fixture/email-calls': return Response.json(await box.emailCalls());
          case '/__fixture/crash-after': await box.crashAfter(await req.text() as SendStep); break;
          case '/__fixture/fail-next-epilogue': await box.failNextEpilogue(); break;
          case '/__fixture/bump-builder': await box.bumpBuilder(); break;
          case '/__fixture/mime-builds': return Response.json(await box.mimeBuilds());
          case '/__fixture/mime-requests': return Response.json(await box.mimeRequests());
          case '/__fixture/sent-headers': return Response.json(await box.sentHeaders(ws, await req.text()));
          case '/__fixture/stall-publish': await box.stallPublish(); break;
          case '/__fixture/publish-stalled': await box.publishStalled(); break;
          case '/__fixture/resume-publish': await box.resumePublish(); break;
          case '/__fixture/short-barrier': await box.shortenBarrier(Number(await req.text()) || 200); break;
          case '/__fixture/hold-publish-lane': await box.holdPublishLane(ws); break;
          case '/__fixture/cover-held': await box.coverHeld(); break;
          case '/__fixture/release-held': await box.releaseHeld(); break;
          case '/__fixture/drop-builder': await box.dropBuilder(await req.text() === 'true'); break;
          case '/__fixture/refuse-mime': await box.refuseMime(await req.json()); break;
          case '/__fixture/send-ids': return Response.json(await box.sendIds());
          case '/__fixture/short-handler-budget': await box.shortenHandlerBudget(); break;
          case '/__fixture/send-row': return Response.json(await box.sendRow(await req.text()));
          case '/__fixture/send-driver': return Response.json(await box.sendDriver(await req.text()));
          case '/__fixture/pause-publish-through': await box.pausePublishThrough(Number(await req.text())); break;
          case '/__fixture/publish-through-paused': await box.publishThroughPaused(); break;
          case '/__fixture/resume-publish-through': await box.resumePublishThrough(); break;
          case '/__fixture/drive-idle': await box.driveIdle(); break;
          case '/__fixture/active-alerts': return Response.json(await box.activeAlerts());
          case '/__fixture/send-breaches': return Response.json(await box.sendBreaches());
          case '/__fixture/change-part-digest': await box.changePartDigest(await req.text()); break;
          case '/__fixture/fail-lane-wakeup': await box.failLaneWakeup(await req.text() === 'true'); break;
          case '/__fixture/gate-lane-wakeup': await box.gateLaneWakeup(); break;
          case '/__fixture/lane-wakeup-entered': await box.laneWakeupEntered(); break;
          case '/__fixture/open-lane-wakeup': await box.openLaneWakeup(); break;
          case '/__fixture/set-recipient-state': {
            const { sendId, idx, state } = await req.json<{ sendId: string; idx: number; state: string }>();
            await box.setRecipientState(sendId, idx, state);
            break;
          }
          case '/__fixture/set-send-undo-until': {
            const { sendId, undoUntil } = await req.json<{ sendId: string; undoUntil: number }>();
            await box.setSendUndoUntil(sendId, undoUntil);
            break;
          }
          case '/__fixture/set-send-draft-key': {
            const { sendId, rawKey } = await req.json<{ sendId: string; rawKey: string }>();
            await box.setSendDraftKey(sendId, rawKey);
            break;
          }
          case '/__fixture/change-attachment-size': {
            const { messageId, part, delta } = await req.json<{ messageId: string; part: number; delta: number }>();
            await box.changeAttachmentSize(messageId, part, delta);
            break;
          }
          case '/__fixture/change-attachment-meta': {
            const { messageId, part, name, type } = await req.json<{ messageId: string; part: number; name: string; type: string }>();
            await box.changeAttachmentMeta(messageId, part, name, type);
            break;
          }
          case '/__fixture/drop-synthetic-mark': await box.dropSyntheticMark(await req.text()); break;
          case '/__fixture/seed-forward-draft': return Response.json(await box.seedForwardDraft(ws, mailboxId!, await req.json()));
          case '/__fixture/seed-legacy-api-draft': return Response.json(await box.seedLegacyApiDraft(ws, mailboxId!, await req.json()));
          case '/__fixture/send-switch': {
            const enabled = await req.text() === 'true';
            try { await box.changeSendSwitch(enabled); }
            catch { /* the fixture deliberately aborts the isolate after persisting the override */ }
            break;
          }
          case '/__fixture/lifecycle': return Response.json(await box.lifecycle());
          case '/__fixture/set-reply-to': await box.setReplyTo(ws, mailboxId!, await req.json()); break;
          case '/__fixture/send-registration': return Response.json(await refs.registration(mailboxId!, await req.text()));
          case '/__fixture/generation': return Response.json(await refs.generation(await req.text()));
          case '/__fixture/force-lost': await refs.forceLost(await req.text()); break;
          case '/__fixture/send-release-failure': await refs.setSendReleaseFailure(await req.text() === 'true'); break;
          case '/__fixture/activate-alias': {
            await env.DIRECTORY.prepare("UPDATE addresses SET send_as_policy = 'active' WHERE address_norm = ?").bind(await req.text()).run();
            break;
          }
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
        const mode = req.headers.get('x-fixture-parallel');
        const alarms = req.headers.get('x-fixture-alarms') === 'false' || mode === 'clock-only' ? 0 : mode === 'true' ? 2 : 1;
        await Promise.all(results.map(({ workspace_id, id }) => env.MAILBOX.getByName(mailboxName(workspace_id, id)).advanceClock(time!,
          env.MAIL_DRAFT_UPLOADS_ENABLED === 'on' && (mode === 'all-mailboxes' ||
            (workspace_id === env.ACCOUNTS.member.ws && id === env.ACCOUNTS.member.mailboxId)) ? alarms : 0)));
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
    const allow = { async limit() { return { success: true }; } };
    const port: MailApiEnvironment = {
      MAIL_RATE_READS: allow, MAIL_RATE_WRITES: allow, MAIL_RATE_UPLOADS: allow, MAIL_RATE_SENDS: limiter('MAIL_RATE_SENDS'),
      MAIL_RATE_UNDO: limiter('MAIL_RATE_UNDO'), MAIL_RATE_UNDO_FLOOD: limiter('MAIL_RATE_UNDO_FLOOD'), MAIL_RATE_ADMIN_WRITES: allow,
      MAIL_LOCAL_API: 'on', MAIL_DRAFT_UPLOADS_ENABLED: env.MAIL_DRAFT_UPLOADS_ENABLED, MAIL_SEND_ENABLED: env.MAIL_SEND_ENABLED,
      MAILBOX: mailboxPort(env), DIRECTORY: env.DIRECTORY,
      MAIL_DEV_SESSION: { resolve, members: async (ws) => [...new Map(Object.values(env.ACCOUNTS).filter((p) => p.ws === ws).map((p) => [p.userId, p])).values()]
        .map((p) => ({ id: p.userId, name: p.name, email: p.address, status: p.status ?? 'active' })) },
      LINK_USAGE: fileLinkUsage(env.DIRECTORY),
      MAIL_CONTENT_ENABLED: 'on', MAIL_CONTENT_ORIGIN: env.REAL_CONTENT_ORIGIN ?? contentOrigin(url, env),
      MAIL_CONTENT: env.MAIL_CONTENT ?? { mintForWeb: (purpose, claims) => mint(contentOrigin(url, env), purpose, claims, env) },
    };
    if (req.headers.get('x-fixture-watch-body') === 'true' && req.body) {
      const reader = req.body.getReader();
      let firstPull = true;
      req = new Request(req, { body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (firstPull) {
            firstPull = false;
            await fetch('https://object-store.example.test/fixture-body-read', { method: 'POST' });
          }
          const { done, value } = await reader.read();
          if (done) { reader.releaseLock(); controller.close(); }
          else controller.enqueue(value);
        },
        cancel: reason => reader.cancel(reason),
      }, { highWaterMark: 0 }) });
    }
    return handleMailApi(req, port);
  },
};
