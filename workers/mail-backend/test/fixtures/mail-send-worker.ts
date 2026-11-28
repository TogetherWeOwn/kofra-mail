// A test-only HTTP entrypoint to inspect individual ack/retry decisions. The
// separate native queue path exercises Miniflare's retry/DLQ implementation.
import type { SendFence } from '../../src/mailbox-send-quota.ts';
import type { EmailBinding } from '../../src/send-consumer.ts';
import { consumeBatch, type Env } from '../../../mail-send/src/entry.ts';

type FixtureEnv = Env & { PROBE: Fetcher; FIXTURE_EMAIL: boolean; FIXTURE_TRACK_AUTH: boolean };
type Grant = { sendId: string; fence: SendFence; deadline: number };
export type ProviderStart = { now: number; grant: Grant | null };
const binding = (env: FixtureEnv, start: () => ProviderStart): EmailBinding => ({ async send(request) {
  const response = await env.PROBE.fetch('https://fixture.internal/email', { method: 'POST', body: JSON.stringify(request),
    ...(env.FIXTURE_TRACK_AUTH && { headers: { 'x-fixture-provider-start': JSON.stringify(start()) } }) });
  if (!response.ok) throw Object.assign(new Error('Fixture provider rejection'), await response.json());
  return response.json();
} });

function handle(batch: Pick<MessageBatch<unknown>, 'messages' | 'queue'>, env: FixtureEnv, now: () => number) {
  let grant: Grant | null = null;
  const mailbox: Env['MAILBOX'] = { getByName(name) {
    const box = env.MAILBOX.getByName(name);
    const authorize: typeof box.authorizeDispatch = async (...args) => {
      const requested = now();
      const answer = await box.authorizeDispatch(...args);
      grant = answer.status === 'ok' ? { sendId: args[2], fence: args[3], deadline: requested + answer.remainingMs } : null;
      return answer;
    };
    return {
      authorizeDispatch: authorize,
      claimSend: (...args) => box.claimSend(...args),
      markSend: (...args) => box.markSend(...args),
      sendRequest: (...args) => box.sendRequest(...args),
      recordResult: (...args) => box.recordResult(...args),
      delaySend: (...args) => box.delaySend(...args),
      abandonClaim: (...args) => box.abandonClaim(...args),
      recordStoredResults: (...args) => box.recordStoredResults(...args),
      recordSendEvent: (...args) => box.recordSendEvent(...args),
    };
  } };
  return consumeBatch(batch, { ...env, MAILBOX: env.FIXTURE_TRACK_AUTH ? mailbox : env.MAILBOX,
    EMAIL: env.FIXTURE_EMAIL ? binding(env, () => ({ grant, now: now() })) : undefined, SEND: { async send(notice) {
      await env.PROBE.fetch('https://fixture.internal/notice', { method: 'POST', body: JSON.stringify(notice) });
    } } }, now);
}

export default {
  async queue(batch: MessageBatch<unknown>, env: FixtureEnv) { await handle(batch, env, Date.now); },
  async fetch(request: Request, env: FixtureEnv) {
    const { queue, body, now } = await request.json<{ queue: string; body: unknown; now: number }>();
    const calls: string[] = [];
    const message: Message<unknown> = {
      id: 'fixture-delivery-id', body, timestamp: new Date(now), attempts: 1,
      ack: () => { calls.push('ack'); }, retry: () => { calls.push('retry'); },
    };
    await handle({ queue, messages: [message] }, env, () => now);
    return Response.json(calls);
  },
};
