import { sha256 } from '../../src/bytes.ts';
import { kofra } from '../../src/kofra.ts';
import type { MailboxIndex, MailboxObjects } from '../../src/mailbox-index.ts';
import type { Env } from '../../src/worker.ts';

// Seed backups from the old writer without exposing that writer on the
// deployed mailbox. These objects are only used by legacy restore fixtures.
export async function seedLegacyDraft(index: MailboxIndex, objects: Pick<MailboxObjects, 'put' | 'hold'>,
  id: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const rawKey = `drafts/${await sha256(bytes)}`;
  const holder = `draft:${crypto.randomUUID()}`;
  await objects.hold(rawKey, holder);
  await objects.put(rawKey, bytes);
  index.changeMany([{ type: 'draft', id, rawKey, holder }]);
}

export function legacyFixtureObjects(env: Env, workspaceId: string): Pick<MailboxObjects, 'put' | 'hold'> {
  const refs = env.SWEEPER.getByName(workspaceId);
  return { put: kofra(env, workspaceId).put, hold: (key, holder) => refs.hold(key, holder) };
}
