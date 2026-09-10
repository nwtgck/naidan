import { crc32, inflateSync } from 'node:zlib';
import { z } from 'zod';

const maxEncodedBytes = 4096;
const maxCanvasPixels = 4_194_304;
const pngSignature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function readChunk({ bytes, offset, expectedType }: { bytes: Uint8Array, offset: number, expectedType: string }) {
  if (bytes.byteLength - offset < 12) throw new Error('Truncated PNG chunk');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(offset);
  if (length > bytes.byteLength - offset - 12) throw new Error('PNG chunk exceeds input bounds');
  const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  if (type !== expectedType) throw new Error(`Unsupported PNG chunk/order: ${type}`);
  const dataEnd = offset + 8 + length;
  if (crc32(bytes.subarray(offset + 4, dataEnd)) !== view.getUint32(dataEnd)) throw new Error('PNG CRC mismatch');
  return { data: bytes.subarray(offset + 8, dataEnd), nextOffset: dataEnd + 4 };
}

function decodeOpaquePixelPng({ bytes }: { bytes: Uint8Array }) {
  if (bytes.byteLength > maxEncodedBytes || !pngSignature.every((value, index) => bytes[index] === value)) {
    throw new Error('Unsupported PNG signature or size');
  }
  const header = readChunk({ bytes, offset: 8, expectedType: 'IHDR' });
  if (header.data.length !== 13) throw new Error('Invalid PNG IHDR length');
  const view = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
  if (view.getUint32(0) !== 1 || view.getUint32(4) !== 1 || header.data[8] !== 8 || header.data[9] !== 4
    || header.data[10] !== 0 || header.data[11] !== 0 || header.data[12] !== 0) {
    throw new Error('Only non-interlaced 1x1 8-bit grayscale-alpha PNG is supported');
  }
  const image = readChunk({ bytes, offset: header.nextOffset, expectedType: 'IDAT' });
  const end = readChunk({ bytes, offset: image.nextOffset, expectedType: 'IEND' });
  if (image.data.length === 0 || end.data.length !== 0 || end.nextOffset !== bytes.byteLength) {
    throw new Error('Invalid PNG image/end or trailing bytes');
  }
  // Validate the native zlib result shape as well as the consumed input. A valid
  // stream followed by ignored compressed junk is not an accepted fixture.
  const inflated = z.object({
    buffer: z.instanceof(Uint8Array),
    engine: z.object({ bytesWritten: z.number().int().nonnegative() }),
  }).parse(inflateSync(image.data, { maxOutputLength: 3, info: true }));
  if (inflated.engine.bytesWritten !== image.data.length || inflated.buffer.length !== 3) {
    throw new Error('PNG compressed input or scanline length mismatch');
  }
  const [filter, gray, alpha] = inflated.buffer;
  if (filter === undefined || filter > 4) throw new Error('Unsupported PNG scanline filter');
  // In a one-pixel first row, every PNG predictor is zero: no left/up pixel.
  if (gray === undefined || alpha !== 255) throw new Error('Only opaque PNG pixels are supported');
  return Uint8ClampedArray.of(gray, gray, gray, alpha);
}

function pixelCount({ width, height }: { width: number, height: number }) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width * height > maxCanvasPixels) throw new Error('Unsupported image dimensions');
  return width * height;
}

function solidPixel({ data, width, height }: { data: Uint8ClampedArray, width: number, height: number }) {
  if (!(data instanceof Uint8ClampedArray) || data.length !== pixelCount({ width, height }) * 4) {
    throw new Error('ImageData length/type mismatch');
  }
  if (data[3] !== 255) throw new Error('Only opaque solid images are supported');
  for (let offset = 4; offset < data.length; offset += 4) {
    for (let channel = 0; channel < 4; ++channel) {
      if (data[offset + channel] !== data[channel]) throw new Error('Only opaque solid images are supported');
    }
  }
  return data.slice(0, 4);
}

function replicatePixel({ pixel, width, height }: { pixel: Uint8ClampedArray, width: number, height: number }) {
  const result = new Uint8ClampedArray(pixelCount({ width, height }) * 4);
  for (let offset = 0; offset < result.length; offset += 4) result.set(pixel, offset);
  return result;
}

/**
 * Test-only native image boundary, not a general Canvas implementation. It
 * decodes bounded PNG bytes and supports opaque solid full-frame draws only.
 * Actual RawImage conversion/resize calls and Processor patchification remain
 * outside this helper. Unsupported image content or operations must fail.
 * Returns owned platform values; never installs globals or model expectations.
 */
export function createProductionReplayTestImagePlatform() {
  const decodes: Array<{ bytes: Uint8Array, rgba: Uint8ClampedArray }> = [];
  const draws: Array<{ sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number }> = [];

  /* eslint-disable local-rules-named-args/require-named-args -- These constructors/functions mirror the native ImageData, ImageBitmap and Canvas positional APIs consumed by RawImage. */
  class ReplayImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number, ...unsupported: unknown[]) {
      if (unsupported.length) throw new Error('Unsupported ImageData options');
      solidPixel({ data, width, height });
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }

  class ReplayImageBitmap {
    readonly width = 1;
    readonly height = 1;
    readonly #rgba: Uint8ClampedArray;
    #closed = false;
    constructor({ rgba }: { rgba: Uint8ClampedArray }) {
      this.#rgba = Uint8ClampedArray.from(rgba);
    }
    snapshot() {
      if (this.#closed) throw new Error('ImageBitmap is closed');
      return this.#rgba.slice();
    }
    close() {
      this.#closed = true;
    }
  }

  class ReplayOffscreenCanvas {
    readonly width: number;
    readonly height: number;
    #data: Uint8ClampedArray | undefined;
    constructor(width: number, height: number, ...unsupported: unknown[]) {
      if (unsupported.length) throw new Error('Unsupported Canvas constructor options');
      pixelCount({ width, height });
      this.width = width;
      this.height = height;
    }
    snapshot() {
      if (!this.#data) throw new Error('Canvas has no supported full-frame content');
      return this.#data.slice();
    }
    readonly #context = {
      drawImage: (source: unknown, dx: number, dy: number, ...size: number[]) => {
        if (!(source instanceof ReplayImageBitmap) && !(source instanceof ReplayOffscreenCanvas)) {
          throw new Error('Unsupported or foreign drawImage source');
        }
        if (dx !== 0 || dy !== 0 || (size.length !== 0 && size.length !== 2)) throw new Error('Only full-frame drawImage is supported');
        const width = size.length === 0 ? source.width : size[0];
        const height = size.length === 0 ? source.height : size[1];
        if (width !== this.width || height !== this.height) throw new Error('Only full-frame drawImage is supported');
        const pixel = solidPixel({ data: source.snapshot(), width: source.width, height: source.height });
        this.#data = replicatePixel({ pixel, width, height });
        draws.push({ sourceWidth: source.width, sourceHeight: source.height, targetWidth: width, targetHeight: height });
      },
      putImageData: (data: unknown, dx: number, dy: number, ...unsupported: unknown[]) => {
        if (!(data instanceof ReplayImageData)) throw new Error('Unsupported or foreign ImageData');
        if (dx !== 0 || dy !== 0 || unsupported.length || data.width !== this.width || data.height !== this.height) {
          throw new Error('Only full-frame putImageData is supported');
        }
        // Revalidate mutable ImageData at consumption and take an owned copy.
        solidPixel({ data: data.data, width: data.width, height: data.height });
        this.#data = data.data.slice();
      },
      getImageData: (sx: number, sy: number, width: number, height: number, ...unsupported: unknown[]) => {
        if (sx !== 0 || sy !== 0 || width !== this.width || height !== this.height || unsupported.length) {
          throw new Error('Only full-frame getImageData is supported');
        }
        return new ReplayImageData(this.snapshot(), width, height);
      },
    };
    getContext(contextId: string, ...unsupported: unknown[]) {
      if (contextId !== '2d' || unsupported.length) throw new Error('Only an unconfigured 2d context is supported');
      return this.#context;
    }
  }

  async function createImageBitmap(blob: Blob, ...unsupported: unknown[]) {
    if (!(blob instanceof Blob) || unsupported.length || blob.type !== 'image/png' || blob.size > maxEncodedBytes) {
      throw new Error('Only a bounded PNG Blob without bitmap options is supported');
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const rgba = decodeOpaquePixelPng({ bytes });
    decodes.push({ bytes: bytes.slice(), rgba: rgba.slice() });
    return new ReplayImageBitmap({ rgba });
  }
  /* eslint-enable local-rules-named-args/require-named-args */

  return { ImageData: ReplayImageData, OffscreenCanvas: ReplayOffscreenCanvas, createImageBitmap, observations: { decodes, draws } };
}

export const TEST_ONLY = {
  decodeOpaquePixelPng,
};
