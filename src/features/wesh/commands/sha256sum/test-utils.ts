import { Wesh } from '@/features/wesh';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createReadHandleFromStream } from '@/features/wesh/utils/stream';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

export interface Sha256sumTestHarness {
  execute({
    script,
    stdinText,
    stdinChunks,
  }: {
    script: string,
    stdinText?: string,
    stdinChunks?: Uint8Array[],
  }): Promise<{
    result: Awaited<ReturnType<Wesh['execute']>>,
    stdout: ReturnType<typeof createTestWriteCaptureHandle>,
    stderr: ReturnType<typeof createTestWriteCaptureHandle>,
  }>,
  writeFile({
    path,
    data,
  }: {
    path: string,
    data: string | Uint8Array,
  }): Promise<void>,
}

export async function createSha256sumTestHarness(): Promise<Sha256sumTestHarness> {
  const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
  const wesh = new Wesh({
    rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
  });
  await wesh.init();

  const writeFile = async ({
    path,
    data,
  }: {
    path: string,
    data: string | Uint8Array,
  }): Promise<void> => {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let directory = rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }

    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  };

  const execute = async ({
    script,
    stdinText,
    stdinChunks,
  }: {
    script: string,
    stdinText?: string,
    stdinChunks?: Uint8Array[],
  }) => {
    if (stdinText !== undefined && stdinChunks !== undefined) {
      throw new Error('stdinText and stdinChunks are mutually exclusive');
    }

    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const stdin = stdinChunks === undefined
      ? createTestReadHandleFromText({ text: stdinText ?? '' })
      : createReadHandleFromStream({
        source: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of stdinChunks) {
              controller.enqueue(new Uint8Array(chunk));
            }
            controller.close();
          },
        }),
      });
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  };

  return { execute, writeFile };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
