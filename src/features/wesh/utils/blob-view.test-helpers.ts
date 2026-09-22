import { vi } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFile, MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from '@/features/wesh/utils/test-stream';
import * as io from '@/utils/blob-view-io';
import { createWorkerBlobContext } from '@/utils/worker-blob-context';
import { workerTransfer } from '@/utils/worker-transport';

/** A real File at the fast-path boundary; Mock storage is not claimed to be real OPFS. */
export async function createBlobViewShellFixture() {
  const nativeRead = Blob.prototype.arrayBuffer;
  const mockRead = MockFile.prototype.arrayBuffer;
  const read = vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    const slice = blob.slice(offset, offset + length);
    const buffer = slice instanceof MockFile ? await mockRead.call(slice) : await nativeRead.call(slice);
    const bytes = new Uint8Array(buffer);
    return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
  });
  const blobs = createWorkerBlobContext({ host: { read } });
  const root = new MockFileSystemDirectoryHandle({ name: 'root' });
  const wesh = new Wesh({ rootHandle: root as unknown as FileSystemDirectoryHandle, blobs });
  try {
    await wesh.init();
  } catch (error) {
    blobs.dispose(); throw error;
  }
  return {
    wesh, root, blobs, read,
    async writeFile({ path, data }: { path: string, data: Uint8Array | string }) {
      const parts = path.split('/').filter(Boolean);
      const name = parts.pop();
      if (name === undefined) throw new Error('File name required');
      let folder = root;
      for (const part of parts) folder = await folder.getDirectoryHandle(part, { create: true });
      const file = await folder.getFileHandle(name, { create: true });
      const writable = await file.createWritable();
      await writable.write(data); await writable.close();
      vi.spyOn(file as unknown as FileSystemFileHandle, 'getFile').mockImplementation(async () =>
        new File([file.content.slice().buffer], name, { lastModified: file.lastModified }));
      return file;
    },
    blockNativeReads() {
      const error = new DOMException('Opaque Worker Blob read', 'NotReadableError');
      vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(error);
      for (const prototype of [Blob.prototype, MockFile.prototype]) {
        vi.spyOn(prototype, 'arrayBuffer').mockRejectedValue(error);
        vi.spyOn(prototype, 'text').mockRejectedValue(error);
        vi.spyOn(prototype, 'stream').mockImplementation(() => {
          throw error;
        });
      }
    },
    async execute({ script, stdinText }: { script: string, stdinText: string | undefined }) {
      const stdout = createTestWriteCaptureHandle();
      const stderr = createTestWriteCaptureHandle();
      const result = await wesh.execute({
        source: createTextShellSource({ text: script }),
        stdin: createTestReadHandleFromText({ text: stdinText ?? '' }),
        stdout: stdout.handle, stderr: stderr.handle,
      });
      return { result, stdout, stderr };
    },
    dispose: () => blobs.dispose(),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
