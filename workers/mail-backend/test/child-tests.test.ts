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

test('a runner stopped by SIGTERM or SIGINT kills its child group before it exits', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const helper = new URL('./fixtures/child-tests.ts', import.meta.url).href;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'child-tests-'));
    const pidFile = join(dir, 'pid');
    // The runner's child starts a grandchild, records its pid and hangs.
    const child = `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid)); setInterval(() => {}, 1000);`;
    const runner = spawn(process.execPath, ['--input-type=module', '-e',
      `const { runChild } = await import(${JSON.stringify(helper)}); await runChild(['-e', ${JSON.stringify(child)}], { timeoutMs: 60_000 });`],
    { stdio: 'ignore' });
    let pid = 0;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      for (let i = 0; i < 250 && !pid; i++) {
        pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
        if (!pid) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(pid > 0, 'the grandchild started');
      const exited = new Promise(resolve => runner.on('exit', resolve));
      runner.kill(signal);
      await exited;
      for (let i = 0; i < 100 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(alive(), false, `the grandchild outlived a runner stopped by ${signal}`);
    } finally {
      if (pid && alive()) process.kill(pid, 'SIGKILL');
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
      await rm(dir, { recursive: true });
    }
  }
});
