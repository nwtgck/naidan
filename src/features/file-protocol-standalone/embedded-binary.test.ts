// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeEmbeddedBrotli } from './embedded-binary';
import { installBrotliDecoderForTest } from './embedded-binary.test-support';

function payload({ bytes }: { bytes: Uint8Array }) {
  return {
    base64: brotliCompressSync(bytes).toString('base64'),
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
const nativeFromBase64 = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
beforeEach(() => {
  installBrotliDecoderForTest();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (nativeFromBase64) Object.defineProperty(Uint8Array, 'fromBase64', nativeFromBase64);
  else Reflect.deleteProperty(Uint8Array, 'fromBase64');
});
describe('standalone embedded Brotli decoding', () => {
  it.each([0, 1, 131073])('round-trips %i bytes without fetching a sidecar', async byteLength => {
    const bytes = Uint8Array.from({ length: byteLength }, (_value, index) => index % 251);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const decoded = await decodeEmbeddedBrotli(payload({ bytes }));
    expect(decoded).toEqual(bytes);
    expect(fetcher).not.toHaveBeenCalled();
    // No additional JavaScript-side full copy for integrity checking. Web Crypto
    // may still snapshot its input internally, which this assertion does not hide.
    expect(digest).toHaveBeenCalledOnce();
    expect(digest.mock.calls[0]?.[0]).toBe('SHA-256');
    expect(digest.mock.calls[0]?.[1]).toBe(decoded);
  });
  it.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte length %s', async byteLength => {
    await expect(decodeEmbeddedBrotli({ ...payload({ bytes: new Uint8Array() }), byteLength })).rejects.toThrow('Invalid embedded binary size');
  });
  it.each(['', '0'.repeat(63), 'g'.repeat(64), '0'.repeat(65)])('rejects an invalid expected hash: %s', async sha256 => {
    await expect(decodeEmbeddedBrotli({ ...payload({ bytes: new Uint8Array() }), sha256 })).rejects.toThrow('Invalid embedded binary hash');
  });
  it('rejects both excess and missing decoded bytes', async () => {
    const input = payload({ bytes: new Uint8Array([1, 2, 3]) });
    await expect(decodeEmbeddedBrotli({ ...input, byteLength: 2 })).rejects.toThrow('exceeds');
    await expect(decodeEmbeddedBrotli({ ...input, byteLength: 4 })).rejects.toThrow('size mismatch');
  });
  it.each(['not base64!', 'AAA', 'AA=A', '===='])('rejects invalid Base64: %s', async base64 => {
    await expect(decodeEmbeddedBrotli({ ...payload({ bytes: new Uint8Array([1, 2, 3]) }), base64 })).rejects.toThrow('base64');
  });
  it('rejects truncated Brotli and a gzip payload rather than silently changing formats', async () => {
    const source = new Uint8Array([1, 2, 3]);
    const input = payload({ bytes: source });
    const compressed = Buffer.from(input.base64, 'base64');
    await expect(decodeEmbeddedBrotli({ ...input, base64: compressed.subarray(0, -1).toString('base64') })).rejects.toThrow();
    await expect(decodeEmbeddedBrotli({ ...input, base64: gzipSync(source).toString('base64') })).rejects.toThrow();
  });
  it('rejects valid Brotli containing wrong same-length bytes, not just malformed streams', async () => {
    const expected = payload({ bytes: new Uint8Array([1, 2, 3]) });
    const changed = payload({ bytes: new Uint8Array([1, 2, 4]) });
    await expect(decodeEmbeddedBrotli({ ...expected, base64: changed.base64 })).rejects.toThrow('integrity mismatch');
    await expect(decodeEmbeddedBrotli({ ...expected, sha256: '0'.repeat(64) })).rejects.toThrow('integrity mismatch');
  });
  it('does not bypass a failed integrity checker', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('digest denied'));
    await expect(decodeEmbeddedBrotli(payload({ bytes: new Uint8Array([1]) }))).rejects.toThrow('digest denied');
  });
  it('rejects a platform without Brotli instead of using gzip, a polyfill or fetch', async () => {
    const formats: string[] = [];
    vi.stubGlobal('DecompressionStream', class {
      constructor(format: string) {
        formats.push(format); throw new TypeError('Unsupported format');
      }
    });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(decodeEmbeddedBrotli(payload({ bytes: new Uint8Array([1]) }))).rejects.toThrow('Unsupported format');
    expect(formats).toEqual(['brotli']);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['native', 'fallback'] as const)('bounds %s Base64 decoding and preserves all bytes across group boundaries', async decoder => {
    const source = randomBytes(400001);
    const fromBase64 = vi.fn((text: string) => new Uint8Array(Buffer.from(text, 'base64')));
    Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, value: decoder === 'native' ? fromBase64 : undefined });
    const fallback = vi.spyOn(globalThis, 'atob');
    const blob = vi.fn(() => {
      throw new Error('Unexpected full binary Blob copy');
    });
    vi.stubGlobal('Blob', blob);
    const input = payload({ bytes: source });
    const result = await decodeEmbeddedBrotli(input);
    expect(Buffer.from(result).equals(source)).toBe(true);
    const calls = decoder === 'native' ? fromBase64.mock.calls : fallback.mock.calls;
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.map(([text]) => text).join('')).toBe(input.base64);
    for (const [text] of calls) {
      expect(text.length).toBeLessThanOrEqual(64 * 1024);
      expect(text.length % 4).toBe(0);
    }
    if (decoder === 'native') expect(fallback).not.toHaveBeenCalled();
    expect(blob).not.toHaveBeenCalled();
  });
  it('rejects padding inside a non-final Base64 chunk', async () => {
    const input = payload({ bytes: randomBytes(100001) });
    const base64 = '=' + input.base64.slice(1);
    await expect(decodeEmbeddedBrotli({ ...input, base64 })).rejects.toThrow('Invalid embedded base64');
  });
  it('propagates cancellation upstream after an output size violation', async () => {
    const input = payload({ bytes: randomBytes(1000001) });
    Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, value: undefined });
    const fallback = vi.spyOn(globalThis, 'atob');
    // A controlled downstream isolates cancellation from native Brotli buffering.
    vi.stubGlobal('DecompressionStream', class {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array>;
      constructor() {
        const stream = new TransformStream<Uint8Array, Uint8Array>({
          transform(_chunk, controller) {
            controller.enqueue(new Uint8Array(2));
          },
        });
        this.readable = stream.readable; this.writable = stream.writable;
      }
    });
    const digest = vi.spyOn(crypto.subtle, 'digest');
    await expect(decodeEmbeddedBrotli({ ...input, byteLength: 1 })).rejects.toThrow('exceeds');
    expect(digest).not.toHaveBeenCalled();
    expect(fallback.mock.calls.reduce((length, [text]) => length + text.length, 0)).toBeLessThan(input.base64.length);
  });
});
