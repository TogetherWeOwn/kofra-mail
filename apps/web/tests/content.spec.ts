import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/mail';

async function openPlan(page: Page) {
  const response = await page.goto('/');
  await page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).click();
  return response;
}

test.describe('without a configured content origin', () => {
  test.use({ contentOriginEnabled: false });
  test('keeps plain text and never mints or mounts a message iframe', async ({ page }) => {
    const minted: string[] = [];
    page.on('request', (request) => { if (/\/api\/v1\/messages\/[^/]+\/body-url$/.test(new URL(request.url()).pathname)) minted.push(request.url()); });
    const response = await openPlan(page);
    expect(response?.headers()['content-security-policy']).toBe("frame-src 'none'; object-src 'none'");
    await expect(page.getByText(/I’ve attached the latest floor plan/)).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(minted).toEqual([]);
  });
});

test('opens a truncated plain message in the isolated reader on request', async ({ page, origins }) => {
  await page.goto('/');
  const all = page.getByRole('button', { name: 'All mail', exact: true });
  if (!(await all.isVisible())) await page.getByRole('button', { name: 'Navigation menu' }).click();
  await all.click();
  await page.getByRole('button', { name: /^Mira Chen.*Long plain message/ }).click();
  await expect(page.getByText('This message preview is truncated.')).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByText(/Unique tail after the preview/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Show full message' }).click();
  const frame = page.locator('iframe[title="Full message: Long plain message"]');
  await expect(frame).toBeVisible();
  expect(new URL((await frame.getAttribute('src'))!).origin).toBe(origins.contentOrigin);
  await expect(frame).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  await expect(frame.contentFrame().getByText(/Unique tail after the preview/)).toBeVisible();
});

test('Spam keeps formatted bodies and remote images blocked', async ({ page }) => {
  await openPlan(page);
  await expect(page.locator('iframe')).toHaveCount(1);
  await page.getByRole('button', { name: 'Report spam' }).click();
  const spam = page.getByRole('button', { name: 'Spam', exact: true });
  if (!(await spam.isVisible())) await page.getByRole('button', { name: 'Navigation menu' }).click();
  await spam.click();
  await page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).click();
  await expect(page.getByText('Why is this message in Spam?')).toBeVisible();
  await expect(page.getByText('Remote images blocked')).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show images' })).toHaveCount(0);
  await expect(page.getByText('Formatted message unavailable. Showing plain text.')).toHaveCount(0);
});

test('only loads formatted content and then opted-in images from a separate sandbox', async ({ page, origins }) => {
  const imageRequests: string[] = [];
  page.on('request', (request) => { if (request.resourceType() === 'image') imageRequests.push(request.url()); });
  const response = await openPlan(page);
  expect(response?.headers()['content-security-policy']).toBe(`frame-src ${origins.contentOrigin}; object-src 'none'`);
  const element = page.locator('iframe[title="Formatted message: Floor plan revisions"]');
  await expect(element).toBeVisible();
  const withoutImages = (await element.getAttribute('src'))!;
  expect(new URL(withoutImages).origin).toBe(origins.contentOrigin);
  expect(new URL(withoutImages).pathname).toMatch(/^\/v1\/body\//);
  await expect(element).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  await expect(element).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(await element.getAttribute('srcdoc')).toBeNull();
  const frame = element.contentFrame();
  await expect(frame.getByText('Kitchen measurements revised.')).toBeVisible();
  await expect(frame.getByText('before Tuesday?', { exact: false })).toBeVisible();
  await expect(page.getByText('Kitchen measurements revised.')).toHaveCount(0);
  expect(await element.evaluate((node: HTMLIFrameElement) => node.contentDocument === null)).toBe(true);
  expect(imageRequests).toEqual([]);
  await page.getByRole('button', { name: 'Show images' }).click();
  await expect(page.getByText('Remote images shown for this message')).toBeVisible();
  const withImages = (await element.getAttribute('src'))!;
  expect(withImages).not.toBe(withoutImages);
  await expect(frame.getByRole('img')).toBeVisible();
  await expect.poll(() => imageRequests).toEqual([`${origins.contentOrigin}/fixture-image.svg`]);
  await page.getByRole('button', { name: 'Manage labels' }).click();
  await page.getByRole('checkbox', { name: 'Finance', exact: true }).check();
  await expect(page.locator('.thread-title').getByText('Finance', { exact: true })).toBeVisible();
  await expect(element).toHaveAttribute('src', withImages);
  await expect.poll(() => imageRequests).toEqual([`${origins.contentOrigin}/fixture-image.svg`]);
  await page.getByRole('button', { name: 'Hide images' }).click();
  await expect(frame.getByText('Kitchen measurements revised.')).toBeVisible();
  await expect(frame.getByRole('img')).toHaveCount(0);
  await page.getByText('View plain text', { exact: true }).click();
  await expect(page.getByText(/I’ve attached the latest floor plan/)).toBeVisible();
  // Axe cannot inject into a scriptless frame; inspect the same document separately.
  const result = await new AxeBuilder({ page }).exclude('iframe').analyze();
  expect(result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  const fixture = await page.context().newPage();
  try {
    await fixture.route(withImages, async (route) => {
      const response = await route.fetch();
      const headers = response.headers();
      const directives = headers['content-security-policy'].split(';').map((item) => item.trim());
      expect(directives).toContain('sandbox');
      // Axe must execute in this separate test page; keep the real document and all other CSP directives.
      headers['content-security-policy'] = directives.filter((item) => item !== 'sandbox').join('; ');
      await route.fulfill({ response, headers });
    });
    await fixture.goto(withImages);
    const inside = await new AxeBuilder({ page: fixture }).analyze();
    expect(inside.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  } finally { await fixture.close(); }
});
