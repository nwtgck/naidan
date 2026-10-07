// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { convertDownloadImage, validateDownloadImage } from './download-format';
import { generationXmp, jpegWithXmp, webpWithXmp } from './download-xmp';
import { imageGenerationDownloadBlob } from './download';
import { snapshotImageGeneration } from './snapshot';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';

const pngBytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'));
const png = new Blob([pngBytes], { type: 'image/png' });
// These byte fixtures exercise container structure, not an image decoder.
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0x4a, 0x46, 0xff, 0xdb, 0, 4, 7, 8, 0xff, 0xda, 0, 2, 5, 0xff, 0, 6, 0xff, 0xd9]);
function webpFixture({ chunks }: { chunks: { name: string, payload: number[] }[] }): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(12 + chunks.reduce((total, chunk) => total + 8 + chunk.payload.length + chunk.payload.length % 2, 0));
  bytes.set(new TextEncoder().encode('RIFF')); bytes.set(new TextEncoder().encode('WEBP'), 8);
  const view = new DataView(bytes.buffer); view.setUint32(4, bytes.length - 8, true);
  let offset = 12;
  for (const chunk of chunks) {
    bytes.set(new TextEncoder().encode(chunk.name), offset); view.setUint32(offset + 4, chunk.payload.length, true);
    bytes.set(chunk.payload, offset + 8); offset += 8 + chunk.payload.length + chunk.payload.length % 2;
  }
  return bytes;
}
const vp8 = [0, 0, 0, 0x9d, 1, 0x2a, 16, 0, 12, 0];
const webp = webpFixture({ chunks: [{ name: 'VP8 ', payload: vp8 }] });
function parseWebp({ bytes }: { bytes: Uint8Array<ArrayBuffer> }) {
  const chunks: { name: string, payload: Uint8Array<ArrayBuffer> }[] = [];
  const view = new DataView(bytes.buffer);
  expect(view.getUint32(4, true)).toBe(bytes.length - 8);
  for (let position = 12; position < bytes.length;) {
    const length = view.getUint32(position + 4, true);
    chunks.push({ name: new TextDecoder().decode(bytes.slice(position, position + 4)), payload: bytes.slice(position + 8, position + 8 + length) });
    if (length % 2) expect(bytes[position + 8 + length]).toBe(0);
    position += 8 + length + length % 2;
  }
  return chunks;
}
function decodePacket({ packet }: { packet: Uint8Array }): unknown {
  const dom = new JSDOM();
  try {
    const xml = new dom.window.DOMParser().parseFromString(new TextDecoder().decode(packet), 'application/xml');
    expect(xml.querySelector('parsererror')).toBeNull();
    const json = xml.getElementsByTagNameNS('https://naidan.app/ns/image-generation/1.0/', 'Generation')[0]?.textContent;
    if (!json) throw new Error('Missing XMP settings');
    return JSON.parse(json);
  } finally {
    dom.window.close();
  }
}
function request() {
  return snapshotImageGeneration({
    request: requestFixture(),
    sourceCommit: 'a'.repeat(40),
    createdAt: 1,
    locateFile: ({ file }) => ({ type: 'file', name: file.name, size: file.size, lastModified: file.lastModified }),
  }).request;
}
function encoder({ output }: { output: Blob | null }) {
  const bitmap = { width: 16, height: 12, close: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage: vi.fn() })),
    toBlob: vi.fn((callback: BlobCallback) => callback(output)),
  };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  return { bitmap, canvas };
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('download image conversion', () => {
  it('keeps the original PNG for an unmodified PNG download', async () => {
    const original = await imageGenerationDownloadBlob({ png, request: request(), image: { kind: 'final', width: 1, height: 1 }, format: 'png', includeMetadata: false });
    expect(original).toBe(png);
  });
  it.each(['webp', 'jpeg'] as const)('uses the requested %s encoder and releases its bitmap and canvas', async format => {
    const output = new Blob([format === 'webp' ? webp : jpeg], { type: `image/${format}` });
    const { bitmap, canvas } = encoder({ output });
    expect(await convertDownloadImage({ png, format })).toBe(output);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), `image/${format}`, 1);
    expect(bitmap.close).toHaveBeenCalledOnce(); expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(pngBytes);
  });
  it('rejects a browser PNG fallback and releases resources', async () => {
    const { bitmap, canvas } = encoder({ output: png });
    await expect(convertDownloadImage({ png, format: 'webp' })).rejects.toThrow('did not produce a valid WEBP');
    expect(bitmap.close).toHaveBeenCalledOnce(); expect(canvas.width).toBe(0);
  });
  it('rejects encoding failure and a MIME/signature disagreement', async () => {
    const { bitmap } = encoder({ output: null });
    await expect(convertDownloadImage({ png, format: 'jpeg' })).rejects.toThrow('could not encode');
    expect(bitmap.close).toHaveBeenCalledOnce();
    await expect(validateDownloadImage({ blob: new Blob([pngBytes], { type: 'image/jpeg' }), format: 'jpeg' })).rejects.toThrow('valid JPEG');
  });
});

describe('structured image download metadata', () => {
  const image = { kind: 'preview' as const, width: 16, height: 12, step: 3, steps: 8, mode: 'vae' as const };
  it('round-trips Unicode, XML markup and JSON control characters through valid XMP', () => {
    const value = { prompt: '猫 & <tree> "😀"\n\u0000\ufffe\uffff\ud800', request: request(), image };
    expect(decodePacket({ packet: generationXmp({ json: JSON.stringify(value) }) })).toEqual(value);
  });
  it('inserts JPEG APP1 after JFIF while preserving all original image/scan bytes', async () => {
    const data = { request: request(), image };
    const packet = generationXmp({ json: JSON.stringify(data) });
    const output = new Uint8Array(await jpegWithXmp({ bytes: jpeg, packet }).arrayBuffer());
    expect(output.slice(0, 8)).toEqual(jpeg.slice(0, 8)); expect(output.slice(8, 10)).toEqual(new Uint8Array([255, 225]));
    const size = new DataView(output.buffer).getUint16(10);
    expect(new TextDecoder().decode(output.slice(12, 41))).toBe('http://ns.adobe.com/xap/1.0/\0');
    expect(decodePacket({ packet: output.slice(41, 10 + size) })).toEqual(data);
    expect(output.slice(10 + size)).toEqual(jpeg.slice(8));
    expect(size).toBe(packet.length + 31);
  });
  it('accepts the standard JPEG packet bound and rejects larger settings without truncation', async () => {
    const accepted = await jpegWithXmp({ bytes: jpeg, packet: new Uint8Array(65_502) }).arrayBuffer();
    expect(new DataView(accepted).getUint16(10)).toBe(65_533);
    expect(() => jpegWithXmp({ bytes: jpeg, packet: new Uint8Array(65_503) })).toThrow('Choose PNG or WebP');
    expect(() => jpegWithXmp({ bytes: jpeg.slice(0, -1), packet: new Uint8Array() })).toThrow('Incomplete JPEG');
  });
  it('adds WebP VP8X dimensions and an odd-sized padded XMP chunk without changing the lossy bitstream', async () => {
    const packet = new Uint8Array([65, 66, 67]);
    const output = new Uint8Array(await webpWithXmp({ bytes: webp, packet }).arrayBuffer());
    const chunks = parseWebp({ bytes: output });
    expect(chunks.map(chunk => chunk.name)).toEqual(['VP8X', 'VP8 ', 'XMP ']);
    expect(chunks[0]?.payload).toEqual(new Uint8Array([4, 0, 0, 0, 15, 0, 0, 11, 0, 0]));
    expect(chunks[1]?.payload).toEqual(new Uint8Array(vp8)); expect(chunks[2]?.payload).toEqual(packet);
  });
  it('keeps lossless WebP alpha and exact dimensions in the new extended header', async () => {
    const bits = new Uint8Array(5); bits[0] = 0x2f;
    new DataView(bits.buffer).setUint32(1, 31 | 63 << 14 | 1 << 28, true);
    const source = webpFixture({ chunks: [{ name: 'VP8L', payload: [...bits] }] });
    const output = new Uint8Array(await webpWithXmp({ bytes: source, packet: new Uint8Array() }).arrayBuffer());
    const chunks = parseWebp({ bytes: output });
    expect(chunks[0]?.payload).toEqual(new Uint8Array([0x14, 0, 0, 0, 31, 0, 0, 63, 0, 0]));
    expect(chunks[1]?.payload).toEqual(bits);
  });
  it('preserves existing WebP alpha/ICCP/Exif chunks and flags with large international settings', async () => {
    const source = webpFixture({
      chunks: [
        { name: 'VP8X', payload: [0x38, 0, 0, 0, 15, 0, 0, 11, 0, 0] },
        { name: 'ICCP', payload: [1, 2, 3] }, { name: 'ALPH', payload: [0, 1, 2, 3] },
        { name: 'VP8 ', payload: vp8 }, { name: 'EXIF', payload: [4, 5] },
      ],
    });
    const data = { prompt: '癒し😀'.repeat(20_000), image };
    const output = new Uint8Array(await webpWithXmp({ bytes: source, packet: generationXmp({ json: JSON.stringify(data) }) }).arrayBuffer());
    const chunks = parseWebp({ bytes: output });
    expect(chunks[0]?.payload[0]).toBe(0x3c);
    expect(chunks.slice(1, -1)).toEqual(parseWebp({ bytes: source }).slice(1));
    expect(decodePacket({ packet: chunks.at(-1)!.payload })).toEqual(data);
  });
  it('rejects truncated WebP chunks and bad RIFF sizes without rewriting them', () => {
    const truncated = webp.slice(0, -1);
    expect(() => webpWithXmp({ bytes: truncated, packet: new Uint8Array() })).toThrow('Invalid WebP container');
    const invalid = webp.slice(); new DataView(invalid.buffer).setUint32(16, 0xffffffff, true);
    expect(() => webpWithXmp({ bytes: invalid, packet: new Uint8Array() })).toThrow('Invalid WebP chunk padding');
  });
  it.each(['webp', 'jpeg'] as const)('converts before embedding the full fixed request in %s', async format => {
    encoder({ output: new Blob([format === 'webp' ? webp : jpeg], { type: `image/${format}` }) });
    const snapshot = request(); snapshot.parameters.prompt = '猫と湖 <夜> & 朝';
    const blob = await imageGenerationDownloadBlob({ png, request: snapshot, image, format, includeMetadata: true });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const packet = format === 'webp' ? parseWebp({ bytes }).at(-1)!.payload : bytes.slice(41, 10 + new DataView(bytes.buffer).getUint16(10));
    expect(decodePacket({ packet })).toEqual({ request: snapshot, image });
    expect(blob.type).toBe(`image/${format}`); expect(new Uint8Array(await png.arrayBuffer())).toEqual(pngBytes);
  });
});
