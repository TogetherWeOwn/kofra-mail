// A test-only HTTP entrypoint to inspect individual ack/retry decisions. The
// separate native queue path exercises Miniflare's retry/DLQ implementation.
import type { EmailBinding } from '../../src/send-consumer.ts';
import { consumeBatch, type Env } from '../../../mail-send/src/entry.ts';

type FixtureEnv = Env & { PROBE: Fetcher; FIXTURE_EMAIL: boolean };
const binding = (env: FixtureEnv): EmailBinding => ({ async send(request) {
  const response = await env.PROBE.fetch('https://fixture.internal/email', { method: 'POST', body: JSON.stringify(request) });
  if (!response.ok) throw Object.assign(new Error('Fixture provider rejection'), await response.json());
  return response.json();
} });

function handle(batch: Pick<MessageBatch<unknown>, 'messages' | 'queue'>, env: FixtureEnv, now: () => number) {
  return consumeBatch(batch, { ...env, EMAIL: env.FIXTURE_EMAIL ? binding(env) : undefined, SEND: { async send(notice) {
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
