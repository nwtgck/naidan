import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createTextShellSource } from '@/features/wesh/shell/source';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

export async function createGitTestExecutor() {
  const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
  const wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
  await wesh.init();

  return async ({ script }: { script: string }) => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  };
}

export const TEST_ONLY = {
};
