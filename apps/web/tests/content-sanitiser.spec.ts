import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { vectors } from '../../../workers/mail-content/test/corpus.ts';
import { createRuntime, render } from '../../../workers/mail-content/test/runtime.ts';

async function startHost(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const overlays = vectors.filter(vector => vector.overlay);
const batches = Array.from({ length: Math.ceil(vectors.length / 12) }, (_, i) => vectors.slice(i * 12, (i + 1) * 12));
const cases = new Map(vectors.map(vector => [vector.id, vector]));
let runtime: Awaited<ReturnType<typeof createRuntime>>;
let app: Awaited<ReturnType<typeof startHost>>;
let content: Awaited<ReturnType<typeof startHost>>;

test.beforeAll(async () => {
  runtime = await createRuntime();
  app = await startHost((request, response) => {
    const ids = new URL(request.url ?? '/', app.origin).searchParams.getAll('id').filter(id => cases.has(id));
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `frame-src ${content.origin}; object-src 'none'`,
    });
    response.end(`<!doctype html><html lang="en"><title>Mail fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"><main>
      <h1>Message</h1><button type="button" onclick="this.textContent='Warning acknowledged'">Suspicious sender warning</button>
      <div style="display:grid; height:180px; overflow:auto">${ids.map(id =>
        `<iframe src="${content.origin}/body/${encodeURIComponent(id)}" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>`).join('')}</div>
      </main></html>`);
  });
  content = await startHost(async (request, response) => {
    const path = new URL(request.url ?? '/', content.origin).pathname;
    const vector = cases.get(path.slice('/body/'.length));
    const headers = {
      'content-security-policy': `default-src 'none'; img-src ${content.origin} data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${app.origin}; sandbox allow-popups allow-popups-to-escape-sandbox`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
    };
    try {
      if (path.startsWith('/body/') && vector) {
        const { filled } = await render(runtime, vector, content.origin);
        response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
        response.end(filled);
      } else if (path.startsWith('/asset/')) {
        response.writeHead(200, { ...headers, 'content-type': 'image/gif' });
        response.end(pixel);
      } else {
        response.writeHead(404, headers).end();
      }
    } catch (error) {
      response.writeHead(500, headers).end(String(error));
    }
  });
});

test.afterAll(async () => {
  await Promise.all([app?.close(), content?.close(), runtime?.dispose()]);
});

async function visit(page: Page, ids: string[]) {
  const url = new URL(app.origin);
  for (const id of ids) url.searchParams.append('id', id);
  let appEntry = false;
  const outside: string[] = [];
  const executed: string[] = [];
  const topNavigations: string[] = [];
  const assetRequests = new Set<string>();
  page.on('console', message => { if (message.text().includes('mail-fixture-script')) executed.push(message.text()); });
  page.on('pageerror', error => executed.push(error.message));
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) topNavigations.push(frame.url());
  });
  const bodyResponses = new Map<string, number>();
  page.on('response', response => {
    const responseUrl = new URL(response.url());
    if (responseUrl.origin === content.origin && responseUrl.pathname.startsWith('/body/')) {
      bodyResponses.set(responseUrl.pathname.slice('/body/'.length), response.status());
    }
  });
  await page.context().route('**/*', async route => {
    const requestUrl = route.request().url();
    const parsed = new URL(requestUrl);
    if (!appEntry && requestUrl === url.href) {
      appEntry = true;
      await route.continue();
    } else if (parsed.origin === content.origin) {
      if (parsed.pathname.startsWith('/asset/')) assetRequests.add(`${parsed.searchParams.get('case')}:${parsed.pathname}`);
      await route.continue();
    } else {
      outside.push(requestUrl);
      await route.abort();
    }
  });
  await page.goto(url.href, { waitUntil: 'load' });
  expect(new URL(url).origin).not.toBe(content.origin);
  expect([...bodyResponses.keys()].sort()).toEqual([...ids].sort());
  for (const id of ids) {
    expect(bodyResponses.get(id), id).toBe(200);
    const frame = page.locator(`iframe[src="${content.origin}/body/${id}"]`);
    await expect(frame).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(frame.contentFrame().locator('meta[charset="utf-8"]')).toHaveCount(1);
    expect(await frame.evaluate((node: HTMLIFrameElement) => node.contentDocument)).toBeNull();
  }
  // Wait for the frames' load handlers, delayed image discovery and scheduled navigation to settle.
  await page.waitForLoadState('networkidle');
  if (ids.includes('img-cid')) expect(assetRequests.has('img-cid:/asset/cid/0')).toBe(true);
  if (ids.includes('css-sheet-remote-enabled')) expect(assetRequests.has('css-sheet-remote-enabled:/asset/img/0')).toBe(true);
  expect(executed).toEqual([]);
  expect(outside).toEqual([]);
  expect(topNavigations).toEqual([url.href]);
  await expect(page).toHaveURL(url.href);
}

for (const [i, batch] of batches.entries()) {
  test(`isolates corpus batch ${i + 1} of ${batches.length}`, async ({ page }) => {
    await visit(page, batch.map(vector => vector.id));
  });
}

for (const vector of overlays) test(`app warning stays visible and clickable: ${vector.id}`, async ({ page }) => {
  await visit(page, [vector.id]);
  const warning = page.getByRole('button', { name: 'Suspicious sender warning' });
  const frame = page.locator('iframe');
  await expect(warning).toBeVisible();
  await expect(frame.contentFrame().getByText('Overlay')).toHaveCount(1);
  expect(await warning.evaluate(button => {
    const { top, left, right, bottom } = button.getBoundingClientRect();
    return [[left + 1, top + 1], [right - 1, top + 1], [left + 1, bottom - 1], [right - 1, bottom - 1]]
      .every(([x, y]) => button.contains(document.elementFromPoint(x, y)));
  })).toBe(true);
  await warning.click();
  await expect(page.getByRole('button', { name: 'Warning acknowledged' })).toBeVisible();
  const result = await new AxeBuilder({ page }).exclude('iframe').analyze();
  expect(result.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical')).toEqual([]);
});
