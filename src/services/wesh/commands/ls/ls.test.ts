import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh ls', () => {
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

  it('sorts directory entries by name by default', async () => {
    await writeFile({ path: 'dir/zeta.txt', data: 'z' });
    await writeFile({ path: 'dir/alpha.txt', data: 'a' });
    await writeFile({ path: 'dir/mid.txt', data: 'm' });

    const { result, stdout, stderr } = await execute({
      script: 'ls dir',
    });

    expect(stdout.text).toBe('alpha.txt  mid.txt  zeta.txt  \n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -d to list a directory itself rather than its contents', async () => {
    await writeFile({ path: 'dir/file.txt', data: 'payload' });

    const { result, stdout, stderr } = await execute({
      script: 'ls -d dir',
    });

    expect(stdout.text).toBe('dir\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -F to classify directory and symlink entries', async () => {
    await writeFile({ path: 'dir/file.txt', data: 'payload' });
    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/dir',
    });

    const { result, stdout, stderr } = await execute({
      script: 'ls -F .',
    });

    expect(stdout.text).toContain('dir/');
    expect(stdout.text).toContain('dir.link@');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -a to include dotfiles', async () => {
    await writeFile({ path: '.hidden.txt', data: 'hidden' });
    await writeFile({ path: 'visible.txt', data: 'visible' });

    const hidden = await execute({
      script: 'ls',
    });
    const all = await execute({
      script: 'ls -a',
    });

    expect(hidden.stdout.text).not.toContain('.hidden.txt');
    expect(all.stdout.text).toContain('.hidden.txt');
    expect(all.stdout.text).toContain('visible.txt');
    expect(hidden.stderr.text).toBe('');
    expect(all.stderr.text).toBe('');
    expect(hidden.result.exitCode).toBe(0);
    expect(all.result.exitCode).toBe(0);
  });

  it('lists root-relative paths correctly from /', async () => {
    await writeFile({ path: 'root.txt', data: 'root' });

    const { result, stdout, stderr } = await execute({
      script: 'cd /; ls',
    });

    expect(stdout.text).toContain('root.txt');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -R to list subdirectories recursively', async () => {
    await writeFile({ path: 'tree/root.txt', data: 'root' });
    await writeFile({ path: 'tree/nested/deep.txt', data: 'deep' });

    const { result, stdout, stderr } = await execute({
      script: 'ls -R tree',
    });

    expect(stdout.text).toBe(`\
nested  root.txt  

tree/nested:
deep.txt  
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
