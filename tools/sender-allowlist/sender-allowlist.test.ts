import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CloudflareMail } from './cloudflare.ts';
import { configWithSenders } from './deploy.ts';
import { SELECT_ADDRESSES, SELECT_DOMAINS, runSenderAllowlist, senderList } from './job.ts';
import { credentials, directoryFixture, exampleDomain, otherVersion, quotedAddress, version } from './fixtures/directory.ts';

const runFile = promisify(execFile);
const cliFixture = fileURLToPath(new URL('./fixtures/run-cli.ts', import.meta.url));
const alice = `a@${exampleDomain}`;

test('keeps only eligible senders, sorted and unique', () => {
  const address = (address_norm: string, send_as_policy = 'pending', workspace_id = 'wk') =>
    ({ address_norm, workspace_id, send_as_policy });
  const domain = (name: string, kind = 'primary', sending_state = 'active', workspace_id = 'wk') =>
    ({ name, workspace_id, kind, sending_state });
  assert.deepEqual(senderList([
    address('z@secondary.test', 'active'), address(quotedAddress), address(quotedAddress, 'active'), address(alice),
    address('a@alias.test'), address('a@inactive.test'), address('a@missing.test'), address('a@wrong-workspace.test'),
    address(`revoked@${exampleDomain}`, 'revoked'), address(exampleDomain),
  ], [
    domain(exampleDomain), domain('secondary.test', 'secondary'), domain('alias.test', 'alias'),
    domain('inactive.test', 'primary', 'pending'), domain('wrong-workspace.test', 'primary', 'active', 'another'),
  ]), [alice, quotedAddress, 'z@secondary.test']);
});

for (const boundedTable of ['addresses', 'domains'] as const) {
  test(`a cap+1 ${boundedTable} read aborts before any mutation or deployment`, async (t) => {
    const fixture = await directoryFixture(t);
    for (const i of [2, 0, 1]) {
      const domain = `${i}.test`;
      if (boundedTable === 'addresses') fixture.address(`a@${domain}`, 'active');
      else fixture.domain(domain);
    }
    const client = new CloudflareMail(credentials, fixture.request);
    await assert.rejects(runSenderAllowlist(client, async () => assert.fail('unexpected deployment'), 2), /cap/);
    assert.deepEqual(fixture.calls, [
      { sql: SELECT_ADDRESSES, params: ['3'] },
      ...(boundedTable === 'domains' ? [{ sql: SELECT_DOMAINS, params: ['3'] }] : []),
    ]);
    assert.deepEqual(fixture.events, []);
  });
}

test('dry run reads at most default cap plus one, prints counts, and does not mutate', async (t) => {
  const fixture = await directoryFixture(t);
  fixture.domain();
  fixture.address(alice);
  fixture.address('a@not-listed.test', 'active');
  const result = await invokeCli(t, fixture.origin, 'dry-run', false);
  assert.deepEqual(result, { stdout: '{"pending":1,"active":1,"listed":1,"lowered":0,"promoted":0,"domains":1}\n', stderr: '' });
  assert.deepEqual(fixture.calls, [
    { sql: 'SELECT address_norm, workspace_id, send_as_policy FROM addresses ORDER BY address_norm LIMIT ?', params: ['501'] },
    { sql: 'SELECT name, workspace_id, kind, sending_state FROM domains ORDER BY name LIMIT ?', params: ['501'] },
  ]);
  assert.deepEqual(fixture.events, []);
});

test('an empty list omits the binding; a nonempty list adds only the exact senders', () => {
  const base = { name: 'mail-send', main: 'src/index.ts', vars: { UNRELATED: 'keep' } };
  assert.deepEqual(configWithSenders(base, []), base);
  assert.deepEqual(configWithSenders(base, [alice, quotedAddress]), {
    ...base, send_email: [{ name: 'EMAIL', allowed_sender_addresses: [alice, quotedAddress] }],
  });
});

test('rejects base config settings that can inject or retain unmanaged email bindings', () => {
  for (const base of [
    { send_email: [] },
    { unsafe: { bindings: [{ type: 'send_email', name: 'EMAIL' }] } },
    { unsafe: { metadata: { bindings: [{ type: 'send_email', name: 'EMAIL' }] } } },
    { unsafe: { metadata: { keep_bindings: ['send_email'] } } },
  ]) {
    assert.throws(() => configWithSenders(base, []), /send_email/);
  }
});

test('lowering comes before deploy; only deployed, still-pending rows can be promoted', async (t) => {
  const fixture = await directoryFixture(t);
  const toLower = "lower'quoted@not-listed.test";
  const revoked = `revoked@${exampleDomain}`;
  const moved = `moved@${exampleDomain}`;
  const disabled = 'a@later-disabled.test';
  const unlisted = 'a@not-listed.test';
  fixture.domain();
  fixture.domain('later-disabled.test');
  fixture.address(toLower, 'active');
  for (const address of [quotedAddress, revoked, moved, disabled, unlisted]) fixture.address(address);
  const counts = await runSenderAllowlist(new CloudflareMail(credentials, fixture.request), async (list) => {
    fixture.events.push('deploy');
    assert.equal(fixture.policy(toLower), 'pending');
    assert.deepEqual(list, [disabled, moved, quotedAddress, revoked]);
    fixture.setPolicy(revoked, 'revoked');
    fixture.mailbox('other-mailbox', 'other');
    fixture.db.prepare('UPDATE addresses SET workspace_id = ?, target_id = ? WHERE address_norm = ?')
      .run('other', 'other-mailbox', moved);
    fixture.db.prepare('UPDATE domains SET sending_state = ? WHERE name = ?').run('disabled', 'later-disabled.test');
    return version;
  });
  assert.deepEqual(counts, { pending: 5, active: 1, listed: 4, lowered: 1, promoted: 1, domains: 2 });
  assert.deepEqual(fixture.events, ['lower', 'deploy', 'verify', 'promote']);
  assert.equal(fixture.policy(quotedAddress), 'active');
  assert.equal(fixture.policy(revoked), 'revoked');
  for (const address of [toLower, moved, disabled, unlisted]) assert.equal(fixture.policy(address), 'pending');
  for (const address of [quotedAddress, toLower]) {
    assert.ok(fixture.calls.some(({ params }) => params.includes(address)));
    assert.ok(fixture.calls.every(({ sql }) => !sql.includes(address)));
  }
});

test('a recreated pending row in the same workspace can activate the already-deployed address', async (t) => {
  const fixture = await directoryFixture(t);
  fixture.domain();
  fixture.address(alice, 'pending', 'wk', 'original-mailbox');
  fixture.address(quotedAddress);
  const counts = await runSenderAllowlist(new CloudflareMail(credentials, fixture.request), async (list) => {
    assert.deepEqual(list, [alice, quotedAddress]);
    fixture.db.prepare('DELETE FROM addresses WHERE address_norm IN (?, ?)').run(alice, quotedAddress);
    fixture.address(alice, 'pending', 'wk', 'different-mailbox');
    return version;
  });
  assert.equal(counts.promoted, 1);
  const current = fixture.db.prepare('SELECT target_id, send_as_policy FROM addresses WHERE address_norm = ?').get(alice);
  assert.equal(current?.target_id, 'different-mailbox');
  assert.equal(current?.send_as_policy, 'active');
  assert.equal(fixture.policy(quotedAddress), undefined);
});

const deploymentCases = [
  ['a newer version', [{ versions: [{ version_id: otherVersion, percentage: 100 }] },
    { versions: [{ version_id: version, percentage: 100 }] }]],
  ['split traffic', [{ versions: [{ version_id: version, percentage: 90 }, { version_id: otherVersion, percentage: 10 }] }]],
  ['partial traffic', [{ versions: [{ version_id: version, percentage: 99 }] }]],
  ['no deployment', []],
] as const;
for (const [label, deployments] of deploymentCases) {
  test(`verification rejects ${label} and does not promote`, async (t) => {
    const fixture = await directoryFixture(t);
    fixture.domain();
    fixture.address(alice);
    fixture.control.deployments = structuredClone(deployments).map(({ versions }) => ({ versions: [...versions] }));
    await assert.rejects(runSenderAllowlist(new CloudflareMail(credentials, fixture.request), async () => version), /active deployment/);
    assert.deepEqual(fixture.events, ['verify']);
    assert.equal(fixture.policy(alice), 'pending');
  });
}

test('deploy mode chunks statements at 100 bound parameters and does not mutate D1 on unchanged rerun', async (t) => {
  const fixture = await directoryFixture(t);
  fixture.domain();
  for (let i = 0; i < 120; i++) {
    fixture.address(`${i}@${exampleDomain}`);
    fixture.address(`${i}@not-listed.test`, 'active');
  }
  const client = new CloudflareMail(credentials, fixture.request);
  const deploy = async (list: string[]) => {
    fixture.events.push('deploy');
    assert.equal(list.length, 120);
    return version;
  };
  const first = await runSenderAllowlist(client, deploy);
  assert.equal(first.lowered, 120);
  assert.equal(first.promoted, 120);
  assert.ok(fixture.events.filter((event) => event === 'lower').length > 1);
  assert.ok(fixture.events.filter((event) => event === 'promote').length > 1);
  fixture.events.length = 0;
  fixture.calls.length = 0;
  const second = await runSenderAllowlist(client, deploy);
  assert.equal(second.lowered, 0);
  assert.equal(second.promoted, 0);
  assert.deepEqual(fixture.events, ['deploy', 'verify']);
  assert.equal(fixture.calls.length, 2);
});

test('deploy mode fails closed without the sending worker config', async (t) => {
  const fixture = await directoryFixture(t);
  await assert.rejects(invokeCli(t, fixture.origin, 'deploy', false), { code: 2, stdout: '', stderr: '' });
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.events, []);
});

for (const hasSender of [true, false]) {
  test(`fixture deploy ${hasSender ? 'with senders' : 'without a binding'} logs only counts`, async (t) => {
    const fixture = await directoryFixture(t);
    fixture.domain();
    if (hasSender) fixture.address(quotedAddress);
    const { stdout, stderr } = await invokeCli(t, fixture.origin, 'deploy', true, hasSender ? 'listed' : 'empty');
    assert.doesNotMatch(stdout + stderr, new RegExp(`@|${exampleDomain.replace('.', '\\.')}`));
    assert.deepEqual(JSON.parse(stdout), { pending: Number(hasSender), active: 0, listed: Number(hasSender),
      lowered: 0, promoted: Number(hasSender), domains: 1 });
    assert.equal(stderr, '');
    assert.deepEqual(fixture.events, hasSender ? ['verify', 'promote'] : ['verify']);
  });
}

test('failed REST responses and failed Wrangler output never reach either log stream', async (t) => {
  const fixture = await directoryFixture(t);
  fixture.control.failQuery = true;
  await assert.rejects(invokeCli(t, fixture.origin, 'dry-run', false), { code: 3, stdout: '', stderr: '' });
  fixture.control.failQuery = false;
  fixture.domain();
  fixture.address(quotedAddress);
  await assert.rejects(invokeCli(t, fixture.origin, 'deploy', true, 'failure'), { code: 4, stdout: '', stderr: '' });
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.policy(quotedAddress), 'pending');
});

test('deployment refuses a stale dispatch even when checked out at its original commit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'velmora-sender-allowlist-ref-'));
  t.after(() => rm(dir, { recursive: true }));
  const env = { PATH: process.env.PATH, HOME: dir };
  const git = async (...args: string[]) => (await runFile('git', args, { cwd: dir, env })).stdout.trim();
  const commit = (message: string) => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', message);
  const guard = fileURLToPath(new URL('./check-main.sh', import.meta.url));
  const check = (sha: string) => runFile('bash', [guard], { cwd: dir, env: { ...env, GITHUB_SHA: sha } });
  await git('init', '--initial-branch=main');
  await git('remote', 'add', 'origin', '.');
  await commit('original dispatch');
  const original = await git('rev-parse', 'HEAD');
  await check(original);
  await commit('new main head');
  const current = await git('rev-parse', 'HEAD');
  await git('checkout', '--detach', original);
  const stale = { code: 1, stdout: '', stderr: 'Cannot verify this checkout is current main; start a fresh dispatch.\n' };
  await assert.rejects(check(original), stale);
  await assert.rejects(check(current), stale);
  await git('checkout', 'main');
  await check(current);
});

async function invokeCli(t: TestContext, origin: string, mode: string, hasConfig: boolean, wranglerMode = 'empty') {
  const dir = await mkdtemp(join(tmpdir(), 'velmora-sender-allowlist-test-'));
  t.after(() => rm(dir, { recursive: true }));
  if (hasConfig) await writeFile(join(dir, 'wrangler.jsonc'), '{\n // Wrangler JSONC fixture\n "name":"mail-send", "main":"src/index.ts",\n}\n');
  try {
    return await runFile(process.execPath, [cliFixture, origin, mode, dir, wranglerMode], { env: credentials });
  } finally {
    assert.deepEqual(await readdir(dir), hasConfig ? ['wrangler.jsonc'] : []);
  }
}
