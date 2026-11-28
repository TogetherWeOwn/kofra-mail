// The sender check of the send path (docs/m3-outbound-plan.md, section 1 and
// M3-7). sendDraft and release run this one indexed, primary-consistent
// directory statement, and so must each claim and authorizeDispatch when the
// consumer (M3-5) adds them. It requires, together, the
// workspace, the mailbox, the submitting user as its owner and `from` as an
// active identity of that mailbox: two separate reads could combine states
// that were never true at the same time.

type DirectoryDatabase = { withSession(constraint: 'first-primary'): Pick<D1DatabaseSession, 'prepare'> };

export type SenderCheck = { workspaceId: string; mailboxId: string; ownerUserId: string; from: string };

// Both primary and alias senders must match an active addresses row exactly.
// Read ownership in the same statement to distinguish a lost mailbox from
// an inactive identity without a second read.
const active = (from: string) => `EXISTS (SELECT 1 FROM addresses a WHERE a.address_norm = ${from} AND a.workspace_id = m.workspace_id
      AND a.target_kind = 'mailbox' AND a.target_id = m.id AND a.send_as_policy = 'active'
      AND (a.kind = 'alias' OR (a.kind = 'primary' AND a.address_norm = m.primary_address)))`;
export const SENDER_CHECK = `SELECT m.user_id = ?3 AS owner,
    ${active('?4')} AS active
  FROM mailboxes m WHERE m.workspace_id = ?1 AND m.id = ?2`;

// The same statement as a condition, for a write that decides inside itself:
// the internal handoff's insert (section 2.4, release step 6; M3-8). The
// arguments are the statement's own parameter placeholders, never values.
export const senderHolds = (workspace: string, mailbox: string, owner: string, from: string) =>
  `EXISTS (SELECT 1 FROM mailboxes m WHERE m.workspace_id = ${workspace} AND m.id = ${mailbox} AND m.user_id = ${owner}
    AND ${active(from)})`;

// `not_owner`: the mailbox is gone or belongs to someone else now.
// `inactive`: the owner still has the mailbox, but `from` is not its active identity.
export type SenderState = 'ok' | 'not_owner' | 'inactive';

export async function senderState(directory: DirectoryDatabase, { workspaceId, mailboxId, ownerUserId, from }: SenderCheck): Promise<SenderState> {
  const row = await directory.withSession('first-primary').prepare(SENDER_CHECK)
    .bind(workspaceId, mailboxId, ownerUserId, from).first<{ owner: number; active: number }>();
  if (row?.owner !== 1) return 'not_owner';
  return row.active === 1 ? 'ok' : 'inactive';
}

export async function senderActive(directory: DirectoryDatabase, check: SenderCheck): Promise<boolean> {
  return await senderState(directory, check) === 'ok';
}
