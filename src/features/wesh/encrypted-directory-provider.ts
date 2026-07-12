import type { StorageVolumeAccess } from '@/00-storage/service/volume-access';
import { EncryptedFileStore } from '@/00-storage/service/opfs-encryption/encrypted-file-store';
import { EncryptedFileSystemStore } from '@/00-storage/service/opfs-encryption/encrypted-file-system-store';
import { EncryptedObjectStore } from '@/00-storage/service/opfs-encryption/encrypted-object-store';
import type {
  WeshDirEntry,
  WeshFileHandle,
  WeshIOResult,
  WeshOpenFlags,
  WeshStat,
  WeshVirtualMountProvider,
  WeshWriteResult,
} from '@/features/wesh/types';

const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;
const SYMLINK_MODE = 0o777;

type EncryptedResolvedEntry = Awaited<
  ReturnType<EncryptedFileSystemStore['resolve']>
>['entry'];

type EncryptedSymlinkEntry = Extract<
  NonNullable<EncryptedResolvedEntry>,
  { type: 'symlink' }
>;

function requireFileEntry({
  entry,
  path,
}: {
  entry: EncryptedResolvedEntry,
  path: string,
}): Extract<NonNullable<EncryptedResolvedEntry>, { type: 'file' }> {
  if (entry === undefined) {
    throw new Error(`Encrypted filesystem path is not a file: ${path}`);
  }
  switch (entry.type) {
  case 'file':
    return entry;
  case 'directory':
  case 'symlink':
    throw new Error(`Encrypted filesystem path is not a file: ${path}`);
  default: {
    const _ex: never = entry;
    throw new Error(
      `Unhandled encrypted filesystem entry: ${((_ex satisfies never) as { readonly type: string }).type}`,
    );
  }
  }
}

function requireSymlinkEntry({
  entry,
  path,
}: {
  entry: EncryptedResolvedEntry,
  path: string,
}): EncryptedSymlinkEntry {
  if (entry === undefined) {
    throw new Error(`Encrypted filesystem path is not a symlink: ${path}`);
  }
  switch (entry.type) {
  case 'symlink':
    return entry;
  case 'file':
  case 'directory':
    throw new Error(`Encrypted filesystem path is not a symlink: ${path}`);
  default: {
    const _ex: never = entry;
    throw new Error(
      `Unhandled encrypted filesystem entry: ${((_ex satisfies never) as { readonly type: string }).type}`,
    );
  }
  }
}

function getDirectoryId({
  entry,
  rootDirectoryId,
  path,
}: {
  entry: EncryptedResolvedEntry,
  rootDirectoryId: string,
  path: string,
}): string {
  if (entry === undefined) {
    return rootDirectoryId;
  }
  switch (entry.type) {
  case 'directory':
    return entry.directoryId;
  case 'file':
  case 'symlink':
    throw new Error(`Encrypted filesystem path is not a directory: ${path}`);
  default: {
    const _ex: never = entry;
    throw new Error(
      `Unhandled encrypted filesystem entry: ${((_ex satisfies never) as { readonly type: string }).type}`,
    );
  }
  }
}

function shouldAppend({ append }: { append: WeshOpenFlags['append'] }): boolean {
  switch (append) {
  case 'append':
    return true;
  case 'preserve':
    return false;
  default: {
    const _ex: never = append;
    throw new Error(`Unhandled Wesh append mode: ${_ex}`);
  }
  }
}

function normalizePath({ path }: { path: string }): string {
  const parts = path.split('/').filter(part => part !== '' && part !== '.');
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return `/${normalized.join('/')}`;
}

function dirname({ path }: { path: string }): string {
  const normalized = normalizePath({ path });
  if (normalized === '/') {
    return '/';
  }
  const parts = normalized.split('/');
  parts.pop();
  return parts.join('/') || '/';
}

function resolveSymlinkTarget({
  linkPath,
  targetPath,
}: {
  linkPath: string,
  targetPath: string,
}): string {
  return normalizePath({
    path: targetPath.startsWith('/')
      ? targetPath
      : `${dirname({ path: linkPath })}/${targetPath}`,
  });
}

function createStat({
  type,
  size,
  mtime,
}: {
  type: WeshStat['type'],
  size: number,
  mtime: number,
}): WeshStat {
  const mode = (() => {
    switch (type) {
    case 'file':
      return FILE_MODE;
    case 'directory':
      return DIRECTORY_MODE;
    case 'symlink':
      return SYMLINK_MODE;
    case 'fifo':
    case 'chardev':
      return FILE_MODE;
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled encrypted Wesh stat type: ${String(_ex)}`);
    }
    }
  })();
  return {
    type,
    size,
    mtime,
    mode,
    ino: 0,
    uid: 0,
    gid: 0,
  };
}

class EncryptedDirectoryFileHandle implements WeshFileHandle {
  constructor({
    fileStore,
    fileId,
    displayPath,
    append,
  }: {
    fileStore: EncryptedFileStore,
    fileId: string,
    displayPath: string,
    append: boolean,
  }) {
    this.fileStore = fileStore;
    this.fileId = fileId;
    this.displayPath = displayPath;
    this.append = append;
  }

  private readonly fileStore: EncryptedFileStore;
  private readonly fileId: string;
  private readonly displayPath: string;
  private readonly append: boolean;
  private cursor = 0;

  async read({
    buffer,
    offset: requestedOffset,
    length: requestedLength,
    position,
  }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshIOResult> {
    const offset = requestedOffset ?? 0;
    const length = requestedLength ?? buffer.byteLength - offset;
    const readPosition = position ?? this.cursor;
    const reader = await this.fileStore.open({
      fileId: this.fileId,
      mimeType: 'application/octet-stream',
    });
    if (reader === null) {
      throw new Error(`Encrypted filesystem file is missing: ${this.displayPath}`);
    }
    try {
      const result = await reader.read({
        buffer,
        offset,
        length,
        position: readPosition,
        signal: undefined,
      });
      if (position === undefined) {
        this.cursor += result.bytesRead;
      }
      return result;
    } finally {
      await reader.close();
    }
  }

  async write({
    buffer,
    offset: requestedOffset,
    length: requestedLength,
    position,
  }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshWriteResult> {
    const offset = requestedOffset ?? 0;
    const length = requestedLength ?? buffer.byteLength - offset;
    const manifest = await this.fileStore.readManifest({ fileId: this.fileId });
    if (manifest === undefined) {
      throw new Error(`Encrypted filesystem file is missing: ${this.displayPath}`);
    }
    const writePosition = this.append
      ? manifest.size
      : position ?? this.cursor;
    const bytes = buffer.slice(offset, offset + length);
    await this.fileStore.writeRange({
      fileId: this.fileId,
      bytes,
      position: writePosition,
      modifiedAt: Date.now(),
      signal: undefined,
    });
    if (position === undefined || this.append) {
      this.cursor = writePosition + bytes.byteLength;
    }
    return { bytesWritten: bytes.byteLength };
  }

  async close(): Promise<void> {}

  async stat(): Promise<WeshStat> {
    const manifest = await this.fileStore.readManifest({ fileId: this.fileId });
    if (manifest === undefined) {
      throw new Error(`Encrypted filesystem file is missing: ${this.displayPath}`);
    }
    return createStat({
      type: 'file',
      size: manifest.size,
      mtime: manifest.modifiedAt,
    });
  }

  async truncate({ size }: { size: number }): Promise<void> {
    await this.fileStore.truncate({
      fileId: this.fileId,
      size,
      modifiedAt: Date.now(),
    });
    this.cursor = Math.min(this.cursor, size);
  }

  async ioctl(): Promise<{ ret: number }> {
    return { ret: 0 };
  }
}

export class EncryptedDirectoryWeshProvider implements WeshVirtualMountProvider {
  constructor({
    access,
    mountPath,
  }: {
    access: Extract<StorageVolumeAccess, { type: 'encrypted_directory' }>,
    mountPath: string,
  }) {
    const objectStore = new EncryptedObjectStore({
      storeDirectory: access.storeDirectory,
      keys: {
        objectEncryptionKey: access.objectEncryptionKey,
        objectAddressKey: access.objectAddressKey,
      },
      area: access.physicalArea,
    });
    const fileStore = new EncryptedFileStore({ objectStore });
    this.fileStore = fileStore;
    this.store = new EncryptedFileSystemStore({ objectStore, fileStore });
    this.rootDirectoryId = access.rootDirectoryId;
    this.mountPath = normalizePath({ path: mountPath });
  }

  private readonly store: EncryptedFileSystemStore;
  private readonly fileStore: EncryptedFileStore;
  private readonly rootDirectoryId: string;
  private readonly mountPath: string;

  async open({
    path,
    flags,
  }: {
    path: string,
    flags: WeshOpenFlags,
    mode?: number,
  }): Promise<WeshFileHandle> {
    const relativePath = this.toRelativePath({ path });
    const requestedEntry = await this.store.tryResolve({
      rootDirectoryId: this.rootDirectoryId,
      path: relativePath,
    });
    const shouldFollowRequestedEntry = (() => {
      const entry = requestedEntry?.entry;
      if (entry === undefined) {
        return false;
      }
      switch (entry.type) {
      case 'file':
      case 'directory':
        return false;
      case 'symlink':
        return true;
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled encrypted filesystem entry: ${String(_ex)}`);
      }
      }
    })();
    const resolvedPath = shouldFollowRequestedEntry
      ? (await this.resolveFollowingSymlinks({ path: relativePath })).path
      : relativePath;
    const existing = resolvedPath === relativePath
      ? requestedEntry
      : await this.store.tryResolve({
        rootDirectoryId: this.rootDirectoryId,
        path: resolvedPath,
      });
    let fileId: string;
    if (existing === undefined) {
      switch (flags.creation) {
      case 'always':
      case 'if-needed':
        fileId = await this.store.createFile({
          rootDirectoryId: this.rootDirectoryId,
          path: relativePath,
          overwrite: false,
          modifiedAt: Date.now(),
        });
        break;
      case 'never':
        throw new Error(`Encrypted filesystem path not found: ${path}`);
      default: {
        const _ex: never = flags.creation;
        throw new Error(`Unhandled Wesh creation mode: ${_ex}`);
      }
      }
    } else {
      fileId = requireFileEntry({ entry: existing.entry, path }).fileId;
      switch (flags.creation) {
      case 'always':
        throw new Error(`Encrypted filesystem file already exists: ${path}`);
      case 'if-needed':
      case 'never':
        break;
      default: {
        const _ex: never = flags.creation;
        throw new Error(`Unhandled Wesh creation mode: ${_ex}`);
      }
      }
    }
    switch (flags.truncate) {
    case 'truncate':
      await this.fileStore.truncate({
        fileId,
        size: 0,
        modifiedAt: Date.now(),
      });
      break;
    case 'preserve':
      break;
    default: {
      const _ex: never = flags.truncate;
      throw new Error(`Unhandled Wesh truncate mode: ${_ex}`);
    }
    }
    return new EncryptedDirectoryFileHandle({
      fileStore: this.fileStore,
      fileId,
      displayPath: path,
      append: shouldAppend({ append: flags.append }),
    });
  }

  async stat({ path }: { path: string }): Promise<WeshStat> {
    const relativePath = this.toRelativePath({ path });
    const resolved = await this.resolveFollowingSymlinks({ path: relativePath });
    return await this.statResolved({ path: resolved.path, entry: resolved.entry });
  }

  async lstat({ path }: { path: string }): Promise<WeshStat> {
    const relativePath = this.toRelativePath({ path });
    const resolved = await this.store.resolve({
      rootDirectoryId: this.rootDirectoryId,
      path: relativePath,
    });
    return await this.statResolved({ path: relativePath, entry: resolved.entry });
  }

  async *readDir({ path }: { path: string }): AsyncIterable<WeshDirEntry> {
    const relativePath = this.toRelativePath({ path });
    const resolved = await this.resolveFollowingSymlinks({ path: relativePath });
    const directoryId = getDirectoryId({
      entry: resolved.entry,
      rootDirectoryId: this.rootDirectoryId,
      path,
    });
    for await (const entry of this.store.readDirectory({
      rootDirectoryId: this.rootDirectoryId,
      directoryId,
    })) {
      yield {
        name: entry.name,
        type: entry.type,
        fullPath: normalizePath({ path: `${path}/${entry.name}` }),
      };
    }
  }

  async readlink({ path }: { path: string }): Promise<string> {
    const relativePath = this.toRelativePath({ path });
    const resolved = await this.store.resolve({
      rootDirectoryId: this.rootDirectoryId,
      path: relativePath,
    });
    return requireSymlinkEntry({
      entry: resolved.entry,
      path,
    }).targetPath;
  }

  async mkdir({ path, recursive }: { path: string, recursive: boolean }): Promise<void> {
    await this.store.createDirectory({
      rootDirectoryId: this.rootDirectoryId,
      path: this.toRelativePath({ path }),
      recursive,
    });
  }

  async symlink({ path, targetPath }: { path: string, targetPath: string }): Promise<void> {
    await this.store.createSymlink({
      rootDirectoryId: this.rootDirectoryId,
      path: this.toRelativePath({ path }),
      targetPath,
      modifiedAt: Date.now(),
    });
  }

  async unlink({ path }: { path: string }): Promise<void> {
    await this.store.remove({
      rootDirectoryId: this.rootDirectoryId,
      path: this.toRelativePath({ path }),
      recursive: false,
    });
  }

  async rmdir({ path }: { path: string }): Promise<void> {
    await this.store.remove({
      rootDirectoryId: this.rootDirectoryId,
      path: this.toRelativePath({ path }),
      recursive: false,
    });
  }

  async rename({ oldPath, newPath }: { oldPath: string, newPath: string }): Promise<void> {
    await this.store.rename({
      rootDirectoryId: this.rootDirectoryId,
      oldPath: this.toRelativePath({ path: oldPath }),
      newPath: this.toRelativePath({ path: newPath }),
    });
  }

  private toRelativePath({ path }: { path: string }): string {
    const normalized = normalizePath({ path });
    if (normalized === this.mountPath) {
      return '/';
    }
    const prefix = `${this.mountPath}/`;
    if (!normalized.startsWith(prefix)) {
      throw new Error(`Path is outside encrypted mount: ${path}`);
    }
    return `/${normalized.slice(prefix.length)}`;
  }

  private async resolveFollowingSymlinks({
    path,
    depth = 0,
  }: {
    path: string,
    depth?: number,
  }): Promise<{ path: string, entry: Awaited<ReturnType<EncryptedFileSystemStore['resolve']>>['entry'] }> {
    if (depth > 40) {
      throw new Error(`Too many symbolic links: ${path}`);
    }
    const resolved = await this.store.resolve({
      rootDirectoryId: this.rootDirectoryId,
      path,
    });
    if (resolved.entry === undefined) {
      return { path, entry: resolved.entry };
    }
    switch (resolved.entry.type) {
    case 'file':
    case 'directory':
      return { path, entry: resolved.entry };
    case 'symlink':
      return await this.resolveFollowingSymlinks({
        path: resolveSymlinkTarget({
          linkPath: path,
          targetPath: resolved.entry.targetPath,
        }),
        depth: depth + 1,
      });
    default: {
      const _ex: never = resolved.entry;
      throw new Error(
        `Unhandled encrypted filesystem entry: ${((_ex satisfies never) as { readonly type: string }).type}`,
      );
    }
    }
  }

  private async statResolved({
    path,
    entry,
  }: {
    path: string,
    entry: Awaited<ReturnType<EncryptedFileSystemStore['resolve']>>['entry'],
  }): Promise<WeshStat> {
    if (entry === undefined) {
      const manifest = await this.store.getDirectoryManifest({
        rootDirectoryId: this.rootDirectoryId,
        directoryId: this.rootDirectoryId,
      });
      return createStat({
        type: 'directory',
        size: 0,
        mtime: manifest.modifiedAt,
      });
    }
    switch (entry.type) {
    case 'file': {
      const manifest = await this.store.getFileManifest({
        rootDirectoryId: this.rootDirectoryId,
        path,
      });
      return createStat({
        type: 'file',
        size: manifest.size,
        mtime: manifest.modifiedAt,
      });
    }
    case 'directory': {
      const manifest = await this.store.getDirectoryManifest({
        rootDirectoryId: this.rootDirectoryId,
        directoryId: entry.directoryId,
      });
      return createStat({
        type: 'directory',
        size: 0,
        mtime: manifest.modifiedAt,
      });
    }
    case 'symlink':
      return createStat({
        type: 'symlink',
        size: new TextEncoder().encode(entry.targetPath).byteLength,
        mtime: entry.modifiedAt,
      });
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled encrypted filesystem entry: ${String(_ex)}`);
    }
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  normalizePath,
  resolveSymlinkTarget,
};
