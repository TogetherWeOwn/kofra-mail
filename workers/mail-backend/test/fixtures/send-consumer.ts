import { DurableObject } from 'cloudflare:workers';
import type { QuotaPort, SendFence } from '../../src/mailbox-send-quota.ts';
import type { SendRequest } from '../../src/send-mime.ts';
import {
  dispatchSend, storeSendResult, type ConsumerMailbox, type ConsumerPorts, type DispatchOutcome, type ResultNotice,
} from '../../src/send-consumer.ts';
import { mailboxName, type SendDispatch } from '../../src/worker.ts';

// The send consumer's dispatch core (M3-5b) run inside local workerd against
// the real Mailbox object and the recording quota fake, with a scripted fake
// EMAIL binding, a fake result-notice producer, the real D1 send_results
// table and a controllable clock. Every port is wrapped with seams a test can
// pause at, fail once, or "crash" at: a crashed run's later port calls all
// fail and change nothing, as if its isolate had died.

type Env = {
  MAILBOX: { getByName(name: string): ConsumerMailbox & { sendQueue(): Promise<unknown[]> } };
  SEND_QUOTA: { getByName(name: string): unknown };
  DIRECTORY: D1Database;
};

// What the fake EMAIL binding does with the next call. `hold` waits at the
// 'email' seam (the call has started) and then does `then`.
export type EmailBehaviour =
  | { result: 'accept'; messageId?: string | null; value?: unknown }
  | { result: 'reject'; code?: string; typeError?: boolean }
  | { result: 'throw'; code?: string }
  | { result: 'hold'; then: EmailBehaviour };

// One send() call, on three clocks: the consumer's, the harness's real time,
// and the authorizing mailbox's clock at that real time.
export type EmailCall = {
  n: number; sendId: string; fence: SendFence | null; deadline: number | null; consumerNow: number; real: number; authClock: number;
  to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; replyTo: string | null; headers: Record<string, string>;
  attachments: { filename: string; type: string; size: number }[];
};

class FixtureCrash extends Error { constructor() { super('Fixture consumer crashed'); } }
type Run = { dead: boolean; auth: { fence: SendFence; deadline: number; lead: number } | null; checked?: boolean };
// `wait`: the run waits there until resumed; `crash`: the run dies there (at once, or when resumed).
type Gate = { reached: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void>; wait: boolean; crash: boolean; taken?: boolean };

const address = (value: unknown) => typeof value === 'string' ? value : (value as { email: string }).email;
const addresses = (value: unknown) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(address);

export function sendConsumerFixture(mailboxNow: (env: never) => number) {
  return class SendConsumer extends DurableObject<Env> {
    private mailboxLead = 0;
    private consumerLead = 0;
    private readonly script: EmailBehaviour[] = [];
    private readonly calls: EmailCall[] = [];
    private readonly requests: SendRequest[] = [];
    private readonly notices: ResultNotice[] = [];
    private readonly gates = new Map<string, Gate>();
    private readonly failures = new Map<string, number>();
    private readonly consumed = new Map<string, number>();
    private messages = 0;

    private mailboxClock() { return mailboxNow(this.env as never); }
    private real() { return this.mailboxClock() - this.mailboxLead; }
    private consumerNow() { return this.real() + this.consumerLead; }

    // Test controls.
    setLeads(leads: { mailbox?: number; consumer?: number }) {
      if (leads.mailbox !== undefined) this.mailboxLead = leads.mailbox;
      if (leads.consumer !== undefined) this.consumerLead = leads.consumer;
    }
    leads() { return { mailbox: this.mailboxLead, consumer: this.consumerLead, real: this.real(), consumerNow: this.consumerNow() }; }
    scriptEmail(behaviours: EmailBehaviour[]) { this.script.push(...behaviours); }
    emailCalls() { return this.calls; }
    // The n-th call's whole request, with attachment bytes in base64.
    emailRequest(n: number) {
      const request = this.requests[n - 1];
      const attachments = (request.attachments ?? []).map(({ content, ...rest }) => ({ ...rest,
        content: typeof content === 'string' ? content : btoa(String.fromCharCode(...new Uint8Array(content instanceof ArrayBuffer ? content
          : (content as ArrayBufferView).buffer.slice((content as ArrayBufferView).byteOffset, (content as ArrayBufferView).byteOffset + (content as ArrayBufferView).byteLength)))) }));
      return { ...request, attachments };
    }
    resultNotices() { return this.notices; }
    failNext(method: string, times = 1) { this.failures.set(method, times); }
    // Arms a trap on the deadline check: the first clock read after the authorization schedules
    // a microtask that moves the consumer's clock to the deadline, so any yield between that check
    // and the call lets the call start at the deadline.
    private yieldTrap = false;
    trapYieldAfterCheck(armed: boolean) { this.yieldTrap = armed; }
    // An environment without the send_email binding.
    private bindingMissing = false;
    removeBinding(missing: boolean) { this.bindingMissing = missing; }
    pauseAt(point: string) {
      this.gates.set(point, { reached: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>(), wait: true, crash: false });
    }
    crashAt(point: string) {
      this.gates.set(point, { reached: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>(), wait: false, crash: true });
    }
    async pausedAt(point: string) { await this.gates.get(point)!.reached.promise; }
    // `crash`: the paused run dies instead of going on.
    resumeAt(point: string, crash = false) {
      const gate = this.gates.get(point);
      this.gates.delete(point);
      if (!gate) return;
      gate.crash = crash;
      gate.resume.resolve();
    }
    dispatched() { return this.messages; }
    // A restore wipes the mailbox's recorded queue: drain from its start again.
    resetDrain(ws: string, mb: string) { this.consumed.delete(mailboxName(ws, mb)); }

    private async seam(run: Run, point: string) {
      if (run.dead) throw new FixtureCrash();
      const gate = this.gates.get(point);
      // Only the first run through an armed seam stops there.
      if (!gate || gate.taken) return;
      gate.taken = true;
      gate.reached.resolve();
      if (gate.wait) await gate.resume.promise;
      else this.gates.delete(point);
      if (gate.crash) run.dead = true;
      if (run.dead) throw new FixtureCrash();
    }
    private failure(method: string) {
      const left = this.failures.get(method) ?? 0;
      if (left <= 0) return;
      this.failures.set(method, left - 1);
      throw new Error(`Fixture ${method} failure`);
    }
    // A port method with its seams: before:<name>, a scripted failure, the call, after:<name>.
    private async step<T>(run: Run, name: string, call: () => Promise<T>): Promise<T> {
      await this.seam(run, `before:${name}`);
      this.failure(name);
      const value = await call();
      await this.seam(run, `after:${name}`);
      return value;
    }

    private ports(run: Run, message: SendDispatch): ConsumerPorts {
      const self = this;
      const box = this.env.MAILBOX.getByName(mailboxName(message.ws, message.mb));
      const mailbox: ConsumerMailbox = {
        claimSend: (...args) => this.step(run, 'claimSend', () => box.claimSend(...args)),
        markSend: (...args) => this.step(run, 'markSend', () => box.markSend(...args)),
        sendRequest: (...args) => this.step(run, 'sendRequest', () => box.sendRequest(...args)),
        authorizeDispatch: async (...args) => {
          const t0 = this.consumerNow();
          const lead = this.mailboxLead;
          const answer = await this.step(run, 'authorizeDispatch', () => box.authorizeDispatch(...args));
          if (answer.status === 'ok') run.auth = { fence: args[3], deadline: t0 + answer.remainingMs, lead };
          return answer;
        },
        recordResult: (...args) => this.step(run, 'recordResult', () => box.recordResult(...args)),
        delaySend: (...args) => this.step(run, 'delaySend', () => box.delaySend(...args)),
        abandonClaim: (...args) => this.step(run, 'abandonClaim', () => box.abandonClaim(...args)),
      };
      const stub = this.env.SEND_QUOTA.getByName('account') as QuotaPort;
      const quota: QuotaPort = {
        reserve: (...args) => this.step(run, 'reserve', () => stub.reserve(...args)),
        confirm: (...args) => this.step(run, 'confirm', () => stub.confirm(...args)),
        release: (...args) => this.step(run, 'release', () => stub.release(...args)),
        resetAt: () => this.step(run, 'resetAt', () => stub.resetAt()),
      };
      return {
        mailbox: () => mailbox,
        quota: () => quota,
        request: (dispatch, fence) => mailbox.sendRequest(dispatch.ws, dispatch.mb, dispatch.sendId, fence),
        email: () => this.bindingMissing ? undefined : { send(request: SendRequest) { return self.email(run, message, request); } },
        storeResult: row => this.step(run, 'storeResult', () => storeSendResult(this.env.DIRECTORY, row)),
        notify: notice => this.step(run, 'notify', async () => { this.notices.push(notice); }),
        now: () => {
          const now = this.consumerNow();
          if (this.yieldTrap && run.auth && !run.checked) {
            run.checked = true;
            const { deadline } = run.auth;
            queueMicrotask(() => { this.consumerLead += deadline - this.consumerNow(); });
          }
          return now;
        },
      };
    }

    // The fake EMAIL binding: records the call synchronously when it starts.
    private email(run: Run, message: SendDispatch, request: SendRequest): Promise<unknown> {
      if (run.dead) throw new FixtureCrash();
      const real = this.real();
      const auth = run.auth;
      const { attachments = [], headers = {}, replyTo, subject, text } = request as SendRequest & { text?: string; subject?: string };
      this.calls.push({
        n: this.calls.length + 1, sendId: message.sendId, fence: auth?.fence ?? null, deadline: auth?.deadline ?? null, consumerNow: this.consumerNow(),
        real, authClock: real + (auth?.lead ?? this.mailboxLead), to: addresses(request.to), cc: addresses(request.cc), bcc: addresses(request.bcc),
        subject: subject ?? '', text: text ?? '', replyTo: replyTo === undefined ? null : address(replyTo), headers: { ...headers },
        attachments: attachments.map(({ filename, type, content }) => ({ filename, type: type ?? '',
          size: typeof content === 'string' ? content.length : (content as ArrayBuffer | ArrayBufferView).byteLength })),
      });
      this.requests.push(request);
      const behaviour = this.script.shift() ?? { result: 'accept' };
      return this.behave(run, behaviour);
    }
    private behave(run: Run, behaviour: EmailBehaviour): Promise<unknown> {
      const coded = (code?: string, typeError = false) => Object.assign(typeError ? new TypeError('Fixture send error') : new Error('Fixture send error'),
        code === undefined ? {} : { code });
      switch (behaviour.result) {
        case 'accept': return Promise.resolve(behaviour.value !== undefined ? behaviour.value
          : { messageId: behaviour.messageId === undefined ? `provider-${this.calls.length}` : behaviour.messageId });
        case 'reject': return Promise.reject(coded(behaviour.code, behaviour.typeError));
        case 'throw': throw coded(behaviour.code);
        case 'hold': return (async () => {
          await this.seam(run, 'email').catch(() => {});
          return this.behave(run, behaviour.then);
        })();
      }
    }

    // One queue delivery of a message to the consumer.
    async consume(message: unknown): Promise<DispatchOutcome | { crashed: true; outcome: DispatchOutcome }> {
      this.messages++;
      const run: Run = { dead: false, auth: null };
      const ports = typeof message === 'object' && message ? this.ports(run, message as SendDispatch) : this.ports(run, { kind: 'dispatch', ws: '', mb: '', sendId: '' });
      const outcome = await dispatchSend(message, ports);
      return run.dead ? { crashed: true, outcome } : outcome;
    }

    // Delivers every dispatch message the mailbox enqueued since the last drain, in order.
    async drain(ws: string, mb: string): Promise<(DispatchOutcome | { crashed: true; outcome: DispatchOutcome })[]> {
      const name = mailboxName(ws, mb);
      const queue = await this.env.MAILBOX.getByName(name).sendQueue() as SendDispatch[];
      const from = this.consumed.get(name) ?? 0;
      this.consumed.set(name, queue.length);
      const outcomes = [];
      for (const message of queue.slice(from)) outcomes.push(await this.consume(message));
      return outcomes;
    }
  };
}
