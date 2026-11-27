import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { quotedAddress, version } from './directory.ts';

const [mode, command, configFlag, configPath] = process.argv.slice(2);
console.log(`Wrangler listed ${quotedAddress}`);
console.error(`Wrangler debug ${quotedAddress}`);
assert.equal(command, 'deploy');
assert.equal(configFlag, '--config');
assert.equal(process.env.CLOUDFLARE_D1_DATABASE_ID, undefined);
const config = JSON.parse(await readFile(configPath, 'utf8'));
assert.equal(config.main, 'src/index.ts');
assert.deepEqual(config.send_email, mode === 'empty'
  ? undefined : [{ name: 'EMAIL', allowed_sender_addresses: [quotedAddress] }]);
if (mode === 'failure') process.exit(1);
await writeFile(process.env.WRANGLER_OUTPUT_FILE_PATH!, `${JSON.stringify({
  type: 'deploy', version: 1, worker_name: 'mail-send', version_id: version,
})}\n`);
