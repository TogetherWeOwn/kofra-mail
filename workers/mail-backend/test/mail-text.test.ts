import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bodyForIndex } from '../src/mail-text.ts';

test('indexes visible text after an optional head end tag', () => {
  const body = bodyForIndex(undefined, '<html><head><title>Not searchable</title><p>Visible body</p></html>');
  assert.equal(body.trim(), 'Visible body');
});

test('separates text across line and definition-list boundaries', () => {
  const body = bodyForIndex(undefined, 'Before<hr>After<dl><dt>Definition</dt><dd>Body</dd></dl>');
  assert.equal(body.trim().replace(/\s+/g, ' '), 'Before After Definition Body');
});

test('head-only content and leading whitespace do not consume the index budget', () => {
  const body = bodyForIndex(undefined, `<html><head><noframes>hidden</noframes>${' '.repeat(64 * 1024)}<p>Visible body</p></html>`);
  assert.equal(body.trim().includes('Visible body'), true);
  assert.equal(body.includes('hidden'), false);
});
