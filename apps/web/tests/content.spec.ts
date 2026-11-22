import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const isolated = 'http://127.0.0.1:4179';
const content = 'http://localhost:4180';
async function openPlan(page: Page, url: string) {
  const response = await page.goto(url);
  await page.getByRole('button', { name: /^Mira Chen.*Floor plan revisions/ }).click();
  return response;
}

test('unconfigured reader keeps plain text and never mounts a message iframe', async ({ page }) => {
  const response = await openPlan(page, '/');
  expect(response?.headers()['content-security-policy']).toBe("frame-src 'none'; object-src 'none'");
  await expect(page.getByText(/I’ve attached the latest floor plan/)).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('Spam keeps formatted bodies and remote images blocked', async ({ page }) => {
  await openPlan(page, isolated);
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
});

test('only loads formatted content and then opted-in images from a separate sandbox', async ({ page }) => {
  const imageRequests: string[] = [];
  page.on('request', (request) => { if (request.resourceType() === 'image') imageRequests.push(request.url()); });
  const response = await openPlan(page, isolated);
  expect(response?.headers()['content-security-policy']).toBe(`frame-src ${content}; object-src 'none'`);
  const element = page.locator('iframe[title="Formatted message: Floor plan revisions"]');
  await expect(element).toHaveAttribute('src', `${content}/body/plan-latest`);
  await expect(element).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  await expect(element).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(await element.getAttribute('srcdoc')).toBeNull();
  const frame = element.contentFrame();
  await expect(frame.getByText('Kitchen measurements revised.')).toBeVisible();
  await expect(page.locator('[data-fixture-body]')).toHaveCount(0);
  expect(await element.evaluate((node: HTMLIFrameElement) => node.contentDocument === null)).toBe(true);
  expect(imageRequests).toEqual([]);
  await page.getByRole('button', { name: 'Show images' }).click();
  await expect(element).toHaveAttribute('src', `${content}/body/plan-latest?images=1`);
  await expect(frame.getByRole('img', { name: 'Demo floor plan' })).toBeVisible();
  await expect.poll(() => imageRequests).toEqual([`${content}/image/plan-latest.svg`]);
  await page.getByRole('button', { name: 'Hide images' }).click();
  await expect(frame.getByRole('img')).toHaveCount(0);
  // Axe's cross-frame injection cannot execute in a scriptless sandbox.
  // Check the frame title above, scan the app without injection into it, and
  // scan the authored document separately at its own origin.
  const result = await new AxeBuilder({ page }).exclude('iframe').analyze();
  expect(result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  const fixture = await page.context().newPage();
  try {
    await fixture.goto(`${content}/body/plan-latest?images=1`);
    const inside = await new AxeBuilder({ page: fixture }).analyze();
    expect(inside.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  } finally { await fixture.close(); }
});
