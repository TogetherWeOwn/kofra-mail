import { defineConfig, devices } from '@playwright/test';

const port = 4178;
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 2,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-light', use: { ...devices['Desktop Chrome'], colorScheme: 'light' } },
    { name: 'desktop-dark', use: { ...devices['Desktop Chrome'], colorScheme: 'dark' } },
    { name: 'phone-light', use: { ...devices['Pixel 7'], colorScheme: 'light', defaultBrowserType: 'chromium' } },
    { name: 'phone-dark', use: { ...devices['Pixel 7'], colorScheme: 'dark', defaultBrowserType: 'chromium' } }
  ],
  webServer: [
    { command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`, url: baseURL, env: { MAIL_DEMO_CONTENT_ORIGIN: '' }, reuseExistingServer: false },
    { command: 'node tests/fixtures/content-server.mjs', url: 'http://localhost:4180/healthz', reuseExistingServer: false },
    { command: 'npm run dev -- --host 127.0.0.1 --port 4179 --strictPort', url: 'http://127.0.0.1:4179', env: { MAIL_DEMO_CONTENT_ORIGIN: 'http://localhost:4180' }, reuseExistingServer: false }
  ]
});
