import { expect, test } from './fixtures/mail';

test('a selected thread that leaves the view cannot be moved by bulk controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('searchbox')).toBeEnabled();
  const starred = page.getByRole('button', { name: 'Starred', exact: true });
  await page.getByRole('button', { name: 'Star Floor plan revisions' }).click();
  await expect(page.getByRole('button', { name: 'Unstar Floor plan revisions' })).toBeEnabled();
  if (!(await starred.isVisible())) await page.getByRole('button', { name: 'Navigation menu' }).click();
  await starred.click();
  await page.getByRole('checkbox', { name: 'Select Floor plan revisions' }).check();
  await page.getByRole('button', { name: 'Unstar Floor plan revisions' }).click();
  await expect(page.getByText('No conversations here.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete selected' })).toHaveCount(0);
});

test('bulk archive updates both selected conversations in one HTTP request', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('checkbox', { name: 'Select Floor plan revisions' }).check();
  await page.getByRole('checkbox', { name: 'Select Project schedule' }).check();
  const updates: { ids: string[]; set: { folder?: string } }[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/threads/update') && request.method() === 'POST') updates.push(request.postDataJSON());
  });
  await page.getByRole('button', { name: 'Archive selected' }).click();
  await expect(page.getByText('No conversations here.')).toBeVisible();
  expect(updates).toHaveLength(1);
  expect(new Set(updates[0].ids).size).toBe(2);
  expect(updates[0].set).toEqual({ folder: 'archive' });
});

test('focus returns to the list heading after moving an open conversation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeFocused();
});
