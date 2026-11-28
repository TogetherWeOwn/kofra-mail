import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import {
  CredentialSealError, credentialSecret, DELETE_CLAIM_MS, LocationPendingDeleteError, USAGE_TIMEOUT_MS, deploymentLocations, linkKek, linkSecretViolations, LinkStorageStore, LocationRepointedError,
  newLocationId, openCredential, S3Credentials, sealCredential, type LinkKek, type LinkLocationFields, type LinkLocationUsage,
} from '../src/index.ts';
import { testDatabase } from './d1.ts';

// Synthetic values only.
const READ = { accessKeyId: 'FAKEREADKEY0001', secretAccessKey: 'fake-read-secret-value-0001' };
const WRITE = { accessKeyId: 'FAKEWRITEKEY002', secretAccessKey: 'fake-write-secret-value-0002' };
const READ2 = { accessKeyId: 'FAKEREADKEY0003', secretAccessKey: 'fake-read-secret-value-0003' };
const WRITE2 = { accessKeyId: 'FAKEWRITEKEY004', secretAccessKey: 'fake-write-secret-value-0004' };
const SECRETS = [READ, WRITE, READ2, WRITE2].map(({ secretAccessKey }) => secretAccessKey);
const credentials = { read: S3Credentials.from(READ)!, write: S3Credentials.from(WRITE)! };
const rotated = { read: S3Credentials.from(READ2)!, write: S3Credentials.from(WRITE2)! };
const fields: LinkLocationFields = { endpoint: 'https://s3.storage-fixture.test', region: 'auto', bucket: 'links', prefix: '', pathStyle: true };
const keyBytes = (seed: number) => Buffer.from(new Uint8Array(32).fill(seed)).toString('base64');
const kekJson = (current: number, versions: number[]) => JSON.stringify({ current: String(current),
  keys: Object.fromEntries(versions.map(v => [String(v), keyBytes(v)])) });
const kek = async (current: number, versions: number[]) => (await linkKek(kekJson(current, versions)))!;

async function created(store: LinkStorageStore, db: ReturnType<typeof testDatabase>, k: LinkKek, ws = 'ws-a', id = newLocationId()) {
  await db.batch(await store.createStatements(k, ws, id, fields, credentials, 1_000));
  return id;
}

test('the KEK secret parses strictly and fails closed', async () => {
  assert.ok(await linkKek(kekJson(1, [1])));
  assert.equal((await linkKek(kekJson(2, [1, 2])))!.current, 2);
  for (const raw of [undefined, '', 'not json', '[]', kekJson(2, [1]), JSON.stringify({ current: '1', keys: { 1: 'short' } }),
    JSON.stringify({ current: '0', keys: { 0: keyBytes(1) } }), JSON.stringify({ current: '256', keys: { 256: keyBytes(1) } }),
    JSON.stringify({ current: 1, keys: { 1: keyBytes(1) } }), JSON.stringify({ current: '1', keys: { 1: keyBytes(1) }, extra: 1 })]) {
    assert.equal(await linkKek(raw), undefined, String(raw));
  }
});

test('the AAD binds a sealed credential to its workspace, location, key version and role', async () => {
  const k = await kek(1, [1, 2]);
  const sealed = await sealCredential(k, 'ws-a', 'loc-a', 'write', credentials.write);
  assert.equal(sealed.version, 1);
  assert.deepEqual((await openCredential(k, 'ws-a', 'loc-a', 'write', 1, sealed.sealed)).reveal(), WRITE);
  for (const [ws, loc, role, version] of [['ws-b', 'loc-a', 'write', 1], ['ws-a', 'loc-b', 'write', 1], ['ws-a', 'loc-a', 'read', 1],
    ['ws-a', 'loc-a', 'write', 2]] as const) {
    await assert.rejects(openCredential(k, ws, loc, role, version, sealed.sealed), CredentialSealError, `${ws} ${loc} ${role} ${version}`);
  }
  // A relabelled version byte also fails: it changes the AAD.
  const bytes = Buffer.from(sealed.sealed, 'base64url');
  bytes[0] = 2;
  await assert.rejects(openCredential(k, 'ws-a', 'loc-a', 'write', 2, bytes.toString('base64url')), CredentialSealError);
  // A tampered byte fails, and so does a different KEK.
  bytes[0] = 1;
  bytes[20] ^= 1;
  await assert.rejects(openCredential(k, 'ws-a', 'loc-a', 'write', 1, bytes.toString('base64url')), CredentialSealError);
  const other = (await linkKek(JSON.stringify({ current: '1', keys: { 1: keyBytes(9) } })))!;
  await assert.rejects(openCredential(other, 'ws-a', 'loc-a', 'write', 1, sealed.sealed), CredentialSealError);
});

test('a row copied to another workspace or location, or a column swapped, fails to decrypt', async () => {
  const db = testDatabase();
  const store = new LinkStorageStore(db);
  const k = await kek(1, [1]);
  const a = await created(store, db, k, 'ws-a');
  const b = await created(store, db, k, 'ws-b');
  assert.deepEqual((await store.credential(k, 'ws-a', a, 'read'))!.reveal(), READ);
  assert.deepEqual((await store.credential(k, 'ws-b', b, 'write'))!.reveal(), WRITE);
  // Copy ws-a's sealed values into ws-b's row: they still belong to ws-a.
  db.raw.prepare(`UPDATE link_storage_locations SET read_sealed = (SELECT read_sealed FROM link_storage_locations WHERE workspace_id = 'ws-a'),
    write_sealed = (SELECT write_sealed FROM link_storage_locations WHERE workspace_id = 'ws-a') WHERE workspace_id = 'ws-b'`).run();
  await assert.rejects(store.credential(k, 'ws-b', b, 'read'), CredentialSealError);
  await assert.rejects(store.credential(k, 'ws-b', b, 'write'), CredentialSealError);
  // Swap ws-a's read and write columns: the read-only path cannot open the write credential.
  db.raw.prepare(`UPDATE link_storage_locations SET read_sealed = write_sealed, write_sealed = read_sealed WHERE workspace_id = 'ws-a'`).run();
  await assert.rejects(store.credential(k, 'ws-a', a, 'read'), CredentialSealError);
  await assert.rejects(store.credential(k, 'ws-a', a, 'write'), CredentialSealError);
});

test('no secret is stored, serialised, inspected or thrown in plain form', async () => {
  const db = testDatabase();
  const store = new LinkStorageStore(db);
  const k = await kek(1, [1]);
  const id = await created(store, db, k);
  await store.rotate(k, 'ws-a', id, rotated, 2_000);
  const stored = JSON.stringify(db.dump('link_storage_locations'));
  const errors: string[] = [];
  try { await openCredential(k, 'ws-a', id, 'read', 1, 'AAAA'); } catch (error) { errors.push(String(error), (error as Error).stack ?? ''); }
  const shown = [stored, JSON.stringify(credentials), String(credentials.read), inspect(credentials), inspect(credentials.write, { showHidden: true }),
    JSON.stringify(await store.list('ws-a')), ...errors].join('\n');
  for (const secret of SECRETS) assert.ok(!shown.includes(secret), 'secret appears');
  for (const { accessKeyId } of [READ, WRITE, READ2, WRITE2]) assert.ok(!shown.includes(accessKeyId), 'full key id appears');
  assert.match(shown, /0003/);
  // A malformed secret map is refused without echoing it.
  assert.equal(credentialSecret(JSON.stringify({ main: { accessKeyId: 'x', secretAccessKey: SECRETS[0] } })), undefined);
});

test('credentials rotate in place', async () => {
  const db = testDatabase();
  const store = new LinkStorageStore(db);
  const k = await kek(1, [1]);
  const id = await created(store, db, k);
  const before = (await store.get('ws-a', id))!;
  assert.equal((await store.rotate(k, 'ws-a', id, rotated, 2_000))?.locationId, id);
  const after = (await store.get('ws-a', id))!;
  // Same location, same fields, still current; only the credentials changed.
  assert.deepEqual({ ...after, readKeyLast4: before.readKeyLast4, writeKeyLast4: before.writeKeyLast4, rotatedAt: null }, before);
  assert.deepEqual([after.readKeyLast4, after.writeKeyLast4, after.rotatedAt], ['0003', 'Y004', 2_000]);
  assert.deepEqual((await store.credential(k, 'ws-a', id, 'read'))!.reveal(), READ2);
  assert.deepEqual((await store.credential(k, 'ws-a', id, 'write'))!.reveal(), WRITE2);
  assert.equal(db.dump('link_storage_locations').length, 1);
  assert.equal(await store.rotate(k, 'ws-a', newLocationId(), rotated, 3_000), null);
  assert.equal(await store.rotate(k, 'ws-b', id, rotated, 3_000), null);
});

test('a location still in use cannot be deleted', async () => {
  const db = testDatabase();
  const store = new LinkStorageStore(db);
  const k = await kek(1, [1]);
  const id = await created(store, db, k);
  const seen: string[] = [];
  const usage = (answer: boolean | Error): LinkLocationUsage => ({ async inUse({ workspaceId, locationId }) {
    // While the check runs, the row is `deleting`: no new reference may be attached to it.
    seen.push(String(db.raw.prepare('SELECT state FROM link_storage_locations WHERE location_id = ?').get(locationId)?.state));
    // A second delete meanwhile learns that the first is still deciding, not that the location is gone.
    assert.equal(await store.delete(workspaceId, locationId, { inUse: async () => false }), 'pending');
    // Links made with it still resolve, and it is listed as `deleting`.
    assert.equal((await store.get(workspaceId, locationId))?.state, 'deleting');
    assert.deepEqual((await store.credential(k, workspaceId, locationId, 'read', { rewrap: false }))!.reveal(), READ);
    if (answer instanceof Error) throw answer;
    return answer;
  } });
  assert.equal(await store.delete('ws-a', id, usage(true)), 'in_use');
  assert.ok(await store.get('ws-a', id));
  await assert.rejects(store.delete('ws-a', id, usage(new Error('usage unavailable'))), /usage unavailable/);
  assert.ok(await store.get('ws-a', id));
  assert.equal(await store.delete('ws-a', id, { inUse: async () => undefined as unknown as boolean }), 'in_use');
  assert.equal(await store.delete('ws-b', id, usage(false)), 'not_found');
  assert.ok(await store.get('ws-a', id));
  assert.equal(await store.delete('ws-a', id, usage(false)), 'deleted');
  assert.equal(await store.get('ws-a', id), null);
  assert.deepEqual(seen, ['deleting', 'deleting', 'deleting']);
  assert.equal(await store.delete('ws-a', id, usage(false)), 'not_found');
});

test('a workspace has one current location and a bounded number of locations', async () => {
  const db = testDatabase();
  const store = new LinkStorageStore(db);
  const k = await kek(1, [1]);
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push(await created(store, db, k));
  assert.deepEqual((await store.list('ws-a')).filter(l => l.current).map(l => l.locationId), [ids[7]]);
  // A ninth changes nothing, not even which one is current.
  const ninth = await created(store, db, k);
  assert.equal(await store.get('ws-a', ninth), null);
  assert.deepEqual((await store.list('ws-a')).filter(l => l.current).map(l => l.locationId), [ids[7]]);
  const deployment = deploymentLocations(JSON.stringify({ current: 'main', locations: { main: fields } }));
  assert.equal((await store.currentLocation('ws-a', deployment, 1))?.kind, 'workspace');
  assert.deepEqual(await store.currentLocation('ws-b', deployment, 1), { kind: 'deployment', locationId: 'main', fields });
  assert.equal(await store.currentLocation('ws-b', undefined, 1), null);
});

test('rotation of the KEK: lazy rewrap on use, a bounded job, and the versions still in use', async () => {
  const db = testDatabase();
  const store = new LinkStorageStore(db);
  const v1 = await kek(1, [1]);
  const ids = [await created(store, db, v1, 'ws-a'), await created(store, db, v1, 'ws-b'), await created(store, db, v1, 'ws-c')];
  assert.deepEqual(await store.keyVersionsInUse(), [1]);
  const v2 = await kek(2, [1, 2]);
  // A use rewraps that one credential.
  assert.deepEqual((await store.credential(v2, 'ws-a', ids[0], 'read'))!.reveal(), READ);
  const row = (ws: string) => db.raw.prepare('SELECT read_key_version, write_key_version FROM link_storage_locations WHERE workspace_id = ?').get(ws);
  assert.deepEqual({ ...row('ws-a') }, { read_key_version: 2, write_key_version: 1 });
  assert.deepEqual(await store.keyVersionsInUse(), [1, 2]);
  // The operator job rewraps at most `limit` per call and resumes from its cursor.
  const first = await store.rewrapStale(v2, 2);
  assert.deepEqual([first.rewrapped, first.failed, typeof first.next], [2, 0, 'string']);
  assert.deepEqual(await store.rewrapStale(v2, 100, first.next), { rewrapped: 3, failed: 0, next: null });
  assert.deepEqual(await store.rewrapStale(v2, 100), { rewrapped: 0, failed: 0, next: null });
  await assert.rejects(store.rewrapStale(v2, 1, 'not a cursor'), /Invalid rewrap cursor/);
  assert.deepEqual(await store.keyVersionsInUse(), [2]);
  // Version 1 can now be removed, and everything still opens.
  const only2 = (await linkKek(JSON.stringify({ current: '2', keys: { 2: keyBytes(2) } })))!;
  for (const [i, ws] of ['ws-a', 'ws-b', 'ws-c'].entries()) assert.deepEqual((await store.credential(only2, ws, ids[i], 'write'))!.reveal(), WRITE);
  // A value that cannot be opened is counted and left alone.
  db.raw.prepare(`UPDATE link_storage_locations SET read_key_version = 3 WHERE workspace_id = 'ws-c'`).run();
  const v4 = await kek(4, [2, 4]);
  assert.deepEqual(await store.rewrapStale(v4, 100), { rewrapped: 5, failed: 1, next: null });
});

test('the rewrap job moves past values it cannot open', async () => {
  const db = testDatabase();
  const store = new LinkStorageStore(db);
  const v1 = await kek(1, [1]);
  for (const ws of ['ws-a', 'ws-b', 'ws-c']) await created(store, db, v1, ws);
  // Two unreadable read values (under a missing version 3) come first in the walk.
  db.raw.prepare(`UPDATE link_storage_locations SET read_key_version = 3 WHERE workspace_id IN ('ws-a', 'ws-b')`).run();
  const v2 = await kek(2, [1, 2]);
  let next: string | null = null;
  const totals = { rewrapped: 0, failed: 0 };
  let calls = 0;
  do {
    const step = await store.rewrapStale(v2, 2, next);
    totals.rewrapped += step.rewrapped;
    totals.failed += step.failed;
    next = step.next;
    assert.ok(++calls < 10);
  } while (next !== null);
  assert.deepEqual(totals, { rewrapped: 4, failed: 2 });
  assert.deepEqual(await store.keyVersionsInUse(), [2, 3]);
});

test('a content-lookup read does not rewrap, and a failed final delete keeps the location', async () => {
  const db = testDatabase();
  const store = new LinkStorageStore(db);
  const id = await created(store, db, await kek(1, [1]));
  const v2 = await kek(2, [1, 2]);
  const before = JSON.stringify(db.dump('link_storage_locations'));
  assert.deepEqual((await store.credential(v2, 'ws-a', id, 'read', { rewrap: false }))!.reveal(), READ);
  assert.equal(JSON.stringify(db.dump('link_storage_locations')), before);
  // The final DELETE fails once: the row is active again, visible and deletable later.
  const failing = { ...db, prepare(sql: string) {
    const statement = db.prepare(sql);
    return sql.startsWith('DELETE FROM link_storage_locations') ? { ...statement, bind: () => ({ ...statement, run: async () => { throw new Error('d1 down'); } }) } as typeof statement : statement;
  } };
  await assert.rejects(new LinkStorageStore(failing).delete('ws-a', id, { inUse: async () => false }), /d1 down/);
  assert.ok(await store.get('ws-a', id));
  // Both the delete and its restore fail: the row stays `deleting` until its claim expires,
  // then the next delete takes the claim over and finishes.
  const broken = { ...db, prepare(sql: string) {
    const statement = db.prepare(sql);
    const fails = sql.startsWith('DELETE FROM link_storage_locations') || sql.includes("SET state = 'active'");
    return fails ? { ...statement, bind: () => ({ ...statement, run: async () => { throw new Error('d1 down'); } }) } as typeof statement : statement;
  } };
  await assert.rejects(new LinkStorageStore(broken).delete('ws-a', id, { inUse: async () => false }, 10_000), /d1 down/);
  assert.equal((await store.get('ws-a', id))?.state, 'deleting');
  assert.equal(await store.delete('ws-a', id, { inUse: async () => false }, 10_000 + DELETE_CLAIM_MS - 1), 'pending');
  let asked = false;
  assert.equal(await store.delete('ws-a', id, { inUse: async () => { asked = true; return true; } }, 10_000 + DELETE_CLAIM_MS), 'in_use');
  assert.ok(asked);
  assert.ok(await store.get('ws-a', id));
  assert.equal(await store.delete('ws-a', id, { inUse: async () => false }), 'deleted');
});

test('while a delete checks usage, downloads resolve and new links wait instead of using the deployment', async () => {
  const db = testDatabase();
  const store = new LinkStorageStore(db);
  const k = await kek(1, [1]);
  const id = await created(store, db, k);
  const deployment = deploymentLocations(JSON.stringify({ current: 'main', locations: { main: fields } }));
  let answer!: (value: boolean) => void;
  let checking!: () => void;
  const started = new Promise<void>(resolve => { checking = resolve; });
  const pending = store.delete('ws-a', id, { inUse: () => { checking(); return new Promise<boolean>(resolve => { answer = resolve; }); } }, 1_000);
  await started;
  // A download of an existing link still gets the read key.
  assert.deepEqual((await store.credential(k, 'ws-a', id, 'read', { rewrap: false }))!.reveal(), READ);
  // A new link neither uses the deployment bucket nor the location: retry later.
  await assert.rejects(store.currentLocation('ws-a', deployment, 1_001), LocationPendingDeleteError);
  assert.deepEqual((await store.list('ws-a', 1_001)).map(l => [l.locationId, l.state]), [[id, 'deleting']]);
  answer(true);
  assert.equal(await pending, 'in_use');
  assert.equal((await store.currentLocation('ws-a', deployment, 1_002))?.kind, 'workspace');
});

test('a location whose restore failed after an in-use answer heals itself', async () => {
  const db = testDatabase();
  const store = new LinkStorageStore(db);
  const k = await kek(1, [1]);
  const id = await created(store, db, k);
  const deployment = deploymentLocations(JSON.stringify({ current: 'main', locations: { main: fields } }));
  const broken = { ...db, prepare(sql: string) {
    const statement = db.prepare(sql);
    return sql.includes("SET state = 'active'") ? { ...statement, bind: () => ({ ...statement, run: async () => { throw new Error('d1 down'); } }) } as typeof statement : statement;
  } };
  await assert.rejects(new LinkStorageStore(broken).delete('ws-a', id, { inUse: async () => true }, 5_000), /d1 down/);
  // Until the claim is stale the row is `deleting`; downloads still work.
  assert.equal((await store.get('ws-a', id))?.state, 'deleting');
  assert.ok(await store.credential(k, 'ws-a', id, 'read', { rewrap: false }));
  await assert.rejects(store.currentLocation('ws-a', deployment, 5_000 + DELETE_CLAIM_MS - 1), LocationPendingDeleteError);
  // Then it heals without anyone retrying the delete.
  const current = await store.currentLocation('ws-a', deployment, 5_000 + DELETE_CLAIM_MS);
  assert.deepEqual([current?.kind, current?.kind === 'workspace' && current.location.state], ['workspace', 'active']);
  assert.deepEqual((await store.list('ws-a', 5_000 + DELETE_CLAIM_MS)).map(l => l.state), ['active']);
});

test('a delete whose claim was taken over can neither delete nor restore the location', async () => {
  const db = testDatabase();
  const store = new LinkStorageStore(db);
  const id = await created(store, db, await kek(1, [1]));
  const state = () => db.raw.prepare('SELECT state, delete_claim FROM link_storage_locations').get() as { state: string; delete_claim: string } | undefined;
  for (const lateAnswer of [false, true]) {
    let answer!: (value: boolean) => void;
    let checking!: () => void;
    const started = new Promise<void>(resolve => { checking = resolve; });
    const first = store.delete('ws-a', id, { inUse: () => { checking(); return new Promise<boolean>(resolve => { answer = resolve; }); } }, 1_000);
    await started;
    const firstClaim = state()!.delete_claim;
    // The second delete takes the stale claim over and holds it while it checks.
    let release!: (value: boolean) => void;
    let secondChecking!: () => void;
    const secondStarted = new Promise<void>(resolve => { secondChecking = resolve; });
    const second = store.delete('ws-a', id, { inUse: () => { secondChecking(); return new Promise<boolean>(resolve => { release = resolve; }); } },
      1_000 + DELETE_CLAIM_MS);
    await secondStarted;
    const secondClaim = state()!.delete_claim;
    assert.notEqual(secondClaim, firstClaim);
    // The late first delete answers now: it may not delete (false) or reactivate (true) the row.
    answer(lateAnswer);
    assert.equal(await first, lateAnswer ? 'in_use' : 'pending');
    assert.deepEqual({ ...state() }, { state: 'deleting', delete_claim: secondClaim });
    // The second delete decides: in use, so the row is active again.
    release(true);
    assert.equal(await second, 'in_use');
    assert.deepEqual({ ...state() }, { state: 'active', delete_claim: null });
  }
});

test('a usage check that hangs keeps the location and fails the delete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = testDatabase();
  const store = new LinkStorageStore(db);
  const id = await created(store, db, await kek(1, [1]));
  const pending = store.delete('ws-a', id, { inUse: () => new Promise<boolean>(() => {}) });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(USAGE_TIMEOUT_MS);
  await assert.rejects(pending, /timed out/);
  assert.ok(await store.get('ws-a', id));
});

test('a deployment location id is never silently repointed', async () => {
  const db = testDatabase();
  const store = new LinkStorageStore(db);
  await store.ensureDeploymentFingerprint('main', fields, 1);
  await store.ensureDeploymentFingerprint('main', { ...fields }, 2);
  for (const changed of [{ bucket: 'other' }, { endpoint: 'https://s3.other-fixture.test' }, { prefix: 'p/' }, { pathStyle: false }, { region: 'eu' }]) {
    await assert.rejects(store.ensureDeploymentFingerprint('main', { ...fields, ...changed }, 3), LocationRepointedError);
  }
  await store.ensureDeploymentFingerprint('second', { ...fields, bucket: 'other' }, 4);
  const config = deploymentLocations(JSON.stringify({ current: 'main', locations: { main: { ...fields, bucket: 'moved' } } }));
  await assert.rejects(store.currentLocation('ws-a', config, 5), LocationRepointedError);
});

test('the deployment config parses strictly', () => {
  const ok = deploymentLocations(JSON.stringify({ current: 'main', locations: { main: fields, old: { ...fields, bucket: 'old-links' } } }));
  assert.deepEqual([ok?.current, [...ok!.locations.keys()]], ['main', ['main', 'old']]);
  // The operator's own storage domain is allowed in the deployment config.
  assert.ok(deploymentLocations(JSON.stringify({ current: 'k', locations: { k: { ...fields, endpoint: 'https://s3.kofra-fixture.test' } } })));
  for (const value of [undefined, 'x', { current: 'missing', locations: { main: fields } }, { current: 'main', locations: { main: { ...fields, endpoint: 'https://localhost' } } },
    { current: 'main', locations: { main: { ...fields, extra: 1 } } }, { current: 'Main', locations: { Main: fields } }, { current: 'main', locations: { main: fields }, more: 1 }]) {
    assert.equal(deploymentLocations(typeof value === 'object' ? JSON.stringify(value) : value), undefined);
  }
  const secrets = credentialSecret(JSON.stringify({ main: READ }));
  assert.deepEqual(secrets?.get('main')?.reveal(), READ);
});

test('only the read-only credential secret is allowed in mail-content', () => {
  assert.deepEqual(linkSecretViolations('content', ['LINK_READ_CREDENTIALS', 'CONTENT_URL_KEYS']), []);
  assert.deepEqual(linkSecretViolations('content', ['LINK_READ_CREDENTIALS', 'LINK_WRITE_CREDENTIALS', 'LINK_CRED_KEK']),
    ['LINK_WRITE_CREDENTIALS', 'LINK_CRED_KEK']);
  assert.deepEqual(linkSecretViolations('web', ['LINK_READ_CREDENTIALS', 'LINK_WRITE_CREDENTIALS', 'LINK_CRED_KEK']), ['LINK_READ_CREDENTIALS']);
  assert.deepEqual(linkSecretViolations('backend', ['LINK_WRITE_CREDENTIALS', 'LINK_CRED_KEK']), []);
});
