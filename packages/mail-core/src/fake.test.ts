import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeMailApi } from './fake.ts';

const inbox = { mailboxId: 'inbox' } as const;

test('archive preserves labels and trash is restorable until expiry', async () => {
  let now = Date.UTC(2026, 10, 22);
  const api = createFakeMailApi(() => now);
  const [thread] = await api.listThreads(inbox);
  const label = await api.createLabel('Invoices');
  await api.updateThread(thread.id, { labelId: label.id, labelled: true, mailboxId: 'archive' });
  assert.ok(!(await api.listThreads(inbox)).some((t) => t.id === thread.id));
  assert.deepEqual((await api.listThreads({ labelId: label.id })).map((t) => t.id), [thread.id]);
  await api.updateThread(thread.id, { mailboxId: 'trash' });
  assert.equal((await api.listThreads({ labelId: label.id })).length, 0);
  now += 29 * 86400_000;
  assert.ok((await api.listThreads({ mailboxId: 'trash' })).some((item) => item.id === thread.id));
  now += 86400_000;
  assert.equal((await api.listThreads({ mailboxId: 'trash' })).length, 0);
  assert.equal(await api.getThread(thread.id), undefined);
});

test('search applies operators to the same message and excludes spam by default', async () => {
  const api = createFakeMailApi();
  assert.equal((await api.listThreads({ query: 'from:mira@example.com subject:"floor plan" has:attachment' })).length, 1);
  assert.equal((await api.listThreads({ query: 'from:mira@example.com subject:"floor plan" before:2026-11-01' })).length, 0);
  assert.equal((await api.listThreads({ query: 'prize' })).length, 0);
  assert.equal((await api.listThreads({ query: 'prize', mailboxId: 'spam' })).length, 1);
});

test('undo restores the exact draft before the deadline, but not at the deadline', async () => {
  let now = 100_000;
  const api = createFakeMailApi(() => now);
  const [from] = await api.listIdentities();
  const draft = { from: from.email, to: ['recipient@example.com'], cc: [], bcc: [], subject: 'Demo', body: 'Hello', attachments: [] };
  const first = await api.send(draft);
  assert.deepEqual(await api.undoSend(first.id), draft);
  assert.equal(await api.undoSend(first.id), undefined);
  const next = await api.send(draft);
  now = next.undoUntil;
  assert.equal(await api.undoSend(next.id), undefined);
  assert.equal((await api.listThreads({ mailboxId: 'sent' })).length, 1);
});

test('rejects unknown From addresses and supports Drive link and copy fixtures', async () => {
  const api = createFakeMailApi();
  await assert.rejects(() => api.send({ from: 'unknown@example.com', to: ['recipient@example.com'], cc: [], bcc: [], subject: '', body: '', attachments: [] }), /From address/);
  const [file] = await api.listDriveFiles();
  const copy = await api.attachFromDrive(file.id, 'copy');
  assert.equal(copy.name, file.name);
  const link = await api.attachFromDrive(file.id, 'link');
  assert.equal(new URL(link.link!).hostname, 'example.com');
});
