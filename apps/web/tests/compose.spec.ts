import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function noSeriousIssues(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test('composes from an alias with a Drive copy, uploads a file and undoes send', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  const compose = page.getByRole('dialog', { name: 'New message' });
  await compose.getByRole('combobox', { name: 'From', exact: true }).selectOption('hello@example.com');
  await compose.getByLabel('To', { exact: true }).fill('recipient@example.com');
  await compose.getByLabel('Subject').fill('Demo message');
  await compose.getByLabel('Subject').press('Enter');
  await expect(compose).toBeVisible();
  await expect(page.getByText('Message queued')).toHaveCount(0);
  await compose.getByLabel('Message body').fill('Hello from the alias.');
  await noSeriousIssues(page);
  await compose.getByRole('button', { name: 'Attach from Drive' }).click();
  const drive = page.getByRole('dialog', { name: 'Attach from Drive' });
  await noSeriousIssues(page);
  await drive.getByRole('radio', { name: /floor-plan-v3/ }).check();
  await drive.getByRole('button', { name: 'Attach copy' }).click();
  await compose.getByLabel('Upload attachments').setInputFiles({ name: 'local.txt', mimeType: 'text/plain', buffer: Buffer.from('demo') });
  await expect(compose.getByText('local.txt')).toBeVisible();
  await compose.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Message queued')).toBeVisible();
  await page.getByRole('button', { name: 'Undo send' }).click();
  await expect(compose.getByLabel('To', { exact: true })).toHaveValue('recipient@example.com');
  await expect(compose.getByRole('combobox', { name: 'From', exact: true })).toHaveValue('hello@example.com');
  await expect(compose.getByText('floor-plan-v3.txt')).toBeVisible();
  await compose.getByRole('button', { name: 'Save draft', exact: true }).click();
  const drafts = page.getByRole('button', { name: 'Drafts', exact: true });
  if (!(await drafts.isVisible())) await page.getByRole('button', { name: 'Navigation menu' }).click();
  await drafts.click();
  await page.getByRole('button', { name: 'Open draft Demo message' }).click();
  await expect(compose.getByLabel('Message body')).toHaveValue('Hello from the alias.');
});

test('undo stays available inside the next composer and does not overwrite it', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Compose', exact: true });
  const editor = page.getByRole('dialog', { name: 'New message' });
  await trigger.click();
  await editor.getByLabel('To', { exact: true }).fill('recipient@example.com');
  await editor.getByLabel('Subject').fill('First draft');
  await editor.getByRole('button', { name: 'Send', exact: true }).click();
  await trigger.click();
  await editor.getByLabel('Subject').fill('Second draft');
  await editor.getByRole('button', { name: 'Undo send' }).click();
  await expect(editor.getByText('Send undone; saved to Drafts.')).toBeVisible();
  await expect(editor.getByLabel('Subject')).toHaveValue('Second draft');
  await editor.getByRole('button', { name: 'Discard draft' }).click();
  const drafts = page.getByRole('button', { name: 'Drafts', exact: true });
  if (!(await drafts.isVisible())) await page.getByRole('button', { name: 'Navigation menu' }).click();
  await drafts.click();
  await expect(page.getByRole('button', { name: 'Open draft First draft' })).toBeVisible();
});

test('settings signature applies to reply and forwarding includes the original attachment', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('searchbox')).toBeEnabled();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('link', { name: 'Mail settings' }).click();
  await page.getByLabel('Signature').fill('Regards, Alex');
  const skip = page.getByRole('link', { name: 'Skip to mail' });
  await skip.focus();
  await skip.press('Enter');
  await expect(page.getByLabel('Signature')).toHaveValue('Regards, Alex');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await noSeriousIssues(page);
  await page.getByRole('button', { name: 'Back to mail' }).click();
  await page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download floor-plan-notes.txt' }).click();
  expect((await download).suggestedFilename()).toBe('floor-plan-notes.txt');
  await page.getByRole('button', { name: 'Save floor-plan-notes.txt to Drive' }).click();
  await expect(page.getByText('Saved floor-plan-notes.txt to demo Drive.')).toBeVisible();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('mira@example.com');
  await expect(page.getByRole('combobox', { name: 'From', exact: true })).toHaveValue('hello@example.com');
  await expect(page.getByLabel('Message body')).toHaveValue(/Regards, Alex/);
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(page.getByLabel('Subject')).toHaveValue('Fwd: Floor plan revisions');
  await expect(page.getByRole('dialog').getByText('floor-plan-notes.txt')).toBeVisible();
});
