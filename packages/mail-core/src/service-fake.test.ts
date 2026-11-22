import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineConformance } from '@kofra/mail-contract/conformance';
import { createFakeMailHarness } from './service-fake.ts';

defineConformance('in-memory fake', async () => createFakeMailHarness({ contentOrigin: 'https://content.usercontent.example' }));

test('a workspace cannot register a domain already used by another workspace', async () => {
  const harness = createFakeMailHarness();
  const foreignAdmin = harness.as('foreignAdmin');
  await assert.rejects(foreignAdmin.addDomain({ name: 'example.com', kind: 'secondary' }, { idempotencyKey: 'duplicate-domain' }), {
    code: 'domain_exists', status: 409,
  });
  assert.ok(!(await foreignAdmin.listDomains()).items.some(({ name }) => name === 'example.com'));
});
