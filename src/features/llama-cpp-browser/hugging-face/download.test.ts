import { describe, expect, it, vi } from 'vitest';
import { responseOffset } from './download';
vi.mock('@/features/privacy-fetch', () => ({ privacyFetchStream: vi.fn() }));
describe('Hugging Face range validation', () => {
  it('accepts exact remaining bytes and restarts a 200 response instead of appending', () => {
    expect(responseOffset({ status: 206, headers: new Headers({ 'content-range': 'bytes 24-127/128', 'content-length': '104' }), offset: 24, size: 128 })).toBe(24);
    expect(responseOffset({ status: 200, headers: new Headers({ 'content-length': '128' }), offset: 24, size: 128 })).toBe(0);
  });
  it.each(['bytes 0-127/128', 'bytes 24-126/128', 'bytes 24-127/129', 'bytes 24-127/*', 'bytes 24-127/128, bytes 0-1/128'])('rejects invalid ranges: %s', range => {
    expect(() => responseOffset({ status: 206, headers: new Headers({ 'content-range': range }), offset: 24, size: 128 })).toThrow();
  });
  it('does not promote 416 or other errors to a completed download', () => {
    for (const status of [416, 404, 500]) expect(() => responseOffset({ status, headers: new Headers(), offset: 128, size: 128 })).toThrow();
    expect(() => responseOffset({ status: 206, headers: new Headers({ 'content-range': 'bytes 24-127/128', 'content-length': '103' }), offset: 24, size: 128 })).toThrow();
  });
});
