import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/mail';

test.use({ realContent: true });

async function openRealBody(page: Page) {
  const contentResponse = page.waitForResponse(response => new URL(response.url()).pathname.startsWith('/v1/body/'));
  const appResponse = await page.goto('/');
  await page.getByRole('button', { name: /Floor plan revisions/ }).filter({ hasText: 'Floor plan revisions' }).click();
  const frame = page.locator('iframe[title="Formatted message: Floor plan revisions"]');
  await expect(frame).toBeVisible();
  const response = await contentResponse;
  expect(response.status()).toBe(200);
  return { frame, response, appResponse };
}

test('renders a real signed body issued over RPC in the app sandboxed iframe', async ({ page, origins }) => {
  const { frame, response, appResponse } = await openRealBody(page);
  expect(appResponse?.headers()['referrer-policy']).toBe('no-referrer');
  expect(response.headers()['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  expect(response.headers()['content-security-policy']).toContain(`frame-ancestors ${origins.appOrigin}`);
  expect(new URL(response.url()).origin).toBe(origins.contentOrigin);
  await expect(frame).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(frame.contentFrame().getByText('Kitchen measurements revised.')).toBeVisible();
  expect(await frame.evaluate((node: HTMLIFrameElement) => node.contentDocument === null)).toBe(true);
});

test('direct-open of a signed body has an opaque origin and runs no message script', async ({ page, context }) => {
  const { response } = await openRealBody(page);
  const direct = await context.newPage();
  try {
    const result = await direct.goto(response.url());
    expect(result?.status()).toBe(200);
    expect(result?.headers()['content-security-policy']).toContain('sandbox allow-popups allow-popups-to-escape-sandbox');
    expect(await direct.evaluate(() => globalThis.origin)).toBe('null');
    await expect(direct.getByText('Kitchen measurements revised.')).toBeVisible();
    await expect(direct.locator('script')).toHaveCount(0);
    expect(await direct.evaluate(() => Object.hasOwn(globalThis, 'messageScriptRan'))).toBe(false);
  } finally { await direct.close(); }
});
