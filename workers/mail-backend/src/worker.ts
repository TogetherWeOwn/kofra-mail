import { ulid } from 'ulid';
import { mailAlert, type AlertBinding } from './alerts.ts';
import type { ObjectKind } from './object-key.ts';
import { deliver, dlq } from './deliver.ts';
import { lookupRecipient } from './directory.ts';
import { receive, type InboundMail } from './inbound.ts';
import { kofra, type KofraConfig } from './kofra.ts';
import { Outbox } from './outbox.ts';

export type ObjectReferences = {
  register(kind: ObjectKind, digest: string, holder: string): Promise<string>;
  hold(key: string, holder: string): Promise<void>;
  release(key: string, holder: string): Promise<void>;
};
export type MailboxDelivery = { deliver(id: string): Promise<void> };
type Namespace<T> = { getByName(name: string): T };

export type Env = KofraConfig & {
  MAIL_BACKEND_ENABLED?: string;
  DIRECTORY: D1Database;
  DELIVER: Queue<string>;
  DELIVERY_QUEUE_NAME: string;
  DEAD_LETTER_QUEUE_NAME: string;
  ALERTS?: AlertBinding;
  SWEEPER: Namespace<ObjectReferences>;
  MAILBOX: Namespace<MailboxDelivery>;
};

export function enabled(env: { MAIL_BACKEND_ENABLED?: string }): boolean {
  return env.MAIL_BACKEND_ENABLED === 'on';
}

export async function handleEmail(message: InboundMail, env: Partial<Env>): Promise<void> {
  if (!enabled(env)) throw new Error('Mail backend is disabled');
  const { DIRECTORY, DELIVER, SWEEPER } = env;
  if (!DIRECTORY || !DELIVER || !SWEEPER) throw new Error('Mail ingress bindings missing');
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
  if (batch.queue !== env.DELIVERY_QUEUE_NAME && batch.queue !== env.DEAD_LETTER_QUEUE_NAME) {
    throw new Error('Unexpected mail queue');
  }
  const outbox = new Outbox(env.DIRECTORY);
  for (const message of batch.messages) {
    try {
      if (batch.queue === env.DEAD_LETTER_QUEUE_NAME) {
        await dlq(message.body, mailAlert(env.ALERTS));
      } else {
        await deliver(message.body, {
          outbox,
          index: (workspaceId, mailboxId, id) => env.MAILBOX.getByName(JSON.stringify([workspaceId, mailboxId])).deliver(id),
          release: (workspaceId, key, id) => env.SWEEPER.getByName(workspaceId).release(key, `delivery:${id}`),
          now: Date.now,
        });
      }
      message.ack();
    } catch {
      message.retry();
    }
  }
}

export default { email: handleEmail, queue: handleQueue };
