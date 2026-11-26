import assert from 'node:assert/strict';
import test from 'node:test';
import { failedTests, passedCases, runChild } from './fixtures/child-tests.ts';

// The runner that mail-send-conformance.test.ts uses for its child test run.

test('a TAP pass qualified by # SKIP or # TODO does not count as a passed case', () => {
  const output = ['TAP version 13', '# Subtest: suite', '    # Subtest: 13. runs', '    ok 1 - 13. runs', '    ok 2 - 14. skipped # SKIP',
    '    ok 3 - 22. todo # TODO not ready', '    ok 4 - 23a. skipped with a reason # SKIP needs M3-4', '    ok 5 - 23. a name with \\# SKIP in it',
    '    not ok 6 - 24. fails', 'ok 1 - suite'].join('\n');
  assert.deepEqual(passedCases(output), ['13', '23']);
  assert.deepEqual(failedTests(output), ['24. fails']);
});

test('a child run past its deadline is killed with its whole process group', async () => {
  // The child starts a grandchild that ignores its parent's death, then hangs.
  const script = `const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log('grandchild ' + grandchild.pid);
    setInterval(() => {}, 1000);`;
  const run = await runChild(['-e', script], { timeoutMs: 1_000 });
  const pid = Number(/grandchild (\d+)/.exec(run.output)?.[1]);
  assert.ok(pid > 0, run.output);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    assert.equal(run.signal, 'SIGKILL');
    // The reaper may take a moment to collect it.
    for (let i = 0; i < 100 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(alive(), false, 'the grandchild outlived the run');
  } finally {
    if (alive()) process.kill(pid, 'SIGKILL');
  }
});
