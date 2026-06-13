import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from './index';
import { WeshVFS } from './vfs';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from './utils/test-stream';
import { readAllFileBytes } from './utils/fs';
import type { WeshFileHandle, WeshOpenFlags, WeshStat, WeshVirtualMountProvider } from './types';

function createVirtualFileHandle({ text }: { text: string }): WeshFileHandle {
  const bytes = new TextEncoder().encode(text);
  let cursor = 0;

  return {
    async read({ buffer, offset, length, position }) {
      const bufferOffset = offset ?? 0;
      const start = position ?? cursor;
      const maxLength = length ?? (buffer.length - bufferOffset);
      const end = Math.min(start + maxLength, bytes.length);
      const slice = bytes.subarray(start, end);
      buffer.set(slice, bufferOffset);
      if (position === undefined) {
        cursor = end;
      }
      return { bytesRead: slice.length };
    },
    async write() {
      throw new Error('File is read-only');
    },
    async close() {},
    async stat() {
      return { size: bytes.length, mode: 0o444, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 };
    },
    async truncate() {
      throw new Error('File is read-only');
    },
    async ioctl() {
      return { ret: 0 };
    },
  };
}

function createDirectoryStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 };
}

function createFileStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o444, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 };
}

function createSymlinkStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o777, type: 'symlink', mtime: 0, ino: 0, uid: 0, gid: 0 };
}

describe('wesh vfs mounts', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
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

  it('lists and reads direct mount points from their parent directory', async () => {
    const mountedRoot = new MockFileSystemDirectoryHandle({ name: 'mounted' });
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
    const mountedRoot = new MockFileSystemDirectoryHandle({ name: 'nested' });
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

  it('readDir reports fullPath for synthetic mount parents and mounted directories', async () => {
    const mountedRoot = new MockFileSystemDirectoryHandle({ name: 'work' });
    const fileHandle = await mountedRoot.getFileHandle('note.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('hello');
    await writable.close();

    await wesh.vfs.mount({
      path: '/volumes/work',
      handle: mountedRoot as unknown as FileSystemDirectoryHandle,
      readOnly: false,
    });

    const syntheticEntries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/volumes' })) {
      syntheticEntries.push(entry);
    }
    expect(syntheticEntries).toEqual([
      { name: 'work', type: 'directory', fullPath: '/volumes/work' },
    ]);

    const mountedEntries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/volumes/work' })) {
      mountedEntries.push(entry);
    }
    expect(mountedEntries).toEqual([
      { name: 'note.txt', type: 'file', fullPath: '/volumes/work/note.txt' },
    ]);
  });

  it('readDir reports special-file types without stat fallback', async () => {
    const devEntries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/dev' })) {
      devEntries.push(entry);
    }

    expect(devEntries).toEqual(expect.arrayContaining([
      { name: 'null', type: 'chardev', fullPath: '/dev/null' },
      { name: 'zero', type: 'chardev', fullPath: '/dev/zero' },
    ]));

    const binEntries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/bin' })) {
      binEntries.push(entry);
    }

    expect(binEntries).toEqual(expect.arrayContaining([
      { name: 'sh', type: 'file', fullPath: '/bin/sh' },
      { name: 'bash', type: 'file', fullPath: '/bin/bash' },
    ]));
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

    const data = await readAllFileBytes({ files: wesh.kernel, path: '/append.txt' });
    expect(new TextDecoder().decode(data)).toBe(`\
first
second
`);
  });

  it('rejects unlink and rmdir mutations on read-only mounts', async () => {
    const readOnlyRoot = new MockFileSystemDirectoryHandle({ name: 'readonly' });
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
    const readOnlyRoot = new MockFileSystemDirectoryHandle({ name: 'readonly-open' });
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
    const readOnlyRoot = new MockFileSystemDirectoryHandle({ name: 'readonly-create' });

    await wesh.vfs.mount({
      path: '/ro-create',
      handle: readOnlyRoot as unknown as FileSystemDirectoryHandle,
      readOnly: true,
    });

    await expect(wesh.vfs.mkdir({ path: '/ro-create/subdir', recursive: true })).rejects.toThrow('Read-only fs');
    await expect(wesh.vfs.mknod({ path: '/ro-create/pipe', type: 'fifo' })).rejects.toThrow('Read-only filesystem');
  });

  it('rejects rename when the source or destination filesystem is read-only', async () => {
    const sourceRoot = new MockFileSystemDirectoryHandle({ name: 'readonly-source' });
    const sourceFile = await sourceRoot.getFileHandle('file.txt', { create: true });
    const sourceWritable = await sourceFile.createWritable();
    await sourceWritable.write('source');
    await sourceWritable.close();

    const destinationRoot = new MockFileSystemDirectoryHandle({ name: 'readonly-destination' });
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

    const entries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/real.link' })) entries.push(entry);
    expect(entries).toEqual([{ name: 'child.txt', type: 'file', fullPath: '/real/child.txt' }]);

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
    const entries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/dir' })) entries.push(entry);
    expect(entries).toEqual([{ name: 'keep.txt', type: 'file', fullPath: '/dir/keep.txt' }]);
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
    const treeEntries = [];
    for await (const entry of wesh.vfs.readDir({ path: '/tree' })) treeEntries.push(entry);
    expect(treeEntries.map(entry => entry.name)).toEqual(['leaf.txt']);
  });
});

describe('WeshVFS — getNativeHandle / getReadOnlyForPath / optional root', () => {
  it('getNativeHandle returns a real handle for a mounted directory', async () => {
    const mount = new MockFileSystemDirectoryHandle({ name: 'mount' });
    await mount.getFileHandle('file.txt', { create: true });
    const vfs = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/data', handle: mount as unknown as FileSystemDirectoryHandle, readOnly: false });

    const handle = await vfs.getNativeHandle({ path: '/data' });
    expect(handle).not.toBeNull();
    expect(handle!.kind).toBe('directory');
  });

  it('getNativeHandle returns null for a synthetic intermediate directory', async () => {
    const mount = new MockFileSystemDirectoryHandle({ name: 'mount' });
    const vfs = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/home/user/v1', handle: mount as unknown as FileSystemDirectoryHandle, readOnly: false });

    expect(await vfs.getNativeHandle({ path: '/home' })).toBeNull();
    expect(await vfs.getNativeHandle({ path: '/home/user' })).toBeNull();
  });

  it('getNativeHandle returns a file handle for a real file inside a mount', async () => {
    const mount = new MockFileSystemDirectoryHandle({ name: 'mount' });
    await mount.getFileHandle('note.txt', { create: true });
    const vfs = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/data', handle: mount as unknown as FileSystemDirectoryHandle, readOnly: false });

    const handle = await vfs.getNativeHandle({ path: '/data/note.txt' });
    expect(handle).not.toBeNull();
    expect(handle!.kind).toBe('file');
  });

  it('getReadOnlyForPath returns the mount readOnly flag for paths inside a mount', async () => {
    const m1 = new MockFileSystemDirectoryHandle({ name: 'm1' });
    const m2 = new MockFileSystemDirectoryHandle({ name: 'm2' });
    const vfs = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/home/user/rw', handle: m1 as unknown as FileSystemDirectoryHandle, readOnly: false });
    await vfs.mount({ path: '/home/user/ro', handle: m2 as unknown as FileSystemDirectoryHandle, readOnly: true });

    expect(vfs.getReadOnlyForPath({ path: '/home/user/rw' })).toBe(false);
    expect(vfs.getReadOnlyForPath({ path: '/home/user/ro' })).toBe(true);
  });

  it('getReadOnlyForPath returns true for synthetic directories outside any mount', async () => {
    const mount = new MockFileSystemDirectoryHandle({ name: 'mount' });
    const vfs = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/home/user/v1', handle: mount as unknown as FileSystemDirectoryHandle, readOnly: false });

    expect(vfs.getReadOnlyForPath({ path: '/' })).toBe(true);
    expect(vfs.getReadOnlyForPath({ path: '/home' })).toBe(true);
    expect(vfs.getReadOnlyForPath({ path: '/home/user' })).toBe(true);
  });

  it('VFS with no rootHandle synthesises directories for nested mounts', async () => {
    const v1 = new MockFileSystemDirectoryHandle({ name: 'v1' });
    const v2 = new MockFileSystemDirectoryHandle({ name: 'v2' });
    const vfs = new WeshVFS({ rootHandle: undefined });
    await vfs.mount({ path: '/home/user/v1', handle: v1 as unknown as FileSystemDirectoryHandle, readOnly: false });
    await vfs.mount({ path: '/home/user/v2', handle: v2 as unknown as FileSystemDirectoryHandle, readOnly: true });

    const rootEntries: string[] = [];
    for await (const e of vfs.readDir({ path: '/' })) rootEntries.push(e.name);
    expect(rootEntries).toEqual(['home']);

    const userEntries: string[] = [];
    for await (const e of vfs.readDir({ path: '/home/user' })) userEntries.push(e.name);
    expect(userEntries.sort()).toEqual(['v1', 'v2']);
  });

  it('VFS with no rootHandle does not expose /dev special files', async () => {
    const vfs = new WeshVFS({ rootHandle: undefined });
    const mount = new MockFileSystemDirectoryHandle({ name: 'mount' });
    await vfs.mount({ path: '/data', handle: mount as unknown as FileSystemDirectoryHandle, readOnly: false });

    const rootEntries: string[] = [];
    for await (const e of vfs.readDir({ path: '/' })) rootEntries.push(e.name);
    expect(rootEntries).toEqual(['data']);
    expect(rootEntries).not.toContain('dev');
  });
});

describe('WeshVFS virtual mounts', () => {
  it('exposes virtual mounts through synthetic parent directories', async () => {
    const vfs = new WeshVFS({ rootHandle: undefined });
    const provider: WeshVirtualMountProvider = {
      async open({ path, flags, mode }: { path: string; flags: WeshOpenFlags; mode?: number }) {
        void path;
        void flags;
        void mode;
        return createVirtualFileHandle({ text: '' });
      },
      async stat({ path }: { path: string }) {
        return path === '/sys/fs/naidan'
          ? createDirectoryStat({ size: 0 })
          : createFileStat({ size: 0 });
      },
      async lstat({ path }: { path: string }) {
        return path === '/sys/fs/naidan'
          ? createDirectoryStat({ size: 0 })
          : createFileStat({ size: 0 });
      },
      async *readDir({ path }: { path: string }) {
        if (path === '/sys/fs/naidan') {
          yield { name: 'version', type: 'file', fullPath: '/sys/fs/naidan/version' };
        }
      },
      async readlink({ path }: { path: string }) {
        return path;
      },
    };

    vfs.mountVirtual({
      path: '/sys/fs/naidan',
      readOnly: true,
      provider,
    });

    const rootEntries: string[] = [];
    for await (const entry of vfs.readDir({ path: '/' })) rootEntries.push(entry.name);
    expect(rootEntries).toEqual(['sys']);

    const sysEntries: string[] = [];
    for await (const entry of vfs.readDir({ path: '/sys' })) sysEntries.push(entry.name);
    expect(sysEntries).toEqual(['fs']);

    const fsEntries: string[] = [];
    for await (const entry of vfs.readDir({ path: '/sys/fs' })) fsEntries.push(entry.name);
    expect(fsEntries).toEqual(['naidan']);
  });

  it('delegates file operations to the virtual provider', async () => {
    const vfs = new WeshVFS({ rootHandle: undefined });
    const open = vi.fn(async ({ path }: { path: string; flags: WeshOpenFlags; mode?: number }) => {
      expect(path).toBe('/sys/fs/naidan/version');
      return createVirtualFileHandle({ text: 'naidan-sysfs-v1\n' });
    });
    const stat = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/sys/fs/naidan/current-chat') {
        return createSymlinkStat({ size: '/sys/fs/naidan/chats/chat-1'.length });
      }
      if (path === '/sys/fs/naidan') {
        return createDirectoryStat({ size: 0 });
      }
      return createFileStat({ size: 'naidan-sysfs-v1\n'.length });
    });
    const lstat = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/sys/fs/naidan/current-chat') {
        return createSymlinkStat({ size: '/sys/fs/naidan/chats/chat-1'.length });
      }
      if (path === '/sys/fs/naidan') {
        return createDirectoryStat({ size: 0 });
      }
      return createFileStat({ size: 'naidan-sysfs-v1\n'.length });
    });
    const readlink = vi.fn(async ({ path }: { path: string }) => {
      expect(path).toBe('/sys/fs/naidan/current-chat');
      return '/sys/fs/naidan/chats/chat-1';
    });
    const provider: WeshVirtualMountProvider = {
      open,
      stat,
      lstat,
      async *readDir({ path }: { path: string }) {
        if (path === '/sys/fs/naidan') {
          yield { name: 'version', type: 'file', fullPath: '/sys/fs/naidan/version' };
          yield { name: 'current-chat', type: 'symlink', fullPath: '/sys/fs/naidan/current-chat' };
        }
      },
      readlink,
    };

    vfs.mountVirtual({
      path: '/sys/fs/naidan',
      readOnly: true,
      provider,
    });

    const handle = await vfs.open({
      path: '/sys/fs/naidan/version',
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
    });
    const buffer = new Uint8Array(32);
    const readResult = await handle.read({ buffer });
    await handle.close();

    expect(new TextDecoder().decode(buffer.subarray(0, readResult.bytesRead))).toBe('naidan-sysfs-v1\n');
    expect((await vfs.stat({ path: '/sys/fs/naidan/version' })).type).toBe('file');
    expect((await vfs.lstat({ path: '/sys/fs/naidan/current-chat' })).type).toBe('symlink');
    expect(await vfs.readlink({ path: '/sys/fs/naidan/current-chat' })).toBe('/sys/fs/naidan/chats/chat-1');
    expect(open).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(lstat).toHaveBeenCalledTimes(1);
    expect(readlink).toHaveBeenCalledTimes(1);
  });

  it('treats virtual mounts as read-only and non-native', async () => {
    const vfs = new WeshVFS({ rootHandle: undefined });
    const provider: WeshVirtualMountProvider = {
      async open({ path, flags, mode }: { path: string; flags: WeshOpenFlags; mode?: number }) {
        void path;
        void flags;
        void mode;
        return createVirtualFileHandle({ text: '' });
      },
      async stat({ path }: { path: string }) {
        return path === '/sys/fs/naidan'
          ? createDirectoryStat({ size: 0 })
          : createFileStat({ size: 0 });
      },
      async lstat({ path }: { path: string }) {
        return path === '/sys/fs/naidan'
          ? createDirectoryStat({ size: 0 })
          : createFileStat({ size: 0 });
      },
      async *readDir({ path }: { path: string }) {
        if (path === '/sys/fs/naidan') {
          yield { name: 'version', type: 'file', fullPath: '/sys/fs/naidan/version' };
        }
      },
      async readlink({ path }: { path: string }) {
        return path;
      },
    };

    vfs.mountVirtual({
      path: '/sys/fs/naidan',
      readOnly: true,
      provider,
    });

    expect(await vfs.getNativeHandle({ path: '/sys/fs/naidan' })).toBeNull();
    expect(vfs.getReadOnlyForPath({ path: '/sys/fs/naidan' })).toBe(true);
    await expect(vfs.mkdir({ path: '/sys/fs/naidan/chats', recursive: true })).rejects.toThrow('Read-only filesystem');
    await expect(vfs.mknod({ path: '/sys/fs/naidan/node', type: 'fifo' })).rejects.toThrow('No mount point');
    await expect(vfs.unlink({ path: '/sys/fs/naidan/version' })).rejects.toThrow('Read-only filesystem');
  });
});
