import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

// Conformance cases 13, 14, 22 and 23 (with 23a) against the backend over HTTP
// in local workerd (docs/m3-outbound-plan.md, section 3, M3-3). The other
// outbound cases (6a, 11a, 15, 21a) wait for the MIME builder and the
// consumer, so a child test run selects only the named cases.
const owned = ['13', '14', '22', '23', '23a'];

test('conformance cases 13, 14, 22, 23 and 23a pass against the backend with the send path on', { timeout: 600_000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/send-conformance.ts', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // The child has its own deadline, inside this test's, and is killed whatever happens.
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1',
    ...owned.map(id => `--test-name-pattern=^${id.replace('.', '\\.')}\\. `), file],
  { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 540_000, killSignal: 'SIGKILL' });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  const passed = [...output.matchAll(/^\s+ok \d+ - (\d+a?)\. /gm)].map(match => match[1]).sort();
  const failed = [...output.matchAll(/^\s+not ok \d+ - (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(failed, [], output);
  assert.equal(code, 0, output);
  assert.deepEqual(passed, [...owned].sort(), output);
});
