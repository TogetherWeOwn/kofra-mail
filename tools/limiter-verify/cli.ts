import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bucketNames, type Bucket } from './expected-buckets.ts';

export function isEntryPoint(meta: { url: string; main?: boolean }): boolean {
  if (typeof meta.main === 'boolean') return meta.main;
  // Node 24.0 and 24.1 support stripping TypeScript but lack import.meta.main.
  if (!process.argv[1]) return false;
  try { return pathToFileURL(realpathSync(process.argv[1])).href === meta.url; }
  catch { return false; }
}

export type Verdict = { bucket: Bucket; pass: boolean };

export function failures(buckets: readonly Bucket[] = bucketNames): Verdict[] {
  return buckets.map((bucket) => ({ bucket, pass: false }));
}

export function report(verdicts: readonly Verdict[]): void {
  for (const { bucket, pass } of verdicts) console.log(`${bucket} ${pass ? 'PASS' : 'FAIL'}`);
  process.exitCode = verdicts.some(({ pass }) => !pass) ? 1 : 0;
}

export function targetOrigin(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? '');
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password
      || url.href !== `${url.origin}/`) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
