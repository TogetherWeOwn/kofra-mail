import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpMailService, ERROR_STATUS, isMailApiError, LIMITS } from './index.ts';
import type { DraftInput, Idempotent, Problem, Session } from './index.ts';

const session: Session = {
  user: { id: 'user-1', name: 'Mailbox owner' },
  mailbox: { id: 'mailbox-1', primaryAddress: 'mailbox@example.com' },
  workspace: { id: 'workspace-1', role: 'member' },
  csrfToken: 'test-csrf-token', authTime: '2026-11-24T00:00:00Z', limits: LIMITS,
  features: { drive: false, htmlContent: true, m3: false }, state: 'initial',
};
const draftInput: DraftInput = {
  from: 'mailbox@example.com', to: [], cc: [], bcc: [], subject: 'A draft', body: 'Hello', attachments: [],
};
const draft = { ...draftInput, id: 'draft-1', revision: 'r-2', updatedAt: '2026-11-24T00:00:00Z' };
const page = { items: [], nextCursor: null, state: 'state-2' };
const json = (content: unknown, status = 200) => Response.json(content, { status });

function recording(...replies: ((request: Request) => Response | Promise<Response>)[]) {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(typeof input === 'string' ? new URL(input, 'https://mail.example.com') : input, init);
    requests.push(request);
    const reply = replies.shift();
    assert.ok(reply, 'unexpected request');
    return reply(request);
  };
  return { requests, fetch };
}

test('defaults to a same-origin session request with no cache or redirects', async () => {
  const { fetch } = recording((request) => {
    assert.equal(request.url, 'https://mail.example.com/api/v1/session');
    assert.equal(request.method, 'GET');
    assert.equal(request.credentials, 'same-origin');
    assert.equal(request.mode, 'same-origin');
    assert.equal(request.redirect, 'error');
    assert.equal(request.cache, 'no-store');
    assert.equal(request.headers.get('X-CSRF-Token'), null);
    return json(session);
  });
  assert.deepEqual(await createHttpMailService({ fetch }).getSession(), session);
});

test('uses an explicit base and preserves query values without adding absent fields', async () => {
  const { fetch } = recording(
    (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin + url.pathname, 'https://mail.example.com/local/v1/threads');
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        view: 'all', q: 'subject:"A + B & é"', tz: 'Asia/Tokyo', cursor: 'a+/= test', limit: '0',
      });
      return json(page);
    },
    (request) => {
      assert.equal(new URL(request.url).search, '?active=false');
      return json(page);
    },
  );
  const mail = createHttpMailService({ baseUrl: 'https://mail.example.com/local/v1/', fetch });
  assert.deepEqual(await mail.listThreads({ view: 'all', q: 'subject:"A + B & é"', tz: 'Asia/Tokyo', cursor: 'a+/= test', limit: 0, labelId: undefined }), page);
  assert.deepEqual(await mail.listSends({ active: false }), page);
});

test('lazily obtains CSRF for mutations and sends the JSON, path and conditional headers unchanged', async () => {
  const { fetch } = recording(
    () => json(session),
    async (request) => {
      assert.equal(request.method, 'POST');
      assert.equal(new URL(request.url).pathname, '/api/v1/drafts');
      assert.equal(request.headers.get('X-CSRF-Token'), session.csrfToken);
      assert.equal(request.headers.get('Idempotency-Key'), 'create-action');
      assert.equal(request.headers.get('If-Match'), null);
      assert.equal(request.headers.get('Content-Type'), 'application/json; charset=utf-8');
      assert.deepEqual(await request.json(), draftInput);
      return json(draft, 201);
    },
    async (request) => {
      assert.equal(request.method, 'PUT');
      assert.equal(new URL(request.url).pathname, '/api/v1/drafts/draft%2F%23%3F%20%C3%A9');
      assert.equal(request.headers.get('X-CSRF-Token'), session.csrfToken);
      assert.equal(request.headers.get('Idempotency-Key'), null);
      assert.equal(request.headers.get('If-Match'), 'r-2');
      assert.deepEqual(await request.json(), draftInput);
      return json(draft);
    },
    (request) => {
      assert.equal(request.method, 'DELETE');
      assert.equal(request.headers.get('X-CSRF-Token'), session.csrfToken);
      assert.equal(request.headers.get('If-Match'), 'r-2');
      assert.equal(request.headers.get('Content-Type'), null);
      assert.equal(request.body, null);
      return new Response(null, { status: 204 });
    },
  );
  const mail = createHttpMailService({ fetch });
  assert.deepEqual(await mail.createDraft(draftInput, { idempotencyKey: 'create-action' }), draft);
  const id = 'draft/#? é';
  assert.deepEqual(await mail.replaceDraft(id, draftInput, { ifMatch: draft.revision }), draft);
  assert.equal(await mail.deleteDraft(id, { ifMatch: draft.revision }), undefined);
});

test('uses fresh CSRF after an explicit session read and never replays a rejected write', async () => {
  const denied = {
    type: 'urn:kofra-mail:problem:csrf_failed', title: 'CSRF failed', status: 403, code: 'csrf_failed',
  } satisfies Problem;
  const { fetch, requests } = recording(
    () => json(session),
    () => json({ ...session, csrfToken: 'rotated-csrf-token' }),
    (request) => {
      assert.equal(request.headers.get('X-CSRF-Token'), 'rotated-csrf-token');
      assert.equal(request.headers.get('Idempotency-Key'), null);
      assert.equal(request.headers.get('If-Match'), null);
      assert.equal(request.body, null);
      return Response.json(denied, { status: 403, headers: { 'Content-Type': 'application/problem+json' } });
    },
    () => json({ ...session, csrfToken: 'renewed-csrf-token' }),
    (request) => {
      assert.equal(request.headers.get('X-CSRF-Token'), 'renewed-csrf-token');
      return new Response(null, { status: 204 });
    },
  );
  const mail = createHttpMailService({ fetch });
  await mail.getSession();
  await mail.getSession();
  await assert.rejects(mail.sendDraft('draft-1', {} as Idempotent & { ifMatch: string }), (err) => isMailApiError(err, 'csrf_failed'));
  assert.equal(requests.length, 3);
  await mail.deleteDraft('draft-1');
});

test('uploads put names in the query and send the raw bytes with their media type', async () => {
  const bytes = Uint8Array.of(0, 255, 13, 10);
  const name = 'A + B & é.txt';
  const mediaType = 'text/plain';
  const upload = { id: 'u1', name, type: mediaType, size: 4, sha256: 'sha', expiresAt: '2026-11-25T00:00:00Z' };
  const { fetch } = recording(
    () => json(session),
    async (request) => {
      const url = new URL(request.url);
      assert.equal(url.pathname, '/api/v1/uploads');
      assert.deepEqual(Object.fromEntries(url.searchParams), { name });
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('Idempotency-Key'), 'upload-action');
      assert.equal(request.headers.get('X-CSRF-Token'), session.csrfToken);
      assert.equal(request.headers.get('Content-Type'), mediaType);
      assert.deepEqual(new Uint8Array(await request.arrayBuffer()), bytes);
      return json(upload, 201);
    },
  );
  assert.deepEqual(await createHttpMailService({ fetch }).createUpload({ name, type: mediaType, bytes: new Blob([bytes]) }, { idempotencyKey: 'upload-action' }), upload);
});

test('preserves typed problems, status, request id and extension fields from the wire', async () => {
  assert.equal(ERROR_STATUS.not_implemented, 501);
  const problems: Problem[] = [
    { type: 'https://mail.example.com/problems/not_implemented', title: 'Unavailable in M2', status: 501, code: 'not_implemented', requestId: 'r-1' },
    { type: 'urn:kofra-mail:problem:invalid_request', title: 'Invalid request', status: 400, code: 'invalid_request', errors: [{ field: '/limit', code: 'invalid' }] },
    { type: 'urn:kofra-mail:problem:mailbox_restoring', title: 'Restoring', status: 503, code: 'mailbox_restoring', detail: 'Please try later', retryAfterSeconds: 15 },
  ];
  const { fetch } = recording(...problems.map((problem) => () => Response.json(problem, {
    status: problem.status,
    headers: { 'Content-Type': 'application/problem+json', ...(problem.retryAfterSeconds && { 'Retry-After': String(problem.retryAfterSeconds) }) },
  })));
  const mail = createHttpMailService({ fetch });
  for (const expected of problems) {
    await assert.rejects(mail.listSends({}), (err) => {
      assert.ok(isMailApiError(err, expected.code));
      assert.equal(err.status, expected.status);
      assert.deepEqual(err.problem, expected);
      return true;
    });
  }
});

test('rejects invalid HTTP replies without exposing their body as an error message', async () => {
  const { fetch } = recording(
    () => new Response('<html>unexpected response body</html>', { status: 502, headers: { 'X-Request-Id': 'edge-1' } }),
    () => json(page, 202),
    () => new Response('invalid JSON', { status: 200 }),
  );
  const mail = createHttpMailService({ fetch });
  for (const [status, requestId] of [[502, 'edge-1'], [202, undefined], [200, undefined]] as const) {
    await assert.rejects(mail.listSends({}), (err) => {
      assert.ok(isMailApiError(err, 'internal'));
      assert.equal(err.status, status);
      assert.equal(err.problem.requestId, requestId);
      assert.ok(!err.message.includes('response body') && !err.message.includes('invalid JSON'));
      return true;
    });
  }
});

test('refuses dot segments rather than allowing URL normalization to route the request elsewhere', async () => {
  const { fetch, requests } = recording();
  const mail = createHttpMailService({ fetch });
  await assert.rejects(mail.getThread('..'), (err) => isMailApiError(err, 'invalid_request'));
  assert.equal(requests.length, 0);
});
