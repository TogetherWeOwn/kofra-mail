import { ulid } from 'ulid';
import { mailAlert, type AlertBinding } from './alerts.ts';
import type { ObjectKind } from './object-key.ts';
import type { ConfirmAnswer, ConfirmEntry, HoldTarget } from './sweep-ledger.ts';
import { deliver, dlq } from './deliver.ts';
import { lookupRecipient } from './directory.ts';
import { receive, type InboundMail } from './inbound.ts';
import { kofra, type KofraConfig } from './kofra.ts';
import { MailAlerts } from './mail-alerts.ts';
import { Outbox } from './outbox.ts';
import { reconcile } from './reconcile.ts';

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
};
export type MailboxDelivery = { deliver(id: string): Promise<'indexed' | 'deferred' | 'rejected'> };
type Namespace<T> = { getByName(name: string): T };

export type Env = KofraConfig & {
  MAIL_BACKEND_ENABLED?: string;
  MAIL_LOCAL_API?: string;
  MAIL_DRAFT_UPLOADS_ENABLED?: string;
  MAIL_RECOVERY_ENABLED?: string;
  MAIL_SWEEP_ENABLED?: string;
  DIRECTORY: D1Database;
  DELIVER: Queue<string>;
  DELIVERY_QUEUE_NAME: string;
  DEAD_LETTER_QUEUE_NAME: string;
  ALERTS?: AlertBinding;
  SWEEPER: Namespace<SweeperReferences>;
  MAILBOX: Namespace<MailboxDelivery> & { idFromName(name: string): DurableObjectId };
  MAIL_STATE: R2Bucket;
};

export function mailboxName(workspaceId: string, mailboxId: string): string {
  return JSON.stringify([workspaceId, mailboxId]);
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
          release: (workspaceId, key, id) => env.SWEEPER.getByName(workspaceId).release(key, `delivery:${id}`),
          now: Date.now,
        }, message.id);
      }
      message.ack();
    } catch {
      message.retry();
    }
  }
}

export async function handleScheduled(_event: ScheduledController, env: Env): Promise<void> {
  if (!enabled(env)) return;
  queueNames(env);
  const result = await reconcile({
    outbox: new Outbox(env.DIRECTORY), mailAlerts: new MailAlerts(env.DIRECTORY), now: Date.now,
    send: async id => { await env.DELIVER.send(id); }, alert: mailAlert(env.ALERTS),
  });
  if (result.enqueueErrors || result.alertErrors) console.error({ code: 'mail_reconcile_partial', ...result });
}

export default { email: handleEmail, queue: handleQueue, scheduled: handleScheduled };
