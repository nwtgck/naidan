// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelFile } from '@/features/llama-cpp-browser/runtime/model-directory';
import { openModelFileAccess } from './model-file-access';

const slices = new WeakMap<Blob, Uint8Array>();
const readAsArrayBuffer = vi.fn<(blob: Blob) => ArrayBuffer>();
const opfs = vi.fn();

beforeEach(() => {
  readAsArrayBuffer.mockReset().mockImplementation(blob => {
    const bytes = slices.get(blob);
    if (!bytes) throw new Error('Unexpected full-file read');
    return new Uint8Array(bytes).buffer;
  });
  opfs.mockReset();
  vi.stubGlobal('navigator', { storage: { getDirectory: opfs } });
  vi.stubGlobal('FileReaderSync', class {
    readAsArrayBuffer(blob: Blob): ArrayBuffer {
      return readAsArrayBuffer(blob);
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture({ size }: { size: number }): {
  entry: ModelFile,
  bytes: Uint8Array,
  getFile: ReturnType<typeof vi.fn<() => Promise<File>>>,
  sync: ReturnType<typeof vi.fn>,
  slice: ReturnType<typeof vi.fn<File['slice']>>,
} {
  const bytes = Uint8Array.from({ length: size }, (_value, index) => index % 251);
  const file = new File([bytes], 'model.gguf', { lastModified: 123 });
  const slice = vi.spyOn(file, 'slice').mockImplementation((start, end) => {
    const chunk = bytes.slice(start, end);
    const blob = new Blob([chunk]);
    slices.set(blob, chunk);
    return blob;
  });
  vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Do not buffer the entire host model'));
  const getFile = vi.fn(async () => file);
  const sync = vi.fn().mockRejectedValue(new DOMException('Host handles are not OPFS', 'InvalidStateError'));
  const entry: ModelFile = {
    storageKind: 'host',
    path: 'nested/model.gguf',
    file,
    handle: { getFile, createSyncAccessHandle: sync } as unknown as FileSystemFileHandle,
  };
  return { entry, bytes, getFile, sync, slice };
}

describe('direct linked-folder model reads', () => {
  it('reads the requested slice directly without OPFS or a synchronous access handle', async () => {
    const host = fixture({ size: 64 });
    const access = await openModelFileAccess({ entry: host.entry });
    const destination = new Uint8Array(20).fill(255);

    expect(access.getSize()).toBe(64);
    expect(access.read(destination.subarray(4, 12), { at: 7 })).toBe(8);
    expect(destination.subarray(4, 12)).toEqual(host.bytes.subarray(7, 15));
    expect(destination.subarray(0, 4)).toEqual(new Uint8Array(4).fill(255));
    expect(destination.subarray(12)).toEqual(new Uint8Array(8).fill(255));
    expect(host.slice).toHaveBeenCalledExactlyOnceWith(7, 15);
    expect(host.entry.file.arrayBuffer).not.toHaveBeenCalled();
    expect(host.sync).not.toHaveBeenCalled();
    expect(opfs).not.toHaveBeenCalled();
    access.close();
  });

  it('bounds a direct read to 8 MiB even when its caller supplies a larger destination', async () => {
    const host = fixture({ size: 9 * 1024 * 1024 });
    const access = await openModelFileAccess({ entry: host.entry });
    const destination = new Uint8Array(9 * 1024 * 1024).fill(255);

    expect(access.read(destination, { at: 0 })).toBe(8 * 1024 * 1024);
    expect(host.slice).toHaveBeenCalledExactlyOnceWith(0, 8 * 1024 * 1024);
    expect(destination[8 * 1024 * 1024]).toBe(255);
    expect(access.read(destination.subarray(8 * 1024 * 1024), { at: 8 * 1024 * 1024 })).toBe(1024 * 1024);
    expect(destination.every((byte, index) => byte === host.bytes[index])).toBe(true);
    access.close();
  });

  it('returns only remaining bytes at EOF and rejects reads after close', async () => {
    const host = fixture({ size: 32 });
    const access = await openModelFileAccess({ entry: host.entry });
    const destination = new Uint8Array(8).fill(255);

    expect(access.read(destination, { at: 30 })).toBe(2);
    expect(destination).toEqual(new Uint8Array([30, 31, 255, 255, 255, 255, 255, 255]));
    expect(access.read(destination, { at: 32 })).toBe(0);
    expect(access.read(destination, { at: 99 })).toBe(0);
    access.close();
    access.close();
    expect(() => access.read(destination, { at: 0 })).toThrow('storage-error');
  });

  it.each([-1, 0.5, Number.POSITIVE_INFINITY, Number.NaN])('rejects invalid byte offset %s before accessing the file', async offset => {
    const host = fixture({ size: 32 });
    const access = await openModelFileAccess({ entry: host.entry });

    expect(() => access.read(new Uint8Array(8), { at: offset })).toThrow('storage-error');
    expect(host.slice).not.toHaveBeenCalled();
    access.close();
  });

  it.each([{ size: 33, lastModified: 123 }, { size: 32, lastModified: 124 }])('rejects a stale snapshot when current metadata is $size/$lastModified', async ({ size, lastModified }) => {
    const host = fixture({ size: 32 });
    host.getFile.mockResolvedValue(new File([new Uint8Array(size)], 'model.gguf', { lastModified }));

    await expect(openModelFileAccess({ entry: host.entry })).rejects.toThrow('storage-error');
    expect(readAsArrayBuffer).not.toHaveBeenCalled();
    expect(host.sync).not.toHaveBeenCalled();
    expect(opfs).not.toHaveBeenCalled();
  });

  it('rejects a short native read rather than exposing zero-filled weights', async () => {
    const host = fixture({ size: 32 });
    const access = await openModelFileAccess({ entry: host.entry });
    readAsArrayBuffer.mockReturnValueOnce(new ArrayBuffer(7));
    const destination = new Uint8Array(8).fill(255);

    expect(() => access.read(destination, { at: 0 })).toThrow('storage-error');
    expect(destination).toEqual(new Uint8Array(8).fill(255));
    access.close();
  });

  it('propagates permission revocation without trying another storage source', async () => {
    const host = fixture({ size: 32 });
    const failure = new DOMException('Read permission expired', 'NotAllowedError');
    host.getFile.mockRejectedValue(failure);

    await expect(openModelFileAccess({ entry: host.entry })).rejects.toBe(failure);
    expect(host.sync).not.toHaveBeenCalled();
    expect(opfs).not.toHaveBeenCalled();
  });

  it('keeps host reading unavailable when FileReaderSync is absent', async () => {
    const host = fixture({ size: 32 });
    vi.stubGlobal('FileReaderSync', undefined);

    await expect(openModelFileAccess({ entry: host.entry })).rejects.toThrow('unavailable');
    expect(host.sync).not.toHaveBeenCalled();
    expect(opfs).not.toHaveBeenCalled();
  });

  it('does not turn an OPFS access failure into a host-file fallback', async () => {
    const host = fixture({ size: 32 });
    const { storageKind: _storageKind, ...entry } = host.entry;
    const failure = new DOMException('OPFS read denied', 'NotAllowedError');
    host.sync.mockRejectedValue(failure);

    await expect(openModelFileAccess({ entry })).rejects.toBe(failure);
    expect(host.getFile).not.toHaveBeenCalled();
    expect(readAsArrayBuffer).not.toHaveBeenCalled();
  });
});
