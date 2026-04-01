import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh mkdir', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
  }: {
    script: string;
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('creates nested directories with -p', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
mkdir -p a/b/c
test -d a/b/c
echo $?`,
    });

    expect(stdout.text).toBe('0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --parents as a long option alias', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
mkdir --parents nested/a/b
test -d nested/a/b
echo $?`,
    });

    expect(stdout.text).toBe('0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports errors and returns non-zero on failure', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
mkdir missing/child
echo $?`,
    });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toContain("mkdir: cannot create directory 'missing/child':");
    expect(result.exitCode).toBe(0);
  });
});
