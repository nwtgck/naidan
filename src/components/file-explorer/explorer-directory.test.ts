import { describe, it, expect, vi } from 'vitest';
import { VfsExplorerDirectory, FsExplorerDirectory } from './explorer-directory';
import type { ExplorerChild } from './explorer-directory';
import type { WeshVFS } from '@/services/wesh/vfs';
import type { WeshFileType } from '@/services/wesh/types';

// ---- Helpers ----

function asDir(child: ExplorerChild): Extract<ExplorerChild, { kind: 'directory' }> {
  if (child.kind !== 'directory') throw new Error(`Expected directory child, got ${child.kind}`);
  return child;
}

// ---- Mock WeshVFS ----

type ReadDirEntry = { name: string; type: WeshFileType };

function makeMockVfs({
  readDirEntries = [] as ReadDirEntry[],
  nativeHandles = {} as Record<string, FileSystemHandle | null>,
  readOnlyPaths = {} as Record<string, boolean>,
  statResults = {} as Record<string, { type: WeshFileType } | null>,
} = {}): WeshVFS {
  return {
    async *readDir({ path: _path }: { path: string }) {
      for (const e of readDirEntries) {
        yield e;
      }
    },
    async getNativeHandle({ path }: { path: string }) {
      return nativeHandles[path] ?? null;
    },
    getReadOnlyForPath({ path }: { path: string }) {
      return readOnlyPaths[path] ?? true;
    },
    async stat({ path }: { path: string }) {
      const r = statResults[path];
      if (!r) throw new DOMException('Not found', 'NotFoundError');
      return { size: 0, mode: 0o755, type: r.type, mtime: 0, ino: 0, uid: 0, gid: 0 };
    },
  } as unknown as WeshVFS;
}

function makeFakeDirHandle(name: string): FileSystemDirectoryHandle {
  return { kind: 'directory', name } as unknown as FileSystemDirectoryHandle;
}

// ---- VfsExplorerDirectory.children() ----

describe('VfsExplorerDirectory.children()', () => {
  it('yields FsExplorerDirectory for an entry that resolves to a real native handle', async () => {
    const handle = makeFakeDirHandle('v1');
    const vfs = makeMockVfs({
      readDirEntries: [{ name: 'v1', type: 'directory' }],
      nativeHandles: { '/home/user/v1': handle },
      readOnlyPaths: { '/home/user/v1': false },
    });
    const dir = new VfsExplorerDirectory({ name: 'user', path: '/home/user', vfs });

    const children: ExplorerChild[] = [];
    for await (const child of dir.children()) {
      children.push(child);
    }

    expect(children).toHaveLength(1);
    const child = asDir(children[0]!);
    expect(child.kind).toBe('directory');
    expect(child.name).toBe('v1');
    expect(child.readOnly).toBe(false);
    expect(child.directory).toBeInstanceOf(FsExplorerDirectory);
    // Name override: FsExplorerDirectory should use the VFS segment name, not handle.name
    expect(child.directory.name).toBe('v1');
  });

  it('FsExplorerDirectory created for real mount uses VFS segment name as display name', async () => {
    // Simulate an OPFS handle whose internal name is a volume ID
    const handle = makeFakeDirHandle('opaque-volume-id-1234');
    const vfs = makeMockVfs({
      readDirEntries: [{ name: 'v3', type: 'directory' }],
      nativeHandles: { '/home/user/v3': handle },
      readOnlyPaths: { '/home/user/v3': false },
    });
    const dir = new VfsExplorerDirectory({ name: 'user', path: '/home/user', vfs });

    const children: ExplorerChild[] = [];
    for await (const child of dir.children()) {
      children.push(child);
    }

    const c0 = asDir(children[0]!);
    expect(c0.name).toBe('v3');
    expect(c0.directory.name).toBe('v3');
  });

  it('yields VfsExplorerDirectory for an entry with no native handle (synthetic dir)', async () => {
    const vfs = makeMockVfs({
      readDirEntries: [{ name: 'user', type: 'directory' }],
      nativeHandles: { '/home/user': null },
    });
    const dir = new VfsExplorerDirectory({ name: 'home', path: '/home', vfs });

    const children: ExplorerChild[] = [];
    for await (const child of dir.children()) {
      children.push(child);
    }

    expect(children).toHaveLength(1);
    const child = asDir(children[0]!);
    expect(child.kind).toBe('directory');
    expect(child.name).toBe('user');
    expect(child.readOnly).toBe(true);
    expect(child.directory).toBeInstanceOf(VfsExplorerDirectory);
  });

  it('skips non-directory entries (files, fifos, chardevs, symlinks)', async () => {
    const vfs = makeMockVfs({
      readDirEntries: [
        { name: 'readme.txt', type: 'file' },
        { name: 'pipe', type: 'fifo' },
        { name: 'null', type: 'chardev' },
        { name: 'link', type: 'symlink' },
        { name: 'subdir', type: 'directory' },
      ],
      nativeHandles: { '/root/subdir': null },
    });
    const dir = new VfsExplorerDirectory({ name: 'root', path: '/root', vfs });

    const children: ExplorerChild[] = [];
    for await (const child of dir.children()) {
      children.push(child);
    }

    expect(children).toHaveLength(1);
    expect(children[0]!.name).toBe('subdir');
  });

  it('propagates readOnly flag from vfs.getReadOnlyForPath', async () => {
    const handle = makeFakeDirHandle('ro-mount');
    const vfs = makeMockVfs({
      readDirEntries: [{ name: 'ro-mount', type: 'directory' }],
      nativeHandles: { '/mnt/ro-mount': handle },
      readOnlyPaths: { '/mnt/ro-mount': true },
    });
    const dir = new VfsExplorerDirectory({ name: 'mnt', path: '/mnt', vfs });

    const children: ExplorerChild[] = [];
    for await (const child of dir.children()) {
      children.push(child);
    }

    const c0 = asDir(children[0]!);
    expect(c0.readOnly).toBe(true);
    expect(c0.directory.readOnly).toBe(true);
  });
});

// ---- VfsExplorerDirectory.subdir() ----

describe('VfsExplorerDirectory.subdir()', () => {
  it('returns FsExplorerDirectory when child path resolves to a real handle', async () => {
    const handle = makeFakeDirHandle('v1');
    const vfs = makeMockVfs({
      statResults: { '/home/user/v1': { type: 'directory' } },
      nativeHandles: { '/home/user/v1': handle },
      readOnlyPaths: { '/home/user/v1': false },
    });
    const dir = new VfsExplorerDirectory({ name: 'user', path: '/home/user', vfs });

    const child = await dir.subdir({ name: 'v1' });

    expect(child).toBeInstanceOf(FsExplorerDirectory);
    expect(child!.name).toBe('v1');
    expect(child!.readOnly).toBe(false);
  });

  it('returns VfsExplorerDirectory when child path is synthetic', async () => {
    const vfs = makeMockVfs({
      statResults: { '/home/user': { type: 'directory' } },
      nativeHandles: { '/home/user': null },
    });
    const dir = new VfsExplorerDirectory({ name: 'home', path: '/home', vfs });

    const child = await dir.subdir({ name: 'user' });

    expect(child).toBeInstanceOf(VfsExplorerDirectory);
    expect(child!.name).toBe('user');
  });

  it('returns null when path does not exist', async () => {
    const vfs = makeMockVfs({
      statResults: {},  // stat will throw
    });
    const dir = new VfsExplorerDirectory({ name: 'home', path: '/home', vfs });

    const child = await dir.subdir({ name: 'nonexistent' });

    expect(child).toBeNull();
  });

  it('returns null when path exists but is not a directory', async () => {
    const vfs = makeMockVfs({
      statResults: { '/home/file.txt': { type: 'file' } },
    });
    const dir = new VfsExplorerDirectory({ name: 'home', path: '/home', vfs });

    const child = await dir.subdir({ name: 'file.txt' });

    expect(child).toBeNull();
  });
});

// ---- VfsExplorerDirectory — write operations rejected ----

describe('VfsExplorerDirectory write operations', () => {
  const dir = new VfsExplorerDirectory({
    name: 'test',
    path: '/test',
    vfs: makeMockVfs(),
  });

  it('subdirCreate rejects with NotAllowedError', async () => {
    await expect(dir.subdirCreate({ name: 'new' })).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('fileCreate rejects with NotAllowedError', async () => {
    await expect(dir.fileCreate({ name: 'new.txt' })).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('remove rejects with NotAllowedError', async () => {
    await expect(dir.remove({ name: 'x', recursive: false })).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('file always resolves to null', async () => {
    await expect(dir.file({ name: 'anything' })).resolves.toBeNull();
  });
});

// ---- VfsExplorerDirectory.isSameAs() ----

describe('VfsExplorerDirectory.isSameAs()', () => {
  const vfs = makeMockVfs();

  it('returns true for same vfs instance and same path', async () => {
    const a = new VfsExplorerDirectory({ name: 'x', path: '/a', vfs });
    const b = new VfsExplorerDirectory({ name: 'x', path: '/a', vfs });
    expect(await a.isSameAs({ other: b })).toBe(true);
  });

  it('returns false for different paths', async () => {
    const a = new VfsExplorerDirectory({ name: 'a', path: '/a', vfs });
    const b = new VfsExplorerDirectory({ name: 'b', path: '/b', vfs });
    expect(await a.isSameAs({ other: b })).toBe(false);
  });

  it('returns false for different vfs instances', async () => {
    const vfs2 = makeMockVfs();
    const a = new VfsExplorerDirectory({ name: 'x', path: '/a', vfs });
    const b = new VfsExplorerDirectory({ name: 'x', path: '/a', vfs: vfs2 });
    expect(await a.isSameAs({ other: b })).toBe(false);
  });

  it('returns false when compared to a non-VfsExplorerDirectory', async () => {
    const a = new VfsExplorerDirectory({ name: 'x', path: '/a', vfs });
    const other = { name: 'x', readOnly: false } as unknown as FsExplorerDirectory;
    expect(await a.isSameAs({ other })).toBe(false);
  });
});

// ---- VfsExplorerDirectory path joining ----

describe('VfsExplorerDirectory path joining', () => {
  it('joins correctly from root path "/"', async () => {
    const statSpy = vi.fn().mockRejectedValue(new DOMException('Not found', 'NotFoundError'));
    const vfs = { ...makeMockVfs(), stat: statSpy } as unknown as WeshVFS;
    const dir = new VfsExplorerDirectory({ name: '/', path: '/', vfs });
    await dir.subdir({ name: 'home' });
    expect(statSpy).toHaveBeenCalledWith({ path: '/home' });
  });

  it('joins correctly from non-root path', async () => {
    const statSpy = vi.fn().mockRejectedValue(new DOMException('Not found', 'NotFoundError'));
    const vfs = { ...makeMockVfs(), stat: statSpy } as unknown as WeshVFS;
    const dir = new VfsExplorerDirectory({ name: 'user', path: '/home/user', vfs });
    await dir.subdir({ name: 'v1' });
    expect(statSpy).toHaveBeenCalledWith({ path: '/home/user/v1' });
  });
});
