import { describe, expect, it } from 'vitest';
import { assertSafeGitRepositoryPath, assertSafeGitRepositoryPathBytes } from './path-safety';

describe('wesh git repository pathname safety', () => {
  it('accepts ordinary repository-relative paths, including .wesh-system', () => {
    expect(() => assertSafeGitRepositoryPath({ path: 'a/b.txt', source: 'tree' })).not.toThrow();
    expect(() => assertSafeGitRepositoryPath({ path: '.wesh-system/x', source: 'tree' })).not.toThrow();
  });

  it.each([
    '',
    '/absolute',
    '.',
    '..',
    '../outside',
    'a/../outside',
    'a/./b',
    'a//b',
    '.git',
    '.git/config',
    'a/.git/config',
  ])('rejects unsafe repository pathname %j', path => {
    expect(() => assertSafeGitRepositoryPath({ path, source: 'index' })).toThrow(
      `invalid index path '${path}'`,
    );
  });

  it('validates raw pathname bytes without requiring UTF-8 decoding', () => {
    expect(() => assertSafeGitRepositoryPathBytes({
      bytes: Uint8Array.of(0x62, 0x61, 0x64, 0x2d, 0xff),
      source: 'index',
    })).not.toThrow();

    const encoder = new TextEncoder();
    for (const path of ['/absolute', '../outside', 'a/../outside', '.git/config']) {
      expect(() => assertSafeGitRepositoryPathBytes({
        bytes: encoder.encode(path),
        source: 'index',
      })).toThrow('invalid index pathname bytes');
    }
  });

});
