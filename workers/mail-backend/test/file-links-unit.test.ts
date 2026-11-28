import assert from 'node:assert/strict';
import test from 'node:test';
import { isObjectKey, isStoredFileLink, validSendLinks, type SendLink } from '../src/file-links.ts';

// The frozen link's object key (M3-13): never empty, `.` or `..` segments, which
// URL parsing would collapse into a path outside the location's bucket or prefix.
const link: SendLink = { id: 'abcdefghijklmnopqrstuvwxyz', token: 'abcdefghijklmnopqrstuA', host: 'files.example.test', name: 'a.bin', size: 1,
  expiresAt: null, location: { kind: 'deployment', id: 'links' }, key: 'files/ws/a.bin', fingerprint: '0'.repeat(64) };

test('object keys refuse empty, dot and dot-dot segments', () => {
  assert.equal(isObjectKey('files/ws/a.bin'), true);
  assert.equal(isObjectKey('files/ws/.hidden'), true);
  for (const key of ['', '/files/a', 'files//a', 'files/./a', 'files/../a', '..', '.', 'a/', 'a/..']) assert.equal(isObjectKey(key), false, key);
  assert.equal(validSendLinks([link]), true);
  assert.equal(validSendLinks([{ ...link, key: 'files/../../other-bucket/secret' }]), false, 'a frozen record cannot carry it');
  assert.equal(isStoredFileLink({ location: link.location, key: 'files/../x', fingerprint: link.fingerprint }), false, 'nor a draft');
});
