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
});
