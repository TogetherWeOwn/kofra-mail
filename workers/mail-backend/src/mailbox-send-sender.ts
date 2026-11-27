// The sender check of the send path (docs/m3-outbound-plan.md, section 1 and
// M3-7). sendDraft and release run this one indexed, primary-consistent
// directory statement, and so must each claim and authorizeDispatch when the
// consumer (M3-5) adds them. It requires, together, the
// workspace, the mailbox, the submitting user as its owner and `from` as an
// active identity of that mailbox: two separate reads could combine states
// that were never true at the same time.

type DirectoryDatabase = { withSession(constraint: 'first-primary'): Pick<D1DatabaseSession, 'prepare'> };

export type SenderCheck = { workspaceId: string; mailboxId: string; ownerUserId: string; from: string };

// `from` is compared exactly with the stored identity: the primary address,
// or an alias of this mailbox with send-as `active`. Both conditions come
// from the same read, so a caller can tell a lost mailbox from a lost
// identity without a second statement.
export const SENDER_CHECK = `SELECT m.user_id = ?3 AS owner,
    (m.primary_address = ?4 OR EXISTS (SELECT 1 FROM addresses a WHERE a.address_norm = ?4 AND a.workspace_id = m.workspace_id
      AND a.target_kind = 'mailbox' AND a.target_id = m.id AND a.kind = 'alias' AND a.send_as_policy = 'active')) AS active
  FROM mailboxes m WHERE m.workspace_id = ?1 AND m.id = ?2`;

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
