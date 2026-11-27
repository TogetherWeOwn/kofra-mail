import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { runChild } from './fixtures/child-tests.ts';

// Each case runs in its own process with --expose-gc; the child fails above
// 64 MiB. `replayed` is how many attachments each case must decode again,
// digest and stream, so a case cannot pass by no longer exercising the store.
const cases: Record<string, { description: string; replayed: number }> = {
  'one-attachment': { description: 'a 25 MiB message with one base64 attachment', replayed: 1 },
  'eight-attachments': { description: 'a 25 MiB message with eight base64 attachments', replayed: 8 },
  'unwrapped-base64': { description: 'a 25 MiB message with one base64 attachment on a single line', replayed: 1 },
  '8bit-long-lines': { description: 'a 25 MiB message with an 8-bit attachment in 1 MB lines', replayed: 1 },
  'qp-long-lines': { description: 'a 25 MiB message with a quoted-printable attachment in 1 MB lines', replayed: 1 },
  'qp-body': { description: 'a message with a 1 MiB non-ASCII quoted-printable body', replayed: 0 },
};
// Known over the budget: PostalMime holds these parts whole. Bounding them is
// M3-14b; until then they are measured and reported, not asserted.
const known = {
  'plain-text-body': 'a 25 MiB plain-text body',
  'inline-forward': 'a 25 MiB inline message/rfc822 holding a large attachment',
  calendar: 'a 25 MiB ASCII calendar attachment',
  'qp-escape-dense-lines': 'a 25 MiB quoted-printable attachment in escape-dense 1 MB lines',
  'qp-single-line': 'a quoted-printable attachment on one 23 MB line',
};

async function run(kind: string, reportOnly: boolean) {
  const file = fileURLToPath(new URL('./fixtures/parse-mail-memory.ts', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { code, signal, output } = await runChild(['--expose-gc', file, kind, ...reportOnly ? ['--report-only'] : []], { env, timeoutMs: 60_000 });
  assert.equal(code, 0, signal ? `Memory child stopped on ${signal}\n${output}` : output);
  return output.trim();
}

for (const [kind, { description, replayed }] of Object.entries(cases)) {
  test(`parsing and storing ${description} stays within the 64 MiB budget`, async t => {
    const output = await run(kind, false);
    t.diagnostic(output);
    const report = JSON.parse(output.split('\n').find(line => line.startsWith('{')) ?? '{}') as { replayed?: number };
    assert.equal(report.replayed, replayed, `${kind}: attachments decoded again, digested and streamed`);
  });
}

for (const [kind, description] of Object.entries(known)) {
  test(`parsing ${description} is measured (known over the budget until M3-14b)`, async t => {
    t.diagnostic(`M3-14b: ${await run(kind, true)}`);
  });
}
