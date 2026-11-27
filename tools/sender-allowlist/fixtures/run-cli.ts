import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../cli.ts';

const [origin, mode, directory, wranglerMode] = process.argv.slice(2);
const fakeWrangler = fileURLToPath(new URL('./wrangler.ts', import.meta.url));
process.exitCode = await runCli(mode, { ...process.env, RUNNER_TEMP: directory }, {
  configPath: join(directory, 'wrangler.jsonc'),
  request: ((input, options) => fetch(origin + new URL(String(input)).pathname, options)) as typeof fetch,
  wrangler: [process.execPath, fakeWrangler, wranglerMode],
});
