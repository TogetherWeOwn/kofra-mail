import assert from 'node:assert/strict';
import type { MailService } from '../../../../contracts/mail-api/src/index.ts';
import type { DraftInput } from '../../../../contracts/mail-api/src/wire.ts';
import type { EmailCall } from './send-consumer.ts';
import { startMailHttpFixture } from './mail-http.ts';

// Internal delivery (docs/m3-outbound-plan.md, section 2.4, release step 6;
// M3-8), run in local workerd against the real Mailbox objects, the real
// Sweeper, the real D1 outbox and the delivery pipeline's real deliver().
export type Fixture = Awaited<ReturnType<typeof startMailHttpFixture>>;
export type Principal = 'member' | 'other' | 'admin';
export const WS = 'w1', MB = 'mailbox-a';
export const second = 1000, minute = 60 * second, hour = 60 * minute, day = 24 * hour;
export const UNDO = 10 * second;
export const MEMBER = 'member@example.com', OTHER = 'other@example.com', ADMIN = 'admin@example.com', OUTSIDE = 'friend@example.net';
export const key = (idempotencyKey: string) => ({ idempotencyKey });

export type HandoffRecord = {
  key: string; workspace_id: string; mailbox_id: string; send_id: string; raw_key: string; decision: string; reason: string | null;
  plan: string | null; expanded_at: number | null; holder_release_pending: number; release_retry_at: number | null;
  acknowledged_at: number | null; prune_after: number | null; created_at: number; addresses: string;
};
export type ChildRow = { id: string; mailbox: string; state: string; source: string; kind: string; raw_key: string; envelope_to: string;
  file_message_id: string | null; file_folder_rev: number | null };
export type MessageRow = { id: string; raw_key: string; flags: number; folder_rev: number; auth: string; indexed: number; subject: string };

export const handoffKeyOf = (sendId: string, mb = MB) => `internal:${WS}:${mb}:${sendId}`;
export const handoffs = (h: Fixture) => h.directoryRows('SELECT * FROM internal_handoffs ORDER BY key') as Promise<HandoffRecord[]>;
export const handoff = async (h: Fixture, sendId: string, mb = MB) => (await handoffs(h)).find(row => row.key === handoffKeyOf(sendId, mb));
export const children = (h: Fixture) => h.directoryRows(`SELECT id, json_extract(resolved_mailbox_ids, '$[0]') AS mailbox, state, source, kind,
  raw_key, envelope_to, file_message_id, file_folder_rev FROM deliveries WHERE source = 'internal' ORDER BY id`) as Promise<ChildRow[]>;
export const messages = (h: Fixture, principal: Principal) => h.box<MessageRow[]>(principal, 'messageRows');
// Folders as the mailbox stores them in its flags (mailbox-api-messages.ts).
export const folderOf = (flags: number) => ['inbox', 'archive', 'spam', 'trash'][(flags >> 16) & 3];
export const SENT_FLAG = 1 << 20;
export const ledgerOf = (state: { ledger: { kind: string; state: string; reason: string | null }[] }) =>
  state.ledger.map(({ kind, state: s, reason }) => `${kind}:${s}${reason ? `:${reason}` : ''}`);

export const draftInput = (from: string, to: string[], patch: Partial<DraftInput> = {}): DraftInput => ({
  from, to: to.map(email => ({ email })), cc: [], bcc: [], subject: 'Internal hello', body: 'Body text for colleagues', attachments: [], ...patch,
});

export async function withInternal(run: (h: Fixture, mail: MailService, from: string) => Promise<void>,
  options: Parameters<typeof startMailHttpFixture>[0] = {}) {
  const fixture = await startMailHttpFixture({ send: true, ...options });
  try {
    const mail = fixture.as('member');
    const { mailbox } = await mail.getSession();
    assert.ok(mailbox);
    await run(fixture, mail, mailbox.primaryAddress);
  } finally { await fixture.close(); }
}

// A draft sent and left pending in its undo window.
export async function submit(mail: MailService, from: string, token: string, to: string[], patch: Partial<DraftInput> = {}): Promise<string> {
  const draft = await mail.createDraft(draftInput(from, to, patch), key(`draft-${token}`));
  return (await mail.sendDraft(draft.id, { ...key(`send-${token}`), ifMatch: draft.revision })).id;
}

// A send released: its undo window passed and the drive handler ran.
export async function released(h: Fixture, mail: MailService, from: string, token: string, to: string[], patch: Partial<DraftInput> = {}) {
  const id = await submit(mail, from, token, to, patch);
  await h.advance(UNDO);
  return id;
}

// Every EMAIL call any part of the fixture made: the send path never calls it for an internal recipient.
export async function emailCalls(h: Fixture): Promise<number> {
  return (await h.consumer<EmailCall[]>('emailCalls')).length + await h.sends.emailCalls();
}

// Every holder of a generation that still counts (held or provisional).
export async function liveHolders(h: Fixture, rawKey: string): Promise<string[]> {
  const rows = await h.holderDetails(rawKey);
  return rows.filter(row => row.state === 'held' || row.state === 'provisional').map(row => row.holder);
}

export const directoryUpdate = (h: Fixture, statement: string, ...binds: unknown[]) => h.directoryChange(statement, ...binds);
export const addAlias = (h: Fixture, address: string, mailbox: string) =>
  h.directoryChange("INSERT INTO addresses VALUES (?, 'w1', 'mailbox', ?, 'alias', 'active')", address, mailbox);
export const moveAlias = (h: Fixture, address: string, mailbox: string) =>
  h.directoryChange('UPDATE addresses SET target_id = ? WHERE address_norm = ?', mailbox, address);
export const deleteAlias = (h: Fixture, address: string) => h.directoryChange('DELETE FROM addresses WHERE address_norm = ?', address);
export const outboxDown = (h: Fixture, down: boolean, principal: Principal = 'member') => h.box(principal, 'setOutboxDown', down);
