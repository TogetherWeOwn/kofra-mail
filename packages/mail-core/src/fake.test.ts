import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeMailApi } from './fake.ts';
import { secureHttpsLink } from './index.ts';

test('Drive attachment links must be absolute, HTTPS, and credential-free', async () => {
  for (const link of ['javascript:alert(1)', 'data:text/plain,demo', '//example.com/drive', 'https://user@example.com/drive', 'http://example.com/drive']) {
    assert.equal(secureHttpsLink(link), undefined, link);
  }
  assert.equal(secureHttpsLink('https://example.com/drive'), 'https://example.com/drive');
  const api = createFakeMailApi();
  const [from] = await api.listIdentities();
  const draft = { from: from.email, to: ['recipient@example.com'], cc: [], bcc: [], subject: '', body: '', attachments: [{ id: 'unsafe', name: 'unsafe', size: 0, type: '', link: 'javascript:alert(1)' }] };
  await assert.rejects(() => api.send(draft), /Invalid Drive attachment link/);
});

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

test('restoring clears expiry, while newly reported Spam expires at 30 days', async () => {
  let now = Date.UTC(2026, 10, 22);
  const api = createFakeMailApi(() => now);
  const [restored, spam] = await api.listThreads(inbox);
  await api.updateThread(restored.id, { mailboxId: 'trash' });
  await api.updateThread(spam.id, { mailboxId: 'spam' });
  now += 29 * 86400_000;
  assert.ok((await api.listThreads({ mailboxId: 'spam' })).some((thread) => thread.id === spam.id));
  await api.updateThread(restored.id, { mailboxId: 'inbox' });
  assert.equal((await api.getThread(restored.id))?.expiresAt, undefined);
  now += 86400_000;
  assert.equal(await api.getThread(spam.id), undefined);
  now += 86400_000;
  assert.equal((await api.getThread(restored.id))?.mailboxId, 'inbox');
});

test('search applies operators to the same message and excludes spam by default', async () => {
  const api = createFakeMailApi();
  assert.equal((await api.listThreads({ query: 'from:mira@example.com subject:"floor plan" has:attachment' })).length, 1);
  assert.equal((await api.listThreads({ query: 'from:mira@example.com subject:"floor plan" before:2026-11-01' })).length, 0);
  assert.equal((await api.listThreads({ query: 'prize' })).length, 0);
  assert.equal((await api.listThreads({ query: 'prize', mailboxId: 'spam' })).length, 1);
  assert.equal((await api.listThreads({ query: 'from:mira "revised drawings" has:attachment' })).length, 0);
});

test('individual operators constrain the result and starred only returns starred threads', async () => {
  const api = createFakeMailApi();
  const cases = [
    ['to:hello@example.com', 'to:nobody@example.com'], ['label:projects', 'label:finance'],
    ['after:2026-11-21', 'after:2026-11-24'], ['larger:200', 'larger:1m'],
    ['subject:"floor plan"', 'subject:"winter schedule"']
  ];
  for (const [matches, misses] of cases) {
    assert.ok((await api.listThreads({ query: `from:mira ${matches}` })).some((thread) => thread.id === 'plan'), matches);
    assert.equal((await api.listThreads({ query: `from:mira ${misses}` })).length, 0, misses);
  }
  assert.deepEqual((await api.listThreads({ starred: true })).map((thread) => thread.id), ['visit']);
});

test('date filters use the same local calendar day as the displayed date', async () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Auckland';
    const api = createFakeMailApi();
    assert.deepEqual((await api.listThreads({ query: 'from:mira has:attachment after:2026-11-23' })).map((thread) => thread.id), ['plan']);
    assert.equal((await api.listThreads({ query: 'from:mira has:attachment before:2026-11-23' })).length, 0);
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('undo restores the exact draft before the deadline, but not at the deadline', async () => {
  let now = 100_000;
  const api = createFakeMailApi(() => now);
  const [from] = await api.listIdentities();
  const file = await api.uploadAttachment(new Blob(['restored attachment bytes']), 'demo.txt');
  const draft = { from: from.email, to: ['recipient@example.com'], cc: [], bcc: [], subject: 'Demo', body: 'Hello', attachments: [file] };
  const first = await api.send(draft);
  const restored = (await api.undoSend(first.id))!;
  assert.ok(restored.id);
  assert.deepEqual(restored, { ...draft, id: restored.id });
  assert.deepEqual(await api.listDrafts(), [restored]);
  assert.equal(await (await api.downloadAttachment(restored.attachments[0].id)).text(), 'restored attachment bytes');
  assert.equal(await api.undoSend(first.id), undefined);
  const next = await api.send(restored);
  assert.deepEqual(await api.listDrafts(), []);
  assert.equal(await (await api.downloadAttachment(file.id)).text(), 'restored attachment bytes');
  now = next.undoUntil;
  assert.equal(await api.undoSend(next.id), undefined);
  const [sent] = await api.listThreads({ mailboxId: 'sent' });
  assert.equal(sent?.id, next.id);
  const [sentFile] = (await api.getThread(sent.id))!.messages[0].attachments;
  assert.equal(await (await api.downloadAttachment(sentFile.id)).text(), 'restored attachment bytes');
});

test('uses the normalized subject to thread replies and retains Cc and Bcc on the sent copy', async () => {
  let now = Date.UTC(2026, 10, 22);
  const api = createFakeMailApi(() => now);
  const [from] = await api.listIdentities();
  const original = (await api.getThread('plan'))!;
  const draft = { from: from.email, to: [], cc: ['copy@example.com'], bcc: ['blind@example.com'], subject: `Re: ${original.subject}`, body: 'Hello', attachments: [], replyToThreadId: 'plan' };
  now = (await api.send(draft)).undoUntil;
  const reply = (await api.getThread('plan'))!.messages.at(-1) as { cc?: { email: string }[]; bcc?: { email: string }[] };
  assert.equal(reply.cc?.[0]?.email, 'copy@example.com');
  assert.equal(reply.bcc?.[0]?.email, 'blind@example.com');
  const changed = await api.send({ ...draft, subject: 'Different subject' });
  now = changed.undoUntil;
  assert.equal((await api.getThread(changed.id))?.subject, 'Different subject');
  assert.equal((await api.getThread('plan'))?.count, original.count + 1);
});

test('rejects domain inputs that contain paths, ports or malformed DNS labels', async () => {
  const api = createFakeMailApi();
  for (const domain of ['example.com/support', 'example.com:443', 'bad-.example.com', 'one..example.com']) {
    await assert.rejects(() => api.addDomain(domain, 'Primary'), /Enter a valid domain/);
  }
  await api.addDomain('sales.example.com', 'Alias');
  assert.ok((await api.listDomains()).some((domain) => domain.name === 'sales.example.com'));
});

test('discard releases uploaded bytes unless a stored message or another draft refers to them', async () => {
  const api = createFakeMailApi();
  const file = await api.uploadAttachment(new Blob(['notes']), 'notes.txt');
  const draft = { from: 'alex@example.com', to: [], cc: [], bcc: [], subject: '', body: '', attachments: [file] };
  const saved = await api.saveDraft(draft);
  await api.releaseAttachment(file.id);
  assert.equal(await (await api.downloadAttachment(file.id)).text(), 'notes');
  await api.discardDraft(saved.id!);
  await assert.rejects(() => api.downloadAttachment(file.id), /Attachment not found/);
  await api.releaseAttachment('plan');
  assert.ok((await api.downloadAttachment('plan')).size > 0);
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
