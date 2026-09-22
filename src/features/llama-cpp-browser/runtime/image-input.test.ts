import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeImage, imageFromDataUrl } from './image-input';
afterEach(() => vi.unstubAllGlobals());
describe('local image input', () => {
  it('decodes local bytes without fetching a remote resource', async () => {
    const blob = imageFromDataUrl({ url: 'data:image/png;base64,AQID' });
    expect(blob.type).toBe('image/png'); expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3]);
    for (const url of ['https://example.invalid/private', 'data:text/plain;base64,AQID', 'data:image/png;base64,!']) expect(() => imageFromDataUrl({ url })).toThrow('unsupported-input');
  });
  it('converts RGBA to RGB and releases the browser bitmap', async () => {
    const close = vi.fn(); vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2, height: 1, close })));
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() {
        return { drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 0]) }) };
      }
    });
    expect(await decodeImage({ blob: new Blob(['image'], { type: 'image/webp' }) })).toEqual({ width: 2, height: 1, rgb: new Uint8Array([10, 20, 30, 255, 255, 255]) });
    expect(close).toHaveBeenCalledOnce();
  });
  it('closes the bitmap when pixel extraction fails', async () => {
    const close = vi.fn(); vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close })));
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() {
        return undefined;
      }
    });
    await expect(decodeImage({ blob: new Blob(['image'], { type: 'image/png' }) })).rejects.toThrow('unsupported-input');
    expect(close).toHaveBeenCalledOnce();
  });
  it('keeps the existing alpha composition when pixels come from a decoder dependency', async () => {
    const dispose = vi.fn();
    const decoder = { decode: vi.fn(async () => ({ width: 3, height: 1, rgba: new Uint8Array([10, 20, 30, 255, 200, 100, 0, 128, 90, 80, 70, 0]) })), dispose };
    const signal = new AbortController().signal;
    const blob = new Blob(['image'], { type: 'image/png' });
    expect(await decodeImage({ blob, decoder, signal })).toEqual({ width: 3, height: 1, rgb: new Uint8Array([10, 20, 30, 227, 177, 127, 255, 255, 255]) });
    expect(decoder.decode).toHaveBeenCalledWith({ blob, signal });
    expect(dispose).not.toHaveBeenCalled();
  });

  it('rejects invalid image input before asking a supplied decoder', async () => {
    const decoder = { decode: vi.fn(), dispose: vi.fn() };
    await expect(decodeImage({ blob: new Blob(['text'], { type: 'text/plain' }), decoder })).rejects.toThrow('unsupported-input');
    expect(decoder.decode).not.toHaveBeenCalled();
  });

  it('validates pixels from an injected decoder instead of reading beyond its buffer', async () => {
    const decoder = { decode: vi.fn(async () => ({ width: 2, height: 1, rgba: new Uint8Array(4) })), dispose: vi.fn() };
    await expect(decodeImage({ blob: new Blob(['image'], { type: 'image/png' }), decoder })).rejects.toThrow('unsupported-input');
    expect(decoder.dispose).not.toHaveBeenCalled();
  });

  it('preserves cancellation rather than misreporting unsupported image input', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Cancelled', 'AbortError');
    const decoder = { decode: vi.fn(async () => {
      controller.abort(reason); return { width: 1, height: 1, rgba: new Uint8Array(4) };
    }), dispose: vi.fn() };
    await expect(decodeImage({ blob: new Blob(['image'], { type: 'image/png' }), decoder, signal: controller.signal })).rejects.toBe(reason);
  });

});
