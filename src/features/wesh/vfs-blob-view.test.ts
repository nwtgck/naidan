// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as io from '@/utils/blob-view-io';
import { createWorkerBlobContext } from '@/utils/worker-blob-context';
import { workerTransfer } from '@/utils/worker-transport';
import { MockFile, MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import { WeshVFS } from './vfs';
import { readAllFileBytes, readAllFileText, openFileReadStream } from './utils/fs';
import type { WeshOpenFlags } from './types';

const hostBlobBytes = Blob.prototype.arrayBuffer;
const hostMockBytes = MockFile.prototype.arrayBuffer;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture() {
  const root = new MockFileSystemDirectoryHandle({ name: 'root' });
  const file = await root.getFileHandle('data.bin', { create: true });
  const bytes = Uint8Array.from({ length: io.BLOB_VIEW_CHUNK_SIZE + 11 }, (_, i) => i % 256);
  file.content = bytes.slice();
  const read = vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    // Real structured clone does not copy the Worker instance's overridden
    // methods. This in-process host must use its saved, independent reader too.
    const slice = blob.slice(offset, offset + length);
    const result = new Uint8Array(await (slice instanceof MockFile ? hostMockBytes : hostBlobBytes).call(slice));
    return workerTransfer({ value: result, transferables: [result.buffer] });
  });
  const blobs = createWorkerBlobContext({ host: { read } });
  cleanup.push(() => blobs.dispose());
  const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle, blobs });
  vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
  vi.spyOn(MockFile.prototype, 'stream').mockImplementation(() => {
    throw new Error('Unsafe Blob.stream');
  });
  vi.spyOn(MockFile.prototype, 'text').mockRejectedValue(new Error('Unsafe Blob.text'));
  async function open({ access }: { access: WeshOpenFlags['access'] }) {
    const handle = await vfs.open({ path: '/data.bin', flags: { access, creation: 'never', truncate: 'preserve', append: 'preserve' } });
    cleanup.push(() => handle.close());
    return handle;
  }
  return { root, file, bytes, blobs, vfs, read, open };
}

describe('Wesh native handles borrowing a BlobContext', () => {
  it('does not expose a real File as a directly readable Blob when a context is attached', async () => {
    const { file, vfs, read } = await fixture();
    const content = '日本語\0😀';
    const realFile = new File([content], 'data.bin');
    vi.spyOn(file as unknown as FileSystemFileHandle, 'getFile').mockResolvedValue(realFile);
    // Native Blob optimizations would otherwise bypass the context entirely.
    const rawText = vi.spyOn(realFile, 'text').mockRejectedValue(new Error('Unsafe File.text'));
    const rawBytes = vi.spyOn(realFile, 'arrayBuffer').mockRejectedValue(new Error('Unsafe File.arrayBuffer'));
    const rawStream = vi.spyOn(realFile, 'stream').mockImplementation(() => {
      throw new Error('Unsafe File.stream');
    });
    expect(await vfs.tryReadBlobEfficiently({ path: '/data.bin' })).toMatchObject({ kind: 'blob_view' });
    const open = vi.spyOn(vfs, 'open');
    expect(await readAllFileText({ files: vfs, path: '/data.bin' })).toBe(content);
    expect(await readAllFileBytes({ files: vfs, path: '/data.bin' })).toEqual(new TextEncoder().encode(content));
    expect(await new Response(await openFileReadStream({ files: vfs, path: '/data.bin' })).text()).toBe(content);
    expect(read).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(rawText).not.toHaveBeenCalled(); expect(rawBytes).not.toHaveBeenCalled(); expect(rawStream).not.toHaveBeenCalled();
  });

  it('preserves the real-Blob fast path for callers that do not inject a context', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const file = await root.getFileHandle('native.txt', { create: true });
    const realFile = new File(['native contents'], 'native.txt');
    vi.spyOn(file as unknown as FileSystemFileHandle, 'getFile').mockResolvedValue(realFile);
    const vfs = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    const result = await vfs.tryReadBlobEfficiently({ path: '/native.txt' });
    expect(result).toEqual({ kind: 'blob', blob: realFile });
    expect(await readAllFileText({ files: vfs, path: '/native.txt' })).toBe('native contents');
  });

  it('keeps sequential and positional reads independent and preserves all binary bytes', async () => {
    const { bytes, read, open } = await fixture();
    const handle = await open({ access: 'read' });
    const buffer = new Uint8Array(9).fill(99);
    expect(await handle.read({ buffer, offset: 2, length: 3 })).toEqual({ bytesRead: 3 });
    expect(buffer).toEqual(new Uint8Array([99, 99, 0, 1, 2, 99, 99, 99, 99]));
    expect(await handle.read({ buffer, position: bytes.length - 2, length: 9 })).toEqual({ bytesRead: 2 });
    expect(buffer.subarray(0, 2)).toEqual(bytes.subarray(bytes.length - 2));
    const remainder: Uint8Array[] = [];
    while (true) {
      const chunk = new Uint8Array(4096);
      const result = await handle.read({ buffer: chunk });
      if (result.bytesRead === 0) break;
      remainder.push(chunk.slice(0, result.bytesRead));
    }
    const merged = Buffer.concat(remainder);
    expect(Buffer.compare(merged, Buffer.from(bytes.subarray(3)))).toBe(0);
    expect(read.mock.calls.every(([request]) => request.length <= io.BLOB_VIEW_CHUNK_SIZE)).toBe(true);
  });

  it('bounds oversized read requests to destination capacity and one chunk', async () => {
    const { open } = await fixture();
    const handle = await open({ access: 'read' });
    const buffer = new Uint8Array(io.BLOB_VIEW_CHUNK_SIZE + 11);
    expect(await handle.read({ buffer, length: Number.MAX_SAFE_INTEGER })).toEqual({ bytesRead: io.BLOB_VIEW_CHUNK_SIZE });
    expect(await handle.read({ buffer: new Uint8Array(20) })).toEqual({ bytesRead: 11 });
  });

  it('invalidates read-write snapshots after fallback writes and truncation', async () => {
    const { open, file } = await fixture();
    const handle = await open({ access: 'read-write' });
    const first = new Uint8Array(4);
    await handle.read({ buffer: first, position: 0 });
    await handle.write({ buffer: new Uint8Array([255, 0, 128]), position: 1 });
    expect(await handle.read({ buffer: first, position: 0 })).toEqual({ bytesRead: 4 });
    expect(first).toEqual(new Uint8Array([0, 255, 0, 128]));
    await handle.truncate({ size: 2 });
    const next = new Uint8Array(4).fill(9);
    expect(await handle.read({ buffer: next, position: 0 })).toEqual({ bytesRead: 2 });
    expect(next).toEqual(new Uint8Array([0, 255, 9, 9]));
    expect(file.content).toHaveLength(2);
  });

  it('keeps the existing sync-access read-write path without invoking the Blob host', async () => {
    const { file, open, read } = await fixture();
    const sync = {
      read: vi.fn((buffer: Uint8Array, options: { at: number }) => {
        const chunk = file.content.subarray(options.at, options.at + buffer.length);
        buffer.set(chunk); return chunk.length;
      }),
      write: vi.fn(() => 0), truncate: vi.fn(), flush: vi.fn(), close: vi.fn(), getSize: () => file.content.length,
    };
    Object.assign(file, { createSyncAccessHandle: async () => sync });
    const handle = await open({ access: 'read-write' });
    expect(await handle.read({ buffer: new Uint8Array(2), position: 1 })).toEqual({ bytesRead: 2 });
    expect(sync.read).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    await handle.close();
    expect(sync.close).toHaveBeenCalledOnce();
  });

  it.each([{ offset: -1 }, { length: -1 }, { length: 0.5 }, { position: -1 }, { position: NaN }])('rejects an invalid read before requesting bytes: %j', async options => {
    const { open, read } = await fixture();
    const handle = await open({ access: 'read' });
    await expect(handle.read({ buffer: new Uint8Array(2), ...options })).rejects.toBeInstanceOf(RangeError);
    expect(read).not.toHaveBeenCalled();
  });

  it('does not publish a pending positional result after close or dispose the shared context', async () => {
    const { blobs, open, read } = await fixture();
    await blobs.fromNative({ blob: new Blob(['warm']) }).text();
    const late = Promise.withResolvers<Awaited<ReturnType<typeof read>>>();
    read.mockReturnValueOnce(late.promise);
    const handle = await open({ access: 'read-write' });
    const target = new Uint8Array(3).fill(9);
    const operation = handle.read({ buffer: target, position: 0 });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(read.mock.calls.at(-1)?.[0].length).toBe(3));
    await handle.close();
    await rejected;
    const bytes = new Uint8Array([0, 1, 2]);
    late.resolve(workerTransfer({ value: bytes, transferables: [bytes.buffer] }));
    expect(target).toEqual(new Uint8Array([9, 9, 9]));
    expect(await blobs.fromNative({ blob: new Blob(['next']) }).text()).toBe('next');
  });

  it('cancels a pending sequential read on close without advancing or modifying its destination', async () => {
    const { open, read, blobs } = await fixture();
    await blobs.fromNative({ blob: new Blob(['warm']) }).text();
    const handle = await open({ access: 'read' });
    const late = Promise.withResolvers<Awaited<ReturnType<typeof read>>>();
    read.mockReturnValueOnce(late.promise);
    const target = new Uint8Array(4).fill(9);
    const previous = read.mock.calls.length;
    const reading = handle.read({ buffer: target });
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(previous + 1));
    await handle.close(); await rejected;
    expect(target).toEqual(new Uint8Array([9, 9, 9, 9]));
    late.reject(new Error('Late sequential failure'));
  });

  it('opens mounted entry references through the same context and preserves read-only checks', async () => {
    const { vfs, root, bytes } = await fixture();
    await vfs.mount({ path: '/mounted', handle: root as unknown as FileSystemDirectoryHandle, readOnly: true });
    const entry = await vfs.resolveEntry({ path: '/mounted/data.bin', finalSymlinkTreatment: 'follow' });
    const handle = await vfs.openEntry({ entry, flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' } });
    cleanup.push(() => handle.close());
    const target = new Uint8Array(4);
    expect(await handle.read({ buffer: target })).toEqual({ bytesRead: 4 });
    expect(target).toEqual(bytes.subarray(0, 4));
    await expect(vfs.openEntry({ entry, flags: { access: 'write', creation: 'never', truncate: 'preserve', append: 'preserve' } })).rejects.toThrow('read-only');
  });

  it('reads symlink registry JSON via the view and does not mistake read failure for an absent entry', async () => {
    const { vfs, read, file, bytes } = await fixture();
    await vfs.symlink({ targetPath: '/data.bin', path: '/link' });
    expect(await vfs.readlink({ path: '/link' })).toBe('/data.bin');
    expect(Buffer.compare(Buffer.from(await readAllFileBytes({ files: vfs, path: '/link' })), Buffer.from(bytes))).toBe(0);
    read.mockRejectedValue(new DOMException('Host bytes unavailable', 'NotReadableError'));
    await expect(vfs.readlink({ path: '/link' })).rejects.toThrow('Wesh registry bytes');
    await expect(vfs.getNativeHandle({ path: '/link' })).rejects.toThrow('Wesh registry bytes');
    await expect(vfs.mkdir({ path: '/link', recursive: true })).rejects.toThrow('Wesh registry bytes');
    await expect(vfs.tryCreateFileWriterEfficiently({ path: '/link', mode: 'truncate' })).rejects.toThrow('Wesh registry bytes');
    expect(file.content).toEqual(bytes);
  });
});
