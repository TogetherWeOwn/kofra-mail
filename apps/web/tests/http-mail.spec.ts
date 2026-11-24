import { createHttpMailService, type DraftInput } from '@kofra/mail-contract';
import { expect, test } from './fixtures/mail';

function serviceAt(origin: string) {
  return createHttpMailService({ baseUrl: `${origin}/api/v1`, fetch: (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'GET') request.headers.set('Origin', origin);
    return fetch(request);
  } });
}

const planRow = /^Mira Chen.*Floor plan revisions/;

test('reads the HTTP session before listing threads', async ({ page, origins }) => {
  const service = serviceAt(origins.appOrigin);
  const plan = (await service.listThreads({ view: 'inbox' })).items.find(({ subject }) => subject === 'Floor plan revisions')!;
  await service.updateThreads({ ids: [plan.id], set: { unread: false } });
  const detailPath = `/api/v1/threads/${plan.id}`;
  const staleDetail = await service.getThread(plan.id);
  const actualViews = await service.listViews();
  const staleViews = { ...actualViews, state: 'stale-count-snapshot', items: actualViews.items.map((item) =>
    item.view === 'inbox' ? { ...item, unreadThreads: 99 } : item), };
  await page.route(`**${detailPath}`, (route) => route.fulfill({ json: { ...staleDetail, state: 'stale-thread-snapshot' } }), { times: 1 });
  await page.route('**/api/v1/views', (route) => route.fulfill({ json: staleViews }), { times: 1 });
  const operations: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/v1/')) operations.push(path);
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Compose', exact: true })).toBeEnabled();
  expect(operations[0]).toBe('/api/v1/session');
  expect(operations).toContain('/api/v1/threads');
  await expect(page.locator('#count-inbox')).toHaveText('99 unread');
  await page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).click();
  await expect(page.getByRole('heading', { name: 'Floor plan revisions' })).toBeVisible();
  const refresh = page.waitForResponse((response) => new URL(response.url()).pathname === detailPath);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await refresh).ok()).toBe(true);
  await expect(page.locator('#count-inbox')).toHaveText('1 unread');
  expect(operations.filter((path) => path === '/api/v1/threads')).toHaveLength(1);
  await page.getByRole('button', { name: 'Back to list' }).click();
  const query = 'after:2026-11-22';
  const request = page.waitForRequest((request) => new URL(request.url()).searchParams.get('q') === query);
  await page.getByRole('searchbox').fill(query);
  await page.getByRole('searchbox').press('Enter');
  expect(new URL((await request).url()).searchParams.get('tz'))
    .toBe(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone));

  await page.getByRole('button', { name: planRow }).click();
  await expect(page.getByRole('heading', { name: 'Floor plan revisions' })).toBeVisible();
  await page.route('**/api/v1/session', (route) => route.fulfill({ status: 401, json: {
    type: 'urn:kofra-mail:problem:unauthenticated', title: 'Mail session expired', status: 401, code: 'unauthenticated',
  } }), { times: 1 });
  const ended = page.waitForResponse((response) => response.url().endsWith('/api/v1/session') && response.status() === 401);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await ended).status()).toBe(401);
  await expect(page.getByRole('heading', { name: 'Floor plan revisions' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Mail unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compose', exact: true })).toBeDisabled();
  await expect(page.getByRole('searchbox')).toBeDisabled();
});

test('clears the reader and mailbox controls when a real transfer races a focus check', async ({ page, origins }) => {
  const service = serviceAt(origins.appOrigin);
  const session = await service.getSession();
  const nextOwner = (await service.listMembers({})).items.find((member) => !member.hasMailbox && member.id !== session.user.id);
  expect(nextOwner).toBeTruthy();
  const plan = (await service.listThreads({ view: 'inbox' })).items.find(({ subject }) => subject === 'Floor plan revisions')!;
  await service.updateThreads({ ids: [plan.id], set: { unread: false } });
  await page.goto('/');
  await page.getByRole('button', { name: planRow }).click();
  await expect(page.getByRole('heading', { name: 'Floor plan revisions' })).toBeVisible();
  const rechecked = page.waitForResponse((response) => response.url().endsWith('/api/v1/session'), { timeout: 5_000 }).catch(() => null);
  // Execute the directory write after focus starts, just before its real /views read.
  await page.route('**/api/v1/views', async (route) => {
    await service.updateMailbox(session.mailbox!.id, { ownerUserId: nextOwner!.id });
    await route.continue();
  }, { times: 1 });
  const denied = page.waitForResponse((response) => response.url().endsWith('/api/v1/views') && response.status() === 403);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await denied).status()).toBe(403);
  expect((await service.getSession()).mailbox).toBeUndefined();
  await expect(page.getByRole('heading', { name: 'Floor plan revisions' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No mailbox assigned' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compose', exact: true })).toBeDisabled();
  await expect(page.getByRole('searchbox')).toBeDisabled();
  await expect(page.locator('#mail-nav').getByRole('button', { name: 'Inbox', exact: true, includeHidden: true })).toBeDisabled();
  expect((await rechecked)?.ok()).toBe(true);
  // Reproduce the hash left behind when the old mailbox view was cleared.
  await page.evaluate(() => history.replaceState(history.state, '', '#mail-admin'));
  const admin = page.getByRole('button', { name: 'Mail admin', exact: true });
  if (!(await admin.isVisible())) await page.getByRole('button', { name: 'Navigation menu' }).click();
  await admin.click();
  await expect(page.getByRole('button', { name: 'Back to mail' })).toBeVisible();
});

test('failed detail reads leave unopened mail unread on the backend', async ({ page, origins }) => {
  const service = serviceAt(origins.appOrigin);
  const plan = (await service.listThreads({ view: 'inbox' })).items.find(({ subject }) => subject === 'Floor plan revisions')!;
  expect(plan.unread).toBe(true);
  await page.route(`**/api/v1/threads/${plan.id}`, (route) => route.fulfill({ status: 503,
    json: { type: 'urn:kofra-mail:problem:unavailable', title: 'Detail temporarily unavailable', code: 'unavailable', status: 503 }, }), { times: 1 });
  await page.goto('/');
  await page.getByRole('button', { name: planRow }).click();
  await expect(page.getByRole('alert')).toHaveText('Detail temporarily unavailable');
  expect((await service.getThread(plan.id)).thread.unread).toBe(true);
});

test('draft revalidation preserves all loaded pages after an external mailbox change', async ({ page, origins }) => {
  const service = serviceAt(origins.appOrigin);
  const session = await service.getSession();
  const input: DraftInput = { from: session.mailbox!.primaryAddress, to: [], cc: [], bcc: [], subject: '', body: '', attachments: [] };
  for (const subject of ['First saved draft', 'Second saved draft']) {
    await service.createDraft({ ...input, subject }, { idempotencyKey: crypto.randomUUID() });
  }
  await page.route(/\/api\/v1\/drafts(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('limit', '1');
    return route.continue({ url: url.href });
  });
  await page.goto('/');
  await expect(page.getByRole('searchbox')).toBeEnabled();
  const draftsNav = page.getByRole('button', { name: 'Drafts', exact: true });
  if (!(await draftsNav.isVisible())) await page.getByRole('button', { name: 'Navigation menu' }).click();
  await draftsNav.click();
  const list = page.getByRole('list', { name: 'Drafts', exact: true });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await service.createLabel({ name: 'External draft refresh' }, { idempotencyKey: crypto.randomUUID() });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#mail-nav').getByText('External draft refresh', { exact: true })).toHaveCount(1);
  await expect(list.getByRole('listitem')).toHaveCount(2);
});

test('loads the next page using the opaque cursor for the same inbox query', async ({ page }) => {
  const requests: URL[] = [];
  await page.route('**/api/v1/threads?*', async (route) => {
    const url = new URL(route.request().url());
    requests.push(new URL(url));
    url.searchParams.set('limit', '1');
    await route.continue({ url: url.href });
  });
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Inbox', exact: true }).getByRole('listitem')).toHaveCount(1);
  const more = page.getByRole('button', { name: 'Load more' });
  await more.focus();
  await more.press('Enter');
  await expect(page.getByRole('list', { name: 'Inbox', exact: true }).getByRole('listitem')).toHaveCount(2);
  expect(requests[0].searchParams.get('cursor')).toBeNull();
  expect(requests[1].searchParams.get('cursor')).toBeTruthy();
  expect(requests[1].searchParams.get('view')).toBe('inbox');
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  const later = page.getByRole('list', { name: 'Inbox', exact: true }).getByRole('listitem').nth(1).locator('button.open-mail');
  await expect(later).toBeFocused();
  const id = await later.getAttribute('id');
  expect(id).toBeTruthy();
  const counts = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/views');
  await later.click();
  await page.getByRole('button', { name: 'Back to list' }).click();
  await expect(page.locator(`#${id}`)).toBeFocused();
  await expect(page.getByRole('list', { name: 'Inbox', exact: true }).getByRole('listitem')).toHaveCount(2);
  expect(requests).toHaveLength(2); // Opening an unread row does not walk the loaded pages again.
  expect((await counts).ok()).toBe(true);
  const revalidation = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/threads');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await revalidation).ok()).toBe(true); // Updated counts do not stand in for a refreshed list.
  const laterRow = page.getByRole('list', { name: 'Inbox', exact: true }).getByRole('listitem').nth(1);
  await laterRow.getByRole('button', { name: /^Star / }).click();
  await expect(laterRow.getByRole('button', { name: /^Unstar / })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`#${id}`)).toBeVisible();
});

test('preserves unsaved draft during CSRF recovery, while outbound controls stay unavailable', async ({ page, origins }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New message' });
  await expect(editor.getByText('Sending not available yet')).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(editor.getByLabel('Upload attachments')).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Attach from Drive' })).toBeDisabled();
  await expect(page.getByRole('dialog', { name: 'Attach from Drive' })).toHaveCount(0);
  const service = serviceAt(origins.appOrigin);
  const before = await service.getSession();
  const subject = 'CSRF recovery draft';
  const text = 'This body has not been saved yet.';
  await editor.getByLabel('Subject').fill(subject);
  await editor.getByLabel('Message body').fill(text);
  // Corrupt only the browser request token; the real workerd handler must reject it.
  await page.route('**/api/v1/drafts', (route) => route.continue({
    headers: { ...route.request().headers(), 'x-csrf-token': 'invalid-fixture-token' },
  }), { times: 1 });
  const denied = page.waitForResponse((response) => response.url().endsWith('/api/v1/drafts') && response.status() === 403);
  const renewed = page.waitForResponse((response) => response.url().endsWith('/api/v1/session') && response.ok(), { timeout: 5_000 }).catch(() => null);
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
  expect(await (await denied).json()).toMatchObject({ code: 'csrf_failed' });
  expect((await service.getSession()).mailbox?.id).toBe(before.mailbox?.id);
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Message body')).toHaveValue(text);
  await expect(editor.getByRole('alert')).toContainText('Try again');
  expect(await renewed).not.toBeNull();
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(editor).toBeHidden();
  expect((await service.listDrafts({})).items.find((draft) => draft.subject === subject)?.body).toBe(text);

  const nextOwner = (await service.listMembers({})).items.find((member) => !member.hasMailbox && member.id !== before.user.id);
  expect(nextOwner).toBeTruthy();
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  await editor.getByLabel('Message body').fill('New edits before a real transfer.');
  await page.route('**/api/v1/drafts', async (route) => {
    await service.updateMailbox(before.mailbox!.id, { ownerUserId: nextOwner!.id });
    await route.continue({ headers: { ...route.request().headers(), 'x-csrf-token': 'invalid-fixture-token' } });
  }, { times: 1 });
  const transferred = page.waitForResponse((response) => response.url().endsWith('/api/v1/drafts') && response.status() === 403);
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
  expect(await (await transferred).json()).toMatchObject({ code: 'csrf_failed' });
  await expect(editor).toBeHidden();
  await expect(page.getByRole('heading', { name: 'No mailbox assigned' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compose', exact: true })).toBeDisabled();
});

test('restores expired draft edits only for the same verified mailbox binding', async ({ page, origins }) => {
  const service = serviceAt(origins.appOrigin);
  const before = await service.getSession();
  const mailbox = before.mailbox!;
  const plan = (await service.listThreads({ view: 'inbox' })).items.find(({ subject }) => subject === 'Floor plan revisions')!;
  const replied = (await service.getThread(plan.id)).messages[0];
  const editor = page.getByRole('dialog', { name: 'New message' });
  const compose = page.getByRole('button', { name: 'Compose', exact: true });
  async function expire() {
    await expect(page.locator('#mail-content')).toHaveAttribute('aria-busy', 'false');
    await page.route('**/api/v1/session', (route) => route.fulfill({ status: 401, json: {
      type: 'urn:kofra-mail:problem:unauthenticated', title: 'Mail session expired', status: 401, code: 'unauthenticated',
    } }), { times: 1 });
    const rejected = page.waitForResponse((response) => response.url().endsWith('/api/v1/session') && response.status() === 401);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await rejected;
    await expect(editor).toHaveCount(0);
    await expect(compose).toBeDisabled();
  }

  await page.goto('/');
  await page.getByRole('button', { name: planRow }).click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await editor.getByLabel('To', { exact: true }).fill('draft-recipient@example.com');
  await editor.getByLabel('Subject').fill('Unsaved reply');
  await editor.getByLabel('Message body').fill('Reply text before session expiry.');
  await expire();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('To', { exact: true })).toHaveValue('draft-recipient@example.com');
  await expect(editor.getByLabel('Subject')).toHaveValue('Unsaved reply');
  await expect(editor.getByLabel('Message body')).toHaveValue('Reply text before session expiry.');
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect((await service.listDrafts({})).items.find((item) => item.subject === 'Unsaved reply')?.inReplyTo).toBe(replied.id);

  await compose.click();
  await editor.getByLabel('Message body').fill('Do not carry this edit into a different mailbox.');
  await expire();
  const nextOwner = (await service.listMembers({})).items.find((member) => !member.hasMailbox && member.id !== before.user.id);
  expect(nextOwner).toBeTruthy();
  await service.updateMailbox(mailbox.id, { ownerUserId: nextOwner!.id });
  const replacement = await service.createMailbox({
    ownerUserId: before.user.id, displayName: before.user.name,
    primaryAddress: `replacement@${mailbox.primaryAddress.split('@').at(-1)}`,
  }, { idempotencyKey: crypto.randomUUID() });
  expect(replacement.id).not.toBe(mailbox.id);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(compose).toBeEnabled();
  await expect(editor).toHaveCount(0);
  await compose.click();
  await expect(editor.getByLabel('To', { exact: true })).toHaveValue('');
  await expect(editor.getByLabel('Subject')).toHaveValue('');
  await expect(editor.getByLabel('Message body')).toHaveValue('');
});

test('outbound, upload and undo routes return typed 501 without removing a draft', async ({ origins }) => {
  const api = createHttpMailService({
    baseUrl: `${origins.appOrigin}/api/v1`,
    fetch: (input, init) => {
      const request = new Request(input, init);
      if (request.method !== 'GET') request.headers.set('Origin', origins.appOrigin);
      return fetch(request);
    },
  });
  const session = await api.getSession();
  expect(session.features.m3 ?? false).toBe(false);
  const input: DraftInput = { from: session.mailbox!.primaryAddress, to: [{ email: 'recipient@example.com' }], cc: [], bcc: [], subject: 'Not sent', body: '', attachments: [] };
  const key = () => ({ idempotencyKey: crypto.randomUUID() });
  const draft = await api.createDraft(input, key());
  for (const run of [
    () => api.sendDraft(draft.id, { ...key(), ifMatch: draft.revision }),
    () => api.createUpload({ name: 'local.txt', type: 'text/plain', bytes: new Blob(['upload']) }, key()),
    () => api.undoSend('missing-send', key()),
  ]) {
    await expect(run()).rejects.toMatchObject({ code: 'not_implemented', status: 501 });
  }
  expect(await api.getDraft(draft.id)).toMatchObject({ id: draft.id, revision: draft.revision });
});
