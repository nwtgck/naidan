import type { Core } from './core-types';

export type ImagePixels = { pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number };

/** Borrowed native buffers are copied synchronously, before any await/free. */
export function copyNativeImage({ core, pointer }: { core: Core, pointer: bigint }): ImagePixels {
  const width = Number(core.getField('sd_image_t', pointer, 'width'));
  const height = Number(core.getField('sd_image_t', pointer, 'height'));
  const channels = Number(core.getField('sd_image_t', pointer, 'channel'));
  const data = BigInt(core.getField('sd_image_t', pointer, 'data'));
  if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 2048) || ![3, 4].includes(channels) || !data) throw new Error('Invalid generated image dimensions/channels');
  const bytes = width * height * channels;
  if (data < 0n || data + BigInt(bytes) > BigInt(core.module.HEAPU8.byteLength)) throw new Error('Image data is outside Wasm memory');
  const source = core.bytes(data, bytes), pixels = new Uint8ClampedArray(width * height * 4);
  for (let from = 0, to = 0; from < bytes; from += channels, to += 4) {
    pixels[to] = source[from]!; pixels[to + 1] = source[from + 1]!; pixels[to + 2] = source[from + 2]!;
    pixels[to + 3] = channels === 4 ? source[from + 3]! : 255;
  }
  return { pixels, width, height };
}

/** Statistics only: white/black may be intentional. Never retry from colour. */
export function imagePixelStatistics({ pixels }: Pick<ImagePixels, 'pixels'>) {
  let min = 255, max = 0, alphaMin = 255, alphaMax = 0, white = 0, black = 0, identical = true;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!, a = pixels[i + 3]!;
    min = Math.min(min, r, g, b); max = Math.max(max, r, g, b);
    alphaMin = Math.min(alphaMin, a); alphaMax = Math.max(alphaMax, a);
    if (r === 255 && g === 255 && b === 255) white++;
    if (r === 0 && g === 0 && b === 0) black++;
    if (r !== pixels[0] || g !== pixels[1] || b !== pixels[2] || a !== pixels[3]) identical = false;
  }
  return { rgbMin: min, rgbMax: max, alphaMin, alphaMax, whitePixels: white, blackPixels: black, uniformOutput: identical };
}

export async function encodeImagePixels({ image, maxEdge }: { image: ImagePixels, maxEdge: number }): Promise<{ png: Blob, width: number, height: number }> {
  const { pixels, width, height } = image;
  const ratio = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(width, height)) : 1;
  const targetWidth = Math.max(1, Math.round(width * ratio)), targetHeight = Math.max(1, Math.round(height * ratio));
  const source = new OffscreenCanvas(width, height), sourceContext = source.getContext('2d');
  if (!sourceContext) throw new Error('Cannot encode image pixels');
  sourceContext.putImageData(new ImageData(pixels, width, height), 0, 0);
  const target = ratio === 1 ? source : new OffscreenCanvas(targetWidth, targetHeight);
  if (target !== source) {
    const context = target.getContext('2d');
    if (!context) throw new Error('Cannot resize image pixels');
    context.drawImage(source, 0, 0, targetWidth, targetHeight);
  }
  return { png: await target.convertToBlob({ type: 'image/png' }), width: targetWidth, height: targetHeight };
}
export const TEST_ONLY = {
};
