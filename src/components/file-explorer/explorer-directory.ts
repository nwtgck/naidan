import type { WeshVFS } from '@/services/wesh/vfs';

/**
 * File-explorer-specific directory abstraction.
 * Independent of FileSystemDirectoryHandle so it can carry metadata (e.g. readOnly)
 * upfront, enabling the UI to reflect permissions before any operation is attempted.
 */
export interface ExplorerDirectory {
  readonly name: string;
  readonly readOnly: boolean;

  children(): AsyncIterable<ExplorerChild>;
  subdir({ name }: { name: string }): Promise<ExplorerDirectory | null>;
  subdirCreate({ name }: { name: string }): Promise<ExplorerDirectory>;
  file({ name }: { name: string }): Promise<FileSystemFileHandle | null>;
  fileCreate({ name }: { name: string }): Promise<FileSystemFileHandle>;
  remove({ name, recursive }: { name: string; recursive: boolean }): Promise<void>;
  isSameAs({ other }: { other: ExplorerDirectory }): Promise<boolean>;
}

export type ExplorerChild =
  | { kind: 'file'; name: string; readOnly: boolean; fileHandle: FileSystemFileHandle }
  | { kind: 'directory'; name: string; readOnly: boolean; directory: ExplorerDirectory };

// ─── FsExplorerDirectory ─────────────────────────────────────────────────────

/**
 * Standard implementation that wraps a real FileSystemDirectoryHandle.
 * Used for both OPFS and host volumes.
 */
export class FsExplorerDirectory implements ExplorerDirectory {
  readonly name: string;
  readonly readOnly: boolean;
  private readonly _handle: FileSystemDirectoryHandle;

  constructor({
    handle,
    readOnly,
    name,
  }: {
    handle: FileSystemDirectoryHandle;
    readOnly: boolean;
    /** Override the display name (defaults to handle.name). */
    name: string | undefined;
  }) {
    this.name = name ?? handle.name;
    this.readOnly = readOnly;
    this._handle = handle;
  }

  /** Returns the underlying handle for use by low-level copy utilities. */
  getRawHandle(): FileSystemDirectoryHandle {
    return this._handle;
  }

  async *children(): AsyncIterable<ExplorerChild> {
    for await (const handle of this._handle.values()) {
      switch (handle.kind) {
      case 'file':
        yield { kind: 'file', name: handle.name, readOnly: this.readOnly, fileHandle: handle as FileSystemFileHandle };
        break;
      case 'directory':
        yield {
          kind: 'directory',
          name: handle.name,
          readOnly: this.readOnly,
          directory: new FsExplorerDirectory({ handle: handle as FileSystemDirectoryHandle, readOnly: this.readOnly, name: undefined }),
        };
        break;
      default: {
        const _ex: never = handle.kind;
        throw new Error(`Unhandled kind: ${_ex}`);
      }
      }
    }
  }

  async subdir({ name }: { name: string }): Promise<ExplorerDirectory | null> {
    try {
      const h = await this._handle.getDirectoryHandle(name);
      return new FsExplorerDirectory({ handle: h, readOnly: this.readOnly, name: undefined });
    } catch {
      return null;
    }
  }

  async subdirCreate({ name }: { name: string }): Promise<ExplorerDirectory> {
    if (this.readOnly) {
      throw new DOMException('Read-only file system', 'NotAllowedError');
    }
    const h = await this._handle.getDirectoryHandle(name, { create: true });
    return new FsExplorerDirectory({ handle: h, readOnly: false, name: undefined });
  }

  async file({ name }: { name: string }): Promise<FileSystemFileHandle | null> {
    try {
      return await this._handle.getFileHandle(name);
    } catch {
      return null;
    }
  }

  async fileCreate({ name }: { name: string }): Promise<FileSystemFileHandle> {
    if (this.readOnly) {
      throw new DOMException('Read-only file system', 'NotAllowedError');
    }
    return this._handle.getFileHandle(name, { create: true });
  }

  async remove({ name, recursive }: { name: string; recursive: boolean }): Promise<void> {
    if (this.readOnly) {
      throw new DOMException('Read-only file system', 'NotAllowedError');
    }
    await this._handle.removeEntry(name, { recursive });
  }

  async isSameAs({ other }: { other: ExplorerDirectory }): Promise<boolean> {
    if (!(other instanceof FsExplorerDirectory)) return false;
    return this._handle.isSameEntry(other._handle);
  }
}

// ─── VfsExplorerDirectory ─────────────────────────────────────────────────────

function joinVfsPath({ base, name }: { base: string; name: string }): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

/**
 * ExplorerDirectory backed by a WeshVFS instance at a given absolute path.
 * Used for the virtual directory levels above actual mount points (e.g. `/home/user`).
 * Always read-only: the VFS hierarchy above mounts cannot be mutated from the explorer.
 * Once the path resolves to a real mount handle, a FsExplorerDirectory is returned instead.
 */
export class VfsExplorerDirectory implements ExplorerDirectory {
  readonly name: string;
  readonly readOnly = true;
  private readonly _vfs: WeshVFS;
  private readonly _path: string;

  constructor({ name, path, vfs }: { name: string; path: string; vfs: WeshVFS }) {
    this.name = name;
    this._path = path;
    this._vfs = vfs;
  }

  async *children(): AsyncIterable<ExplorerChild> {
    for await (const entry of this._vfs.readDir({ path: this._path })) {
      switch (entry.type) {
      case 'directory':
        break;
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        continue;
      default: {
        const _ex: never = entry.type;
        throw new Error(`Unhandled entry type: ${_ex}`);
      }
      }
      const childPath = joinVfsPath({ base: this._path, name: entry.name });
      const native = await this._vfs.getNativeHandle({ path: childPath });
      if (native !== null && native.kind === 'directory') {
        const ro = this._vfs.getReadOnlyForPath({ path: childPath });
        yield {
          kind: 'directory',
          name: entry.name,
          readOnly: ro,
          directory: new FsExplorerDirectory({ handle: native as FileSystemDirectoryHandle, readOnly: ro, name: entry.name }),
        };
      } else {
        yield {
          kind: 'directory',
          name: entry.name,
          readOnly: true,
          directory: new VfsExplorerDirectory({ name: entry.name, path: childPath, vfs: this._vfs }),
        };
      }
    }
  }

  async subdir({ name }: { name: string }): Promise<ExplorerDirectory | null> {
    const childPath = joinVfsPath({ base: this._path, name });
    const stat = await this._vfs.stat({ path: childPath }).catch(() => null);
    if (stat === null || stat.type !== 'directory') return null;
    const native = await this._vfs.getNativeHandle({ path: childPath });
    if (native !== null && native.kind === 'directory') {
      const ro = this._vfs.getReadOnlyForPath({ path: childPath });
      return new FsExplorerDirectory({ handle: native as FileSystemDirectoryHandle, readOnly: ro, name });
    }
    return new VfsExplorerDirectory({ name, path: childPath, vfs: this._vfs });
  }

  subdirCreate(_: { name: string }): Promise<ExplorerDirectory> {
    return Promise.reject(new DOMException('Read-only file system', 'NotAllowedError'));
  }

  file(_: { name: string }): Promise<FileSystemFileHandle | null> {
    return Promise.resolve(null);
  }

  fileCreate(_: { name: string }): Promise<FileSystemFileHandle> {
    return Promise.reject(new DOMException('Read-only file system', 'NotAllowedError'));
  }

  remove(_: { name: string; recursive: boolean }): Promise<void> {
    return Promise.reject(new DOMException('Read-only file system', 'NotAllowedError'));
  }

  isSameAs({ other }: { other: ExplorerDirectory }): Promise<boolean> {
    if (other instanceof VfsExplorerDirectory) {
      return Promise.resolve(this._vfs === other._vfs && this._path === other._path);
    }
    return Promise.resolve(false);
  }
}
