import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh rmdir', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function createDir({
    path,
  }: {
    path: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    return dir;
  }

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

  it('removes empty directories', async () => {
    await createDir({ path: 'empty' });

    const { result, stdout, stderr } = await execute({
      script: 'rmdir empty',
    });

    const check = await execute({
      script: 'test -e empty',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(check.result.exitCode).toBe(1);
  });

  it('reports missing operands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'rmdir',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('rmdir: missing operand');
    expect(stderr.text).toContain('usage: rmdir directory...');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(1);
  });

  it('reports non-empty directories and returns non-zero', async () => {
    const dir = await createDir({ path: 'full' });
    const handle = await dir.getFileHandle('file.txt', { create: true });
    const writable = await handle.createWritable();
    await writable.write('alpha\n');
    await writable.close();

    const { result, stdout, stderr } = await execute({
      script: 'rmdir full',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("rmdir: failed to remove 'full':");
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'rmdir --help',
    });

    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Remove empty directories');
    expect(stdout.text).toContain('usage: rmdir directory...');
    expect(stdout.text).toContain('--help');
    expect(result.exitCode).toBe(0);
  });
});
