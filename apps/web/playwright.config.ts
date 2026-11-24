import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 2,
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-light', use: { ...devices['Desktop Chrome'], colorScheme: 'light' } },
    { name: 'desktop-dark', use: { ...devices['Desktop Chrome'], colorScheme: 'dark' } },
    { name: 'phone-light', use: { ...devices['Pixel 7'], colorScheme: 'light', defaultBrowserType: 'chromium' } },
    { name: 'phone-dark', use: { ...devices['Pixel 7'], colorScheme: 'dark', defaultBrowserType: 'chromium' } }
  ]
});
