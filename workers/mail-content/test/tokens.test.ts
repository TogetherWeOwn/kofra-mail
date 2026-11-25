import assert from 'node:assert/strict';
import { fileURLToPath, URL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { build } from 'esbuild';
import type { Readable } from 'node:stream';
import { Miniflare } from 'miniflare';
import { runScenario, scenarios, type ScenarioResult } from './token-scenarios.ts';

function assertClean(result: ScenarioResult) {
  assert.equal(result.error, undefined);
  assert.ok(result.ok);
  // Section 6 item 6: nothing is logged on any path, so no token, MAC or claim value can be.
  assert.deepEqual(result.logs, []);
  assert.ok(result.sensitive.length > 0, 'the scenario registered the values it must not log');
}

describe('content tokens in Node', () => {
  for (const { name } of scenarios) test(name, async () => assertClean(await runScenario(name)));
});

describe('content tokens in workerd', () => {
  let runtime: Miniflare;
  let stdio = '';
  const sensitive: string[] = [];
  before(async () => {
    const { outputFiles } = await build({
      entryPoints: [fileURLToPath(new URL('./token-fixture-worker.ts', import.meta.url))],
      bundle: true, write: false, format: 'esm', target: 'es2024',
    });
    runtime = new Miniflare({
      modules: true, script: outputFiles[0].text, compatibilityDate: '2026-07-30',
      handleRuntimeStdio(stdout: Readable, stderr: Readable) {
        stdout.on('data', (chunk: Buffer) => { stdio += String(chunk); });
        stderr.on('data', (chunk: Buffer) => { stdio += String(chunk); });
      },
    });
    const names = await (await runtime.dispatchFetch('https://content.example/')).json();
    assert.deepEqual(names, scenarios.map((scenario) => scenario.name));
  });
  after(() => runtime?.dispose());

  for (const { name } of scenarios) test(name, async () => {
    const url = new URL('https://content.example/');
    url.searchParams.set('scenario', name);
    const result = await (await runtime.dispatchFetch(url)).json() as ScenarioResult;
    sensitive.push(...result.sensitive);
    assertClean(result);
  });

  test('workerd process output carries no token, MAC or claim value', () => {
    assert.ok(sensitive.length > scenarios.length);
    for (const value of sensitive) assert.ok(!stdio.includes(value), 'a sensitive value reached workerd output');
  });
});
