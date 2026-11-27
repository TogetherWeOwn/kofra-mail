import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_NAME, isRecord } from './cloudflare.ts';
import type { Deploy } from './job.ts';

export const CONFIG_PATH = fileURLToPath(new URL('../../workers/mail-send/wrangler.jsonc', import.meta.url));
const VERSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function configWithSenders(base: Record<string, unknown>, list: string[]): Record<string, unknown> {
  const unsafe = isRecord(base.unsafe) ? base.unsafe : undefined;
  const rawEmailBinding = Array.isArray(unsafe?.bindings)
    && unsafe.bindings.some((binding) => isRecord(binding) && binding.type === 'send_email');
  // Wrangler overlays unsafe.metadata onto the final upload, after generating normal bindings.
  const bindingOverrides = isRecord(unsafe?.metadata)
    && (Object.hasOwn(unsafe.metadata, 'bindings') || Object.hasOwn(unsafe.metadata, 'keep_bindings'));
  if (Object.hasOwn(base, 'send_email') || rawEmailBinding || bindingOverrides) {
    throw new Error('The base config must not define or override send_email');
  }
  return list.length === 0 ? { ...base } : {
    ...base, send_email: [{ name: 'EMAIL', allowed_sender_addresses: list }],
  };
}

function deployedVersion(output: string): string {
  const entries: unknown[] = output.split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const deploys = entries.filter((entry) => isRecord(entry) && entry.type === 'deploy');
  const [entry] = deploys;
  if (deploys.length !== 1 || !isRecord(entry) || entry.version !== 1 || entry.worker_name !== WORKER_NAME
    || typeof entry.version_id !== 'string' || !VERSION_ID.test(entry.version_id)) {
    throw new Error('Missing or invalid Wrangler deploy result');
  }
  return entry.version_id;
}

// Check the base config before the run is allowed to read or change the directory.
export async function prepareDeploy(configPath: string, env: NodeJS.ProcessEnv, command?: readonly string[]): Promise<Deploy> {
  const { experimental_readRawConfig } = await import('wrangler');
  const { rawConfig } = experimental_readRawConfig({ config: configPath }, { useRedirectIfAvailable: false });
  if (!isRecord(rawConfig) || rawConfig.name !== WORKER_NAME
    || (rawConfig.account_id !== undefined && rawConfig.account_id !== env.CLOUDFLARE_ACCOUNT_ID)) {
    throw new Error('Unexpected sending worker config');
  }
  configWithSenders(rawConfig, []);
  const wrangler = command ?? [process.execPath, fileURLToPath(new URL('./bin/wrangler.js', import.meta.resolve('wrangler/package.json')))];
  const cwd = dirname(configPath);

  return async (list) => {
    const scratch = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), 'velmora-sender-allowlist-'));
    try {
      // A sibling keeps Wrangler's relative entrypoint, build and asset paths unchanged.
      const generated = join(cwd, `.sender-allowlist-${randomUUID()}.json`);
      const config = await open(generated, 'wx', 0o600);
      try {
        try {
          await config.writeFile(JSON.stringify(configWithSenders(rawConfig, list)));
        } finally {
          await config.close();
        }
        const structured = join(scratch, 'deploy.jsonl');
        const log = await open(join(scratch, 'deploy.log'), 'wx', 0o600);
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(wrangler[0], [...wrangler.slice(1), 'deploy', '--config', generated], {
              cwd,
              env: {
                PATH: env.PATH,
                HOME: scratch,
                TMPDIR: scratch,
                CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
                CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
                CI: 'true',
                WRANGLER_SEND_METRICS: 'false',
                WRANGLER_SEND_ERROR_REPORTS: 'false',
                WRANGLER_LOG_PATH: join(scratch, 'debug.log'),
                WRANGLER_OUTPUT_FILE_PATH: structured,
              },
              stdio: ['ignore', log.fd, log.fd],
            });
            child.once('error', reject);
            child.once('close', (status) => status === 0 ? resolve() : reject(new Error('Wrangler deploy failed')));
          });
        } finally {
          await log.close();
        }
        return deployedVersion(await readFile(structured, 'utf8'));
      } finally {
        await unlink(generated);
      }
    } finally {
      await rm(scratch, { recursive: true });
    }
  };
}
