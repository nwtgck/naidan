// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import type { IFileExplorerWorker } from './types';
import * as Comlink from 'comlink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockFile, MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import * as io from '@/utils/blob-view-io';
import { exposeWorkerRemote, releaseWorkerRemote, workerCapability, workerProxy, workerTransfer, wrapWorkerRemote } from '@/utils/worker-transport';
import { createFileExplorerWorker } from './impl';

const nativeRead = io.readNativeBlobRange;
const nativeFileStream = MockFile.prototype.stream;
const nativeBlobStream = Blob.prototype.stream;
const cleanup: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
  for (const prototype of [Blob.prototype, MockFile.prototype]) {
    vi.spyOn(prototype, 'stream').mockImplementation(() => {
      throw new Error('Native Blob.stream must not bypass BlobView');
    });
  }
});

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture({ root, mounting, readOnly }: {
  root: MockFileSystemDirectoryHandle,
  mounting: 'opfs' | 'wesh',
  readOnly: boolean,
}) {
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  const worker = createFileExplorerWorker();
  const host = { read: vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    const bytes = await nativeRead({ blob, offset, length });
    return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
  }) };
  const released = vi.fn();
  Object.assign(host, { [Comlink.releaseProxy]: released });
  const request = (() => {
    switch (mounting) {
    case 'opfs':
      return { root: { kind: 'opfs-root' as const, rootName: 'OPFS' } };
    case 'wesh':
      return { root: { kind: 'wesh-mounts' as const, rootName: 'Files', mounts: [{
        type: 'directory' as const, path: '/project', handle: root as FileSystemDirectoryHandle, readOnly,
      }] } };
    default: {
      const _ex: never = mounting;
      throw new Error(`Unhandled fixture: ${String(_ex)}`);
    }
    }
  })();
  const { sessionId } = await worker.prepareSession({ request }, undefined, host);
  cleanup.push(() => worker.disposeSession({ request: { sessionId } }));
  return { worker, sessionId, host, released };
}

async function writeBytes({ directory, name, bytes }: {
  directory: MockFileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
}) {
  const file = await directory.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(bytes);
  await writable.close();
  return file;
}

async function expectFile({ directory, name, bytes }: {
  directory: MockFileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
}) {
  const file = await (await directory.getFileHandle(name)).getFile();
  const result = new Uint8Array(await file.arrayBuffer());
  expect(result.byteLength).toBe(bytes.byteLength);
  expect(result.every((value, index) => value === bytes[index])).toBe(true);
}

function sourceBytes({ length }: { length: number }): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, index) => index % 256);
}

describe('native file writes using session BlobViews', () => {
  it('uploads arbitrary bytes in bounded chunks without native Blob.stream or whole-file reads', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const { worker, sessionId, host } = await fixture({ root, mounting: 'opfs', readOnly: false });
    const bytes = sourceBytes({ length: io.BLOB_VIEW_CHUNK_SIZE * 2 + 17 });
    await worker.uploadFiles({ request: { sessionId, targetDirectoryPath: '/', files: [{ name: 'payload.bin', blob: new Blob([bytes]) }] } });
    await expectFile({ directory: root, name: 'payload.bin', bytes });
    expect(host.read.mock.calls.map(([{ length }]) => length)).toEqual([3, io.BLOB_VIEW_CHUNK_SIZE, io.BLOB_VIEW_CHUNK_SIZE, 17]);
    expect(io.readNativeBlobRange).toHaveBeenCalledOnce();
  });

  it('creates an empty uploaded file without probing or reading the host', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const { worker, sessionId, host } = await fixture({ root, mounting: 'opfs', readOnly: false });
    await worker.uploadFiles({ request: { sessionId, targetDirectoryPath: '/', files: [{ name: 'empty', blob: new Blob([]) }] } });
    await expectFile({ directory: root, name: 'empty', bytes: new Uint8Array(0) });
    expect(host.read).not.toHaveBeenCalled();
    expect(io.readNativeBlobRange).not.toHaveBeenCalled();
  });

  it('copies nested directories, renames them and moves binary files through the same context', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const project = await root.getDirectoryHandle('project', { create: true });
    const nested = await project.getDirectoryHandle('nested', { create: true });
    const target = await root.getDirectoryHandle('target', { create: true });
    const bytes = sourceBytes({ length: io.BLOB_VIEW_CHUNK_SIZE + 7 });
    await writeBytes({ directory: nested, name: 'source.bin', bytes });
    await writeBytes({ directory: project, name: 'empty', bytes: new Uint8Array(0) });
    const { worker, sessionId, host } = await fixture({ root, mounting: 'opfs', readOnly: false });
    await worker.copyEntries({ request: { sessionId, sourcePaths: ['/project'], targetDirectoryPath: '/target' } });
    await worker.renameEntry({ request: { sessionId, path: '/target/project', newName: 'renamed' } });
    const renamed = await target.getDirectoryHandle('renamed');
    await expectFile({ directory: renamed, name: 'empty', bytes: new Uint8Array(0) });
    await worker.moveEntries({ request: { sessionId, sourcePaths: ['/target/renamed/nested/source.bin'], targetDirectoryPath: '/' } });
    await expectFile({ directory: root, name: 'source.bin', bytes });
    await expectFile({ directory: nested, name: 'source.bin', bytes });
    await expect((await renamed.getDirectoryHandle('nested')).getFileHandle('source.bin')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(host.read).toHaveBeenCalled();
    expect(io.readNativeBlobRange).toHaveBeenCalledOnce();
  });

  it('retains direct reads when that Worker passes the probe', async () => {
    vi.mocked(io.readNativeBlobRange).mockImplementation(nativeRead);
    // A healthy realm delegates to native streams; the other cases keep those
    // methods forbidden to detect any bypass of the host fallback.
    vi.mocked(MockFile.prototype.stream).mockImplementation(nativeFileStream);
    vi.mocked(Blob.prototype.stream).mockImplementation(nativeBlobStream);
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const target = await root.getDirectoryHandle('target', { create: true });
    const bytes = new Uint8Array([0, 255, 128, 1]);
    await writeBytes({ directory: root, name: 'input.bin', bytes });
    const { worker, sessionId, host } = await fixture({ root, mounting: 'opfs', readOnly: false });
    await worker.copyEntries({ request: { sessionId, sourcePaths: ['/input.bin'], targetDirectoryPath: '/target' } });
    await expectFile({ directory: target, name: 'input.bin', bytes });
    expect(host.read).not.toHaveBeenCalled();
    expect(MockFile.prototype.stream).toHaveBeenCalled();
    expect(io.readNativeBlobRange).toHaveBeenCalledOnce();
  });

  it('copies a native directory mounted beneath Wesh without requiring a native parent of the mount', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const source = await root.getDirectoryHandle('source', { create: true });
    const target = await root.getDirectoryHandle('target', { create: true });
    const bytes = new Uint8Array([0, 255, 128]);
    await writeBytes({ directory: source, name: 'bytes', bytes });
    const { worker, sessionId } = await fixture({ root, mounting: 'wesh', readOnly: false });
    await worker.copyEntries({ request: { sessionId, sourcePaths: ['/project/source'], targetDirectoryPath: '/project/target' } });
    await expectFile({ directory: await target.getDirectoryHandle('source'), name: 'bytes', bytes });
  });

  it('does not mistake an empty resolved path for a descendant when identity says otherwise', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const source = await root.getDirectoryHandle('source', { create: true });
    const target = await root.getDirectoryHandle('target', { create: true });
    const bytes = new Uint8Array([255, 0]);
    await writeBytes({ directory: source, name: 'input', bytes });
    vi.spyOn(source, 'resolve').mockResolvedValue([]);
    const { worker, sessionId } = await fixture({ root, mounting: 'opfs', readOnly: false });
    await worker.copyEntries({ request: { sessionId, sourcePaths: ['/source'], targetDirectoryPath: '/target' } });
    await expectFile({ directory: await target.getDirectoryHandle('source'), name: 'input', bytes });
  });

  it('rejects write destinations on read-only mounts before acquiring their bytes', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    await writeBytes({ directory: root, name: 'input', bytes: new Uint8Array([1]) });
    const { worker, sessionId, host } = await fixture({ root, mounting: 'wesh', readOnly: true });
    await expect(worker.uploadFiles({ request: { sessionId, targetDirectoryPath: '/project', files: [{ name: 'out', blob: new Blob(['new']) }] } })).rejects.toThrow();
    await expect(worker.renameEntry({ request: { sessionId, path: '/project/input', newName: 'renamed' } })).rejects.toThrow();
    expect(host.read).not.toHaveBeenCalled();
    await expect(root.getFileHandle('out')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it.each(['rename', 'move'] as const)('does not delete the %s source or reinterpret a target open failure as a directory', async operation => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const target = await root.getDirectoryHandle('target', { create: true });
    const bytes = new Uint8Array([255, 0, 128]);
    await writeBytes({ directory: root, name: 'input', bytes });
    const destination = await writeBytes({ directory: operation === 'rename' ? root : target, name: operation === 'rename' ? 'renamed' : 'input', bytes: new Uint8Array([9]) });
    const error = new DOMException('Disk is full', 'QuotaExceededError');
    vi.spyOn(destination, 'createWritable').mockRejectedValue(error);
    const getDirectory = vi.spyOn(root, 'getDirectoryHandle');
    const remove = vi.spyOn(root, 'removeEntry');
    const { worker, sessionId } = await fixture({ root, mounting: 'opfs', readOnly: false });
    const result = operation === 'rename'
      ? worker.renameEntry({ request: { sessionId, path: '/input', newName: 'renamed' } })
      : worker.moveEntries({ request: { sessionId, sourcePaths: ['/input'], targetDirectoryPath: '/target' } });
    await expect(result).rejects.toBe(error);
    expect(getDirectory.mock.calls.some(([name]) => name === 'input')).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    await expectFile({ directory: root, name: 'input', bytes });
    expect(await (await destination.getFile()).arrayBuffer()).toEqual(new Uint8Array([9]).buffer);
  });

  it('propagates source lookup permission failure without trying a directory lookup', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    await root.getDirectoryHandle('target', { create: true });
    const error = new DOMException('Read refused', 'NotAllowedError');
    vi.spyOn(root, 'getFileHandle').mockRejectedValue(error);
    const lookupDirectory = vi.spyOn(root, 'getDirectoryHandle');
    const { worker, sessionId, host } = await fixture({ root, mounting: 'opfs', readOnly: false });
    await expect(worker.copyEntries({ request: { sessionId, sourcePaths: ['/missing'], targetDirectoryPath: '/target' } })).rejects.toBe(error);
    expect(lookupDirectory.mock.calls.some(([name]) => name === 'missing')).toBe(false);
    expect(host.read).not.toHaveBeenCalled();
  });

  it('aborts an overwrite on write failure and keeps the context usable for a later upload', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const file = await writeBytes({ directory: root, name: 'input', bytes: new Uint8Array([9]) });
    const open = file.createWritable.bind(file);
    const error = new Error('Write failed');
    const abort = vi.fn();
    vi.spyOn(file, 'createWritable').mockImplementationOnce(async () => {
      const writable = await open();
      vi.spyOn(writable, 'write').mockRejectedValue(error);
      const originalAbort = writable.abort.bind(writable);
      vi.spyOn(writable, 'abort').mockImplementation(async reason => {
        abort(reason); await originalAbort(reason);
      });
      return writable;
    });
    const { worker, sessionId, released } = await fixture({ root, mounting: 'opfs', readOnly: false });
    await expect(worker.uploadFiles({ request: { sessionId, targetDirectoryPath: '/', files: [{ name: 'input', blob: new Blob(['failed']) }] } })).rejects.toBe(error);
    expect(abort).toHaveBeenCalledWith(error);
    await expectFile({ directory: root, name: 'input', bytes: new Uint8Array([9]) });
    expect(released).not.toHaveBeenCalled();
    await worker.uploadFiles({ request: { sessionId, targetDirectoryPath: '/', files: [{ name: 'input', blob: new Blob([new Uint8Array([255])]) }] } });
    await expectFile({ directory: root, name: 'input', bytes: new Uint8Array([255]) });
  });

  it('leaves the source and existing destination intact when both byte-reading paths fail', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const target = await root.getDirectoryHandle('target', { create: true });
    await writeBytes({ directory: root, name: 'input', bytes: new Uint8Array([1]) });
    await writeBytes({ directory: target, name: 'input', bytes: new Uint8Array([9]) });
    const { worker, sessionId, host } = await fixture({ root, mounting: 'opfs', readOnly: false });
    host.read.mockRejectedValue(new Error('Host also failed'));
    await expect(worker.moveEntries({ request: { sessionId, sourcePaths: ['/input'], targetDirectoryPath: '/target' } })).rejects.toThrow('both Worker and host');
    await expectFile({ directory: root, name: 'input', bytes: new Uint8Array([1]) });
    await expectFile({ directory: target, name: 'input', bytes: new Uint8Array([9]) });
  });

  it('rejects moving onto the same file and copying a directory into itself before truncation', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const bytes = new Uint8Array([255]);
    await writeBytes({ directory: root, name: 'input', bytes });
    const source = await root.getDirectoryHandle('source', { create: true });
    const child = await source.getDirectoryHandle('child', { create: true });
    const { worker, sessionId, host } = await fixture({ root, mounting: 'opfs', readOnly: false });
    await expect(worker.moveEntries({ request: { sessionId, sourcePaths: ['/input'], targetDirectoryPath: '/' } })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await worker.renameEntry({ request: { sessionId, path: '/input', newName: 'input' } });
    await expect(worker.copyEntries({ request: { sessionId, sourcePaths: ['/source'], targetDirectoryPath: '/source/child' } })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await expectFile({ directory: root, name: 'input', bytes });
    await expect(child.getDirectoryHandle('source')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(host.read).not.toHaveBeenCalled();
  });

  it('drains writer abort before either concurrent disposal finishes, without waiting for late host bytes', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const file = await writeBytes({ directory: root, name: 'input', bytes: new Uint8Array([9]) });
    const opened = file.createWritable.bind(file);
    const enteredAbort = Promise.withResolvers<void>();
    const finishAbort = Promise.withResolvers<void>();
    let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(file, 'createWritable').mockImplementation(async () => {
      const writable = await opened();
      close = vi.spyOn(writable, 'close');
      const originalAbort = writable.abort.bind(writable);
      vi.spyOn(writable, 'abort').mockImplementation(async reason => {
        enteredAbort.resolve();
        await finishAbort.promise;
        await originalAbort(reason);
      });
      return writable;
    });
    const { worker, sessionId, host, released } = await fixture({ root, mounting: 'opfs', readOnly: false });
    const late = Promise.withResolvers<Awaited<ReturnType<typeof host.read>>>();
    const originalRead = host.read.getMockImplementation()!;
    host.read.mockImplementationOnce(originalRead).mockReturnValueOnce(late.promise);
    const upload = worker.uploadFiles({ request: { sessionId, targetDirectoryPath: '/', files: [{ name: 'input', blob: new Blob(['late']) }] } });
    const rejection = expect(upload).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(host.read).toHaveBeenCalledTimes(2));
    let finished = 0;
    const first = worker.disposeSession({ request: { sessionId } }).then(() => {
      finished += 1;
    });
    const second = worker.disposeSession({ request: { sessionId } }).then(() => {
      finished += 1;
    });
    await enteredAbort.promise;
    expect(finished).toBe(0);
    finishAbort.resolve();
    await Promise.all([first, second]);
    await rejection;
    expect(released).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    late.reject(new Error('Late physical read failure'));
    await expectFile({ directory: root, name: 'input', bytes: new Uint8Array([9]) });
  });

  it('waits for a delayed source acquisition and creates no target after disposal', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const target = await root.getDirectoryHandle('target', { create: true });
    const source = await writeBytes({ directory: root, name: 'input', bytes: new Uint8Array([1]) });
    const snapshot = await source.getFile();
    const late = Promise.withResolvers<MockFile>();
    const acquisition = vi.spyOn(source, 'getFile').mockReturnValue(late.promise);
    const { worker, sessionId } = await fixture({ root, mounting: 'opfs', readOnly: false });
    const move = worker.moveEntries({ request: { sessionId, sourcePaths: ['/input'], targetDirectoryPath: '/target' } });
    const rejection = expect(move).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(acquisition).toHaveBeenCalledOnce());
    let disposed = false;
    const closing = worker.disposeSession({ request: { sessionId } }).then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    late.resolve(snapshot);
    await closing;
    await rejection;
    expect(await root.getFileHandle('input')).toBe(source);
    await expect(target.getFileHandle('input')).rejects.toMatchObject({ name: 'NotFoundError' });
  });
  it('does not delete the move source when cancellation arrives during destination close', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const target = await root.getDirectoryHandle('target', { create: true });
    await writeBytes({ directory: root, name: 'input', bytes: new Uint8Array([1]) });
    const destination = await writeBytes({ directory: target, name: 'input', bytes: new Uint8Array([9]) });
    const originalOpen = destination.createWritable.bind(destination);
    const closing = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    vi.spyOn(destination, 'createWritable').mockImplementation(async () => {
      const writable = await originalOpen();
      const close = writable.close.bind(writable);
      vi.spyOn(writable, 'close').mockImplementation(async () => {
        closing.resolve();
        await finish.promise;
        await close();
      });
      return writable;
    });
    const { worker, sessionId } = await fixture({ root, mounting: 'opfs', readOnly: false });
    const operation = worker.moveEntries({ request: { sessionId, sourcePaths: ['/input'], targetDirectoryPath: '/target' } });
    const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await closing.promise;
    const disposal = worker.disposeSession({ request: { sessionId } });
    finish.resolve();
    await disposal;
    await rejection;
    // The target close had already started: it can commit, but source deletion must not follow.
    await expectFile({ directory: root, name: 'input', bytes: new Uint8Array([1]) });
    await expectFile({ directory: target, name: 'input', bytes: new Uint8Array([1]) });
  });

  it('uploads through real Comlink using native Blob clone and transferred host buffers', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    const worker = createFileExplorerWorker();
    const channel = new MessageChannel();
    exposeWorkerRemote<IFileExplorerWorker>({ api: worker, endpoint: channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<IFileExplorerWorker>({ endpoint: channel.port2 as unknown as MessagePort });
    const sent: ArrayBuffer[] = [];
    const finalized = vi.fn();
    const host = {
      async read({ blob, offset, length }: { blob: Blob, offset: number, length: number }) {
        const bytes = await nativeRead({ blob, offset, length });
        sent.push(bytes.buffer);
        return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
      },
      [Comlink.finalizer]: finalized,
    };
    let sessionId: string | undefined;
    try {
      ({ sessionId } = await remote.prepareSession(workerCapability({
        value: { request: { root: { kind: 'opfs-root' as const, rootName: 'OPFS' } } },
        capability: 'file-system-handle-clone',
      }), undefined, workerProxy({ value: host })));
      const bytes = sourceBytes({ length: io.BLOB_VIEW_CHUNK_SIZE + 13 });
      await remote.uploadFiles({ request: { sessionId, targetDirectoryPath: '/', files: [{ name: 'transferred.bin', blob: new Blob([bytes]) }] } });
      await expectFile({ directory: root, name: 'transferred.bin', bytes });
      expect(sent).toHaveLength(3); // probe + two data chunks
      expect(sent.every(buffer => buffer.byteLength === 0)).toBe(true);
      await remote.disposeSession({ request: { sessionId } });
      await vi.waitFor(() => expect(finalized).toHaveBeenCalledOnce());
    } finally {
      if (sessionId !== undefined) await worker.disposeSession({ request: { sessionId } });
      releaseWorkerRemote({ remote });
      channel.port1.close(); channel.port2.close();
    }
  });

});
