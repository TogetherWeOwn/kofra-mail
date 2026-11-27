import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { runChild } from './fixtures/child-tests.ts';

// Each case runs in its own process with --expose-gc; the child fails above 64 MiB.
const cases = {
  'one-attachment': 'a 25 MiB message with one base64 attachment',
  'eight-attachments': 'a 25 MiB message with eight base64 attachments',
  'unwrapped-base64': 'a 25 MiB message with one base64 attachment on a single line',
  'qp-body': 'a message with a 1 MiB non-ASCII quoted-printable body',
};

for (const [kind, description] of Object.entries(cases)) {
  test(`parsing and storing ${description} stays within the 64 MiB budget`, async t => {
    const file = fileURLToPath(new URL('./fixtures/parse-mail-memory.ts', import.meta.url));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { code, signal, output } = await runChild(['--expose-gc', file, kind], { env, timeoutMs: 60_000 });
    assert.equal(code, 0, signal ? `Memory child stopped on ${signal}\n${output}` : output);
    t.diagnostic(output.trim());
  });
}
