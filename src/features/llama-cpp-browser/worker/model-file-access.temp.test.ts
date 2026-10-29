// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openModelFileAccess } from './model-file-access';

afterEach(() => vi.unstubAllGlobals());

describe('temporary File readers', () => {
  it('reads only bounded slices from the captured File without handles, OPFS or whole-file buffering', async () => {
    const bytes = Uint8Array.from({ length: 9 * 1024 * 1024 }, (_value, index) => index % 251);
    const file = new File([bytes], 'model.gguf');
    const slices = new WeakMap<Blob, Uint8Array>();
    const slice = vi.spyOn(file, 'slice').mockImplementation((start, end) => {
      const part = bytes.slice(start, end);
      const blob = new Blob([part]);
      slices.set(blob, part);
      return blob;
    });
    const read = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Do not read the full model'));
    const opfs = vi.fn(() => {
      throw new Error('No OPFS access');
    });
    vi.stubGlobal('navigator', { storage: { getDirectory: opfs } });
    vi.stubGlobal('FileReaderSync', class {
      readAsArrayBuffer(blob: Blob): ArrayBuffer {
        const part = slices.get(blob);
        if (!part) {
          throw new Error('Unexpected blob');
        }
        return new Uint8Array(part).buffer;
      }
    });
    const access = await openModelFileAccess({ entry: { storageKind: 'temp', registrationRevision: 1, relativePath: 'model.gguf', file } });
    using _cleanup = { [Symbol.dispose]: () => access.close() };
    const destination = new Uint8Array(bytes.length);
    expect(access.getSize()).toBe(bytes.length);
    expect(access.read(destination, { at: 0 })).toBe(8 * 1024 * 1024);
    expect(slice).toHaveBeenCalledWith(0, 8 * 1024 * 1024);
    expect(destination[8 * 1024 * 1024 - 1]).toBe(bytes[8 * 1024 * 1024 - 1]);
    expect(access.read(destination.subarray(0, 7), { at: bytes.length - 3 })).toBe(3);
    expect(destination.subarray(0, 3)).toEqual(bytes.subarray(-3));
    expect(access.read(destination, { at: bytes.length })).toBe(0);
    const tail = new Uint8Array(1024);
    expect(access.readWithTail!({ destination: destination.subarray(0, 65536), offset: 13, tail })).toBe(65536 + 1024);
    expect(slice).toHaveBeenLastCalledWith(13, 13 + 65536 + 1024);
    expect(destination.subarray(0, 65536)).toEqual(bytes.subarray(13, 65549));
    expect(tail).toEqual(bytes.subarray(65549, 66573));
    expect(() => access.read(destination, { at: -1 })).toThrow('storage-error');
    access.close();
    expect(() => access.read(destination, { at: 0 })).toThrow('storage-error');
    expect(opfs).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('fails normally when the worker cannot read File slices', async () => {
    vi.stubGlobal('FileReaderSync', undefined);
    await expect(openModelFileAccess({ entry: { storageKind: 'temp', registrationRevision: 1, relativePath: 'model.gguf', file: new File(['x'], 'model.gguf') } })).rejects.toThrow('unavailable');
  });
});
