import test from 'node:test';
import assert from 'node:assert/strict';
import { sameOriginUploadUrl } from '../src/lib/media-url.ts';

test('legacy absolute HTTP(S) upload URLs become same-origin paths', () => {
  assert.equal(sameOriginUploadUrl('https://old-preview.example/api/uploads/server-123-abc.png'), '/api/uploads/server-123-abc.png');
  assert.equal(sameOriginUploadUrl('http://old-preview.example/api/uploads/17312123-random.jpg'), '/api/uploads/17312123-random.jpg');
});

test('only exact safe upload paths are rewritten', () => {
  for (const url of [
    'https://example.com/api/uploads/../private.txt',
    'https://example.com/api/uploads/file%2Fprivate.png',
    'https://example.com/api/uploads/file.png?download=1',
    'https://user:pass@example.com/api/uploads/file.png',
    'ftp://example.com/api/uploads/file.png',
    'https://example.com/somewhere/file.png',
  ]) {
    assert.equal(sameOriginUploadUrl(url), url);
  }
});

test('relative routes and local blob/data previews remain untouched', () => {
  for (const value of ['/api/uploads/file.png', 'blob:https://example.com/id', 'data:image/png;base64,abc', undefined]) {
    assert.equal(sameOriginUploadUrl(value), value);
  }
  assert.equal(sameOriginUploadUrl(null), undefined);
});