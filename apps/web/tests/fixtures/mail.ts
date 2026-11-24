import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test as playwright } from '@playwright/test';

interface Origins { appOrigin: string; contentOrigin: string }
function isOrigins(value: unknown): value is Origins {
  return !!value && typeof value === 'object' && 'appOrigin' in value && 'contentOrigin' in value
    && typeof value.appOrigin === 'string' && typeof value.contentOrigin === 'string';
}

export const test = playwright.extend<{ origins: Origins; contentOriginEnabled: boolean }>({
  contentOriginEnabled: [true, { option: true }],
  origins: async ({ contentOriginEnabled }, use) => {
    const child = fork(fileURLToPath(new URL('./mail-app.mjs', import.meta.url)), contentOriginEnabled ? [] : ['--plain'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
    });
    const exited = once(child, 'exit');
    try {
      const origins = await Promise.race([
        once(child, 'message').then(([value]: unknown[]) => {
          if (!isOrigins(value)) throw new Error('Expected loopback Mail fixture origins.');
          return value;
        }),
        exited.then(([code, signal]) => { throw new Error(`Mail app exited before listening (${code ?? signal}).`); }),
      ]);
      await use(origins);
    } finally {
      if (child.connected) child.disconnect();
      await exited;
    }
  },
  baseURL: async ({ origins }, use) => { await use(origins.appOrigin); },
});

export { expect } from '@playwright/test';
