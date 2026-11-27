import { pathToFileURL } from 'node:url';
import { CloudflareMail } from './cloudflare.ts';
import { CONFIG_PATH, prepareDeploy } from './deploy.ts';
import { DeploymentError, runSenderAllowlist, type Deploy } from './job.ts';

type Dependencies = { configPath?: string; request?: typeof fetch; wrangler?: readonly string[] };

export async function runCli(mode: string, env: NodeJS.ProcessEnv, deps: Dependencies = {}): Promise<number> {
  if (mode !== 'dry-run' && mode !== 'deploy') return 2;
  let deploy: Deploy | undefined;
  if (mode === 'deploy') {
    try {
      deploy = await prepareDeploy(deps.configPath ?? CONFIG_PATH, env, deps.wrangler);
    } catch {
      return 2;
    }
  }
  try {
    const counts = await runSenderAllowlist(new CloudflareMail(env, deps.request), deploy);
    process.stdout.write(`${JSON.stringify(counts)}\n`);
    return 0;
  } catch (error) {
    // Do not emit upstream errors, URLs, query data or Wrangler output. Exit codes identify the failing phase.
    return error instanceof DeploymentError ? error.exitCode : 3;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = process.argv.length > 3 ? 2 : await runCli(process.argv[2] ?? 'dry-run', process.env);
}
