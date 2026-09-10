// @vitest-environment node
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createProductionReplayTestImagePlatform, TEST_ONLY } from './production-replay-test-image-platform';

const originalPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const originalHeader = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0]);

function chunk({ type, data }: { type: string, data: Uint8Array }) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const content = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(content));
  return Buffer.concat([length, content, crc]);
}

function png({ header, compressed }: { header: Uint8Array, compressed: Uint8Array }) {
  return Buffer.concat([
    signature, chunk({ type: 'IHDR', data: header }),
    chunk({ type: 'IDAT', data: compressed }), chunk({ type: 'IEND', data: new Uint8Array() }),
  ]);
}

function pixelPng({ gray, alpha, filter }: { gray: number, alpha: number, filter: number }) {
  return png({ header: originalHeader, compressed: deflateSync(Uint8Array.of(filter, gray, alpha)) });
}

describe('bounded opaque one-pixel PNG decoding', () => {
  it('decodes the original bytes instead of trusting the misleading transparent fixture name', () => {
    expect(createHash('sha256').update(originalPng).digest('hex')).toBe('431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460');
    expect(TEST_ONLY.decodeOpaquePixelPng({ bytes: originalPng })).toEqual(Uint8ClampedArray.of(0, 0, 0, 255));
  });

  it.each([0, 1, 2, 3, 4])('decodes predictor %i using zero neighbors of the first single-pixel row', filter => {
    const bytes = pixelPng({ gray: 127, alpha: 255, filter });
    expect(TEST_ONLY.decodeOpaquePixelPng({ bytes })).toEqual(Uint8ClampedArray.of(127, 127, 127, 255));
  });

  it('rejects a corrupt chunk even if its decoded dimensions and pixels would be supported', () => {
    const bytes = Buffer.from(originalPng);
    bytes[29] = bytes[29]! ^ 1; // IHDR CRC only
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes })).toThrow('CRC');
  });

  it('rejects an invalid PNG signature', () => {
    const bytes = Buffer.from(originalPng);
    bytes[0] = 0;
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes })).toThrow('signature');
  });

  it('rejects truncated chunk framing and oversized declared payloads', () => {
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes: originalPng.subarray(0, 15) })).toThrow('Truncated');
    const bytes = Buffer.from(originalPng);
    bytes.writeUInt32BE(0xffff_ffff, 8);
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes })).toThrow('bounds');
  });

  it('rejects decoded pixels larger than the scanline bound before allocating arbitrary output', () => {
    const bytes = png({ header: originalHeader, compressed: deflateSync(new Uint8Array(100_000)) });
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes })).toThrow();
  });

  it('rejects a short decoded scanline', () => {
    const bytes = png({ header: originalHeader, compressed: deflateSync(Uint8Array.of(0, 0)) });
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes })).toThrow('scanline');
  });

  it('rejects trailing compressed bytes even with a valid enclosing IDAT CRC', () => {
    const compressed = Buffer.concat([deflateSync(Uint8Array.of(0, 0, 255)), Buffer.from([1, 2, 3])]);
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes: png({ header: originalHeader, compressed }) })).toThrow('compressed input');
  });

  it('rejects an invalid zlib stream despite a valid PNG CRC', () => {
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes: png({ header: originalHeader, compressed: Uint8Array.of(0, 0, 0) }) })).toThrow();
  });

  it('rejects nonopaque alpha instead of guessing Canvas compositing', () => {
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes: pixelPng({ gray: 0, alpha: 0, filter: 0 }) })).toThrow('opaque');
  });

  it('rejects unsupported predictor numbers', () => {
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes: pixelPng({ gray: 0, alpha: 255, filter: 5 }) })).toThrow('filter');
  });

  it('rejects wider images rather than applying the single-pixel predictor shortcut', () => {
    const header = Buffer.from(originalHeader);
    header.writeUInt32BE(2, 0);
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes: png({ header, compressed: deflateSync(Uint8Array.of(0, 0, 255)) }) })).toThrow('1x1');
  });

  it('rejects RGB color PNG instead of interpreting its channels as grayscale-alpha', () => {
    const header = Buffer.from(originalHeader);
    header[9] = 2;
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes: png({ header, compressed: deflateSync(Uint8Array.of(0, 0, 255)) }) })).toThrow('grayscale-alpha');
  });

  it('rejects unsupported bit depth', () => {
    const header = Buffer.from(originalHeader);
    header[8] = 16;
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes: png({ header, compressed: deflateSync(Uint8Array.of(0, 0, 255)) }) })).toThrow('8-bit');
  });

  it('rejects interlaced scanlines', () => {
    const header = Buffer.from(originalHeader);
    header[12] = 1;
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes: png({ header, compressed: deflateSync(Uint8Array.of(0, 0, 255)) }) })).toThrow('non-interlaced');
  });

  it('rejects unimplemented ancillary chunks rather than ignoring color management', () => {
    const bytes = Buffer.concat([originalPng.subarray(0, 33), chunk({ type: 'gAMA', data: Uint8Array.of(0, 0, 0, 1) }), originalPng.subarray(33)]);
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes })).toThrow('chunk/order');
  });

  it('rejects bytes after IEND', () => {
    expect(() => TEST_ONLY.decodeOpaquePixelPng({ bytes: Buffer.concat([originalPng, Buffer.from([0])]) })).toThrow('trailing bytes');
  });
});

describe('opaque solid full-frame image platform', () => {
  it('expands the decoded black pixel through the same native call sequence used by RawImage', async () => {
    const platform = createProductionReplayTestImagePlatform();
    const bitmap = await platform.createImageBitmap(new Blob([originalPng], { type: 'image/png' }));
    const decoded = new platform.OffscreenCanvas(1, 1);
    decoded.getContext('2d').drawImage(bitmap, 0, 0);
    expect(decoded.getContext('2d').getImageData(0, 0, 1, 1).data).toEqual(Uint8ClampedArray.of(0, 0, 0, 255));
    const expanded = new platform.OffscreenCanvas(768, 768);
    expanded.getContext('2d').drawImage(decoded, 0, 0, 768, 768);
    const result = expanded.getContext('2d').getImageData(0, 0, 768, 768);
    expect(result.data.length).toBe(768 * 768 * 4);
    expect(result.data.every((value, index) => value === (index % 4 === 3 ? 255 : 0))).toBe(true);
    expect(platform.observations.decodes).toHaveLength(1);
    expect(platform.observations.draws).toEqual([
      { sourceWidth: 1, sourceHeight: 1, targetWidth: 1, targetHeight: 1 },
      { sourceWidth: 1, sourceHeight: 1, targetWidth: 768, targetHeight: 768 },
    ]);
  });

  it('expands independently encoded white bytes to nonzero pixels, never a fixed black placeholder', async () => {
    const platform = createProductionReplayTestImagePlatform();
    const bytes = pixelPng({ gray: 255, alpha: 255, filter: 0 });
    const bitmap = await platform.createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new platform.OffscreenCanvas(768, 768);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, 768, 768);
    const actual = canvas.getContext('2d').getImageData(0, 0, 768, 768).data;
    expect(actual.length).toBe(768 * 768 * 4);
    expect(actual.every(value => value === 255)).toBe(true);
    expect(platform.observations.decodes[0]?.rgba).toEqual(Uint8ClampedArray.of(255, 255, 255, 255));
  });

  it('copies ImageData into the canvas and returns owned readback pixels', () => {
    const platform = createProductionReplayTestImagePlatform();
    const bytes = Uint8ClampedArray.of(100, 100, 100, 255);
    const image = new platform.ImageData(bytes, 1, 1);
    const canvas = new platform.OffscreenCanvas(1, 1);
    canvas.getContext('2d').putImageData(image, 0, 0);
    bytes[0] = 200;
    const first = canvas.getContext('2d').getImageData(0, 0, 1, 1);
    expect(first.data).toEqual(Uint8ClampedArray.of(100, 100, 100, 255));
    first.data[0] = 0;
    expect(canvas.getContext('2d').getImageData(0, 0, 1, 1).data).toEqual(Uint8ClampedArray.of(100, 100, 100, 255));
  });

  it('revalidates mutable ImageData before consuming it', () => {
    const platform = createProductionReplayTestImagePlatform();
    const bytes = Uint8ClampedArray.of(0, 0, 0, 255, 0, 0, 0, 255);
    const image = new platform.ImageData(bytes, 2, 1);
    bytes[4] = 255;
    const canvas = new platform.OffscreenCanvas(2, 1);
    expect(() => canvas.getContext('2d').putImageData(image, 0, 0)).toThrow('solid');
    expect(() => canvas.getContext('2d').getImageData(0, 0, 2, 1)).toThrow('no supported');
  });

  it('does not let observation mutation change decoded bitmap pixels', async () => {
    const platform = createProductionReplayTestImagePlatform();
    const bitmap = await platform.createImageBitmap(new Blob([originalPng], { type: 'image/png' }));
    platform.observations.decodes[0]!.rgba.fill(255);
    platform.observations.decodes[0]!.bytes.fill(0);
    const canvas = new platform.OffscreenCanvas(1, 1);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    expect(canvas.getContext('2d').getImageData(0, 0, 1, 1).data).toEqual(Uint8ClampedArray.of(0, 0, 0, 255));
  });

  it('rejects a closed bitmap and foreign platform objects', async () => {
    const platform = createProductionReplayTestImagePlatform();
    const other = createProductionReplayTestImagePlatform();
    const bitmap = await platform.createImageBitmap(new Blob([originalPng], { type: 'image/png' }));
    bitmap.close();
    const context = new platform.OffscreenCanvas(1, 1).getContext('2d');
    expect(() => context.drawImage(bitmap, 0, 0)).toThrow('closed');
    expect(() => context.drawImage(new other.OffscreenCanvas(1, 1), 0, 0)).toThrow('foreign');
    expect(() => context.putImageData(new other.ImageData(Uint8ClampedArray.of(0, 0, 0, 255), 1, 1), 0, 0)).toThrow('foreign');
  });

  it('rejects malformed ImageData and bounded canvas allocations', () => {
    const platform = createProductionReplayTestImagePlatform();
    expect(() => new platform.ImageData(Uint8ClampedArray.of(0), 1, 1)).toThrow('length');
    expect(() => new platform.ImageData(Uint8ClampedArray.of(0, 0, 0, 0), 1, 1)).toThrow('opaque');
    expect(() => new platform.OffscreenCanvas(0, 1)).toThrow('dimensions');
    expect(() => new platform.OffscreenCanvas(1.5, 1)).toThrow('dimensions');
    expect(() => new platform.OffscreenCanvas(1_000_000, 1_000_000)).toThrow('dimensions');
  });

  it('rejects cropping, offset, partial-frame, unknown source and non-2d operations', async () => {
    const platform = createProductionReplayTestImagePlatform();
    const bitmap = await platform.createImageBitmap(new Blob([originalPng], { type: 'image/png' }));
    const canvas = new platform.OffscreenCanvas(2, 2);
    const context = canvas.getContext('2d');
    expect(() => context.drawImage(bitmap, 1, 0, 2, 2)).toThrow('full-frame');
    expect(() => context.drawImage(bitmap, 0, 0)).toThrow('full-frame');
    expect(() => context.drawImage(bitmap, 0, 0, 1, 1, 0, 0, 2, 2)).toThrow('full-frame');
    expect(() => context.drawImage({ width: 2, height: 2 }, 0, 0)).toThrow('source');
    expect(() => context.getImageData(0, 0, 1, 1)).toThrow('full-frame');
    expect(() => canvas.getContext('webgl')).toThrow('2d');
    expect(() => canvas.getContext('2d', {})).toThrow('2d');
  });

  it('rejects bitmap options, wrong MIME and oversized inputs before reading their bodies', async () => {
    const platform = createProductionReplayTestImagePlatform();
    await expect(platform.createImageBitmap(new Blob([originalPng], { type: 'text/plain' }))).rejects.toThrow('PNG Blob');
    await expect(platform.createImageBitmap(new Blob([originalPng], { type: 'image/png' }), {})).rejects.toThrow('options');
    class OversizedBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error('Oversized body must not be read');
      }
    }
    await expect(platform.createImageBitmap(new OversizedBlob([new Uint8Array(4097)], { type: 'image/png' }))).rejects.toThrow('bounded');
    expect(platform.observations.decodes).toEqual([]);
  });

  it('does not install or change caller-owned globals', () => {
    const before = ['ImageData', 'OffscreenCanvas', 'createImageBitmap', 'self'].map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    createProductionReplayTestImagePlatform();
    expect(['ImageData', 'OffscreenCanvas', 'createImageBitmap', 'self'].map(key => Object.getOwnPropertyDescriptor(globalThis, key))).toEqual(before);
  });
});
