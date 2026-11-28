import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures/mail';

// A recipient's view of a revocable file link (M3-13): the page served by the
// real content Worker on the link host, with the file in a local fake S3 bucket.
test.use({ realContent: true, fileLinks: true });

const BIDI = /[\p{Bidi_Control}]/u;

test('a recipient downloads a linked file from its page, and hostile names render as text', async ({ page, origins }) => {
  const link = origins.fileLink!;
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  const response = await page.goto(`${origins.contentOrigin}${link.path}`);
  expect(response?.status()).toBe(200);
  const headers = response!.headers();
  expect(headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['cache-control']).toBe('private, no-store');
  await expect(page.getByRole('heading', { name: 'Shared file' })).toBeVisible();
  // The names are shown as the text they are, without their bidi controls.
  await expect(page.locator('.file')).toHaveText(link.name.replace(BIDI, ''));
  await expect(page.getByText(`${link.senderName.replace(BIDI, '')} <${link.senderEmail}>`)).toBeVisible();
  expect(await page.locator('main img, main script').count()).toBe(0);
  expect(await page.evaluate(() => (globalThis as { pwned?: unknown }).pwned)).toBeUndefined();
  expect(BIDI.test(await page.locator('main').innerText())).toBe(false);
  await expect(page.getByRole('button', { name: 'Report abuse' })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download' }).click()]);
  const bytes = await readFile((await download.path())!);
  expect(bytes.byteLength).toBe(link.size);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(link.sha256);
  expect(BIDI.test(download.suggestedFilename())).toBe(false);
  expect(dialogs).toEqual([]);
  expect(await page.evaluate(() => (globalThis as { pwned?: unknown }).pwned)).toBeUndefined();
});
