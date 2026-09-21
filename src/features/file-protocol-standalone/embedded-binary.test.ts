// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeEmbeddedGzip } from './embedded-binary';

const nativeFromBase64 = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (nativeFromBase64) Object.defineProperty(Uint8Array, 'fromBase64', nativeFromBase64);
  else Reflect.deleteProperty(Uint8Array, 'fromBase64');
});
describe('standalone embedded binary decoding', () => {
  it.each([0, 1, 131073])('round-trips %i bytes without fetching a sidecar', async byteLength => {
    const bytes = Uint8Array.from({ length: byteLength }, (_value, index) => index % 251);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const decoded = await decodeEmbeddedGzip({ base64: gzipSync(bytes).toString('base64'), byteLength });
    expect(decoded).toEqual(bytes);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte length %s', async byteLength => {
    await expect(decodeEmbeddedGzip({ base64: '', byteLength })).rejects.toThrow('Invalid embedded binary size');
  });
  it('rejects both excess and missing decoded bytes', async () => {
    const base64 = gzipSync(new Uint8Array([1, 2, 3])).toString('base64');
    await expect(decodeEmbeddedGzip({ base64, byteLength: 2 })).rejects.toThrow('exceeds');
    await expect(decodeEmbeddedGzip({ base64, byteLength: 4 })).rejects.toThrow('size mismatch');
  });
  it('rejects invalid base64, corrupt checksums and truncated streams', async () => {
    await expect(decodeEmbeddedGzip({ base64: 'not base64!', byteLength: 3 })).rejects.toThrow();
    const bytes = gzipSync(new Uint8Array([1, 2, 3]));
    await expect(decodeEmbeddedGzip({ base64: bytes.subarray(0, -1).toString('base64'), byteLength: 3 })).rejects.toThrow();
    bytes[bytes.length - 8] = bytes[bytes.length - 8]! ^ 1;
    await expect(decodeEmbeddedGzip({ base64: bytes.toString('base64'), byteLength: 3 })).rejects.toThrow();
  });
  it.each(['native', 'fallback'] as const)('bounds %s decoding and preserves all bytes across Base64 group boundaries', async decoder => {
    const source = randomBytes(400001);
    const fromBase64 = vi.fn((text: string) => new Uint8Array(Buffer.from(text, 'base64')));
    Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, value: decoder === 'native' ? fromBase64 : undefined });
    const fallback = vi.spyOn(globalThis, 'atob');
    const blob = vi.fn(() => {
      throw new Error('Unexpected full binary Blob copy');
    });
    vi.stubGlobal('Blob', blob);
    const base64 = gzipSync(source).toString('base64');
    const result = await decodeEmbeddedGzip({ base64, byteLength: source.byteLength });
    expect(Buffer.from(result).equals(source)).toBe(true);
    const calls = decoder === 'native' ? fromBase64.mock.calls : fallback.mock.calls;
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.map(([text]) => text).join('')).toBe(base64);
    for (const [text] of calls) {
      expect(text.length).toBeLessThanOrEqual(64 * 1024);
      expect(text.length % 4).toBe(0);
    }
    if (decoder === 'native') expect(fallback).not.toHaveBeenCalled();
    expect(blob).not.toHaveBeenCalled();
  });
  it('propagates cancellation upstream after an output size violation', async () => {
    const base64 = gzipSync(randomBytes(1000001)).toString('base64');
    Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, value: undefined });
    const fallback = vi.spyOn(globalThis, 'atob');
    // A controlled downstream isolates cancellation from browser-specific gzip buffering.
    vi.stubGlobal('DecompressionStream', class {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      constructor() {
        const stream = new TransformStream<Uint8Array, Uint8Array>({
          transform(_chunk, controller) {
            controller.enqueue(new Uint8Array(2));
          },
        });
        this.readable = stream.readable; this.writable = stream.writable;
      }
    });
    await expect(decodeEmbeddedGzip({ base64, byteLength: 1 })).rejects.toThrow('exceeds');
    expect(fallback.mock.calls.reduce((length, [text]) => length + text.length, 0)).toBeLessThan(base64.length);
  });

});
