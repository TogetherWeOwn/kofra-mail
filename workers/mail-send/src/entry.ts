import { mailAlert, type AlertBinding } from '../../mail-backend/src/alerts.ts';
import type { StoredAnswer } from '../../mail-backend/src/mailbox-send-dispatch.ts';
import { validFence, type QuotaPort, type QuotaScope, type SendFence } from '../../mail-backend/src/mailbox-send-quota.ts';
import { validSendId } from '../../mail-backend/src/mailbox-send-store.ts';
import { sendAlertEnvironment } from '../../mail-backend/src/send-alert-events.ts';
import { dispatchSend, storeSendResult, type ConsumerMailbox, type EmailBinding, type ResultNotice } from '../../mail-backend/src/send-consumer.ts';
import { mailboxName } from '../../mail-backend/src/worker.ts';

type Namespace<T> = { getByName(name: string): T };
type QuotaEvent = 'send_quota_failed' | 'send_stale_release_failed';
type SendMailbox = ConsumerMailbox & {
  recordStoredResults(ws: string, mb: string, sendId: string, fence: SendFence): Promise<StoredAnswer>;
  recordSendEvent(ws: string, mb: string, code: QuotaEvent): Promise<void>;
};
export type Env = {
  MAIL_SEND_ENABLED?: string;
  MAIL_ENVIRONMENT: string;
  SEND_QUEUE_NAME: string;
  SEND_DLQ_NAME: string;
  SEND: { send(notice: ResultNotice): Promise<unknown> };
  DIRECTORY: Pick<D1Database, 'prepare'>;
  MAILBOX: Namespace<SendMailbox>;
  ALERTS: AlertBinding;
  // M3-6 supplies the account quota binding. Until then it is only present in
  // tests. A missing binding refuses dispatch even if both flags are on.
  SEND_QUOTA?: Namespace<QuotaPort>;
  EMAIL?: EmailBinding;
};

function isNotice(value: unknown): value is ResultNotice {
  if (!value || typeof value !== 'object') return false;
  const { kind, ws, mb, sendId, fence } = value as Partial<ResultNotice>;
  return kind === 'result' && typeof ws === 'string' && ws.length > 0 && typeof mb === 'string' && mb.length > 0 &&
    validSendId(sendId) && validFence(fence);
}

function quotaPort(env: Env, mailbox: (ws: string, mb: string) => SendMailbox): QuotaPort {
  const account = () => {
    if (!env.SEND_QUOTA) throw new Error('Send quota binding missing');
    return env.SEND_QUOTA.getByName('account');
  };
  const call = async <T>(scope: QuotaScope, code: QuotaEvent, run: (port: QuotaPort) => Promise<T>): Promise<T> => {
    try { return await run(account()); }
    catch (error) {
      const { workspaceId, mailboxId } = scope;
      try { await mailbox(workspaceId, mailboxId).recordSendEvent(workspaceId, mailboxId, code); }
      catch { console.error({ code: 'send_alert_store_failed' }); }
      throw error;
    }
  };
  return {
    reserve: (scope, ...args) => call(scope, 'send_quota_failed', port => port.reserve(scope, ...args)),
    confirm: (scope, ...args) => call(scope, 'send_quota_failed', port => port.confirm(scope, ...args)),
    release: (scope, ...args) => call(scope, 'send_stale_release_failed', port => port.release(scope, ...args)),
    resetAt: async () => account().resetAt(),
  };
}

export async function consumeBatch(batch: Pick<MessageBatch<unknown>, 'queue' | 'messages'>, env: Env, now = Date.now): Promise<void> {
  const mailbox = (ws: string, mb: string) => env.MAILBOX.getByName(mailboxName(ws, mb));
  for (const message of batch.messages) {
    if (batch.queue === env.SEND_DLQ_NAME) {
      try {
        const environment = sendAlertEnvironment(env.MAIL_ENVIRONMENT);
        await mailAlert(env.ALERTS)({ code: 'send_dlq', environment, time: message.timestamp.getTime(),
          occurrence: JSON.stringify(['send-dlq', environment, message.id]) });
        message.ack();
      } catch { message.retry(); }
    } else if (batch.queue === env.SEND_QUEUE_NAME) {
      const value = message.body;
      if (isNotice(value)) {
        try { await mailbox(value.ws, value.mb).recordStoredResults(value.ws, value.mb, value.sendId, value.fence); }
        catch { console.error({ code: 'send_notice_rpc_failed' }); }
        // A notice is only a hint. The mailbox may back off its row while
        // restoring; a failed RPC still leaves the durable row for the cron.
        message.ack();
      } else if (env.MAIL_SEND_ENABLED !== 'on') {
        message.ack();
      } else {
        try {
          const outcome = await dispatchSend(value, {
            mailbox, quota: () => quotaPort(env, mailbox), now,
            request: ({ ws, mb, sendId }, fence) => mailbox(ws, mb).sendRequest(ws, mb, sendId, fence),
            email: () => env.EMAIL,
            storeResult: row => storeSendResult(env.DIRECTORY, row),
            notify: async notice => { await env.SEND.send(notice); },
          });
          if (outcome.ack) message.ack();
          else message.retry();
        } catch {
          console.error({ code: 'send_dispatch_failed' });
          message.retry();
        }
      }
    } else {
      console.error({ code: 'send_queue_unexpected' });
      message.retry();
    }
  }
}

export default { queue: (batch: MessageBatch<unknown>, env: Env) => consumeBatch(batch, env) };
