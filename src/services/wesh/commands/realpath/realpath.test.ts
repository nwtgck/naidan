import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh realpath', () => {
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

  it('prints help and reports missing operands', async () => {
    const help = await execute({ script: 'realpath --help' });
    const missing = await execute({ script: 'realpath' });

    expect(help.stdout.text).toContain('Print the resolved absolute path name');
    expect(help.stdout.text).toContain('usage: realpath [-e|-m] FILE...');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('realpath: missing operand');
    expect(missing.stderr.text).toContain('usage: realpath [-e|-m] FILE...');
    expect(missing.result.exitCode).toBe(1);
  });

  it('canonicalizes symlinks and can allow a missing leaf with -m', async () => {
    await writeFile({
      path: 'dir/target.txt',
      data: 'payload',
    });
    await wesh.vfs.mkdir({ path: '/dir', recursive: true });
    await wesh.vfs.symlink({
      path: '/alias.txt',
      targetPath: '/dir/target.txt',
    });

    const canonical = await execute({
      script: 'realpath alias.txt',
    });
    const missingLeaf = await execute({
      script: 'realpath -m dir/missing.txt',
    });

    expect(canonical.stderr.text).toBe('');
    expect(canonical.result.exitCode).toBe(0);
    expect(canonical.stdout.text).toBe('/dir/target.txt\n');
    expect(missingLeaf.stderr.text).toBe('');
    expect(missingLeaf.result.exitCode).toBe(0);
    expect(missingLeaf.stdout.text).toBe('/dir/missing.txt\n');
  });
});
