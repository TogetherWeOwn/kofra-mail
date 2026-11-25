import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

export async function createRuntime() {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./fixture-worker.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', target: 'es2024',
  });
  return new Miniflare({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-07-30',
  });
}

export interface Rendered {
  html: string;
  filled: string;
  refs: Array<{ kind: 'cid'; contentId: string } | { kind: 'img'; url: string }>;
  version: number;
  unsafe?: 'ambiguous_markup';
}

export async function render(runtime: Miniflare, vector: { html: string; ri?: boolean; verdict?: string; plain?: boolean }, origin?: string) {
  const url = new URL('https://content.example/sanitise');
  if (origin) url.searchParams.set('fixtureOrigin', origin);
  const response = await runtime.dispatchFetch(url, { method: 'POST', body: JSON.stringify(vector) });
  if (!response.ok) throw new Error(`fixture render ${response.status}: ${await response.text()}`);
  return await response.json() as Rendered;
}
