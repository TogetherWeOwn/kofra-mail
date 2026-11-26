import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMailApi, type MailApiEnvironment } from './server/mail-api.ts';

const app = 'http://127.0.0.1:4178';
const content = 'http://localhost:4179';
const principal = { userId: 'session-user', name: 'Member', workspaceId: 'session-ws', role: 'member' as const,
  authTime: Date.now(), credentialEpoch: 7, csrfToken: 'fixture-csrf' };
function setup(returnedUrl?: string) {
  const calls: unknown[][] = [];
  const env: MailApiEnvironment = {
    MAIL_LOCAL_API: 'on', MAIL_CONTENT_ENABLED: 'on', MAIL_CONTENT_ORIGIN: content,
    MAIL_DEV_SESSION: { resolve: async () => principal },
    DIRECTORY: { prepare: () => ({ bind() { return this; }, async first<T>() { return { id: 'session-mailbox', primary_address: 'member@mail.example' } as T; }, async all<T>() { return { results: [] as T[] }; } }), async batch() { return []; } },
    MAILBOX: { getByName: () => ({ mailApi: async () => ({ body: { state: 's1' } }) }) },
    MAIL_CONTENT: { async mintForWeb(purpose: 'body' | 'att', claims: unknown) {
      calls.push([purpose, claims]);
      return { url: returnedUrl ?? `${content}/v1/${purpose}/fake.payload.mac`, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    } },
  };
  return { env, calls };
}
function post(suffix: string, data?: object) {
  return new Request(`${app}/api/v1/messages/m/${suffix}`, {
    method: 'POST', headers: { origin: app, 'x-csrf-token': principal.csrfToken, 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

test('body and attachment call only mintForWeb with the session and resolved mailbox', async () => {
  const { env, calls } = setup();
  for (const req of [post('body-url', { remoteImages: true }), post('attachments/2/url')]) {
    const res = await handleMailApi(req, env);
    assert.equal(res.status, 200);
    assert.equal(new URL((await res.json()).url).origin, content);
  }
  const scope = { ws: 'session-ws', mb: 'session-mailbox', sub: 'session-user', ep: 7, msg: 'm' };
  assert.deepEqual(calls, [['body', { ...scope, ri: true }], ['att', { ...scope, part: 2 }]]);
});

test('the mail-content switch is off by default even if a binding and configured origin exist', async () => {
  const { env, calls } = setup();
  const disabled = { ...env, MAIL_CONTENT_ENABLED: undefined };
  const session = await handleMailApi(new Request(`${app}/api/v1/session`), disabled);
  assert.equal(session.status, 200);
  assert.equal((await session.json()).features.htmlContent, false);
  const res = await handleMailApi(post('body-url', { remoteImages: false }), disabled);
  assert.equal((await res.json()).code, 'feature_unavailable');
  assert.deepEqual(calls, []);
});

test('scope from the request cannot reach the mint port', async () => {
  const { env, calls } = setup();
  const res = await handleMailApi(post('body-url', { remoteImages: true, ws: 'request-ws', mb: 'request-mb', sub: 'request-sub' }), env);
  assert.equal((await res.json()).code, 'unknown_field');
  assert.deepEqual(calls, []);
  const clean = await handleMailApi(post('body-url', { remoteImages: true }), env);
  assert.equal(clean.status, 200);
  assert.deepEqual(calls, [['body', { ws: 'session-ws', mb: 'session-mailbox', sub: 'session-user', ep: 7, msg: 'm', ri: true }]]);
});

test('mint result must be an absolute credential-free URL on the configured separate content origin', async () => {
  for (const url of [`${app}/v1/body/a`, 'https://outside.example/v1/body/a', 'http://user@localhost:4179/v1/body/a', '/v1/body/a']) {
    const { env, calls } = setup(url);
    const res = await handleMailApi(post('body-url', { remoteImages: false }), env);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'unavailable');
    assert.equal(calls.length, 1);
  }
});
