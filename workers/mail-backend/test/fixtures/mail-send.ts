import assert from 'node:assert/strict';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { build } from 'esbuild';
import { Response, type Request } from 'miniflare';
import type { ResultNotice } from '../../src/send-consumer.ts';
import type { SendDispatch } from '../../src/worker.ts';
import { startMailHttpFixture } from './mail-http.ts';
import type { ProviderStart } from './mail-send-worker.ts';

export const SEND = 'send', DLQ = 'send-dlq';
export const WS = 'w1', MB = 'mailbox-a';
export const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// The fixture clock starts at the real clock, never at a fixed date. Mailbox
// calls outside a fixture alarm (a restore's journal wake-up, for example) read
// the platform clock, which a test cannot set; a test that advances to such a
// timer jumps the fixture clock to the real time, so a start that falls behind
// the real clock eventually jumps a test past its quota day.
// The real quota's daily reset sits a fixed time after the start, so every run
// reaches the same quota-day boundaries.
const RESET_AFTER = 3 * HOUR;
// The quota day (its label) `days` after the one the fixture starts in.
export const quotaDay = (startedAt: number, days = 0) => new Date(startedAt + RESET_AFTER + (days - 1) * DAY).toISOString().slice(0, 10);
const entry = fileURLToPath(new NodeURL('./mail-send-worker.ts', import.meta.url));
const compiled = () => build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm',
  external: ['cloudflare:workers'], write: false });
let bundle: ReturnType<typeof compiled> | undefined;

type RealQuota = NonNullable<Parameters<typeof startMailHttpFixture>[0]>['realQuota'];

export async function startMailSendFixture({ quota = true, email = true, environment = 'test', realQuota }: {
  quota?: boolean; email?: boolean; environment?: string; realQuota?: RealQuota;
} = {}) {
  const { outputFiles } = await (bundle ??= compiled());
  const notices: ResultNotice[] = [];
  const noticeStatuses: number[] = [];
  const alerts: { body: string; key: string | null }[] = [];
  const alerted = Promise.withResolvers<void>();
  const alertStatuses: number[] = [];
  const providerErrors: string[] = [];
  const providerStarts: ProviderStart[] = [];
  let emailCalls = 0;
  const probe = async (request: Request) => {
    switch (new URL(request.url).pathname) {
      case '/notice': {
        const batch = await request.json() as ResultNotice | ResultNotice[];
        const status = noticeStatuses.shift() ?? 204;
        if (status === 204) notices.push(...(Array.isArray(batch) ? batch : [batch]));
        return new Response(null, { status });
      }
      case '/email': {
        emailCalls++;
        const start = request.headers.get('x-fixture-provider-start');
        if (start) providerStarts.push(JSON.parse(start) as ProviderStart);
        const code = providerErrors.shift();
        return Response.json(code ? { code } : { messageId: 'provider-acceptance' }, { status: code ? 400 : 200 });
      }
      case '/v1/alert': {
        alerts.push({ body: await request.text(), key: request.headers.get('idempotency-key') });
        alerted.resolve();
        return new Response(null, { status: alertStatuses.shift() ?? 204 });
      }
      default: throw new Error('Unexpected outbound fixture request');
    }
  };
  // Whole minutes: the reset is configured as HH:MM.
  const startedAt = Math.floor(Date.now() / MINUTE) * MINUTE;
  const reset = new Date(startedAt + RESET_AFTER).toISOString().slice(11, 16);
  const h = await startMailHttpFixture({ send: true, startedAt, realQuota: realQuota && { reset, ...realQuota }, configureWorkers(backend, workers) {
    backend.serviceBindings = { ...backend.serviceBindings, SEND_PROBE: probe, ALERTS: probe };
    backend.bindings = { ...backend.bindings, MAIL_ENVIRONMENT: environment };
    workers.push({
      name: 'mail-send', compatibilityDate: '2026-06-25',
      modules: [{ type: 'ESModule', path: 'mail-send-fixture.mjs', contents: outputFiles[0].text }],
      durableObjects: { MAILBOX: { className: 'HttpMailbox', scriptName: 'mail-backend' },
        ...(quota && { SEND_QUOTA: { className: realQuota ? 'RealSendQuota' : 'FakeSendQuota', scriptName: 'mail-backend' } }) },
      d1Databases: ['DIRECTORY'], serviceBindings: { ALERTS: probe, PROBE: probe },
      bindings: { MAIL_SEND_ENABLED: 'on', MAIL_ENVIRONMENT: environment, SEND_QUEUE_NAME: SEND, SEND_DLQ_NAME: DLQ, FIXTURE_EMAIL: email,
        FIXTURE_TRACK_AUTH: !!realQuota },
      queueProducers: { SEND, FIXTURE_DLQ: DLQ },
      queueConsumers: { [SEND]: { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 3, deadLetterQueue: DLQ },
        [DLQ]: { maxBatchSize: 1, maxBatchTimeout: 0 } },
    });
  } });
  const send = await h.worker('mail-send');
  const queue = await h.queue('SEND', 'mail-send');
  return Object.assign(h, {
    async batch(queue: string, body: unknown) {
      const res = await send.fetch('https://fixture.internal/batch', { method: 'POST',
        body: JSON.stringify({ queue, body, now: await h.sends.now() }) });
      assert.equal(res.status, 200);
      return await res.json() as string[];
    },
    submit: (body: SendDispatch) => queue.send(body),
    alerts, alerted: alerted.promise, alertStatuses, notices, noticeStatuses, providerErrors, providerStarts,
    providerCalls: () => emailCalls,
  });
}
