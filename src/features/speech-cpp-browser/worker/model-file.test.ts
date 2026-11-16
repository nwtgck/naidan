// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createSpeechFileSource, inspectSpeechCandidate } from './model-file';
import { speechFileBytes, speechFileSourceFixture, speechModelFile } from './model-file.test-support';

it('uses GGUF architecture/task/audio metadata independently of the filename', async () => {
  const file = await speechModelFile({ architecture: 'haru', name: 'not-a-model-name.bin', frameSamples: 3200 });
  const candidate = await inspectSpeechCandidate({ file, name: file.name, signal: undefined });
  expect(candidate.kind).toBe('speech');
  const other = await speechModelFile({ architecture: 'llama', name: 'Haru-4B.gguf', frameSamples: 3200 });
  expect(await inspectSpeechCandidate({ file: other, name: other.name, signal: undefined })).toEqual({ kind: 'other' });
  const invalid = await speechModelFile({ architecture: 'haru', name: 'Haru.gguf', frameSamples: 6400 });
  await expect(inspectSpeechCandidate({ file: invalid, name: invalid.name, signal: undefined })).rejects.toThrow();
});

it('bounds synchronous reads and preserves offsets above 4 GiB', () => {
  const file = new Blob([new Uint8Array(24)]);
  Object.defineProperty(file, 'size', { value: 2 ** 32 + 100 });
  const slices: [number | undefined, number | undefined][] = [];
  const onRead = vi.fn();
  vi.spyOn(file, 'slice').mockImplementation((start, end) => {
    slices.push([start, end]);
    return new Blob([new Uint8Array(end! - start!)]);
  });
  const source = createSpeechFileSource({ file, maxReadBytes: 24, readBlob: ({ blob }) => new ArrayBuffer(blob.size), onRead });
  expect(source.read({ destination: new Uint8Array(100), offset: 2 ** 32 + 1 })).toBe(24);
  expect(slices).toEqual([[2 ** 32 + 1, 2 ** 32 + 25]]);
  expect(onRead).toHaveBeenCalledWith({ offset: 2 ** 32 + 1, length: 24 });
  expect(source.read({ destination: new Uint8Array(100), offset: file.size })).toBe(0);
  expect(() => source.read({ destination: new Uint8Array(2), offset: -1 })).toThrow();
  const truncated = createSpeechFileSource({ file, maxReadBytes: 24, readBlob: () => new ArrayBuffer(1), onRead });
  expect(() => truncated.read({ destination: new Uint8Array(24), offset: 0 })).toThrow();
  expect(onRead).toHaveBeenCalledOnce();
});

it('coalesces small reads and rereads while reporting only the requested ranges', () => {
  const window = 1024 * 1024;
  const { source, readBlob, slices, onRead } = speechFileSourceFixture({ size: 3 * window + 13, maxReadBytes: 4 * window });
  const ranges = [{ offset: 7, length: 8 }, { offset: 15, length: 12 }, { offset: 7, length: 8 }, { offset: 7 + window - 16, length: 16 }, { offset: 7 + window - 8, length: 16 }, { offset: 0, length: 8 }];
  for (const range of ranges) {
    const destination = new Uint8Array(range.length);
    expect(source.read({ destination, offset: range.offset })).toBe(range.length);
    expect(destination).toEqual(speechFileBytes(range));
  }
  expect(readBlob).toHaveBeenCalledTimes(3);
  expect(slices.mock.calls).toEqual([[7, 7 + window], [window - 1, 2 * window - 1], [0, window]]);
  expect(onRead.mock.calls).toEqual(ranges.map(range => [range]));
});

it('bypasses the cache for weight reads, preserves the 4 MiB limit and retains the small-read window', () => {
  const window = 1024 * 1024;
  const { source, readBlob, slices } = speechFileSourceFixture({ size: 6 * window, maxReadBytes: 4 * window });
  source.read({ destination: new Uint8Array(8), offset: 13 });
  const destination = new Uint8Array(5 * window).fill(0xa5);
  expect(source.read({ destination, offset: window + 100 })).toBe(4 * window);
  expect(destination.subarray(0, 4 * window)).toEqual(speechFileBytes({ offset: window + 100, length: 4 * window }));
  expect(destination.subarray(4 * window).every(byte => byte === 0xa5)).toBe(true);
  const repeated = new Uint8Array(8);
  source.read({ destination: repeated, offset: 13 });
  expect(repeated).toEqual(speechFileBytes({ offset: 13, length: 8 }));
  expect(readBlob).toHaveBeenCalledTimes(2);
  expect(slices.mock.calls).toEqual([[13, window + 13], [window + 100, 5 * window + 100]]);
});

it('clamps read-ahead at EOF above 4 GiB and leaves unread destination bytes unchanged', () => {
  const size = 2 ** 32 + 100;
  const { source, readBlob, slices, onRead } = speechFileSourceFixture({ size, maxReadBytes: 4 * 1024 * 1024 });
  const destination = new Uint8Array(24).fill(0xa5);
  expect(source.read({ destination, offset: size - 8 })).toBe(8);
  expect(destination.subarray(0, 8)).toEqual(speechFileBytes({ offset: size - 8, length: 8 }));
  expect(destination.subarray(8).every(byte => byte === 0xa5)).toBe(true);
  expect(source.read({ destination, offset: size - 8 })).toBe(8);
  expect(source.read({ destination, offset: size })).toBe(0);
  expect(source.read({ destination: new Uint8Array(0), offset: 0 })).toBe(0);
  expect(slices.mock.calls).toEqual([[size - 8, size]]);
  expect(readBlob).toHaveBeenCalledOnce();
  expect(onRead.mock.calls).toEqual([[{ offset: size - 8, length: 8 }], [{ offset: size - 8, length: 8 }]]);
});

it('rejects an incomplete read-ahead without copying, reporting progress or caching the short buffer', () => {
  const window = 1024 * 1024;
  const { source, readBlob, onRead } = speechFileSourceFixture({ size: 2 * window, maxReadBytes: 4 * window });
  const destination = new Uint8Array(8).fill(0xa5);
  readBlob.mockReturnValueOnce(new ArrayBuffer(8));
  expect(() => source.read({ destination, offset: 7 })).toThrow('could not be read completely');
  expect(destination).toEqual(new Uint8Array(8).fill(0xa5));
  expect(onRead).not.toHaveBeenCalled();
  expect(source.read({ destination, offset: 7 })).toBe(8);
  expect(destination).toEqual(speechFileBytes({ offset: 7, length: 8 }));
  expect(readBlob).toHaveBeenCalledTimes(2);
  expect(onRead).toHaveBeenCalledExactlyOnceWith({ offset: 7, length: 8 });
});
