import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { failedTests, passedCases, runChild } from './fixtures/child-tests.ts';

// Run the send cases the backend supports over HTTP in local workerd.
const owned = ['1a', '13', '14', '15', '21', '21a', '22', '23', '23a'];

// Inside the backend CI job's five minutes, so a hang still reports the captured output.
test(`conformance cases ${owned.join(', ')} pass against the backend with the send path on`, { timeout: 170_000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/send-conformance.ts', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // The child has its own deadline, inside this test's, and its whole process group is killed whatever happens.
  const { code, output } = await runChild(['--test', '--test-reporter=tap', '--test-concurrency=1',
    ...owned.map(id => `--test-name-pattern=^${id.replace('.', '\\.')}\\. `), file], { env, timeoutMs: 150_000 });
  // Only unqualified passes count: a `# SKIP` or `# TODO` line did not run the case.
  const passed = passedCases(output);
  const failed = failedTests(output);
  assert.deepEqual(failed, [], output);
  assert.equal(code, 0, output);
  assert.deepEqual(passed, [...owned].sort(), output);
});
