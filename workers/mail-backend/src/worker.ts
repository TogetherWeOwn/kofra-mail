import { ulid } from 'ulid';
import { mailAlert, type AlertBinding } from './alerts.ts';
import type { ObjectKind } from './object-key.ts';
import type { ConfirmAnswer, ConfirmEntry, HoldTarget, SendHolders, SendRegistration, SendReleaseMode } from './sweep-ledger.ts';
import { deliver, dlq } from './deliver.ts';
import { lookupRecipient } from './directory.ts';
import { receive, type InboundMail } from './inbound.ts';
import { kofra, type KofraConfig } from './kofra.ts';
import { MailAlerts } from './mail-alerts.ts';
import { mailboxName } from './mailbox-name.ts';
import type { SendQuotaBinding } from './mailbox-send-quota.ts';
import { deliveryHolder, reconcileHandoffs, type HandoffPorts } from './internal-handoff.ts';
import { Outbox, type DeliverySource } from './outbox.ts';
import { reconcile } from './reconcile.ts';
import { reconcileSendResults, type NoticeBatchProducer } from './reconcile-send-results.ts';
import { sendAlertEnvironment } from './send-alert-events.ts';
import { sweepLinkObjects, type LinkDisposition } from './link-sweep.ts';
import type { LinkDatabase } from '../../../packages/link-storage/src/store.ts';

export type ObjectReferences = {
  register(kind: ObjectKind, digest: string, holder: string): Promise<string>;
  hold(key: string, holder: string): Promise<void>;
  release(key: string, holder: string): Promise<void>;
};
// The Sweeper Durable Object's RPC surface, including provisional holders
// (docs/m3-outbound-plan.md, section 2.7).
export type SweeperReferences = ObjectReferences & {
  holdProvisional(target: HoldTarget, holder: string): Promise<string>;
  confirm(entries: ConfirmEntry[]): Promise<ConfirmAnswer[]>;
  // The send registration of section 2.4, release step 3 (M3-3).
  registerSend(mailbox: string, sendId: string, digest: string, holders: SendHolders): Promise<SendRegistration>;
  releaseSend(mailbox: string, sendId: string, mode: SendReleaseMode): Promise<void>;
  // Releases a handoff's or an internal delivery's holder as a tombstone (M3-8).
  releaseTombstoned(key: string, holder: string): Promise<void>;
};
// The send queue's dispatch message (section 1): ids only.
export type SendDispatch = { kind: 'dispatch'; ws: string; mb: string; sendId: string };
export type MailboxDelivery = { deliver(id: string): Promise<'indexed' | 'deferred' | 'rejected'>;
  linkObjectDisposition?(ws: string, mb: string, upload: string): Promise<LinkDisposition> };
type Namespace<T> = { getByName(name: string): T };

export type Env = KofraConfig & import('./link-uploads.ts').LinkUploadEnv & {
  MAIL_BACKEND_ENABLED?: string;
  MAIL_LOCAL_API?: string;
  MAIL_DRAFT_UPLOADS_ENABLED?: string;
  MAIL_CONTENT_ENABLED?: string;
  MAIL_RECOVERY_ENABLED?: string;
  MAIL_SWEEP_ENABLED?: string;
  // The send path (docs/m3-outbound-plan.md, section 1): off unless 'on'.
  MAIL_SEND_ENABLED?: string;
  // The bound on clock differences of the send path, in seconds (default 30).
  MAIL_SEND_CLOCK_SKEW_SECONDS?: string;
  MAIL_ENVIRONMENT?: string;
  // Secret: the link storage credential KEK (packages/link-storage, kek.ts).
  LINK_CRED_KEK?: string;
  // File links (M3-13): the host new links are made on (a DNS name; each link freezes it),
  // and the per-link download budgets as multiples of the file size (100 per hour, 1,000 in total by default).
  LINK_HOST?: string;
  LINK_TEST_EXPIRY_SECONDS?: string;
  LINK_HOURLY_FACTOR?: string;
  LINK_TOTAL_FACTOR?: string;
  SEND?: { send(message: SendDispatch): Promise<unknown> } & Partial<NoticeBatchProducer>;
  SEND_QUOTA?: SendQuotaBinding;
  DIRECTORY: D1Database;
  DELIVER: Queue<string>;
  DELIVERY_QUEUE_NAME: string;
  DEAD_LETTER_QUEUE_NAME: string;
  ALERTS?: AlertBinding;
  SWEEPER: Namespace<SweeperReferences>;
  MAILBOX: Namespace<MailboxDelivery> & { idFromName(name: string): DurableObjectId };
  MAIL_STATE: R2Bucket;
};

export { mailboxName } from './mailbox-name.ts';

// A delivery's holder after its mailbox indexed it: an internal child's is
// tombstoned (section 2.4, release step 6), an inbound one's deleted.
export function releaseDeliveryHolder(sweeper: Pick<SweeperReferences, 'release' | 'releaseTombstoned'>, key: string, id: string,
  source: DeliverySource): Promise<void> {
  const holder = deliveryHolder(id);
  return source === 'internal' ? sweeper.releaseTombstoned(key, holder) : sweeper.release(key, holder);
}

export function enabled(env: { MAIL_BACKEND_ENABLED?: string }): boolean {
  return env.MAIL_BACKEND_ENABLED === 'on';
}

function queueNames(env: Partial<Env>): void {
  if (!env.DELIVERY_QUEUE_NAME || !env.DEAD_LETTER_QUEUE_NAME || env.DELIVERY_QUEUE_NAME === env.DEAD_LETTER_QUEUE_NAME) {
    throw new Error('Mail queue names missing or not distinct');
  }
}

export async function handleEmail(message: InboundMail, env: Partial<Env>): Promise<void> {
  if (!enabled(env)) throw new Error('Mail backend is disabled');
  const { DIRECTORY, DELIVER, SWEEPER, MAILBOX, MAIL_STATE } = env;
  if (!DIRECTORY || !DELIVER || !SWEEPER || !MAILBOX || !MAIL_STATE) throw new Error('Mail ingress bindings missing');
  queueNames(env);
  const outbox = new Outbox(DIRECTORY);
  await receive(message, {
    lookup: to => lookupRecipient(DIRECTORY, to),
    register: (workspaceId, digest, id) => SWEEPER.getByName(workspaceId).register('raw', digest, `delivery:${id}`),
    put: (workspaceId, key, bytes) => kofra(env, workspaceId).put(key, bytes),
    insert: row => outbox.insert(row),
    send: async id => { await DELIVER.send(id); },
    newId: now => ulid(now),
    now: Date.now,
  });
}

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  if (!enabled(env)) throw new Error('Mail backend is disabled');
  queueNames(env);
  if (batch.queue !== env.DELIVERY_QUEUE_NAME && batch.queue !== env.DEAD_LETTER_QUEUE_NAME) {
    throw new Error('Unexpected mail queue');
  }
  const outbox = new Outbox(env.DIRECTORY);
  const mailAlerts = new MailAlerts(env.DIRECTORY);
  for (const message of batch.messages) {
    try {
      if (batch.queue === env.DEAD_LETTER_QUEUE_NAME) {
        await dlq(message.body, ({ deliveryId }) => mailAlerts.recordDlq(deliveryId ?? null, message.id, Date.now()));
      } else {
        await deliver(message.body, {
          outbox,
          index: (workspaceId, mailboxId, id) => env.MAILBOX.getByName(mailboxName(workspaceId, mailboxId)).deliver(id),
          release: (workspaceId, key, id, source) => releaseDeliveryHolder(env.SWEEPER.getByName(workspaceId), key, id, source),
          now: Date.now,
        }, message.id);
      }
      message.ack();
    } catch {
      message.retry();
    }
  }
}

// The pipeline's handoff ports in the backend Worker.
export function handoffPorts(env: Env): HandoffPorts {
  return {
    db: env.DIRECTORY,
    sweeper: workspaceId => env.SWEEPER.getByName(workspaceId),
    put: (workspaceId, key, bytes) => kofra(env, workspaceId).put(key, bytes),
    enqueue: async id => { await env.DELIVER.send(id); },
  };
}

export async function handleScheduled(_event: ScheduledController, env: Env, now = Date.now): Promise<void> {
  if (!enabled(env)) return;
  queueNames(env);
  // Delayed cron invocations reserve work from the time they actually run.
  const sendBatch = env.SEND?.sendBatch?.bind(env.SEND);
  const outbound = env.MAIL_SEND_ENABLED === 'on' && sendBatch
    ? (async () => {
      sendAlertEnvironment(env.MAIL_ENVIRONMENT);
      await reconcileSendResults(env.DIRECTORY, { sendBatch }, now());
    })().catch(() => console.error({ code: 'send_result_reconcile_failed' }))
    : undefined;
  // Internal handoffs (M3-8): unexpanded accepted handoffs, pending holder releases and old tombstones.
  const handoffs = reconcileHandoffs(handoffPorts(env), now()).catch(() => console.error({ code: 'handoff_reconcile_failed' }));
  const links = env.MAIL_FILE_LINKS_ENABLED === 'on' && sweepLinkObjects(env.DIRECTORY.withSession('first-primary') as unknown as LinkDatabase,
    env, now(), (ws, mb, id) => env.MAILBOX.getByName(mailboxName(ws, mb)).linkObjectDisposition?.(ws, mb, id) ?? Promise.resolve({ state: 'retry' }))
    .catch(() => console.error({ code: 'link_sweep_failed' }));
  const alert = mailAlert(env.ALERTS);
  const [result] = await Promise.all([reconcile({
    outbox: new Outbox(env.DIRECTORY), mailAlerts: new MailAlerts(env.DIRECTORY), now,
    send: async id => { await env.DELIVER.send(id); }, alert, sendAlert: alert,
  }), outbound, handoffs, links]);
  if (result.enqueueErrors || result.alertErrors) console.error({ code: 'mail_reconcile_partial', ...result });
}

export default { email: handleEmail, queue: handleQueue, scheduled: (event: ScheduledController, env: Env) => handleScheduled(event, env) };
