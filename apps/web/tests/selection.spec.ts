import { expect, test } from '@playwright/test';

test('a selected thread that leaves the view cannot be moved by bulk controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('searchbox')).toBeEnabled();
  const starred = page.getByRole('button', { name: 'Starred', exact: true });
  if (!(await starred.isVisible())) await page.getByRole('button', { name: 'Toggle mail navigation' }).click();
  await starred.click();
  await page.getByRole('checkbox', { name: 'Select Site visit next week' }).check();
  await page.getByRole('button', { name: 'Unstar Site visit next week' }).click();
  await expect(page.getByText('No conversations here.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete selected' })).toHaveCount(0);
});

test('focus returns to the list heading after moving an open conversation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeFocused();
});
