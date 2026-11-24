import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMailApi, type MailApiEnvironment } from './server/mail-api.ts';

const app = 'http://127.0.0.1:4178';
const principal = { userId: 'member', name: 'Member', workspaceId: 'w1', role: 'member' as const, authTime: Date.now(), credentialEpoch: 1, csrfToken: 'local-session-csrf' };
const env: MailApiEnvironment = {
  MAIL_LOCAL_API: 'on',
  MAIL_DEV_SESSION: { resolve: async () => principal },
  DIRECTORY: { prepare: () => ({ bind() { return this; }, async first<T>() { return { id: 'mailbox', primary_address: 'member@example.com' } as T; }, async all<T>() { return { results: [] as T[] }; } }), async batch() { return []; } },
  MAILBOX: { getByName: () => ({ mailApi: async () => ({ body: { state: 's1' } }) }) },
};

function request(path: string, init?: RequestInit, origin = app) {
  return new Request(`${origin}/api/v1${path}`, init);
}

test('refuses to use the dev session on a non-loopback host or without the explicit switch', async () => {
  const never = { resolve: async () => { assert.fail('dev session resolved outside local mode'); } };
  for (const [req, cfg] of [
    [request('/session', undefined, 'https://mail.example.com'), { ...env, MAIL_DEV_SESSION: never }],
    [request('/session'), { ...env, MAIL_LOCAL_API: undefined, MAIL_DEV_SESSION: never }],
  ] as const) {
    const res = await handleMailApi(req, cfg);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(res.headers.get('x-request-id'));
  }
});

test('writes check Origin and CSRF before feature availability or body processing', async () => {
  const res = await handleMailApi(request('/uploads?name=file', {
    method: 'POST', headers: { origin: 'https://other.example.com', 'x-csrf-token': principal.csrfToken },
  }), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'csrf_failed');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('same-origin writes still require the correct session CSRF token', async () => {
  for (const token of [undefined, 'wrong-token']) {
    const headers = new Headers({ origin: app });
    if (token !== undefined) headers.set('x-csrf-token', token);
    const res = await handleMailApi(request('/uploads?name=file', { method: 'POST', headers }), env);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'csrf_failed');
  }
});

test('unavailable local outbound operations fail with a typed problem', async () => {
  const res = await handleMailApi(request('/sends'), env);
  assert.equal(res.status, 501);
  assert.equal(res.headers.get('content-type'), 'application/problem+json');
  assert.deepEqual((await res.json()).code, 'not_implemented');
});
