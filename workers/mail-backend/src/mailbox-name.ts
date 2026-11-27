// Shared by Workers that bind the Mailbox namespace. Keep the workspace and
// mailbox separate even when either identifier contains a separator.
export function mailboxName(workspaceId: string, mailboxId: string): string {
  return JSON.stringify([workspaceId, mailboxId]);
}
