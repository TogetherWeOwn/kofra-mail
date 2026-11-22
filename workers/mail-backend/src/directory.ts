export interface ResolvedRecipient {
  workspaceId: string;
  mailboxId: string;
}

// Preserve the directory's stable ID verbatim (including hyphens). Never normalize
// it into a different workspace's bucket. S3 bucket names cap at 63 characters.
export function workspaceMailBucket(workspaceId: string): string {
  if (!workspaceId || workspaceId.length > 58 || /[^a-z0-9-]/.test(workspaceId) || workspaceId.endsWith('-')
    || workspaceId.includes('--') || workspaceId.endsWith('-s3alias')) {
    throw new Error('Invalid workspace storage ID');
  }
  return `mail-${workspaceId}`;
}

type DirectoryDatabase = {
  withSession(constraint: 'first-primary'): Pick<D1DatabaseSession, 'prepare'>;
};

const LOOKUP = `
  SELECT destination.id AS domainId, original.workspace_id AS workspaceId, a.target_id AS mailboxId
  FROM domains AS original
  LEFT JOIN domains AS destination
    ON destination.workspace_id = original.workspace_id
    AND destination.id = coalesce(original.alias_of, original.id)
    AND destination.kind <> 'alias'
  LEFT JOIN addresses AS a
    ON a.address_norm = (?2 || '@' || destination.name)
    AND a.workspace_id = destination.workspace_id
  WHERE original.name = ?1
`;

export async function lookupRecipient(db: DirectoryDatabase, envelopeTo: string): Promise<ResolvedRecipient | null> {
  const address = envelopeTo.normalize('NFC');
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) throw new Error('Invalid envelope recipient');
  const domain = address.slice(at + 1).toLowerCase().normalize('NFC');
  const local = address.slice(0, at).normalize('NFC').toLowerCase().split('+', 1)[0];
  // A stale replica miss must not cause a permanent SMTP bounce.
  const row = await db.withSession('first-primary').prepare(LOOKUP).bind(domain, local)
    .first<{ domainId: string | null; workspaceId: string; mailboxId: string | null }>();
  if (!row) return null;
  if (!row.domainId) throw new Error('Invalid directory alias configuration');
  if (!row.mailboxId) return null;
  return { workspaceId: row.workspaceId, mailboxId: row.mailboxId };
}
