import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/mail';

async function noSeriousIssues(page: Page) {
  expect((await new AxeBuilder({ page }).exclude('iframe').analyze()).violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}
async function drafts(page: Page) {
  const button = page.getByRole('button', { name: 'Drafts', exact: true });
  if (!(await button.isVisible())) await page.getByRole('button', { name: 'Navigation menu' }).click();
  await button.click();
}

test('creates a draft with an idempotency key, replaces it with If-Match and discards it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New message' });
  await editor.getByLabel('To', { exact: true }).fill('recipient@example.com');
  await editor.getByLabel('Subject').fill('Demo message');
  await editor.getByLabel('Subject').press('Enter');
  await expect(editor).toBeVisible();
  await editor.getByLabel('Message body').fill('Hello from the composer.');
  await noSeriousIssues(page);
  const create = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith('/drafts') && res.request().method() === 'POST');
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
  const created = await create;
  expect(created.ok()).toBe(true);
  expect(created.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  const { id, revision } = await created.json();
  await expect(editor).toBeHidden();
  await drafts(page);
  await page.getByRole('button', { name: 'Open draft Demo message' }).click();
  await expect(editor.getByLabel('Message body')).toHaveValue('Hello from the composer.');
  await editor.getByLabel('Subject').fill('Edited message');
  const replace = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith(`/drafts/${id}`) && res.request().method() === 'PUT');
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
  const replaced = await replace;
  expect(replaced.ok()).toBe(true);
  expect(replaced.request().headers()['if-match']).toContain(revision);
  await page.getByRole('button', { name: 'Open draft Edited message' }).click();
  await editor.getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.getByText('No drafts.')).toBeVisible();
});

test('a stale draft cannot overwrite the newer saved draft', async ({ page, origins }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New message' });
  await editor.getByLabel('Subject').fill('Shared draft');
  const create = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith('/drafts') && res.request().method() === 'POST');
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
  const written = await create;
  const { id, revision } = await written.json();
  await drafts(page);
  await page.getByRole('button', { name: 'Open draft Shared draft' }).click();
  await editor.getByLabel('Subject').fill('Local edit');
  const { subject: _subject, ...inserted } = written.request().postDataJSON();
  const updated = await page.request.put(`/api/v1/drafts/${id}`, {
    data: { ...inserted, subject: 'Other editor' },
    headers: { Origin: origins.appOrigin, 'If-Match': revision, 'X-CSRF-Token': written.request().headers()['x-csrf-token'] },
  });
  expect(updated.ok()).toBe(true);
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(editor.getByRole('alert')).toHaveText(/This draft changed elsewhere/);
  await expect(editor.getByLabel('Subject')).toHaveValue('Local edit');
  await editor.getByRole('button', { name: 'Reload saved draft' }).click();
  await expect(editor.getByLabel('Subject')).toHaveValue('Other editor');
});

test('locks draft fields while a save is in flight', async ({ page }) => {
  let resume: () => void = () => {};
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  await page.route('**/api/v1/drafts', async (route) => {
    if (route.request().method() === 'POST') await paused;
    await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New message' });
  await editor.getByLabel('Subject').fill('Save in progress');
  await editor.getByLabel('Message body').fill('Safe draft text');
  const request = page.waitForRequest((req) => new URL(req.url()).pathname.endsWith('/drafts') && req.method() === 'POST');
  await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
  await request;
  try {
    await expect(editor.getByLabel('Subject')).toBeDisabled();
    await expect(editor.getByLabel('Message body')).toBeDisabled();
  } finally { resume(); }
  await expect(editor).toBeHidden();
});

test('browser Back from settings restores the open conversation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).click();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('link', { name: 'Mail settings' }).click();
  await expect(page.getByRole('heading', { name: 'Mail settings' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Floor plan revisions' })).toBeVisible();
});

test('patches only the changed setting and preserves reply and forwarded attachment refs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('searchbox')).toBeEnabled();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('link', { name: 'Mail settings' }).click();
  await page.getByLabel('Signature').fill('Regards, Alex');
  const skip = page.getByRole('link', { name: 'Skip to mail' });
  await skip.focus();
  await skip.press('Enter');
  await expect(page.getByLabel('Signature')).toHaveValue('Regards, Alex');
  const patch = page.waitForRequest((req) => new URL(req.url()).pathname.endsWith('/settings') && req.method() === 'PATCH');
  await page.getByRole('button', { name: 'Save settings' }).click();
  expect((await patch).postDataJSON()).toEqual({ signature: 'Regards, Alex' });
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await noSeriousIssues(page);
  await page.getByRole('button', { name: 'Back to mail' }).click();
  await page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('mira@example.net');
  await expect(page.getByLabel('Message body')).toHaveValue(/Regards, Alex/);
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(page.getByLabel('Subject')).toHaveValue('Fwd: Floor plan revisions');
  await expect(page.getByRole('dialog').getByText('floor-plan-notes.txt')).toBeVisible();
  const created = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith('/drafts') && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(501);
  expect(await response.json()).toMatchObject({ code: 'not_implemented' });
  const body = response.request().postDataJSON();
  expect(body.attachments).toHaveLength(1);
  expect(body.attachments[0]).toEqual({ kind: 'message', messageId: body.forwardOf, part: expect.any(Number) });
  await expect(page.getByText('Draft attachments are not available yet. Remove the attachments to save this draft.')).toBeVisible();
  await page.getByRole('button', { name: 'Remove floor-plan-notes.txt' }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
});
