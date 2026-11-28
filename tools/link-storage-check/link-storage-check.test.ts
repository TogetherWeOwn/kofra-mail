import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALL_OPS, fakeS3, READ_OPS, type S3Op } from '../../packages/link-storage/test/fake-s3.ts';
import { deployCheck, linkHostCheck } from './check.ts';

// Synthetic values only: a local fake S3 endpoint and a fake Cloudflare API.
const READ = { accessKeyId: 'FAKEREADKEY0001', secretAccessKey: 'fake-read-secret-value-0001' };
const WRITE = { accessKeyId: 'FAKEWRITEKEY002', secretAccessKey: 'fake-write-secret-value-0002' };
const TOKEN = 'fake-cloudflare-token-value';
const host = 's3.kofra-fixture.test';
const location = { endpoint: `https://${host}`, region: 'auto', bucket: 'links', prefix: 'links/', pathStyle: true };

function setup(options: { anonymous?: S3Op[]; secrets?: Record<string, string[]> } = {}) {
  const s3 = fakeS3({ host, bucket: 'links', anonymous: options.anonymous, keys: {
    [READ.accessKeyId]: { secret: READ.secretAccessKey, ops: new Set<S3Op>(READ_OPS) },
    [WRITE.accessKeyId]: { secret: WRITE.secretAccessKey, ops: new Set<S3Op>(ALL_OPS) },
  } });
  const secrets = options.secrets ?? { 'mail-content': ['LINK_READ_CREDENTIALS', 'CONTENT_URL_KEYS'],
    'kofra-mail-web': ['LINK_WRITE_CREDENTIALS', 'LINK_CRED_KEK'], 'mail-backend': ['LINK_WRITE_CREDENTIALS', 'LINK_CRED_KEK'] };
  const fetcher = async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'api.cloudflare.com') return s3.fetch(request);
    assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`);
    const script = /^\/client\/v4\/accounts\/fixture-account\/workers\/scripts\/([a-z-]+)\/secrets$/.exec(url.pathname)?.[1];
    if (!script || !secrets[script]) return new Response('{}', { status: 404 });
    return Response.json({ success: true, result: secrets[script].map((name) => ({ name, type: 'secret_text' })) });
  };
  const env = {
    LINK_LOCATIONS: JSON.stringify({ current: 'main', locations: { main: location } }),
    LINK_READ_CREDENTIALS: JSON.stringify({ main: READ }), LINK_WRITE_CREDENTIALS: JSON.stringify({ main: WRITE }),
    CLOUDFLARE_ACCOUNT_ID: 'fixture-account', CLOUDFLARE_API_TOKEN: TOKEN,
  };
  return { s3, fetcher, env };
}

const leaks = (value: unknown) => [READ.secretAccessKey, WRITE.secretAccessKey, TOKEN, READ.accessKeyId, WRITE.accessKeyId]
  .filter((secret) => JSON.stringify(value).includes(secret));

test('the deploy-time check passes a private deployment bucket with correctly split secrets', async () => {
  const { fetcher, env, s3 } = setup();
  const result = await deployCheck(env, fetcher);
  assert.deepEqual(result, { ok: true, lines: [{ location: 'main', result: 'ok' }, { worker: 'mail-content', result: 'ok' },
    { worker: 'kofra-mail-web', result: 'ok' }, { worker: 'mail-backend', result: 'ok' }] });
  assert.equal(s3.objects.size, 0);
});

test('mail-content binding a write credential or the KEK fails the deploy-time check', async () => {
  const { fetcher, env } = setup({ secrets: { 'mail-content': ['LINK_READ_CREDENTIALS', 'LINK_WRITE_CREDENTIALS', 'LINK_CRED_KEK'],
    'kofra-mail-web': ['LINK_WRITE_CREDENTIALS', 'LINK_CRED_KEK', 'LINK_READ_CREDENTIALS'], 'mail-backend': ['LINK_CRED_KEK'] } });
  const result = await deployCheck(env, fetcher);
  assert.equal(result.ok, false);
  assert.deepEqual(result.lines.slice(1), [{ worker: 'mail-content', result: 'forbidden_secrets', names: ['LINK_WRITE_CREDENTIALS', 'LINK_CRED_KEK'] },
    { worker: 'kofra-mail-web', result: 'forbidden_secrets', names: ['LINK_READ_CREDENTIALS'] }, { worker: 'mail-backend', result: 'ok' }]);
});

test('a public deployment bucket, missing credentials and invalid config fail with fixed codes and no secret', async () => {
  const pub = setup({ anonymous: ['ListObjects'] });
  const failed = await deployCheck(pub.env, pub.fetcher);
  assert.deepEqual([failed.ok, failed.lines[0]], [false, { location: 'main', result: 'public_bucket' }]);
  const missing = setup();
  const two = { ...missing.env, LINK_LOCATIONS: JSON.stringify({ current: 'main', locations: { main: location, old: { ...location, bucket: 'old-links' } } }) };
  assert.deepEqual((await deployCheck(two, missing.fetcher)).lines[1], { location: 'old', result: 'missing_credentials' });
  const invalid = await deployCheck({ ...missing.env, LINK_WRITE_CREDENTIALS: `{"main": "${WRITE.secretAccessKey}"}` }, missing.fetcher);
  assert.deepEqual(invalid, { ok: false, lines: [{ config: 'invalid' }] });
  assert.deepEqual(leaks([failed, invalid]), []);
});

test('the CLI prints only fixed codes', () => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  let output = '';
  try {
    execFileSync(process.execPath, [cli], { env: { PATH: process.env.PATH, LINK_LOCATIONS: 'x', LINK_WRITE_CREDENTIALS: JSON.stringify({ main: WRITE }) }, encoding: 'utf8' });
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    assert.equal(failure.status, 1);
    output = failure.stdout + failure.stderr;
  }
  assert.equal(output, '{"config":"invalid"}\n');
});

test('mail-content never names a write credential or the KEK, and mail-web never names the read secret', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = `${dir}/${name}`;
    return name === 'node_modules' ? [] : statSync(path).isDirectory() ? files(path) : [path];
  });
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const [dir, forbidden] of [['workers/mail-content', /LINK_WRITE_CREDENTIALS|LINK_CRED_KEK/], ['apps/web/src', /LINK_READ_CREDENTIALS/],
    ['apps/web/wrangler.jsonc', /LINK_READ_CREDENTIALS/]] as const) {
    const paths = statSync(`${root}${dir}`).isDirectory() ? files(`${root}${dir}`) : [`${root}${dir}`];
    for (const path of paths) assert.doesNotMatch(readFileSync(path, 'utf8'), forbidden, path);
  }
});

test('the link host must be a domain of its own unless the shared-domain override is set, and the CLI then warns', async () => {
  const origins = { MAIL_APP_ORIGIN: 'https://mail.mail-suite.example', CONTENT_ORIGIN: 'https://content.mail-content.example' };
  assert.deepEqual(linkHostCheck({ ...origins, LINK_HOST: 'files.mail-links.example' }), { linkHost: 'files.mail-links.example', result: 'ok' });
  assert.deepEqual(linkHostCheck({ ...origins, LINK_HOST: 'files.mail-suite.example' }), { linkHost: 'files.mail-suite.example', result: 'shared_domain' });
  assert.deepEqual(linkHostCheck({ ...origins, LINK_HOST: 'files.mail-content.example' }), { linkHost: 'files.mail-content.example', result: 'shared_domain' });
  assert.deepEqual(linkHostCheck({ ...origins, LINK_HOST: 'files.mail-suite.example', LINK_HOST_ALLOW_SHARED_DOMAIN: '1' }),
    { linkHost: 'files.mail-suite.example', result: 'shared_domain_allowed' });
  assert.deepEqual(linkHostCheck({ ...origins, LINK_HOST: 'files.mail-suite.example', LINK_HOST_ALLOW_SHARED_DOMAIN: 'yes' }),
    { linkHost: 'files.mail-suite.example', result: 'shared_domain' }, 'only the exact override');
  assert.deepEqual(linkHostCheck({ LINK_HOST: 'https://files.example.com' }), { linkHost: 'LINK_HOST', result: 'invalid' });
  assert.deepEqual(linkHostCheck({ LINK_HOST: 'files.example.com', LINK_HOSTS: 'old.example.net files.example.com' }),
    { linkHost: 'files.example.com', result: 'not_first' });
  assert.equal(linkHostCheck({}), undefined);
  const { fetcher, env } = setup();
  assert.equal((await deployCheck({ ...env, ...origins, LINK_HOST: 'files.mail-suite.example' }, fetcher)).ok, false);
  assert.equal((await deployCheck({ ...env, ...origins, LINK_HOST: 'files.mail-suite.example', LINK_HOST_ALLOW_SHARED_DOMAIN: '1' }, fetcher)).ok, true);
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  let stderr = '';
  try {
    execFileSync(process.execPath, [cli], { env: { PATH: process.env.PATH, ...origins, LINK_HOST: 'files.mail-suite.example', LINK_HOST_ALLOW_SHARED_DOMAIN: '1' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { stderr = (error as { stderr: string }).stderr; }
  assert.match(stderr, /LINK_HOST shares a registrable domain/);
});
