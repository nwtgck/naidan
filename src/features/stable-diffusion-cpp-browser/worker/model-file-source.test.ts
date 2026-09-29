// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createModelFileSource, createModelFileReadCache, MODEL_FILE_CACHE_BYTES, MODEL_FILE_PAGE_BYTES } from './gguf-file';
import { fixtureReader, sparseFile } from '@/features/stable-diffusion-cpp-browser/test-utils/weights';

it('coalesces thousands of native 2-KiB reads into three bounded Blob reads', () => {
  const fixture = sparseFile({ name: 'original.gguf', header: new Uint8Array(), size: 20 * 1024 ** 3 });
  const cache = createModelFileReadCache({ pageBytes: MODEL_FILE_PAGE_BYTES, capacityBytes: MODEL_FILE_CACHE_BYTES });
  const source = createModelFileSource({ file: fixture.file, reader: fixtureReader, cache });
  const destination = new Uint8Array(2048);
  const reads = MODEL_FILE_PAGE_BYTES * 2 / destination.length + 1;
  for (let index = 0; index < reads; index++) expect(source.read(destination, index * destination.length)).toBe(destination.length);
  expect(fixture.reads).toEqual([0, 1, 2].map(page => ({ offset: page * MODEL_FILE_PAGE_BYTES, length: MODEL_FILE_PAGE_BYTES })));
  expect(source.metrics()).toMatchObject({ reads, bytes: reads * destination.length, blobReads: 3, blobBytes: 3 * MODEL_FILE_PAGE_BYTES,
    cacheHits: reads - 3, cacheHitBytes: (reads - 3) * destination.length });
  expect(cache.retainedBytes()).toBe(3 * MODEL_FILE_PAGE_BYTES);
});

it('preserves safe integer offsets through 20 GiB and reads the original file tail', () => {
  const fixture = sparseFile({ name: 'original.safetensors', header: new Uint8Array(), size: 20 * 1024 ** 3 + 24 });
  const cache = createModelFileReadCache({ pageBytes: MODEL_FILE_PAGE_BYTES, capacityBytes: MODEL_FILE_CACHE_BYTES });
  const source = createModelFileSource({ file: fixture.file, reader: fixtureReader, cache });
  for (const gib of [2, 4, 8, 18, 20]) {
    const offset = gib * 1024 ** 3;
    expect(source.read(new Uint8Array(16), offset + 7)).toBe(16);
    expect(fixture.reads.at(-1)).toEqual({ offset, length: gib === 20 ? 24 : MODEL_FILE_PAGE_BYTES });
  }
  const tail = new Uint8Array(10).fill(255);
  expect(source.read(tail, fixture.file.size - 3)).toBe(3);
  expect(tail).toEqual(new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 255]));
  expect(source.read(tail, fixture.file.size)).toBe(0);
  expect(source.read(new Uint8Array(), 0)).toBe(0);
  expect(fixture.reads).toHaveLength(5);
  for (const offset of [-1, 0.5, fixture.file.size + 1, Number.MAX_SAFE_INTEGER + 1, NaN]) expect(() => source.read(tail, offset)).toThrow('offset');
});

it('copies overlapping reads across pages and separates partial from full cache hits', () => {
  const fixture = sparseFile({ name: 'weights.gguf', header: Uint8Array.from({ length: 24 }, (_, index) => index), size: 24 });
  const cache = createModelFileReadCache({ pageBytes: 8, capacityBytes: 24 });
  const source = createModelFileSource({ file: fixture.file, reader: fixtureReader, cache });
  const first = new Uint8Array(3);
  expect(source.read(first, 2)).toBe(3); expect([...first]).toEqual([2, 3, 4]);
  const overlap = new Uint8Array(6);
  expect(source.read(overlap, 6)).toBe(6); expect([...overlap]).toEqual([6, 7, 8, 9, 10, 11]);
  expect(source.metrics()).toMatchObject({ reads: 2, bytes: 9, blobReads: 2, blobBytes: 16, cacheHits: 0, cacheHitBytes: 2 });
  expect(source.read(overlap, 6)).toBe(6);
  const all = new Uint8Array(24);
  expect(source.read(all, 0)).toBe(24); expect([...all]).toEqual(Array.from({ length: 24 }, (_, index) => index));
  expect(source.metrics()).toMatchObject({ reads: 4, bytes: 39, blobReads: 3, blobBytes: 24, cacheHits: 1, cacheHitBytes: 24 });
});

it('shares one LRU byte budget across same-named files without confusing their contents', () => {
  const first = sparseFile({ name: 'weights.gguf', header: new Uint8Array(32).fill(17), size: 32 });
  const second = sparseFile({ name: 'weights.gguf', header: new Uint8Array(32).fill(83), size: 32 });
  const cache = createModelFileReadCache({ pageBytes: 8, capacityBytes: 16 });
  const a = createModelFileSource({ file: first.file, reader: fixtureReader, cache });
  const b = createModelFileSource({ file: second.file, reader: fixtureReader, cache });
  const destination = new Uint8Array(1);
  a.read(destination, 0); expect(destination[0]).toBe(17);
  b.read(destination, 0); expect(destination[0]).toBe(83);
  a.read(destination, 1); // Touch A so the next page evicts B.
  a.read(destination, 8); expect(cache.retainedBytes()).toBe(16);
  a.read(destination, 0); expect(first.reads).toHaveLength(2);
  b.read(destination, 0); expect(destination[0]).toBe(83); expect(second.reads).toHaveLength(2);
  expect(cache.retainedBytes()).toBe(16);
  cache.clear(); expect(cache.retainedBytes()).toBe(0);
  a.read(destination, 0); expect(first.reads).toHaveLength(3);
});

it('never caches a truncated or failed Blob read', () => {
  const fixture = sparseFile({ name: 'weights.safetensors', header: new Uint8Array(16).fill(42), size: 16 });
  const cache = createModelFileReadCache({ pageBytes: 8, capacityBytes: 8 });
  const readAsArrayBuffer = vi.fn(fixtureReader.readAsArrayBuffer).mockReturnValueOnce(new ArrayBuffer(7)).mockImplementationOnce(() => {
    throw new Error('Read failed');
  });
  const source = createModelFileSource({ file: fixture.file, reader: { readAsArrayBuffer }, cache });
  const destination = new Uint8Array(4).fill(255);
  expect(() => source.read(destination, 0)).toThrow('completely');
  expect(cache.retainedBytes()).toBe(0); expect([...destination]).toEqual([255, 255, 255, 255]);
  expect(() => source.read(destination, 0)).toThrow('Read failed');
  expect(cache.retainedBytes()).toBe(0);
  expect(source.read(destination, 0)).toBe(4); expect([...destination]).toEqual([42, 42, 42, 42]);
  expect(readAsArrayBuffer).toHaveBeenCalledTimes(3);
});
