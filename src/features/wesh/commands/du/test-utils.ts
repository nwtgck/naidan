import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

export interface DuTestContext {
  wesh: Wesh,
  rootHandle: MockFileSystemDirectoryHandle,
}

export async function createDuTestContext(): Promise<DuTestContext> {
  const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
  const wesh = new Wesh({
    rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
  });
  await wesh.init();
  return { wesh, rootHandle };
}

export async function writeDuTestFile({
  rootHandle,
  path,
  data,
}: {
  rootHandle: MockFileSystemDirectoryHandle,
  path: string,
  data: string,
}): Promise<void> {
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
}

export async function makeDuTestDirectory({
  rootHandle,
  path,
}: {
  rootHandle: MockFileSystemDirectoryHandle,
  path: string,
}): Promise<void> {
  const segments = path.split('/').filter(Boolean);
  let directory = rootHandle;
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment, { create: true });
  }
}

export async function executeDuTest({
  wesh,
  script,
  stdin,
}: {
  wesh: Wesh,
  script: string,
  stdin: string,
}) {
  const stdout = createTestWriteCaptureHandle();
  const stderr = createTestWriteCaptureHandle();
  const result = await wesh.execute({
    script,
    stdin: createTestReadHandleFromText({ text: stdin }),
    stdout: stdout.handle,
    stderr: stderr.handle,
  });
  return { result, stdout, stderr };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
