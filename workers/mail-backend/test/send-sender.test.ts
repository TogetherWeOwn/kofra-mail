import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { senderActive, senderState, type SenderCheck } from '../src/mailbox-send-sender.ts';
import { migrateDirectory } from './fixtures/directory-db.ts';

// The one directory statement of section 1 (docs/m3-outbound-plan.md): the
// sender check that sendDraft, release, each claim and authorizeDispatch run.
// It requires, together, the workspace, the mailbox, the submitting user as
// its owner and `from` as an active identity of that mailbox.
const mf = new Miniflare({ modules: true, script: 'export default {};', d1Databases: ['DIRECTORY'] });
let db: D1Database;
before(async () => {
  db = await mf.getD1Database('DIRECTORY') as unknown as D1Database;
  await migrateDirectory(db);
});
after(() => mf.dispose());

const send: SenderCheck = { workspaceId: 'w1', mailboxId: 'm1', ownerUserId: 'u1', from: 'sales@example.test' };
beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM addresses'), db.prepare('DELETE FROM mailboxes'), db.prepare('DELETE FROM domains'),
    db.prepare("INSERT INTO domains VALUES ('d1','w1','example.test','primary',NULL,'ready','ready')"),
    db.prepare("INSERT INTO domains VALUES ('d2','w2','other.test','primary',NULL,'ready','ready')"),
    db.prepare("INSERT INTO mailboxes (id, workspace_id, user_id, primary_address) VALUES ('m1','w1','u1','owner@example.test')"),
    db.prepare("INSERT INTO mailboxes (id, workspace_id, user_id, primary_address) VALUES ('m2','w1','u2','colleague@example.test')"),
    db.prepare("INSERT INTO addresses VALUES ('owner@example.test','w1','mailbox','m1','primary','active')"),
    db.prepare("INSERT INTO addresses VALUES ('colleague@example.test','w1','mailbox','m2','primary','active')"),
    db.prepare("INSERT INTO addresses VALUES ('sales@example.test','w1','mailbox','m1','alias','active')"),
  ]);
});

const check = (patch: Partial<SenderCheck> = {}) => senderActive(db, { ...send, ...patch });
const change = (statement: string) => db.prepare(statement).run();

test('accepts the owner sending as the primary address or an active alias', async () => {
  assert.equal(await check(), true);
  assert.equal(await check({ from: 'owner@example.test' }), true);
});

for (const [revocation, statement] of [
  ['set back to pending', "UPDATE addresses SET send_as_policy = 'pending' WHERE address_norm = 'sales@example.test'"],
  ['turned off', "UPDATE addresses SET send_as_policy = 'off' WHERE address_norm = 'sales@example.test'"],
  ['removed', "DELETE FROM addresses WHERE address_norm = 'sales@example.test'"],
  ['moved to another mailbox', "UPDATE addresses SET target_id = 'm2' WHERE address_norm = 'sales@example.test'"],
  ['given with its mailbox to another member', "UPDATE mailboxes SET user_id = 'u3' WHERE workspace_id = 'w1' AND id = 'm1'"],
] as const) {
  test(`refuses a revoked identity: the alias ${revocation}`, async () => {
    assert.equal(await check(), true);
    await change(statement);
    assert.equal(await check(), false);
  });
}

test('refuses an identity of another mailbox, another owner or another workspace', async () => {
  assert.equal(await check({ from: 'colleague@example.test' }), false, "another mailbox's primary");
  assert.equal(await check({ ownerUserId: 'u2' }), false, 'a user who does not own the mailbox');
  assert.equal(await check({ mailboxId: 'm2' }), false, 'the alias checked against another mailbox');
  assert.equal(await check({ workspaceId: 'w2' }), false, 'the same mailbox id in another workspace');
  assert.equal(await check({ from: 'nobody@example.test' }), false, 'an unknown address');
});

test('compares the stored identity exactly: case, plus tags and display names never widen it', async () => {
  for (const from of ['SALES@example.test', 'sales+x@example.test', '"Sales" <sales@example.test>', ' sales@example.test']) {
    assert.equal(await check({ from }), false, from);
  }
});

test('tells a lost mailbox from a lost identity, from the same statement', async () => {
  const state = (patch: Partial<SenderCheck> = {}) => senderState(db, { ...send, ...patch });
  assert.equal(await state(), 'ok');
  assert.equal(await state({ ownerUserId: 'u2' }), 'not_owner');
  assert.equal(await state({ mailboxId: 'missing' }), 'not_owner');
  assert.equal(await state({ from: 'colleague@example.test' }), 'inactive');
  await change("UPDATE addresses SET send_as_policy = 'pending' WHERE address_norm = 'sales@example.test'");
  assert.equal(await state(), 'inactive');
  await change("UPDATE mailboxes SET user_id = 'u3' WHERE workspace_id = 'w1' AND id = 'm1'");
  assert.equal(await state(), 'not_owner', 'a lost mailbox wins over a lost identity');
});
