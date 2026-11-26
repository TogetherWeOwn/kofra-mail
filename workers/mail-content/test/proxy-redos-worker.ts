// Worker thread for the Content-Type backtracking test: a parser stall here
// cannot block the parent, whose watchdog fails the test instead of hanging.
import { parentPort } from 'node:worker_threads';
import { fetchRemoteImage } from '../src/proxy.ts';
import { config, image, images, upstream } from './proxy-fixtures.ts';

const target = 'https://img.sender.example/pixel.png';
const cases = ['image/png; ' + ';   '.repeat(40) + 'x', 'image/png' + ' ;'.repeat(20_000) + ' x', 'image/png;' + ' '.repeat(50_000) + 'x'];
const results: string[] = [];
for (const type of cases) {
  const result = await fetchRemoteImage(target, config, upstream({ [target]: image(type, images['image/png']) }).fetchImpl, () => 0);
  results.push(result.ok ? 'ok' : result.reason);
}
parentPort!.postMessage(results);
