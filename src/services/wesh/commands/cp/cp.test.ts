import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh cp', () => {
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

  async function mkdir({
    path,
  }: {
    path: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
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

  it('copies a regular file by default', async () => {
    await writeFile({ path: 'source.txt', data: 'source-data' });

    const copied = await execute({
      script: `\
cp source.txt copied.txt
cat copied.txt`,
    });

    expect(copied.stdout.text).toBe('source-data');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/copied.txt' })).type).toBe('file');
  });

  it('follows source symlinks by default for non-recursive copies', async () => {
    await writeFile({ path: 'source.txt', data: 'source-data' });
    await wesh.vfs.symlink({
      path: '/source.link',
      targetPath: '/source.txt',
    });

    const copied = await execute({
      script: `\
cp source.link copied.txt
cat copied.txt`,
    });

    expect(copied.stdout.text).toBe('source-data');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/copied.txt' })).type).toBe('file');
  });

  it('supports -P to preserve source symlinks', async () => {
    await writeFile({ path: 'origin.txt', data: 'origin-data' });
    await wesh.vfs.symlink({
      path: '/origin.link',
      targetPath: '/origin.txt',
    });

    const copied = await execute({
      script: `\
cp -P origin.link preserved.link
readlink preserved.link`,
    });

    expect(copied.stdout.text).toBe('/origin.txt\n');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/preserved.link' })).type).toBe('symlink');
  });

  it('supports -R to copy directories recursively', async () => {
    await writeFile({ path: 'tree/sub/file.txt', data: 'nested' });

    const copied = await execute({
      script: `\
cp -R tree copied
cat copied/sub/file.txt`,
    });

    expect(copied.stdout.text).toBe('nested');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('preserves directory symlinks by default under -R', async () => {
    await writeFile({ path: 'target/nested.txt', data: 'nested' });
    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/target',
    });

    const copied = await execute({
      script: `\
cp -R dir.link copied.link
readlink copied.link`,
    });

    expect(copied.stdout.text).toBe('/target\n');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/copied.link' })).type).toBe('symlink');
  });

  it('supports -RL to follow directory symlinks recursively', async () => {
    await writeFile({ path: 'real/sub/deep.txt', data: 'deep' });
    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/real',
    });

    const copied = await execute({
      script: `\
cp -RL dir.link copied
cat copied/sub/deep.txt`,
    });

    expect(copied.stdout.text).toBe('deep');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/copied' })).type).toBe('directory');
  });

  it('supports -H to follow only command-line symlinks', async () => {
    await writeFile({ path: 'real/item.txt', data: 'item' });
    await mkdir({ path: 'tree' });
    await wesh.vfs.symlink({
      path: '/tree.link',
      targetPath: '/tree',
    });
    await wesh.vfs.symlink({
      path: '/tree/child.link',
      targetPath: '/real',
    });

    const copied = await execute({
      script: `\
cp -RH tree.link copied
readlink copied/child.link`,
    });

    expect(copied.stdout.text).toBe('/real\n');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports -t for multiple sources into a destination directory', async () => {
    await writeFile({ path: 'first.txt', data: 'first' });
    await writeFile({ path: 'second.txt', data: 'second' });
    await mkdir({ path: 'out' });

    const copied = await execute({
      script: `\
cp -t out first.txt second.txt
cat out/first.txt
cat out/second.txt`,
    });

    expect(copied.stdout.text).toBe('firstsecond');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports --target-directory as a long option alias', async () => {
    await writeFile({ path: 'first.txt', data: 'first' });
    await writeFile({ path: 'second.txt', data: 'second' });
    await mkdir({ path: 'out' });

    const copied = await execute({
      script: `\
cp --target-directory=out first.txt second.txt
cat out/first.txt
cat out/second.txt`,
    });

    expect(copied.stdout.text).toBe('firstsecond');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports -T to force treating the destination as a normal file path', async () => {
    await writeFile({ path: 'plain.txt', data: 'plain' });

    const copied = await execute({
      script: `\
cp -T plain.txt explicit.out
cat explicit.out`,
    });

    expect(copied.stdout.text).toBe('plain');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports --no-target-directory as a long option alias', async () => {
    await writeFile({ path: 'plain.txt', data: 'plain' });

    const copied = await execute({
      script: `\
cp --no-target-directory plain.txt explicit.out
cat explicit.out`,
    });

    expect(copied.stdout.text).toBe('plain');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports -n to skip overwriting an existing destination', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'dest.txt', data: 'dest' });

    const copied = await execute({
      script: `\
cp -n source.txt dest.txt
cat dest.txt`,
    });

    expect(copied.stdout.text).toBe('dest');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports --no-clobber as a long option alias', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'dest.txt', data: 'dest' });

    const copied = await execute({
      script: `\
cp --no-clobber source.txt dest.txt
cat dest.txt`,
    });

    expect(copied.stdout.text).toBe('dest');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports -f to replace an existing symlink destination', async () => {
    await writeFile({ path: 'source.txt', data: 'source' });
    await writeFile({ path: 'existing.txt', data: 'existing' });
    await wesh.vfs.symlink({
      path: '/dest.link',
      targetPath: '/existing.txt',
    });

    const copied = await execute({
      script: `\
cp -f source.txt dest.link
cat dest.link`,
    });

    expect(copied.stdout.text).toBe('source');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/dest.link' })).type).toBe('file');
  });

  it('supports -a as archive shorthand for recursive physical symlink copies', async () => {
    await writeFile({ path: 'target/sub/file.txt', data: 'payload' });
    await wesh.vfs.symlink({
      path: '/archive.link',
      targetPath: '/target',
    });

    const copied = await execute({
      script: `\
cp -a archive.link archived.link
readlink archived.link`,
    });

    expect(copied.stdout.text).toBe('/target\n');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/archived.link' })).type).toBe('symlink');
  });

  it('reports directories without -R', async () => {
    await writeFile({ path: 'tree/file.txt', data: 'payload' });

    const copied = await execute({
      script: 'cp tree copied',
    });

    expect(copied.stdout.text).toBe('');
    expect(copied.stderr.text).toContain("-r not specified; omitting directory '/tree'");
    expect(copied.result.exitCode).toBe(1);
  });

  it('reports non-directory targets for multiple sources', async () => {
    await writeFile({ path: 'first.txt', data: 'first' });
    await writeFile({ path: 'second.txt', data: 'second' });
    await writeFile({ path: 'dest.txt', data: 'dest' });

    const copied = await execute({
      script: 'cp first.txt second.txt dest.txt',
    });

    expect(copied.stdout.text).toBe('');
    expect(copied.stderr.text).toContain("target 'dest.txt' is not a directory");
    expect(copied.result.exitCode).toBe(1);
  });

  it('reports extra operands with -T', async () => {
    await writeFile({ path: 'first.txt', data: 'first' });
    await writeFile({ path: 'second.txt', data: 'second' });

    const copied = await execute({
      script: 'cp -T first.txt second.txt dest.txt',
    });

    expect(copied.stdout.text).toBe('');
    expect(copied.stderr.text).toContain('cp: extra operand with -T');
    expect(copied.stderr.text).toContain('usage: cp');
    expect(copied.result.exitCode).toBe(1);
  });

  it('continues after a missing source when copying multiple files into a directory', async () => {
    await writeFile({ path: 'present.txt', data: 'present' });
    await mkdir({ path: 'dest' });

    const copied = await execute({
      script: `\
cp -t dest missing.txt present.txt
echo $?
cat dest/present.txt`,
    });

    expect(copied.stdout.text).toBe('1\npresent');
    expect(copied.stderr.text).toContain('cp: missing.txt:');
    expect(copied.result.exitCode).toBe(0);
  });

  it('supports root-relative source and destination paths from /', async () => {
    await writeFile({ path: 'root-source.txt', data: 'root-data' });

    const copied = await execute({
      script: `\
cd /
cp root-source.txt root-dest.txt
cat /root-dest.txt`,
    });

    expect(copied.stdout.text).toBe('root-data');
    expect(copied.stderr.text).toBe('');
    expect(copied.result.exitCode).toBe(0);
  });
});
