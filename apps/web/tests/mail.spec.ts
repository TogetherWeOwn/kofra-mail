import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function mailbox(page: Page, name: string) {
  if (!(await page.getByRole('button', { name, exact: true }).isVisible())) await page.getByRole('button', { name: 'Toggle mail navigation' }).click();
  await page.getByRole('button', { name, exact: true }).click();
}

async function accessible(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test('reads a conversation, archives it and restores it from trash', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await accessible(page);
  await page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).click();
  await expect(page.getByRole('heading', { name: 'Floor plan revisions' })).toBeVisible();
  await expect(page.getByText('Remote images blocked')).toBeVisible();
  await accessible(page);
  await page.getByRole('button', { name: 'Archive', exact: true }).last().click();
  await expect(page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ })).toHaveCount(0);
  await mailbox(page, 'All mail');
  await page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).click();
  await page.getByRole('button', { name: 'Move to Inbox' }).click();
  await mailbox(page, 'Inbox');
  await page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await mailbox(page, 'Trash');
  await page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).click();
  await page.getByRole('button', { name: 'Move to Inbox' }).click();
  await mailbox(page, 'Inbox');
  await expect(page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ })).toBeVisible();
});

test('a long unbroken label fits the actual viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('searchbox')).toBeEnabled();
  const create = page.getByRole('button', { name: 'Create label' });
  if (!(await create.isVisible())) await page.getByRole('button', { name: 'Toggle mail navigation' }).click();
  await create.click();
  const longName = 'W'.repeat(72);
  await page.getByLabel('Label name').fill(longName);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: longName })).toBeVisible();
  await accessible(page);
});

test('searches and can star the result', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('searchbox', { name: 'Search mail' }).fill('from:mira@example.com has:attachment');
  await page.getByRole('searchbox', { name: 'Search mail' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /November receipt/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Star Floor plan revisions' }).click();
  await mailbox(page, 'Starred');
  await expect(page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).first()).toBeVisible();
  await accessible(page);
});
