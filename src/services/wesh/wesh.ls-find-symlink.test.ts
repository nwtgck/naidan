import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from './utils/test-stream';

describe('wesh ls/find symlink semantics', () => {
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

  it('ls switches symlink treatment with -P, -H, and -L', async () => {
    const realDir = await rootHandle.getDirectoryHandle('real', { create: true });
    const child = await realDir.getFileHandle('child.txt', { create: true });
    const writable = await child.createWritable();
    await writable.write('child');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/real',
    });

    const physical = await execute({ script: 'ls -lP dir.link' });
    expect(physical.stdout.text).toBe('l          5 dir.link -> /real\n');
    expect(physical.stderr.text).toBe('');
    expect(physical.result.exitCode).toBe(0);

    const commandLine = await execute({ script: 'ls -lH dir.link' });
    expect(commandLine.stdout.text).toContain('child.txt');
    expect(commandLine.stderr.text).toBe('');
    expect(commandLine.result.exitCode).toBe(0);

    const logical = await execute({ script: 'ls -lL dir.link' });
    expect(logical.stdout.text).toContain('child.txt');
    expect(logical.stderr.text).toBe('');
    expect(logical.result.exitCode).toBe(0);
  });

  it('find -P keeps command-line symlinks as links while -H and -L follow them', async () => {
    const realDir = await rootHandle.getDirectoryHandle('tree', { create: true });
    const leaf = await realDir.getFileHandle('leaf.txt', { create: true });
    const writable = await leaf.createWritable();
    await writable.write('leaf');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/tree.link',
      targetPath: '/tree',
    });

    const physical = await execute({ script: 'find -P tree.link -type l -print' });
    expect(physical.stdout.text).toBe('tree.link\n');
    expect(physical.stderr.text).toBe('');
    expect(physical.result.exitCode).toBe(0);

    const commandLine = await execute({ script: 'find -H tree.link -type f -print' });
    expect(commandLine.stdout.text).toBe('tree.link/leaf.txt\n');
    expect(commandLine.stderr.text).toBe('');
    expect(commandLine.result.exitCode).toBe(0);

    const logical = await execute({
      script: `\
find -L tree.link -type f -print
find -L . -type l -print`,
    });
    expect(logical.stdout.text).toContain('tree.link/leaf.txt');
    expect(logical.stdout.text).not.toContain('tree.link\n');
    expect(logical.stderr.text).toBe('');
    expect(logical.result.exitCode).toBe(0);
  });

  it('find -L follows symlinked directories encountered during traversal while -P does not', async () => {
    const realDir = await rootHandle.getDirectoryHandle('target', { create: true });
    const fileHandle = await realDir.getFileHandle('inside.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('inside');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/nested.link',
      targetPath: '/target',
    });

    const physical = await execute({ script: 'find -P . -type f -print' });
    expect(physical.stdout.text).toContain('./target/inside.txt');
    expect(physical.stdout.text).not.toContain('./nested.link/inside.txt');
    expect(physical.stderr.text).toBe('');
    expect(physical.result.exitCode).toBe(0);

    const logical = await execute({ script: 'find -L . -type f -print' });
    expect(logical.stdout.text).toContain('./target/inside.txt');
    expect(logical.stdout.text).toContain('./nested.link/inside.txt');
    expect(logical.stderr.text).toBe('');
    expect(logical.result.exitCode).toBe(0);
  });

  it('find -H follows only command-line symlinks, not symlinks found later', async () => {
    await rootHandle.getDirectoryHandle('rootdir', { create: true });
    const targetDir = await rootHandle.getDirectoryHandle('shared', { create: true });
    const fileHandle = await targetDir.getFileHandle('item.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('item');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/root.link',
      targetPath: '/rootdir',
    });
    await wesh.vfs.symlink({
      path: '/rootdir/child.link',
      targetPath: '/shared',
    });

    const commandLine = await execute({ script: 'find -H root.link -type f -print' });
    expect(commandLine.stdout.text).not.toContain('root.link/child.link/item.txt');
    expect(commandLine.stderr.text).toBe('');
    expect(commandLine.result.exitCode).toBe(0);

    const logical = await execute({ script: 'find -L root.link -type f -print' });
    expect(logical.stdout.text).toContain('root.link/child.link/item.txt');
    expect(logical.stderr.text).toBe('');
    expect(logical.result.exitCode).toBe(0);
  });
});
