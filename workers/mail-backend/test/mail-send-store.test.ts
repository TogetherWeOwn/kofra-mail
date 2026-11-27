import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import type { SendRecord } from '../src/mail-journal.ts';

// The send record checks that guard the journal, replay and snapshots
// (docs/m3-outbound-plan.md, section 2.3): a stored time must stay inside the
// range a Date can hold, or every later read of the send fails.
type Store = typeof import('../src/mailbox-send-store.ts');
let store: Store;
before(async () => {
  // The module's dependencies use TypeScript syntax that plain type stripping does not run.
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/mailbox-send-store.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'neutral', write: false });
  store = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`) as Store;
});

const MAX_DATE = 8.64e15;
const at = Date.UTC(2026, 10, 26);
const record = (patch: Partial<SendRecord> = {}): SendRecord => ({
  id: '01KBN8ZJ7G0000000000000000', draftId: 'draft-1', createdAt: at, undoUntil: at + 10_000, dateAt: at + 10_000, undoSeconds: 10,
  ownerUserId: 'member', from: { email: 'member@example.com', name: '' }, replyTo: [], builderVersion: 1,
  draft: { rawKey: `raw/${'a'.repeat(64)}/01KBN8ZJ7G0000000000000001`, holder: 'draft:scope:draft-1:1', revision: 'revision-1', updatedAt: at },
  attachmentKeys: [], uploadIds: [], recipients: [{ field: 'to', email: 'friend@example.net' }], parts: [], ...patch,
});

test('a send record with every time inside the Date range is accepted and renders', () => {
  store.checkSendRecord(record());
  const edge = record({ createdAt: MAX_DATE, undoUntil: MAX_DATE, dateAt: MAX_DATE, draft: { ...record().draft, updatedAt: MAX_DATE } });
  store.checkSendRecord(edge);
  const row = { id: edge.id, draftId: edge.draftId, state: 'pending' as const, createdAt: edge.createdAt, undoUntil: edge.undoUntil,
    holder: edge.draft.holder, record: edge, createdSeq: 1, releaseSeq: null, queuedSeq: null, terminalSeq: null, messageId: null,
    reason: null, finishPending: false };
  assert.equal(store.wireSend(row, [], 1, at).undoUntil, new Date(MAX_DATE).toISOString());
});

for (const [field, patch] of [
  ['createdAt', { createdAt: MAX_DATE + 1 }],
  ['undoUntil and dateAt', { undoUntil: MAX_DATE + 1, dateAt: MAX_DATE + 1 }],
  ['draft.updatedAt', { draft: { ...record().draft, updatedAt: MAX_DATE + 1 } }],
] as const) {
  test(`a send record with ${field} past the Date range is refused`, () => {
    assert.throws(() => store.checkSendRecord(record(patch)), /Invalid send record/);
  });
}
