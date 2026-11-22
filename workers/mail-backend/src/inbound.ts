import { MAX_RAW_BYTES, readExact, sha256 } from './bytes.ts';
import type { ResolvedRecipient } from './directory.ts';
import type { NewDelivery } from './outbox.ts';

export type InboundMail = Pick<ForwardableEmailMessage, 'from' | 'to' | 'rawSize' | 'raw' | 'setReject'>;
export type InboundPorts = {
  lookup(to: string): Promise<ResolvedRecipient | null>;
  hold(workspaceId: string, rawKey: string, deliveryId: string): Promise<void>;
  put(workspaceId: string, rawKey: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  insert(row: NewDelivery): Promise<void>;
  send(deliveryId: string): Promise<void>;
  newId(now: number): string;
  now(): number;
};

export async function receive(message: InboundMail, ports: InboundPorts): Promise<void> {
  const recipient = await ports.lookup(message.to);
  if (recipient === null) {
    message.setReject('Unknown recipient');
    return;
  }
  const bytes = await readExact(message.raw, message.rawSize, MAX_RAW_BYTES);
  const rawKey = `raw/${await sha256(bytes)}`;
  const createdAt = ports.now();
  const id = ports.newId(createdAt);
  const { workspaceId, mailboxId } = recipient;
  await ports.hold(workspaceId, rawKey, id);
  await ports.put(workspaceId, rawKey, bytes);
  await ports.insert({ id, workspaceId, mailboxId, envelopeFrom: message.from, envelopeTo: message.to,
    rawKey, authResults: firstCloudflareResult(bytes), createdAt });
  await ports.send(id);
}

function firstCloudflareResult(bytes: Uint8Array): string | null {
  // Headers.get() can combine duplicate fields. Read only the first field in wire order.
  // An incomplete header block is treated as unauthenticated; never trust a later field.
  const prefix = new TextDecoder().decode(bytes.subarray(0, 64 * 1024));
  const boundary = /\r?\n\r?\n/.exec(prefix);
  if (!boundary) return null;
  const lines = prefix.slice(0, boundary.index).split(/\r?\n/);
  const first = lines.findIndex(line => /^authentication-results:/i.test(line));
  if (first < 0) return null;
  let value = lines[first].slice('authentication-results:'.length).trim();
  for (let i = first + 1; i < lines.length && /^[\t ]/.test(lines[i]); i++) value += ` ${lines[i].trim()}`;
  return /^mx\.cloudflare\.net[\t ]*;/i.test(value) && new TextEncoder().encode(value).length <= 2048 ? value : null;
}
