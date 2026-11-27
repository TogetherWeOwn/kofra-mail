import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { runChild } from './fixtures/child-tests.ts';

test('a 23.9 MiB v1 sent-copy build stays under the 64 MiB allocation budget', async t => {
  const file = fileURLToPath(new URL('./fixtures/send-mime-memory.ts', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { code, signal, output } = await runChild(['--expose-gc', file], { env, timeoutMs: 10_000 });
  assert.equal(code, 0, signal ? `Memory child stopped on ${signal}\n${output}` : output);
  t.diagnostic(output.trim());
});
