import { spawn } from 'node:child_process';

export type ChildRun = { code: number | null; signal: NodeJS.Signals | null; output: string };

// Runs a child `node` process in its own process group. At the deadline, when
// it exits, and if this runner exits or is stopped by SIGINT or SIGTERM first,
// the whole group is killed, so no grandchild (a test file's process, a local
// workerd) outlives the run.
export async function runChild(args: string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<ChildRun> {
  const child = spawn(process.execPath, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const killGroup = () => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  process.once('exit', killGroup);
  // A signal skips the exit event: kill the group, then stop as the signal would have.
  const onSignal = (signal: NodeJS.Signals) => {
    killGroup();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.kill(process.pid, signal);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const timer = setTimeout(killGroup, options.timeoutMs);
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const closed = new Promise<void>(resolve => child.on('close', () => resolve()));
  try {
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    // A grandchild still holding the output pipes would keep them open.
    killGroup();
    await closed;
    return { code, signal, output };
  } finally {
    clearTimeout(timer);
    killGroup();
    process.removeListener('exit', killGroup);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

// A TAP `# SKIP` or `# TODO` directive; a `#` inside a test name is escaped as `\#`.
const DIRECTIVE = /(?<!\\)#\s*(?:SKIP|TODO)\b/i;
// The numbered conformance cases a TAP run reports as passed, without a directive.
export const passedCases = (output: string) => [...output.matchAll(/^\s+ok \d+ - (\d+a?)\. (.*)$/gm)]
  .filter(match => !DIRECTIVE.test(match[2])).map(match => match[1]).sort();
export const failedTests = (output: string) => [...output.matchAll(/^\s+not ok \d+ - (.+)$/gm)].map(match => match[1]);
