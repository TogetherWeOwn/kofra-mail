import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentFrameUrl, separateContentOrigin } from './content-origin.ts';

const app = new URL('https://mail.example.com/');
const content = 'https://content.example.net';

test('requires a dedicated HTTPS site and rejects malformed configuration', () => {
  assert.equal(separateContentOrigin(`${content}/`, app, false), content);
  for (const input of [undefined, 'https://mail.example.com:444', 'https://content.example.com', 'https://user@content.example.net', 'https://content.example.net/path', 'https://content.example.net/?x=1', 'http://content.example.net']) {
    assert.equal(separateContentOrigin(input, app, false), undefined, input);
  }
  assert.equal(separateContentOrigin('https://other.example.co.uk', new URL('https://mail.example.co.uk'), false), undefined);
  assert.equal(separateContentOrigin('https://content.example.net', new URL('https://example.net.'), false), undefined);
});

test('offline development may use two distinct loopback hosts', () => {
  const demo = new URL('http://127.0.0.1:4179');
  assert.equal(separateContentOrigin('http://localhost:4180', demo, true), 'http://localhost:4180');
  assert.equal(separateContentOrigin('http://127.0.0.1:4180', demo, true), undefined);
  assert.equal(separateContentOrigin('http://localhost:4180', demo, false), undefined);
  assert.equal(separateContentOrigin('http://localhost:4180', app, true), undefined);
});

test('frame URLs must be absolute URLs on the configured exact origin', () => {
  assert.equal(contentFrameUrl(`${content}/message/123?fixture=1`, content), `${content}/message/123?fixture=1`);
  for (const input of ['/message/123', '//content.example.net/message/123', 'https://evil.example.net/message/123', 'https://content.example.net:444/', 'https://example.com@content.example.net/', 'javascript:alert(1)', 'data:text/html,hello']) {
    assert.equal(contentFrameUrl(input, content), undefined, input);
  }
  assert.equal(contentFrameUrl(`${content}/body`, undefined), undefined);
});
