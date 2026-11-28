// Which Worker binds which link storage secret (docs/m3-outbound-plan.md, M3-15a):
// no Worker binds a secret it does not need. mail-content serves downloads and
// holds only the read-only deployment credentials; a workspace override's read
// credential reaches it through the backend's content lookup, which opens only
// the read column. The KEK and every write credential stay out of mail-content.

export const LINK_SECRETS = ['LINK_READ_CREDENTIALS', 'LINK_WRITE_CREDENTIALS', 'LINK_CRED_KEK'] as const;
export type LinkSecret = (typeof LINK_SECRETS)[number];
export type LinkWorkerRole = 'content' | 'web' | 'backend';

export const LINK_SECRET_BINDINGS: Readonly<Record<LinkWorkerRole, readonly LinkSecret[]>> = Object.freeze({
  content: Object.freeze(['LINK_READ_CREDENTIALS'] as const),
  web: Object.freeze(['LINK_WRITE_CREDENTIALS', 'LINK_CRED_KEK'] as const),
  backend: Object.freeze(['LINK_WRITE_CREDENTIALS', 'LINK_CRED_KEK'] as const),
});

/** The link secrets a Worker of `role` binds but must not, given its secret names. */
export function linkSecretViolations(role: LinkWorkerRole, boundNames: readonly string[]): LinkSecret[] {
  const allowed: readonly string[] = LINK_SECRET_BINDINGS[role];
  return LINK_SECRETS.filter(name => boundNames.includes(name) && !allowed.includes(name));
}
