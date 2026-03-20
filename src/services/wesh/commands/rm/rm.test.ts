import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh rm', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string;
    data: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({
    script,
  }: {
    script: string;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('returns non-zero when removing a directory without -r', async () => {
    await writeFile({ path: 'tree/file.txt', data: 'payload' });

    const { result, stdout, stderr } = await execute({
      script: `\
rm tree
echo $?`,
    });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toContain("rm: cannot remove 'tree': is a directory");
    expect(result.exitCode).toBe(0);
  });

  it('supports -f for missing operands without reporting errors', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
rm -f missing.txt
echo $?`,
    });

    expect(stdout.text).toBe('0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --recursive and --force long options', async () => {
    await writeFile({ path: 'tree/file.txt', data: 'payload' });

    const recursive = await execute({
      script: `\
rm --recursive tree
test -e tree
echo $?`,
    });
    const force = await execute({
      script: `\
rm --force missing.txt
echo $?`,
    });

    expect(recursive.stdout.text).toBe('1\n');
    expect(recursive.stderr.text).toBe('');
    expect(recursive.result.exitCode).toBe(0);
    expect(force.stdout.text).toBe('0\n');
    expect(force.stderr.text).toBe('');
    expect(force.result.exitCode).toBe(0);
  });
});
