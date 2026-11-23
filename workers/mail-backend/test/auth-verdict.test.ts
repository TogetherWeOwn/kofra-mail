import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authVerdict } from '../src/auth-verdict.ts';

const cases: Array<[string, string | null, string, string]> = [
  ['aligned pass', 'mx.example; dmarc=pass header.from=example.test', 'alice@example.test', 'pass'],
  ['unaligned pass', 'mx.example; dmarc=pass header.from=other.test', 'alice@example.test', 'unaligned'],
  ['fail', 'mx.example; dmarc=fail header.from=example.test', 'alice@example.test', 'fail'],
  ['explicit none', 'mx.example; dmarc=none', 'alice@example.test', 'none'],
  ['absent DMARC', 'mx.example; spf=pass', 'alice@example.test', 'none'],
  ['absent header', null, 'alice@example.test', 'none'],
  ['multiple From addresses', 'mx.example; dmarc=pass header.from=example.test', 'a@example.test, b@example.test', 'unaligned'],
  ['case-insensitive alignment', 'mx.example; DMARC=PASS HEADER.FROM=EXAMPLE.test', 'alice@example.TEST', 'pass'],
];
for (const [description, header, from, expected] of cases) {
  test(`DMARC verdict: ${description}`, () => assert.equal(authVerdict(header, from), expected));
}
