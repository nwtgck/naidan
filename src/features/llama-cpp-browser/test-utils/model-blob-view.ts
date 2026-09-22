import { vi } from 'vitest';
import { MockFileSystemDirectoryHandle, MockFileSystemFileHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import * as io from '@/utils/blob-view-io';
import { createWorkerBlobContext } from '@/utils/worker-blob-context';
import { workerTransfer } from '@/utils/worker-transport';

export function ggufFile({ name, size }: { name: string, size: number }): File {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
  bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
  return new File([bytes], name, { lastModified: 123 });
}

/** Real File snapshots at the byte/clone boundary; storage itself is an in-memory mock. */
export function createModelBlobFixture({ releaseProxy }: { releaseProxy: symbol }) {
  const root = new MockFileSystemDirectoryHandle({ name: 'root' });
  const nativeBuffer = Blob.prototype.arrayBuffer;
  const nativeGetFile = MockFileSystemFileHandle.prototype.getFile;
  vi.spyOn(MockFileSystemFileHandle.prototype as FileSystemFileHandle, 'getFile').mockImplementation(async function (this: MockFileSystemFileHandle) {
    const original = await nativeGetFile.call(this);
    return new File([this.content.slice().buffer], this.name, { lastModified: original.lastModified });
  });
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => root },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- LockManager's positional overload at the test boundary.
    locks: { request: async (_name: string, options: object | (() => Promise<unknown>), operation?: (lock: object) => Promise<unknown>) =>
      typeof options === 'function' ? options() : operation!({}) },
  });
  const contexts: ReturnType<typeof createWorkerBlobContext>[] = [];
  function host() {
    const released = vi.fn();
    const read = vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
      if (released.mock.calls.length) throw new Error('Host already released');
      const bytes = new Uint8Array(await nativeBuffer.call(blob.slice(offset, offset + length)));
      return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
    });
    return { host: Object.assign({ read }, { [releaseProxy]: released }), read, released };
  }
  return {
    root, host,
    async names({ folder }: { folder: FileSystemDirectoryHandle }) {
      const names: string[] = [];
      for await (const [name] of folder.entries()) names.push(name);
      return names.sort();
    },
    context() {
      const connection = host();
      const blobs = createWorkerBlobContext({ host: connection.host });
      contexts.push(blobs);
      return { ...connection, blobs };
    },
    async directory({ path }: { path: string }) {
      let directory = root;
      for (const name of path.split('/').filter(Boolean)) directory = await directory.getDirectoryHandle(name, { create: true });
      return directory;
    },
    async put({ path, bytes }: { path: string, bytes: Uint8Array<ArrayBuffer> | string }) {
      const parts = path.split('/'); const name = parts.pop()!;
      let directory = root;
      for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
      const handle = await directory.getFileHandle(name, { create: true });
      const writer = await handle.createWritable();
      await writer.write(bytes); await writer.close();
      return handle;
    },
    async bytes({ blob }: { blob: Blob }) {
      return new Uint8Array(await nativeBuffer.call(blob));
    },
    blockWorkerReads() {
      const error = new DOMException('Opaque Worker Blob read', 'NotReadableError');
      vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(error);
      vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(error);
      vi.spyOn(Blob.prototype, 'text').mockRejectedValue(error);
      vi.spyOn(Blob.prototype, 'stream').mockImplementation(() => {
        throw error;
      });
    },
    dispose() {
      for (const context of contexts) context.dispose();
    },
  };
}
export const TEST_ONLY = {
};
