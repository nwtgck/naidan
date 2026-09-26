import { expect, it, vi } from 'vitest';
import { createGgufFileSource } from './gguf-file';
import { ggufFile } from '@/features/stable-diffusion-cpp-browser/test-fixtures';

it('reads above 2, 4, 8 and 18 GiB without narrowing the file offset or copying the file', () => {
  const file = ggufFile();
  Object.defineProperty(file, 'size', { value: 19 * 1024 ** 3 });
  const parts = new WeakMap<Blob, ArrayBuffer>();
  const slice = vi.spyOn(file, 'slice').mockImplementation((start, end) => {
    const from = start ?? 0, to = end ?? file.size;
    expect(to - from).toBeLessThanOrEqual(24);
    const bytes = new Uint8Array(to - from);
    if (from === 0) {
      const view = new DataView(bytes.buffer); view.setUint32(0, 0x46554747, true); view.setUint32(4, 3, true);
    } else bytes.fill(from % 251);
    const blob = new Blob(); parts.set(blob, bytes.buffer); return blob;
  });
  const reader = { readAsArrayBuffer: vi.fn((blob: Blob) => {
    const bytes = parts.get(blob); if (!bytes) throw new Error('unrequested bytes'); return bytes;
  }) };
  const source = createGgufFileSource({ file, reader });
  for (const gib of [2, 4, 8, 18]) {
    const offset = gib * 1024 ** 3 + 123;
    const target = new Uint8Array(16);
    expect(source.read(target, offset)).toBe(16); expect(target[0]).toBe(offset % 251);
    expect(slice).toHaveBeenLastCalledWith(offset, offset + 16);
  }
  expect(source.size).toBe(file.size);
  expect(source.read(new Uint8Array(16), file.size)).toBe(0);
  expect(() => source.read(new Uint8Array(1), Number.MAX_SAFE_INTEGER + 1)).toThrow('offset');
  expect(() => source.read(new Uint8Array(1), -1)).toThrow('offset');
});
it('rejects invalid headers and incomplete reads before mounting a model', () => {
  const file = ggufFile();
  expect(() => createGgufFileSource({ file, reader: { readAsArrayBuffer: () => new ArrayBuffer(24) } })).toThrow('GGUF version');
  expect(() => createGgufFileSource({ file, reader: { readAsArrayBuffer: () => new ArrayBuffer(2) } })).toThrow('completely');
  expect(() => createGgufFileSource({ file: new File([new ArrayBuffer(24)], 'model.safetensors'), reader: { readAsArrayBuffer: vi.fn() } })).toThrow('GGUF');
});
