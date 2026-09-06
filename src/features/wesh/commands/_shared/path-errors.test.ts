import { describe, expect, it } from 'vitest';
import { getPathErrorReason, isPathNotFoundError, isPathTypeMismatchError } from '@/features/wesh/commands/_shared/path-errors';

describe('isPathNotFoundError', () => {
  it('recognizes browser, Node, and Wesh missing-path errors', () => {
    const named = new Error('missing');
    named.name = 'NotFoundError';

    expect(isPathNotFoundError({
      error: new DOMException('missing', 'NotFoundError'),
    })).toBe(true);
    expect(isPathNotFoundError({ error: named })).toBe(true);
    expect(isPathNotFoundError({ error: { code: 'ENOENT' } })).toBe(true);
    expect(isPathNotFoundError({ error: new Error('Path not found: /missing') })).toBe(true);
    expect(isPathNotFoundError({
      error: new Error('No such file or directory: /missing'),
    })).toBe(true);
  });

  it('does not hide unrelated filesystem failures', () => {
    expect(isPathNotFoundError({ error: { code: 'EACCES' } })).toBe(false);
    expect(isPathNotFoundError({ error: new Error('Permission denied') })).toBe(false);
    expect(isPathNotFoundError({ error: new Error('I/O failure') })).toBe(false);
    expect(isPathNotFoundError({ error: 'NotFoundError' })).toBe(false);
  });
});

describe('isPathTypeMismatchError', () => {
  it('recognizes browser and Wesh not-a-directory errors', () => {
    expect(isPathTypeMismatchError({
      error: new DOMException('browser-specific text', 'TypeMismatchError'),
    })).toBe(true);
    const named = new Error('browser-specific text');
    named.name = 'TypeMismatchError';
    expect(isPathTypeMismatchError({ error: named })).toBe(true);
    expect(isPathTypeMismatchError({ error: { code: 'ENOTDIR' } })).toBe(true);
    expect(isPathTypeMismatchError({ error: new Error('Not a directory') })).toBe(true);
    expect(isPathTypeMismatchError({ error: new Error('Not a file: /archive') })).toBe(true);
  });

  it('does not classify unrelated errors as type mismatches', () => {
    expect(isPathTypeMismatchError({ error: new DOMException('missing', 'NotFoundError') })).toBe(false);
    expect(isPathTypeMismatchError({ error: { code: 'ENOENT' } })).toBe(false);
    expect(isPathTypeMismatchError({ error: new Error('Permission denied') })).toBe(false);
  });
});


describe('getPathErrorReason', () => {
  it('maps browser-shaped path errors to stable semantic reasons', () => {
    expect(getPathErrorReason({
      error: new DOMException('browser-specific missing text', 'NotFoundError'),
    })).toBe('No such file or directory');
    expect(getPathErrorReason({
      error: new DOMException('browser-specific type text', 'TypeMismatchError'),
    })).toBe('Not a directory');
    expect(getPathErrorReason({ error: new Error('Permission denied') })).toBeUndefined();
    expect(getPathErrorReason({ error: new Error("target 'dst' is not a directory") })).toBeUndefined();
  });
});
