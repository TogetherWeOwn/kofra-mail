import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { lookupRecipient, workspaceMailBucket } from '../src/directory.ts';

const mf = new Miniflare({
  modules: true,
  script: 'export default {};',
  d1Databases: ['DIRECTORY'],
});
let db: D1Database;
before(async () => {
  db = await mf.getD1Database('DIRECTORY') as unknown as D1Database;
  const url = new URL('../migrations/0001_directory.sql', import.meta.url);
  const statements = (await readFile(url, 'utf8')).split(/;\s*\n(?=\s*(?:CREATE |$))/).filter(s => s.trim());
  await db.batch(statements.map(s => db.prepare(s)));
  await db.batch([
    db.prepare("INSERT INTO domains VALUES ('d1','w1','example.test','primary',NULL,'ready','ready')"),
    db.prepare("INSERT INTO domains VALUES ('d2','w1','alias.test','alias','d1','ready','ready')"),
    db.prepare("INSERT INTO domains VALUES ('d3','w2','other.test','primary',NULL,'ready','ready')"),
    db.prepare("INSERT INTO mailboxes VALUES ('m1','w1','u1','josé@example.test')"),
    db.prepare("INSERT INTO addresses VALUES ('josé@example.test','w1','mailbox','m1','primary','allowed')"),
    db.prepare("INSERT INTO addresses VALUES ('billing@example.test','w1','mailbox','m1','alias','allowed')"),
  ]);
});
after(() => mf.dispose());

test('maps an alias domain and plus tag, normalizing NFC and folding the local part', async () => {
  for (const address of ['JOSÉ+x@ALIAS.test', 'José+tag@ALIAS.Test', 'José+tag@ALIAS.Test']) {
    assert.deepEqual(await lookupRecipient(db, address), { workspaceId: 'w1', mailboxId: 'm1' }, address);
  }
});

test('resolves a user alias to its mailbox regardless of case', async () => {
  assert.deepEqual(await lookupRecipient(db, 'BILLING@example.test'), { workspaceId: 'w1', mailboxId: 'm1' });
});

test('rejects ASCII uppercase in a stored address', async () => {
  await assert.rejects(
    db.prepare("INSERT INTO addresses VALUES ('Billing@example.test','w1','mailbox','m1','alias','allowed')").run(),
    /CHECK constraint failed: address_norm = lower\(address_norm\)/,
  );
});

test('returns null on a successful point-lookup miss', async () => {
  assert.equal(await lookupRecipient(db, 'missing@example.test'), null);
  assert.equal(await lookupRecipient(db, 'billing@missing.test'), null);
});

test('never routes an address belonging to a different domain workspace', async () => {
  await db.prepare("INSERT INTO addresses VALUES ('billing@other.test','w1','mailbox','m1','alias','allowed')").run();
  assert.equal(await lookupRecipient(db, 'billing@other.test'), null);
});

test('refuses a cross-workspace alias target', async () => {
  await assert.rejects(db.prepare("INSERT INTO domains VALUES ('d4','w2','foreign.test','alias','d1','ready','ready')").run(), /canonical domain/);
});

test('rejects alias chains on insert and cannot turn a referenced canonical domain into an alias', async () => {
  await db.prepare("INSERT INTO domains VALUES ('d5','w1','second.test','secondary',NULL,'ready','ready')").run();
  await assert.rejects(db.prepare("INSERT INTO domains VALUES ('d6','w1','chain.test','alias','d2','ready','ready')").run(), /canonical domain/);
  await assert.rejects(db.prepare("UPDATE domains SET kind = 'alias', alias_of = 'd5' WHERE id = 'd1'").run(), /canonical domain/);
});

test('propagates database unavailability rather than returning a miss', async () => {
  const unavailable = await mf.getD1Database('DIRECTORY') as unknown as D1Database;
  const prepare = () => unavailable.prepare('SELECT * FROM missing_table');
  await assert.rejects(lookupRecipient({ withSession: () => ({ prepare }) }, 'billing@example.test'), /no such table/);
});

test('derives a distinct valid storage bucket for each workspace without changing its ID', () => {
  const bucket = workspaceMailBucket;
  assert.equal(bucket('w1'), 'mail-w1');
  assert.equal(bucket('w2'), 'mail-w2');
  assert.equal(bucket('a'.repeat(58)).length, 63);
  for (const invalid of ['', 'W1', '../w1', 'w1-', 'a'.repeat(59)]) {
    assert.throws(() => bucket(invalid), /Invalid workspace storage ID/);
  }
});

for (const [table, sql] of [
  ['domains', "INSERT INTO domains VALUES ('d7',?,'ulid.test','primary',NULL,'ready','ready')"],
  ['mailboxes', "INSERT INTO mailboxes VALUES ('m2',?,'u2','mailbox@ulid.test')"],
  ['addresses', "INSERT INTO addresses VALUES ('alias@ulid.test',?,'mailbox','m3','alias','allowed')"],
]) {
  test(`${table} accepts a lowercase workspace ID and rejects IDs that cannot name a mail bucket`, async () => {
    const valid = '01arz3ndektsv4rrffq69g5fav';
    if (table === 'addresses') {
      await db.prepare("INSERT INTO mailboxes VALUES ('m3',?,'u3','target@ulid.test')").bind(valid).run();
    }
    for (const invalid of [valid.toUpperCase(), `${valid}-`]) {
      await assert.rejects(db.prepare(sql).bind(invalid).run(), /CHECK constraint failed: length\(workspace_id\)/);
    }
    assert.equal((await db.prepare(sql).bind(valid).run()).meta.changes, 1);
  });
}

test('lookup uses indexes for domain names, alias targets and address keys', async () => {
  let query = '';
  await lookupRecipient({ withSession: () => ({ prepare: (sql: string) => { query = sql; return db.prepare(sql); } }) }, 'billing@alias.test');
  const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${query}`).bind('alias.test', 'billing').all<{ detail: string }>();
  assert.ok(results.filter(row => row.detail.includes('SEARCH')).length >= 3, JSON.stringify(results));
  assert.ok(!results.some(row => row.detail.includes('SCAN')), JSON.stringify(results));
});
