// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createSpeechFileSource, inspectSpeechCandidate } from './model-file';
import { speechModelFile } from './model-file.test-support';

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
