import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from './utils/test-stream';
import { readFile } from './utils/fs';

describe('wesh vfs mounts', () => {
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

  it('lists and reads direct mount points from their parent directory', async () => {
    const mountedRoot = new MockFileSystemDirectoryHandle('mounted');
    const fileHandle = await mountedRoot.getFileHandle('note.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('mounted content');
    await writable.close();

    await wesh.vfs.mount({
      path: '/mnt',
      handle: mountedRoot as unknown as FileSystemDirectoryHandle,
      readOnly: false,
    });

    const listed = await execute({ script: 'ls -F /' });
    expect(listed.stdout.text).toContain('mnt/');
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);

    const read = await execute({ script: 'cat /mnt/note.txt' });
    expect(read.stdout.text).toBe('mounted content');
    expect(read.stderr.text).toBe('');
    expect(read.result.exitCode).toBe(0);
  });

  it('treats synthetic parent directories of nested mounts as readable directories', async () => {
    const mountedRoot = new MockFileSystemDirectoryHandle('nested');
    const fileHandle = await mountedRoot.getFileHandle('hello.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('hello');
    await writable.close();

    await wesh.vfs.mount({
      path: '/volumes/work',
      handle: mountedRoot as unknown as FileSystemDirectoryHandle,
      readOnly: false,
    });

    const listedParent = await execute({ script: 'ls -F /' });
    expect(listedParent.stdout.text).toContain('volumes/');

    const listedSynthetic = await execute({ script: 'ls -F /volumes' });
    expect(listedSynthetic.stdout.text).toContain('work/');
    expect(listedSynthetic.stderr.text).toBe('');
    expect(listedSynthetic.result.exitCode).toBe(0);

    const changed = await execute({ script: 'cd /volumes/work; pwd' });
    expect(changed.stdout.text).toBe('/volumes/work\n');
    expect(changed.stderr.text).toBe('');
    expect(changed.result.exitCode).toBe(0);
  });

  it('lists synthetic special directories like /dev from their parent', async () => {
    const listedRoot = await execute({ script: 'ls -lF /' });
    expect(listedRoot.stdout.text).toContain('dev/');
    expect(listedRoot.stderr.text).toBe('');
    expect(listedRoot.result.exitCode).toBe(0);

    const listedDev = await execute({ script: 'ls -l /dev' });
    expect(listedDev.stdout.text).toContain('null');
    expect(listedDev.stdout.text).toContain('zero');
    expect(listedDev.stderr.text).toBe('');
    expect(listedDev.result.exitCode).toBe(0);

    const changed = await execute({ script: 'cd /dev; pwd' });
    expect(changed.stdout.text).toBe('/dev\n');
    expect(changed.stderr.text).toBe('');
    expect(changed.result.exitCode).toBe(0);
  });

  it('appends with >> without racing back to offset zero', async () => {
    const first = await wesh.vfs.open({
      path: '/append.txt',
      flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
    });
    await first.write({ buffer: new TextEncoder().encode('first\n') });
    await first.close();

    const append = await wesh.vfs.open({
      path: '/append.txt',
      flags: { access: 'write', creation: 'if-needed', truncate: 'preserve', append: 'append' },
    });
    await append.write({ buffer: new TextEncoder().encode('second\n') });
    await append.close();

    const data = await readFile({ files: wesh.kernel, path: '/append.txt' });
    expect(new TextDecoder().decode(data)).toBe('first\nsecond\n');
  });

  it('rejects unlink and rmdir mutations on read-only mounts', async () => {
    const readOnlyRoot = new MockFileSystemDirectoryHandle('readonly');
    const fileHandle = await readOnlyRoot.getFileHandle('locked.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('locked');
    await writable.close();

    await wesh.vfs.mount({
      path: '/ro',
      handle: readOnlyRoot as unknown as FileSystemDirectoryHandle,
      readOnly: true,
    });

    await expect(wesh.vfs.unlink({ path: '/ro/locked.txt' })).rejects.toThrow('Read-only filesystem');
    await expect(wesh.vfs.rmdir({ path: '/ro' })).rejects.toThrow('Cannot remove mount point');
  });

  it('rejects write-oriented opens on read-only mounts', async () => {
    const readOnlyRoot = new MockFileSystemDirectoryHandle('readonly-open');
    const fileHandle = await readOnlyRoot.getFileHandle('existing.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('existing');
    await writable.close();

    await wesh.vfs.mount({
      path: '/ro-open',
      handle: readOnlyRoot as unknown as FileSystemDirectoryHandle,
      readOnly: true,
    });

    await expect(wesh.vfs.open({
      path: '/ro-open/new.txt',
      flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
    })).rejects.toThrow('Read-only file system');

    await expect(wesh.vfs.open({
      path: '/ro-open/existing.txt',
      flags: { access: 'write', creation: 'never', truncate: 'truncate', append: 'preserve' },
    })).rejects.toThrow('File is read-only');

    const readable = await wesh.vfs.open({
      path: '/ro-open/existing.txt',
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
    });
    await readable.close();
  });

  it('rejects mkdir and mknod on read-only mounts', async () => {
    const readOnlyRoot = new MockFileSystemDirectoryHandle('readonly-create');

    await wesh.vfs.mount({
      path: '/ro-create',
      handle: readOnlyRoot as unknown as FileSystemDirectoryHandle,
      readOnly: true,
    });

    await expect(wesh.vfs.mkdir({ path: '/ro-create/subdir', recursive: true })).rejects.toThrow('Read-only fs');
    await expect(wesh.vfs.mknod({ path: '/ro-create/pipe', type: 'fifo' })).rejects.toThrow('Read-only filesystem');
  });

  it('rejects rename when the source or destination filesystem is read-only', async () => {
    const sourceRoot = new MockFileSystemDirectoryHandle('readonly-source');
    const sourceFile = await sourceRoot.getFileHandle('file.txt', { create: true });
    const sourceWritable = await sourceFile.createWritable();
    await sourceWritable.write('source');
    await sourceWritable.close();

    const destinationRoot = new MockFileSystemDirectoryHandle('readonly-destination');
    const destinationDir = await destinationRoot.getDirectoryHandle('dir', { create: true });
    void destinationDir;

    await wesh.vfs.mount({
      path: '/ro-source',
      handle: sourceRoot as unknown as FileSystemDirectoryHandle,
      readOnly: true,
    });
    await wesh.vfs.mount({
      path: '/ro-destination',
      handle: destinationRoot as unknown as FileSystemDirectoryHandle,
      readOnly: true,
    });

    const writableRootFile = await rootHandle.getFileHandle('movable.txt', { create: true });
    const writableRootWritable = await writableRootFile.createWritable();
    await writableRootWritable.write('movable');
    await writableRootWritable.close();

    await expect(wesh.vfs.rename({
      oldPath: '/ro-source/file.txt',
      newPath: '/renamed.txt',
    })).rejects.toThrow('Read-only source');

    await expect(wesh.vfs.rename({
      oldPath: '/movable.txt',
      newPath: '/ro-destination/file.txt',
    })).rejects.toThrow('Read-only destination');
  });

  it('rejects rmdir on regular files', async () => {
    const fileHandle = await rootHandle.getFileHandle('plain.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('plain');
    await writable.close();

    await expect(wesh.vfs.rmdir({ path: '/plain.txt' })).rejects.toThrow('Not a directory');
  });

  it('preserves registry-backed node types across rename', async () => {
    await wesh.vfs.mknod({ path: '/pipe.old', type: 'fifo' });

    await wesh.vfs.rename({ oldPath: '/pipe.old', newPath: '/pipe.new' });

    await expect(wesh.vfs.stat({ path: '/pipe.old' })).rejects.toThrow();

    const stat = await wesh.vfs.stat({ path: '/pipe.new' });
    expect(stat.type).toBe('fifo');

    const listed = await execute({ script: 'ls -lF /' });
    expect(listed.stdout.text).toContain('pipe.new|');
    expect(listed.stderr.text).toBe('');
    expect(listed.result.exitCode).toBe(0);
  });

  it('distinguishes stat from lstat for symlinks and follows symlinks on open', async () => {
    const fileHandle = await rootHandle.getFileHandle('note.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('linked content');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/note.link',
      targetPath: '/note.txt',
    });

    const stat = await wesh.vfs.stat({ path: '/note.link' });
    expect(stat.type).toBe('file');
    expect(stat.size).toBe('linked content'.length);

    const lstat = await wesh.vfs.lstat({ path: '/note.link' });
    expect(lstat.type).toBe('symlink');
    expect(lstat.size).toBe('/note.txt'.length);

    const read = await execute({ script: 'cat /note.link' });
    expect(read.stdout.text).toBe('linked content');
    expect(read.stderr.text).toBe('');
    expect(read.result.exitCode).toBe(0);
  });

  it('follows symlinked directories for readDir and cd', async () => {
    const realDir = await rootHandle.getDirectoryHandle('real', { create: true });
    const nestedFile = await realDir.getFileHandle('child.txt', { create: true });
    const writable = await nestedFile.createWritable();
    await writable.write('child');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/real.link',
      targetPath: '/real',
    });

    const entries = await wesh.vfs.readDir({ path: '/real.link' });
    expect(entries).toEqual([{ name: 'child.txt', type: 'file' }]);

    const changed = await execute({ script: 'cd /real.link; pwd' });
    expect(changed.stdout.text).toBe('/real\n');
    expect(changed.stderr.text).toBe('');
    expect(changed.result.exitCode).toBe(0);
  });

  it('unlinks symlinks without removing their targets and rejects rmdir on symlinks', async () => {
    const realDir = await rootHandle.getDirectoryHandle('dir', { create: true });
    const nestedFile = await realDir.getFileHandle('keep.txt', { create: true });
    const writable = await nestedFile.createWritable();
    await writable.write('keep');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/dir',
    });

    await expect(wesh.vfs.rmdir({ path: '/dir.link' })).rejects.toThrow('Not a directory');

    await wesh.vfs.unlink({ path: '/dir.link' });

    await expect(wesh.vfs.lstat({ path: '/dir.link' })).rejects.toThrow();
    const entries = await wesh.vfs.readDir({ path: '/dir' });
    expect(entries).toEqual([{ name: 'keep.txt', type: 'file' }]);
  });

  it('renames symlinks without renaming their targets', async () => {
    const fileHandle = await rootHandle.getFileHandle('target.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('target');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/target.link',
      targetPath: '/target.txt',
    });

    await wesh.vfs.rename({
      oldPath: '/target.link',
      newPath: '/renamed.link',
    });

    await expect(wesh.vfs.lstat({ path: '/target.link' })).rejects.toThrow();
    expect((await wesh.vfs.lstat({ path: '/renamed.link' })).type).toBe('symlink');
    expect((await wesh.vfs.stat({ path: '/renamed.link' })).type).toBe('file');
    expect((await wesh.vfs.stat({ path: '/target.txt' })).type).toBe('file');
  });

  it('keeps dangling symlinks visible to lstat but not stat/open', async () => {
    await wesh.vfs.symlink({
      path: '/dangling.link',
      targetPath: '/missing.txt',
    });

    const lstat = await wesh.vfs.lstat({ path: '/dangling.link' });
    expect(lstat.type).toBe('symlink');

    await expect(wesh.vfs.stat({ path: '/dangling.link' })).rejects.toThrow();
    await expect(wesh.vfs.open({
      path: '/dangling.link',
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
    })).rejects.toThrow();
  });

  it('rm -r removes a symlinked directory entry without traversing into the target', async () => {
    const realDir = await rootHandle.getDirectoryHandle('tree', { create: true });
    const nestedFile = await realDir.getFileHandle('leaf.txt', { create: true });
    const writable = await nestedFile.createWritable();
    await writable.write('leaf');
    await writable.close();

    await wesh.vfs.symlink({
      path: '/tree.link',
      targetPath: '/tree',
    });

    const removed = await execute({ script: 'rm -r /tree.link' });
    expect(removed.stderr.text).toBe('');
    expect(removed.result.exitCode).toBe(0);

    await expect(wesh.vfs.lstat({ path: '/tree.link' })).rejects.toThrow();
    expect((await wesh.vfs.readDir({ path: '/tree' })).map(entry => entry.name)).toEqual(['leaf.txt']);
  });
});
