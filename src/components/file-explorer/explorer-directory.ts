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
  | { kind: 'file'; name: string; fileHandle: FileSystemFileHandle }
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
  }: {
    handle: FileSystemDirectoryHandle;
    readOnly: boolean;
  }) {
    this.name = handle.name;
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
        yield { kind: 'file', name: handle.name, fileHandle: handle as FileSystemFileHandle };
        break;
      case 'directory':
        yield {
          kind: 'directory',
          name: handle.name,
          readOnly: this.readOnly,
          directory: new FsExplorerDirectory({ handle: handle as FileSystemDirectoryHandle, readOnly: this.readOnly }),
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
      return new FsExplorerDirectory({ handle: h, readOnly: this.readOnly });
    } catch {
      return null;
    }
  }

  async subdirCreate({ name }: { name: string }): Promise<ExplorerDirectory> {
    if (this.readOnly) {
      throw new DOMException('Read-only file system', 'NotAllowedError');
    }
    const h = await this._handle.getDirectoryHandle(name, { create: true });
    return new FsExplorerDirectory({ handle: h, readOnly: false });
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

// ─── MountExplorerDirectory ───────────────────────────────────────────────────

/**
 * Top-level directory for a single chat mount.
 * Overrides name with the mount path's last segment (e.g. "v1"),
 * and reflects mount.readOnly for the volume.
 */
export class MountExplorerDirectory implements ExplorerDirectory {
  readonly name: string;
  readonly readOnly: boolean;
  private readonly _inner: FsExplorerDirectory;

  constructor({
    name,
    handle,
    readOnly,
  }: {
    name: string;
    handle: FileSystemDirectoryHandle;
    readOnly: boolean;
  }) {
    this.name = name;
    this.readOnly = readOnly;
    this._inner = new FsExplorerDirectory({ handle, readOnly });
  }

  getRawHandle(): FileSystemDirectoryHandle {
    return this._inner.getRawHandle();
  }

  children(): AsyncIterable<ExplorerChild> {
    return this._inner.children();
  }

  subdir({ name }: { name: string }): Promise<ExplorerDirectory | null> {
    return this._inner.subdir({ name });
  }

  subdirCreate({ name }: { name: string }): Promise<ExplorerDirectory> {
    return this._inner.subdirCreate({ name });
  }

  file({ name }: { name: string }): Promise<FileSystemFileHandle | null> {
    return this._inner.file({ name });
  }

  fileCreate({ name }: { name: string }): Promise<FileSystemFileHandle> {
    return this._inner.fileCreate({ name });
  }

  remove({ name, recursive }: { name: string; recursive: boolean }): Promise<void> {
    return this._inner.remove({ name, recursive });
  }

  async isSameAs({ other }: { other: ExplorerDirectory }): Promise<boolean> {
    if (other instanceof MountExplorerDirectory) {
      return this._inner.isSameAs({ other: other._inner });
    }
    return false;
  }
}

// ─── VirtualMountRoot ─────────────────────────────────────────────────────────

/**
 * Virtual root directory representing all chat mounts (analogous to /home/user/).
 * Lists each mount as a child directory. Write operations are always rejected.
 */
export class VirtualMountRoot implements ExplorerDirectory {
  readonly name = 'home/user';
  readonly readOnly = true;
  private readonly _children: Map<string, MountExplorerDirectory>;

  constructor({ children }: { children: Map<string, MountExplorerDirectory> }) {
    this._children = children;
  }

  async *children(): AsyncIterable<ExplorerChild> {
    for (const [, dir] of this._children) {
      yield { kind: 'directory', name: dir.name, readOnly: dir.readOnly, directory: dir };
    }
  }

  async subdir({ name }: { name: string }): Promise<ExplorerDirectory | null> {
    return this._children.get(name) ?? null;
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

  isSameAs(_: { other: ExplorerDirectory }): Promise<boolean> {
    return Promise.resolve(false);
  }
}
