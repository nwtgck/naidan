// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeBlobContext } from './blob-view';
import { decodeNativeBlobImage, blobImageInput, parseBlobImagePixels } from './blob-image';

const limits = { maxBytes: 1024, maxPixels: 16 };
function fixture({ width, height }: { width: number, height: number }) {
  const close = vi.fn();
  const bitmap = { width, height, close };
  const createBitmap = vi.fn(async () => bitmap);
  const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]);
  const context = { drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: pixels })) };
  const canvases: Array<{ width: number, height: number }> = [];
  const getContext = vi.fn(() => context);
  vi.stubGlobal('createImageBitmap', createBitmap);
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) {
      canvases.push(this);
    }
    getContext() {
      return getContext();
    }
  });
  return { close, bitmap, createBitmap, context, getContext, canvases, pixels };
}
const image = () => new Blob(['encoded'], { type: 'image/png' });
const read = ({ blob }: { blob: Blob }) => decodeNativeBlobImage({ blob, limits, signal: new AbortController().signal });
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('native Blob image operation', () => {
  it('preserves dimensions and RGBA without reading encoded bytes or resizing the image', async () => {
    const env = fixture({ width: 2, height: 1 });
    const blob = image();
    const byteRead = vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new Error('Cannot consume Blob bytes here'));
    const result = await read({ blob });
    expect(result).toEqual({ width: 2, height: 1, rgba: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]) });
    expect(result.rgba.buffer).toBe(env.pixels.buffer);
    expect(env.createBitmap).toHaveBeenCalledWith(blob);
    expect(env.context.drawImage).toHaveBeenCalledWith(env.bitmap, 0, 0);
    expect(env.context.getImageData).toHaveBeenCalledWith(0, 0, 2, 1);
    expect(byteRead).not.toHaveBeenCalled();
    expect(env.canvases).toEqual([{ width: 0, height: 0 }]);
    expect(env.close).toHaveBeenCalledOnce();
  });

  it('accepts an original BlobView only at the adapter boundary and preserves its sliced range', async () => {
    const blobs = createNativeBlobContext();
    try {
      const view = blobs.fromNative({ blob: new Blob(['012345'], { type: 'image/png' }) });
      const slice = view.slice({ start: 1, end: 4, contentType: 'image/webp' });
      const native = blobImageInput({ blob: slice, limits });
      expect(native.type).toBe('image/webp');
      expect(await native.text()).toBe('123');
      expect(() => blobImageInput({ blob: { ...slice }, limits })).toThrow(TypeError);
    } finally {
      blobs.dispose();
    }
  });

  it.each([
    { blob: new Blob([]), limits },
    { blob: new Blob(['text'], { type: 'text/plain' }), limits },
    { blob: image(), limits: { ...limits, maxBytes: 1 } },
    { blob: image(), limits: { ...limits, maxPixels: NaN } },
    { blob: image(), limits: { ...limits, maxPixels: Number.MAX_SAFE_INTEGER } },
    { blob: image(), limits: { ...limits, maxBytes: 1.5 } },
  ])('rejects invalid input or limits without starting a bitmap ($blob.type)', async request => {
    const env = fixture({ width: 2, height: 1 });
    await expect(decodeNativeBlobImage({ ...request, signal: new AbortController().signal })).rejects.toThrow();
    expect(env.createBitmap).not.toHaveBeenCalled();
    expect(env.close).not.toHaveBeenCalled();
  });

  it.each([
    { width: 0, height: 1 }, { width: 1, height: -1 }, { width: 1.5, height: 1 },
    { width: 5, height: 4 }, { width: Infinity, height: 1 }, { width: 2 ** 40, height: 2 ** 40 },
  ])('rejects invalid/oversized decoded dimensions before allocating canvas: %j', async size => {
    const env = fixture(size);
    await expect(read({ blob: image() })).rejects.toBeInstanceOf(RangeError);
    expect(env.canvases).toHaveLength(0);
    expect(env.close).toHaveBeenCalledOnce();
  });

  it.each(['getContext', 'drawImage', 'getImageData', 'badPixels'] as const)('releases bitmap and canvas after %s failure', async stage => {
    const env = fixture({ width: 2, height: 1 });
    switch (stage) {
    case 'getContext': env.getContext.mockImplementation(() => {
      throw new Error('2D failed');
    }); break;
    case 'drawImage': env.context.drawImage.mockImplementation(() => {
      throw new Error('draw failed');
    }); break;
    case 'getImageData': env.context.getImageData.mockImplementation(() => {
      throw new Error('pixels failed');
    }); break;
    case 'badPixels': env.context.getImageData.mockReturnValue({ data: new Uint8ClampedArray(4) }); break;
    default: { const _ex: never = stage; throw new Error(String(_ex)); }
    }
    await expect(read({ blob: image() })).rejects.toThrow();
    expect(env.canvases).toEqual([{ width: 0, height: 0 }]);
    expect(env.close).toHaveBeenCalledOnce();
  });

  it('uses a host DOM canvas only when no OffscreenCanvas 2D is available', async () => {
    const env = fixture({ width: 2, height: 1 });
    vi.stubGlobal('OffscreenCanvas', undefined);
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => env.context) };
    const createElement = vi.fn(() => canvas);
    vi.stubGlobal('document', { createElement });
    expect((await read({ blob: image() })).rgba).toHaveLength(8);
    expect(createElement).toHaveBeenCalledWith('canvas');
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
    expect(env.close).toHaveBeenCalledOnce();
  });

  it('disposes an unusable OffscreenCanvas before falling back to a host DOM canvas', async () => {
    const env = fixture({ width: 2, height: 1 });
    const offscreen: Array<{ width: number, height: number }> = [];
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {
        offscreen.push(this);
      }
      getContext() {
        return null;
      }
    });
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => env.context) };
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    expect((await read({ blob: image() })).rgba).toHaveLength(8);
    expect(offscreen).toEqual([{ width: 0, height: 0 }]);
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
    expect(env.close).toHaveBeenCalledOnce();
  });

  it('reports unsupported APIs without pretending pixel decoding is a Blob byte read', async () => {
    const env = fixture({ width: 2, height: 1 });
    vi.stubGlobal('createImageBitmap', undefined);
    await expect(read({ blob: image() })).rejects.toMatchObject({ name: 'NotSupportedError' });
    expect(env.canvases).toHaveLength(0);
  });

  it.each(['resolve', 'reject'] as const)('stops waiting on abort and owns the later bitmap %s', async outcome => {
    const env = fixture({ width: 2, height: 1 });
    const pending = Promise.withResolvers<typeof env.bitmap>();
    env.createBitmap.mockReturnValue(pending.promise);
    const signal = new AbortController();
    const reason = new DOMException('Cancelled', 'AbortError');
    const reading = decodeNativeBlobImage({ blob: image(), limits, signal: signal.signal });
    const rejected = expect(reading).rejects.toBe(reason);
    signal.abort(reason); await rejected;
    expect(env.close).not.toHaveBeenCalled();
    if (outcome === 'resolve') pending.resolve(env.bitmap);
    else pending.reject(new Error('Late decode failed'));
    await Promise.resolve(); await Promise.resolve();
    expect(env.close).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 0);
    expect(env.canvases).toHaveLength(0);
  });

  it('closes a bitmap that resolves immediately before the abort without decoding it twice', async () => {
    const env = fixture({ width: 2, height: 1 });
    const signal = new AbortController();
    env.createBitmap.mockImplementation(async () => {
      queueMicrotask(() => signal.abort(new DOMException('Cancelled', 'AbortError')));
      return env.bitmap;
    });
    await expect(decodeNativeBlobImage({ blob: image(), limits, signal: signal.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.close).toHaveBeenCalledOnce();
    expect(env.canvases).toHaveLength(0);
  });
});

describe('decoded image boundary', () => {
  it.each([NaN, 0, Number.MAX_SAFE_INTEGER])('rejects invalid pixel limits %s even at the response boundary', maxPixels => {
    expect(() => parseBlobImagePixels({ value: { width: 1, height: 1, rgba: new Uint8Array(4) }, limits: { ...limits, maxPixels } })).toThrow();
  });

  it.each([
    { width: 2, height: 1, rgba: new Uint8Array(4) },
    { width: 1, height: 1, rgba: new Uint8Array(8) },
    { width: 1, height: 1, rgba: new Uint8Array(new ArrayBuffer(8), 4, 4) },
    { width: 1, height: 1, rgba: new Uint8Array(new SharedArrayBuffer(4)) },
    { width: 1, height: 1, rgba: new Uint8ClampedArray(4) },
    { width: 1, height: 1, rgba: new Uint8Array(4), privateField: 'not on the wire' },
    { width: 0, height: 1, rgba: new Uint8Array(0) },
  ])('rejects invalid shape, backing or length: %j', value => {
    expect(() => parseBlobImagePixels({ value, limits })).toThrow();
  });
});
