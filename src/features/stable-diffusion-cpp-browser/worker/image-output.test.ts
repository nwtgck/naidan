import { afterEach, expect, it, vi } from 'vitest';
import { copyNativeImage, imagePixelStatistics, encodeImagePixels } from './image-output';
import type { Core } from './core-types';
afterEach(() => vi.unstubAllGlobals());
function nativeImage({ channels, data = 64n, width = 2, height = 1 }: { channels: number, data?: bigint, width?: number, height?: number }) {
  const heap = new Uint8Array(128), fields = { width, height, channel: channels, data };
  heap.set([10, 20, 30, 40, 50, 60, 70, 80], 64);
  const core = { module: { HEAPU8: heap }, getField: (_name: string, _pointer: bigint, field: string) => fields[field as keyof typeof fields], bytes: (pointer: bigint, length: number) => heap.subarray(Number(pointer), Number(pointer) + length) } as unknown as Core;
  return { core, heap };
}
it('copies borrowed RGB pixels before native buffers are freed and supplies opaque alpha', () => {
  const h = nativeImage({ channels: 3 }), out = copyNativeImage({ core: h.core, pointer: 1n });
  h.heap.fill(0);
  expect(Array.from(out.pixels)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
});
it('preserves RGBA alpha and rejects invalid shapes, channels and high native addresses', () => {
  const h = nativeImage({ channels: 4 });
  expect(Array.from(copyNativeImage({ core: h.core, pointer: 1n }).pixels)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  for (const values of [{ channels: 2 }, { channels: 3, width: 0 }, { channels: 4, height: 2049 }, { channels: 3, data: 1n << 40n }, { channels: 4, data: 127n }]) {
    expect(() => copyNativeImage({ core: nativeImage(values).core, pointer: 1n })).toThrow();
  }
});
it('records exact white, black and alpha statistics without inferring failure from legitimate image content', () => {
  const stats = imagePixelStatistics({ pixels: new Uint8ClampedArray(512 * 512 * 4).fill(255) });
  expect(stats).toMatchObject({ uniformOutput: true, whitePixels: 512 * 512, blackPixels: 0, rgbMin: 255, rgbMax: 255, alphaMin: 255 });
  expect(imagePixelStatistics({ pixels: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 0]) })).toMatchObject({ uniformOutput: false, whitePixels: 1, blackPixels: 1, alphaMin: 0 });
});
it.each([0, 256, 1024])('scales only the delivered preview surface (maxEdge=%i), never upscales the native decode', async maxEdge => {
  const sizes: number[][] = [], draw = vi.fn(), put = vi.fn();
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(width: number, height: number) {
      sizes.push([width, height]);
    }
    getContext() {
      return { putImageData: put, drawImage: draw };
    }
    async convertToBlob() {
      return new Blob(['image'], { type: 'image/png' });
    }
  });
  vi.stubGlobal('ImageData', class {
    constructor() {}
  });
  const output = await encodeImagePixels({ image: { pixels: new Uint8ClampedArray(512 * 256 * 4), width: 512, height: 256 }, maxEdge });
  expect(output.width).toBe(maxEdge === 256 ? 256 : 512); expect(output.height).toBe(maxEdge === 256 ? 128 : 256);
  expect(sizes[0]).toEqual([512, 256]); expect(put).toHaveBeenCalledTimes(1);
  expect(draw).toHaveBeenCalledTimes(maxEdge === 256 ? 1 : 0);
});
