import { createHttpMailService, type DraftInput } from '@kofra/mail-contract';
import { expect, test } from './fixtures/mail';

test('reads the HTTP session before listing threads', async ({ page, origins }) => {
  const service = createHttpMailService({ baseUrl: `${origins.appOrigin}/api/v1`, fetch: (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'GET') request.headers.set('Origin', origins.appOrigin);
    return fetch(request);
  } });
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
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByRole('list', { name: 'Inbox', exact: true }).getByRole('listitem')).toHaveCount(2);
  expect(requests[0].searchParams.get('cursor')).toBeNull();
  expect(requests[1].searchParams.get('cursor')).toBeTruthy();
  expect(requests[1].searchParams.get('view')).toBe('inbox');
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  const later = page.getByRole('list', { name: 'Inbox', exact: true }).getByRole('listitem').nth(1).locator('button.open-mail');
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

test('leaves sending, uploads and the disabled Drive picker unavailable', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New message' });
  await expect(editor.getByText('Sending not available yet')).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(editor.getByLabel('Upload attachments')).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Attach from Drive' })).toBeDisabled();
  await expect(page.getByRole('dialog', { name: 'Attach from Drive' })).toHaveCount(0);
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
