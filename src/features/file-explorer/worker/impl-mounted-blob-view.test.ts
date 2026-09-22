// @vitest-environment node
import * as Comlink from 'comlink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeshVFS } from '@/features/wesh/vfs';
import { MockFile, MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createFileExplorerWorker } from './impl';
import * as io from '@/utils/blob-view-io';
import { workerTransfer } from '@/utils/worker-transport';

const nativeRead = io.readNativeBlobRange;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0)) await dispose();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture() {
  const root = new MockFileSystemDirectoryHandle({ name: 'root' });
  const native = root as unknown as FileSystemDirectoryHandle;
  const seed = new WeshVFS({ rootHandle: undefined });
  await seed.mount({ path: '/mounted', handle: native, readOnly: false });
  const data = await root.getFileHandle('input.txt', { create: true });
  data.content = new TextEncoder().encode('日本語 link');
  await seed.symlink({ targetPath: '/mounted/input.txt', path: '/mounted/link.txt' });
  const read = vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    const bytes = await nativeRead({ blob, offset, length });
    return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
  });
  const released = vi.fn();
  const host = Object.assign({ read }, { [Comlink.releaseProxy]: released });
  vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
  vi.spyOn(MockFile.prototype, 'text').mockRejectedValue(new Error('Unsafe registry read'));
  vi.spyOn(MockFile.prototype, 'stream').mockImplementation(() => {
    throw new Error('Unsafe native stream');
  });
  const worker = createFileExplorerWorker();
  const { sessionId } = await worker.prepareSession({ request: { root: { kind: 'wesh-mounts', rootName: 'Mounted', mounts: [
    { type: 'directory', path: '/mounted', handle: native, readOnly: false },
  ] } } }, undefined, host);
  cleanup.push(() => worker.disposeSession({ request: { sessionId } }));
  return { root, data, worker, sessionId, read, released };
}

describe('File Explorer mounted VFS borrows the session BlobContext', () => {
  it('reads a symlink registry and its target through the same host', async () => {
    const { worker, sessionId, read } = await fixture();
    const result = await worker.readPreview({ request: { sessionId, path: '/mounted/link.txt', mode: 'bounded' } });
    expect(result).toMatchObject({ kind: 'text', rawText: '日本語 link', oversized: false });
    const listing = await worker.readDirectory({ request: { sessionId, path: '/mounted' } });
    expect(listing.entries.some(entry => entry.name === 'link.txt')).toBe(true);
    expect(read.mock.calls.length).toBeGreaterThan(2);
    expect(read.mock.calls.every(([{ length }]) => length <= io.BLOB_VIEW_CHUNK_SIZE)).toBe(true);
  });

  it('does not mistake an unreadable registry for a missing symlink or create over it', async () => {
    const { worker, sessionId, read, root, data } = await fixture();
    read.mockRejectedValue(new Error('Host unavailable'));
    await expect(worker.readPreview({ request: { sessionId, path: '/mounted/link.txt', mode: 'bounded' } })).rejects.toThrow('Wesh registry bytes');
    await expect(worker.createFolder({ request: { sessionId, parentPath: '/mounted/link.txt', name: 'child' } })).rejects.toThrow('Wesh registry bytes');
    expect(new TextDecoder().decode(data.content)).toBe('日本語 link');
    await expect(root.getDirectoryHandle('link.txt')).rejects.toMatchObject({ name: 'TypeMismatchError' });
  });

  it('terminates a pending registry read when the owning session ends', async () => {
    const { worker, sessionId, read, released } = await fixture();
    await worker.readPreview({ request: { sessionId, path: '/mounted/link.txt', mode: 'bounded' } });
    const late = Promise.withResolvers<Awaited<ReturnType<typeof read>>>();
    read.mockReturnValueOnce(late.promise);
    const before = read.mock.calls.length;
    const result = worker.readPreview({ request: { sessionId, path: '/mounted/link.txt', mode: 'bounded' } });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(before + 1));
    await worker.disposeSession({ request: { sessionId } });
    await rejected;
    expect(released).toHaveBeenCalledOnce();
    late.reject(new Error('Late registry error'));
  });
});
