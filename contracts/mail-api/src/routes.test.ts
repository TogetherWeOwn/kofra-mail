import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ERROR_CODES, ERROR_STATUS, PROBLEM_TYPE_PREFIX, problem, ROUTES } from './index.ts';

const routes = Object.entries(ROUTES);

test('the method and path shape uniquely identify a route', () => {
  const keys = routes.map(([, { method, path }]) => `${method} ${path.replace(/\{[^}]+\}/g, '{}')}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('GET and DELETE routes have no request body', () => {
  for (const [name, route] of routes) {
    if (route.method === 'GET' || route.method === 'DELETE') assert.equal(route.body, 'none', name);
  }
});

test('only POST routes require an idempotency key', () => {
  for (const [name, route] of routes) {
    if (route.idempotency === 'required') assert.equal(route.method, 'POST', name);
  }
});

test('admin writes require re-authentication', () => {
  for (const [name, route] of routes) {
    if (route.access === 'admin' && route.method !== 'GET') assert.equal(route.reauth, true, name);
  }
});

test('only PUT and POST routes can require If-Match', () => {
  for (const [name, route] of routes) {
    if (route.ifMatch === 'required') assert.ok(route.method === 'PUT' || route.method === 'POST', name);
  }
});

test('route parameter names start with a lowercase letter and contain only letters', () => {
  for (const [name, { path }] of routes) {
    for (const segment of path.split('/')) {
      if (/[{}]/.test(segment)) assert.match(segment, /^\{[a-z][A-Za-z]*\}$/, name);
    }
  }
});

test('all catalogue statuses are HTTP errors', () => {
  for (const code of ERROR_CODES) {
    const status = ERROR_STATUS[code];
    assert.ok(Number.isInteger(status) && status >= 400 && status < 600, code);
  }
});

test('problem types are a stable URN by default, or a configured documentation base', () => {
  assert.equal(problem('not_found').type, `${PROBLEM_TYPE_PREFIX}not_found`);
  assert.match(PROBLEM_TYPE_PREFIX, /^urn:/);
  assert.equal(problem('not_found', {}, 'https://docs.example.com/mail/errors/').type, 'https://docs.example.com/mail/errors/not_found');
});

test('only mailbox reads and the thread update carry the mailbox state', () => {
  const stateful = routes.filter(([, route]) => route.state).map(([name]) => name).sort();
  assert.deepEqual(stateful, ['getSession', 'getThread', 'listDrafts', 'listLabels', 'listSends', 'listThreads', 'listViews', 'updateThreads']);
});
