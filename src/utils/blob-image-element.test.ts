// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blobImageInput, decodeNativeBlobImage } from './blob-image';
import { createNativeBlobContext } from './blob-view';
import { createImageElementPlatform } from './blob-image-element.test-helpers';

const limits = { maxBytes: 1024, maxPixels: 16 };
const image = () => new Blob(['encoded pixels'], { type: 'image/png' });
const platforms: ReturnType<typeof createImageElementPlatform>[] = [];
function fixture({ completion }: { completion: 'decode' | 'events' }) {
  const platform = createImageElementPlatform({ completion }); platforms.push(platform); return platform;
}
const decode = ({ blob, signal }: { blob: Blob, signal: AbortSignal | undefined }) =>
  decodeNativeBlobImage({ blob, limits, signal: signal ?? new AbortController().signal });

afterEach(() => {
  for (const platform of platforms.splice(0)) platform.dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe.each(['decode', 'events'] as const)('Blob image element via %s', completion => {
  it('draws intrinsic pixels from an owned Blob URL without byte conversion, DOM insertion or fetch', async () => {
    const env = fixture({ completion });
    const blob = image();
    const byteRead = vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new Error('Cannot consume Blob here'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    const result = await decode({ blob, signal: undefined });
    expect(result).toEqual({ width: 2, height: 1, rgba: new Uint8Array([10, 20, 30, 255, 90, 80, 70, 0]) });
    expect(result.rgba.buffer).toBe(env.elements[0]!.pixels.buffer);
    expect(env.createObjectURL).toHaveBeenCalledWith(blob);
    expect(env.drawImage).toHaveBeenCalledWith(env.elements[0], 0, 0);
    expect(env.getImageData).toHaveBeenCalledWith(0, 0, 2, 1);
    expect(env.appendChild).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(byteRead).not.toHaveBeenCalled();
    expect(env.elements[0]!.src).toBe('');
    expect(env.elements[0]!.removeAttribute).toHaveBeenCalledWith('src');
    expect(env.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(env.created[0]!.url);
    expect(env.live.size).toBe(0);
    expect(env.canvases[0]).toMatchObject({ width: 0, height: 0 });
    expect(env.decoded).toHaveBeenCalledTimes(completion === 'decode' ? 1 : 0);
  });

  it('reads exactly the sliced BlobView range even after the byte context is disposed', async () => {
    const env = fixture({ completion });
    const blobs = createNativeBlobContext();
    const view = blobs.fromNative({ blob: new Blob(['prefix-picture-suffix']) }).slice({ start: 7, end: 14, contentType: 'image/jpeg' });
    blobs.dispose();
    const native = blobImageInput({ blob: view, limits });
    await decode({ blob: native, signal: undefined });
    expect(await env.created[0]!.blob.text()).toBe('picture');
    expect(env.created[0]!.blob.type).toBe('image/jpeg');
    await expect(fetch(env.created[0]!.url)).rejects.toThrow();
  });

  it('rejects an undecodable image instead of accepting its nonzero size or load state', async () => {
    const env = fixture({ completion });
    const error = new DOMException('Broken format', 'EncodingError');
    switch (completion) {
    case 'decode': env.decoded.mockRejectedValue(error); break;
    case 'events': env.sourceAssigned.mockImplementation(({ element }) => {
      queueMicrotask(() => element.dispatchEvent(new Event('error')));
    }); break;
    default: { const _ex: never = completion; throw new Error(String(_ex)); }
    }
    await expect(decode({ blob: image(), signal: undefined })).rejects.toMatchObject({ name: 'EncodingError' });
    expect(env.drawImage).not.toHaveBeenCalled(); expect(env.canvases).toHaveLength(0);
    expect(env.elements[0]!.src).toBe(''); expect(env.live.size).toBe(0);
    expect(env.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('cancels before completion and ignores late success or a late error event', async () => {
    const env = fixture({ completion });
    const pending = Promise.withResolvers<void>();
    env.decoded.mockReturnValue(pending.promise);
    env.sourceAssigned.mockImplementation(() => {});
    const controller = new AbortController();
    const error = new DOMException('Cancelled', 'AbortError');
    const reading = decode({ blob: image(), signal: controller.signal });
    const rejected = expect(reading).rejects.toBe(error);
    await vi.waitFor(() => expect(env.elements).toHaveLength(1));
    controller.abort(error); await rejected;
    expect(env.drawImage).not.toHaveBeenCalled(); expect(env.canvases).toHaveLength(0);
    expect(env.elements[0]!.src).toBe(''); expect(env.live.size).toBe(0);
    pending.resolve(); env.elements[0]!.dispatchEvent(new Event('load')); env.elements[0]!.dispatchEvent(new Event('error'));
    await Promise.resolve();
    expect(env.drawImage).not.toHaveBeenCalled(); expect(env.revokeObjectURL).toHaveBeenCalledOnce();
    if (completion === 'events') {
      expect(env.elements[0]!.removeEventListener.mock.calls.map(([name]) => name)).toEqual(['load', 'error']);
    }
  });

  it('observes a late rejection after cancellation without retaining the URL', async () => {
    const env = fixture({ completion });
    const pending = Promise.withResolvers<void>();
    env.decoded.mockReturnValue(pending.promise);
    env.sourceAssigned.mockImplementation(() => {});
    const controller = new AbortController();
    const reading = decode({ blob: image(), signal: controller.signal });
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(env.elements).toHaveLength(1));
    controller.abort(); await rejected;
    if (completion === 'decode') pending.reject(new Error('Late browser failure'));
    else env.elements[0]!.dispatchEvent(new Event('error'));
    await Promise.resolve();
    expect(env.live.size).toBe(0); expect(env.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('does not draw when cancellation races a completed decode or load notification', async () => {
    const env = fixture({ completion });
    const controller = new AbortController();
    env.decoded.mockImplementation(async () => {
      controller.abort();
    });
    env.sourceAssigned.mockImplementation(({ element }) => {
      queueMicrotask(() => {
        element.dispatchEvent(new Event('load')); controller.abort();
      });
    });
    await expect(decode({ blob: image(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.drawImage).not.toHaveBeenCalled(); expect(env.revokeObjectURL).toHaveBeenCalledOnce();
  });
});

describe('local image decoder selection', () => {
  it('does not create a Blob URL or element when bitmap decoding succeeds', async () => {
    const env = fixture({ completion: 'decode' });
    const close = vi.fn();
    const bitmap = { width: 2, height: 1, pixels: new Uint8ClampedArray(8), close };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    await decode({ blob: image(), signal: undefined });
    expect(env.elements).toHaveLength(0); expect(env.createObjectURL).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(['NotReadableError', 'InvalidStateError', 'EncodingError', 'NotSupportedError'])('recovers bitmap %s using the same original Blob', async name => {
    const env = fixture({ completion: 'decode' });
    const createBitmap = vi.fn().mockRejectedValue(new DOMException('Bitmap unavailable', name));
    vi.stubGlobal('createImageBitmap', createBitmap);
    const blob = image();
    expect((await decode({ blob, signal: undefined })).rgba).toHaveLength(8);
    expect(createBitmap).toHaveBeenCalledExactlyOnceWith(blob);
    expect(env.createObjectURL).toHaveBeenCalledExactlyOnceWith(blob);
  });

  it('handles a synchronous decoder failure without leaking a Blob URL', async () => {
    const env = fixture({ completion: 'decode' });
    vi.stubGlobal('createImageBitmap', () => {
      throw new DOMException('Unsupported', 'NotSupportedError');
    });
    await decode({ blob: image(), signal: undefined });
    expect(env.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it.each(['SecurityError', 'NotAllowedError', 'AbortError', 'RangeError', 'TypeError', 'Error'])('does not use image URLs to bypass bitmap %s', async name => {
    const env = fixture({ completion: 'decode' });
    const error = new DOMException('Failure must propagate', name);
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(error));
    await expect(decode({ blob: image(), signal: undefined })).rejects.toBe(error);
    expect(env.createObjectURL).not.toHaveBeenCalled(); expect(env.createElement).not.toHaveBeenCalled();
  });

  it.each(['dimensions', 'readback', 'pixels'] as const)('does not re-decode an acquired bitmap after %s validation fails', async stage => {
    const env = fixture({ completion: 'decode' });
    const bitmap = { width: 2, height: 1, pixels: new Uint8ClampedArray(8), close: vi.fn() };
    switch (stage) {
    case 'dimensions': bitmap.width = 0; break;
    case 'readback': env.getImageData.mockImplementation(() => {
      throw new DOMException('Canvas tainted', 'SecurityError');
    }); break;
    case 'pixels': bitmap.pixels = new Uint8ClampedArray(1); break;
    default: { const _ex: never = stage; throw new Error(String(_ex)); }
    }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    await expect(decode({ blob: image(), signal: undefined })).rejects.toThrow();
    expect(env.createObjectURL).not.toHaveBeenCalled(); expect(env.elements).toHaveLength(0); expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it.each([undefined, {}])('reports unsupported decoding without a usable document: %j', async document => {
    const env = fixture({ completion: 'decode' }); vi.stubGlobal('document', document);
    await expect(decode({ blob: image(), signal: undefined })).rejects.toMatchObject({ name: 'NotSupportedError' });
    expect(env.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('image element limits and resource ownership', () => {
  it.each([
    { width: 0, height: 1 }, { width: 1, height: 0 }, { width: -1, height: 1 },
    { width: 1.5, height: 1 }, { width: 1, height: NaN }, { width: 2 ** 40, height: 2 ** 40 }, { width: 5, height: 4 },
  ])('rejects invalid intrinsic dimensions before canvas allocation: %j', async ({ width, height }) => {
    const env = fixture({ completion: 'decode' });
    env.sourceAssigned.mockImplementation(({ element }) => {
      element.naturalWidth = width; element.naturalHeight = height;
    });
    await expect(decode({ blob: image(), signal: undefined })).rejects.toBeInstanceOf(RangeError);
    expect(env.canvases).toHaveLength(0); expect(env.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it.each([new Blob([]), new Blob(['x'], { type: 'text/plain' }), new Blob(['x'.repeat(1025)], { type: 'image/png' })])('validates encoded input before creating a URL: $size', async blob => {
    const env = fixture({ completion: 'decode' });
    await expect(decode({ blob, signal: undefined })).rejects.toThrow();
    expect(env.createObjectURL).not.toHaveBeenCalled(); expect(env.elements).toHaveLength(0);
  });

  it('does not allocate a URL after an already-aborted request', async () => {
    const env = fixture({ completion: 'decode' });
    const controller = new AbortController(); controller.abort();
    await expect(decode({ blob: image(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.createObjectURL).not.toHaveBeenCalled();
  });

  it.each(['decode', 'src', 'createElement', 'createURL', 'readback'] as const)('cleans up after synchronous %s failure', async stage => {
    const env = fixture({ completion: 'decode' });
    const error = new Error('Operation failed');
    switch (stage) {
    case 'decode': env.decoded.mockImplementation(() => {
      throw error;
    }); break;
    case 'src': env.sourceAssigned.mockImplementation(() => {
      throw error;
    }); break;
    case 'createElement': env.createElement.mockImplementation(() => {
      throw error;
    }); break;
    case 'createURL': env.createObjectURL.mockImplementation(() => {
      throw error;
    }); break;
    case 'readback': env.getImageData.mockImplementation(() => {
      throw error;
    }); break;
    default: { const _ex: never = stage; throw new Error(String(_ex)); }
    }
    await expect(decode({ blob: image(), signal: undefined })).rejects.toBe(error);
    expect(env.revokeObjectURL).toHaveBeenCalledTimes(env.created.length);
    expect(env.live.size).toBe(0);
    for (const element of env.elements) expect(element.src).toBe('');
    for (const canvas of env.canvases) expect(canvas).toMatchObject({ width: 0, height: 0 });
  });

  it('registers load/error before assigning src and accepts a synchronous load event', async () => {
    const env = fixture({ completion: 'events' });
    env.sourceAssigned.mockImplementation(({ element }) => {
      element.dispatchEvent(new Event('load'));
    });
    await decode({ blob: image(), signal: undefined });
    expect(env.elements[0]!.addEventListener.mock.calls.map(([name]) => name)).toEqual(['load', 'error']);
    expect(env.elements[0]!.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it('still revokes its URL if removing the source attribute throws', async () => {
    const env = fixture({ completion: 'decode' });
    const error = new Error('Source cleanup failed');
    env.sourceAssigned.mockImplementation(({ element }) => {
      element.removeAttribute.mockImplementation(() => {
        throw error;
      });
    });
    await expect(decode({ blob: image(), signal: undefined })).rejects.toBe(error);
    expect(env.revokeObjectURL).toHaveBeenCalledOnce(); expect(env.live.size).toBe(0);
  });

  it('does not publish pixels when URL cleanup fails and still clears the source and canvas', async () => {
    const env = fixture({ completion: 'decode' });
    env.revokeObjectURL.mockImplementation(() => {
      throw new Error('Revoke failed');
    });
    await expect(decode({ blob: image(), signal: undefined })).rejects.toBeInstanceOf(AggregateError);
    expect(env.elements[0]!.src).toBe(''); expect(env.canvases[0]).toMatchObject({ width: 0, height: 0 });
  });
});
