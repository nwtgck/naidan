import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import { isStorageEntryNotFoundError } from '@/00-storage/service/storage-file-system/errors';
import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
  StorageFileHandle,
  StorageFileStat,
  StorageWritableFile,
} from '@/00-storage/service/storage-file-system/types';
import type {
  WeshFileHandle,
  WeshIOResult,
  WeshMount,
  WeshOpenFlags,
  WeshStat,
  WeshWriteResult,
  WeshStorageDirectoryExecution,
} from '@/features/wesh/types';
import type {
  WeshStorageDirectoryReadResult,
  WeshStorageDirectoryRemote,
  WeshStorageDirectoryWriteResult,
} from './types';

const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;
const SYMLINK_MODE = 0o777;
const MAX_SYMLINK_DEPTH = 40;

export type StorageDirectoryMount = Extract<WeshMount, { type: 'storage_directory' }>;

function getModeForKind({ kind }: {
  kind: StorageEntryHandle['kind'];
}): number {
  switch (kind) {
  case 'directory':
    return DIRECTORY_MODE;
  case 'symlink':
    return SYMLINK_MODE;
  case 'file':
    return FILE_MODE;
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled storage entry kind: ${String(_ex)}`);
  }
  }
}

function shouldTruncate({ flags }: { flags: WeshOpenFlags }): boolean {
  switch (flags.truncate) {
  case 'truncate':
    return true;
  case 'preserve':
    return false;
  default: {
    const _ex: never = flags.truncate;
    throw new Error(`Unhandled Wesh truncate mode: ${String(_ex)}`);
  }
  }
}

function shouldAppend({ flags }: { flags: WeshOpenFlags }): boolean {
  switch (flags.append) {
  case 'append':
    return true;
  case 'preserve':
    return false;
  default: {
    const _ex: never = flags.append;
    throw new Error(`Unhandled Wesh append mode: ${String(_ex)}`);
  }
  }
}

function shouldCreateMissingFile({ flags }: { flags: WeshOpenFlags }): boolean {
  switch (flags.creation) {
  case 'always':
  case 'if-needed':
    return true;
  case 'never':
    return false;
  default: {
    const _ex: never = flags.creation;
    throw new Error(`Unhandled Wesh creation mode: ${String(_ex)}`);
  }
  }
}

function rejectsExistingFile({ flags }: { flags: WeshOpenFlags }): boolean {
  switch (flags.creation) {
  case 'always':
    return true;
  case 'if-needed':
  case 'never':
    return false;
  default: {
    const _ex: never = flags.creation;
    throw new Error(`Unhandled Wesh creation mode: ${String(_ex)}`);
  }
  }
}

function requireDirectoryEntry({ entry, path }: {
  entry: StorageEntryHandle;
  path: string;
}): StorageDirectoryHandle {
  switch (entry.kind) {
  case 'directory':
    return entry;
  case 'file':
  case 'symlink':
    throw new Error(`Not a directory: ${path}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled storage entry: ${String(_ex)}`);
  }
  }
}

function requireFileEntry({ entry, path }: {
  entry: StorageEntryHandle;
  path: string;
}): StorageFileHandle {
  switch (entry.kind) {
  case 'file':
    return entry;
  case 'directory':
  case 'symlink':
    throw new Error(`Not a file: ${path}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled storage entry: ${String(_ex)}`);
  }
  }
}

function requireSymlinkEntry({ entry, path }: {
  entry: StorageEntryHandle;
  path: string;
}): Extract<StorageEntryHandle, { kind: 'symlink' }> {
  switch (entry.kind) {
  case 'symlink':
    return entry;
  case 'directory':
  case 'file':
    throw new Error(`Not a symbolic link: ${path}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled storage entry: ${String(_ex)}`);
  }
  }
}

function normalizePath({ path }: { path: string }): string {
  const result: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      result.pop();
      continue;
    }
    result.push(part);
  }
  return `/${result.join('/')}`;
}

function pathParts({ path }: { path: string }): readonly string[] {
  return normalizePath({ path }).split('/').filter(Boolean);
}

function dirname({ path }: { path: string }): string {
  const parts = [...pathParts({ path })];
  parts.pop();
  return `/${parts.join('/')}`;
}

function basename({ path }: { path: string }): string {
  const parts = pathParts({ path });
  const value = parts.at(-1);
  if (value === undefined) {
    throw new Error('The mount root does not have an entry name');
  }
  return value;
}

function resolveSymlinkTarget({ linkPath, targetPath }: {
  linkPath: string;
  targetPath: string;
}): string {
  return normalizePath({
    path: targetPath.startsWith('/')
      ? targetPath
      : `${dirname({ path: linkPath })}/${targetPath}`,
  });
}

function createWeshStat({ kind, stat }: {
  kind: StorageEntryHandle['kind'];
  stat: StorageFileStat;
}): WeshStat {
  return {
    type: kind,
    size: stat.size,
    mtime: stat.modifiedAt ?? 0,
    mode: getModeForKind({ kind }),
    ino: 0,
    uid: 0,
    gid: 0,
  };
}

function canRead({ flags }: { flags: WeshOpenFlags }): boolean {
  return flags.access === 'read' || flags.access === 'read-write';
}

function canWrite({ flags }: { flags: WeshOpenFlags }): boolean {
  return flags.access === 'write' || flags.access === 'read-write';
}

export class OpenStorageFile implements WeshFileHandle {
  constructor({ fileHandle, flags }: {
    fileHandle: StorageFileHandle;
    flags: WeshOpenFlags;
  }) {
    this.fileHandle = fileHandle;
    this.flags = flags;
  }

  private readonly fileHandle: StorageFileHandle;
  private readonly flags: WeshOpenFlags;
  private reader: StorageBinaryObjectReadHandle | undefined;
  private writer: StorageWritableFile | undefined;
  private cursor = 0;
  private logicalSize: number | undefined;
  private modifiedAt: number | undefined;
  private settled = false;

  async initialize(): Promise<void> {
    const initialStat = await this.fileHandle.stat();
    this.logicalSize = initialStat.size;
    this.modifiedAt = initialStat.modifiedAt;
    if (canWrite({ flags: this.flags })) {
      this.writer = await this.fileHandle.createWritable({ keepExistingData: true });
      if (shouldTruncate({ flags: this.flags })) {
        await this.writer.truncate({ size: 0 });
        this.logicalSize = 0;
        this.modifiedAt = Date.now();
      }
    } else if (shouldTruncate({ flags: this.flags })) {
      throw new Error('A read-only Wesh handle cannot truncate a file');
    }
  }

  async read({ buffer, offset: requestedOffset, length: requestedLength, position }: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshIOResult> {
    this.assertOpen();
    if (!canRead({ flags: this.flags })) {
      throw new Error('The Wesh file handle was not opened for reading');
    }
    const offset = requestedOffset ?? 0;
    const length = requestedLength ?? buffer.byteLength - offset;
    if (
      !Number.isSafeInteger(offset)
      || offset < 0
      || !Number.isSafeInteger(length)
      || length < 0
      || offset + length > buffer.byteLength
    ) {
      throw new Error('Read buffer range is invalid');
    }
    this.reader ??= await this.fileHandle.openReadable({ mimeType: 'application/octet-stream' });
    const readPosition = position ?? this.cursor;
    const result = await this.reader.read({
      buffer,
      offset,
      length,
      position: readPosition,
      signal: undefined,
    });
    if (position === undefined) {
      this.cursor += result.bytesRead;
    }
    return { bytesRead: result.bytesRead };
  }

  async readRemote({ length, position }: {
    length: number;
    position: number | undefined;
  }): Promise<WeshStorageDirectoryReadResult> {
    const target = new Uint8Array(length);
    const result = await this.read({
      buffer: target,
      offset: 0,
      length,
      position,
    });
    return {
      buffer: target.buffer.slice(0, result.bytesRead),
      bytesRead: result.bytesRead,
    };
  }

  async write({ buffer, offset: requestedOffset, length: requestedLength, position }: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshWriteResult> {
    this.assertOpen();
    if (!canWrite({ flags: this.flags }) || this.writer === undefined) {
      throw new Error('The Wesh file handle was not opened for writing');
    }
    const offset = requestedOffset ?? 0;
    const length = requestedLength ?? buffer.byteLength - offset;
    if (
      !Number.isSafeInteger(offset)
      || offset < 0
      || !Number.isSafeInteger(length)
      || length < 0
      || offset + length > buffer.byteLength
    ) {
      throw new Error('Write buffer range is invalid');
    }
    const bytes = buffer.subarray(offset, offset + length);
    const append = shouldAppend({ flags: this.flags });
    const writePosition = append
      ? this.logicalSize ?? (await this.fileHandle.stat()).size
      : position ?? this.cursor;
    await this.writer.write({ position: writePosition, data: bytes });
    const end = writePosition + bytes.byteLength;
    this.logicalSize = Math.max(this.logicalSize ?? 0, end);
    this.modifiedAt = Date.now();
    if (position === undefined || append) {
      this.cursor = end;
    }
    return { bytesWritten: bytes.byteLength };
  }

  async writeRemote({ buffer, position }: {
    buffer: ArrayBuffer;
    position: number | undefined;
  }): Promise<WeshStorageDirectoryWriteResult> {
    return this.write({
      buffer: new Uint8Array(buffer),
      offset: 0,
      length: buffer.byteLength,
      position,
    });
  }

  async stat(): Promise<WeshStat> {
    this.assertOpen();
    const stat = await this.fileHandle.stat();
    return createWeshStat({
      kind: 'file',
      stat: {
        ...stat,
        size: this.logicalSize ?? stat.size,
        modifiedAt: this.modifiedAt ?? stat.modifiedAt,
      },
    });
  }

  async truncate({ size }: { size: number }): Promise<void> {
    this.assertOpen();
    if (!canWrite({ flags: this.flags }) || this.writer === undefined) {
      throw new Error('The Wesh file handle was not opened for writing');
    }
    await this.writer.truncate({ size });
    this.logicalSize = size;
    this.modifiedAt = Date.now();
    this.cursor = Math.min(this.cursor, size);
  }


  async ioctl(): Promise<{ ret: number }> {
    this.assertOpen();
    return { ret: 0 };
  }

  async close(): Promise<void> {
    if (this.settled) {
      return;
    }
    this.settled = true;
    let failure: unknown;
    try {
      await this.writer?.close();
    } catch (error) {
      failure = error;
    }
    try {
      await this.reader?.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) {
      throw failure;
    }
  }

  async abort(): Promise<void> {
    if (this.settled) {
      return;
    }
    this.settled = true;
    await Promise.allSettled([
      this.writer?.abort({ reason: new Error('Wesh storage directory access was disposed') }),
      this.reader?.close(),
    ]);
  }

  private assertOpen(): void {
    if (this.settled) {
      throw new Error('The Wesh file handle is closed');
    }
  }
}

export class StorageDirectoryWeshAccess implements WeshStorageDirectoryRemote {
  constructor({ mounts }: {
    mounts: readonly StorageDirectoryMount[];
  }) {
    this.mounts = new Map(mounts.map(mount => [mount.path, mount]));
  }

  private readonly mounts: ReadonlyMap<string, StorageDirectoryMount>;
  private readonly openFiles = new Map<string, OpenStorageFile>();
  private nextHandleId = 1;
  private disposed = false;

  async stat({ mountPath, path, followFinalSymlink }: {
    mountPath: string;
    path: string;
    followFinalSymlink: boolean;
  }): Promise<WeshStat> {
    const entry = await this.resolve({
      root: this.getMount({ mountPath }).handle,
      path,
      followFinalSymlink,
      depth: 0,
    });
    return createWeshStat({ kind: entry.kind, stat: await entry.stat() });
  }

  async readDir({ mountPath, path }: {
    mountPath: string;
    path: string;
  }) {
    const entry = requireDirectoryEntry({
      entry: await this.resolve({
        root: this.getMount({ mountPath }).handle,
        path,
        followFinalSymlink: true,
        depth: 0,
      }),
      path,
    });
    const result = [];
    for await (const [name, child] of entry.entries()) {
      result.push({
        name,
        type: child.kind,
        fullPath: normalizePath({ path: `${path}/${name}` }),
      });
    }
    return result;
  }

  async readlink({ mountPath, path }: {
    mountPath: string;
    path: string;
  }): Promise<string> {
    const entry = requireSymlinkEntry({
      entry: await this.resolve({
        root: this.getMount({ mountPath }).handle,
        path,
        followFinalSymlink: false,
        depth: 0,
      }),
      path,
    });
    return entry.readTarget();
  }

  async openLocal({ mountPath, path, flags }: {
    mountPath: string;
    path: string;
    flags: WeshOpenFlags;
  }): Promise<OpenStorageFile> {
    const mount = this.getMount({ mountPath });
    if (
      mount.readOnly
      && (canWrite({ flags }) || shouldCreateMissingFile({ flags }) || shouldTruncate({ flags }))
    ) {
      throw new Error(`Read-only storage directory mount: ${mountPath}`);
    }
    const root = mount.handle;
    let fileHandle: StorageFileHandle | undefined;
    try {
      const entry = await this.resolve({
        root,
        path,
        followFinalSymlink: true,
        depth: 0,
      });
      if (rejectsExistingFile({ flags })) {
        throw new Error(`File already exists: ${path}`);
      }
      fileHandle = requireFileEntry({ entry, path });
    } catch (error) {
      if (!isStorageEntryNotFoundError({ error })) {
        throw error;
      }
      if (!shouldCreateMissingFile({ flags })) {
        throw error;
      }
      const parent = await this.resolveParent({ root, path });
      fileHandle = await parent.directory.getFileHandle({ name: parent.name, create: true });
    }
    const openFile = new OpenStorageFile({ fileHandle, flags });
    await openFile.initialize();
    return openFile;
  }

  async open({ mountPath, path, flags }: {
    mountPath: string;
    path: string;
    flags: WeshOpenFlags;
  }) {
    const openFile = await this.openLocal({ mountPath, path, flags });
    const handleId = String(this.nextHandleId++);
    this.openFiles.set(handleId, openFile);
    return { handleId };
  }

  async read({ handleId, length, position }: {
    handleId: string;
    length: number;
    position: number | undefined;
  }) {
    return this.getOpenFile({ handleId }).readRemote({ length, position });
  }

  async write({ handleId, buffer, position }: {
    handleId: string;
    buffer: ArrayBuffer;
    position: number | undefined;
  }) {
    return this.getOpenFile({ handleId }).writeRemote({ buffer, position });
  }

  async statHandle({ handleId }: { handleId: string }): Promise<WeshStat> {
    return this.getOpenFile({ handleId }).stat();
  }

  async truncate({ handleId, size }: { handleId: string; size: number }): Promise<void> {
    await this.getOpenFile({ handleId }).truncate({ size });
  }

  async close({ handleId }: { handleId: string }): Promise<void> {
    const file = this.getOpenFile({ handleId });
    this.openFiles.delete(handleId);
    await file.close();
  }

  async mkdir({ mountPath, path, recursive }: {
    mountPath: string;
    path: string;
    recursive: boolean;
  }): Promise<void> {
    const mount = this.getWritableMount({ mountPath });
    const parts = pathParts({ path });
    if (parts.length === 0) {
      return;
    }
    if (!recursive) {
      const parent = await this.resolveParent({ root: mount.handle, path });
      await parent.directory.getDirectoryHandle({ name: parent.name, create: true });
      return;
    }
    let directory = mount.handle;
    for (const name of parts) {
      directory = await directory.getDirectoryHandle({ name, create: true });
    }
  }

  async symlink({ mountPath, path, targetPath }: {
    mountPath: string;
    path: string;
    targetPath: string;
  }): Promise<void> {
    const mount = this.getWritableMount({ mountPath });
    const parent = await this.resolveParent({ root: mount.handle, path });
    await parent.directory.createSymlink({ name: parent.name, target: targetPath });
  }

  async unlink({ mountPath, path }: {
    mountPath: string;
    path: string;
  }): Promise<void> {
    const mount = this.getWritableMount({ mountPath });
    const parent = await this.resolveParent({ root: mount.handle, path });
    const entry = await parent.directory.getEntryHandle({ name: parent.name });
    switch (entry.kind) {
    case 'directory':
      throw new Error(`Is a directory: ${path}`);
    case 'file':
    case 'symlink':
      break;
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled storage entry: ${String(_ex)}`);
    }
    }
    await parent.directory.removeEntry({ name: parent.name, recursive: false });
  }

  async rmdir({ mountPath, path }: {
    mountPath: string;
    path: string;
  }): Promise<void> {
    const mount = this.getWritableMount({ mountPath });
    const parent = await this.resolveParent({ root: mount.handle, path });
    requireDirectoryEntry({
      entry: await parent.directory.getEntryHandle({ name: parent.name }),
      path,
    });
    await parent.directory.removeEntry({ name: parent.name, recursive: false });
  }

  async rename({ mountPath, oldPath, newPath }: {
    mountPath: string;
    oldPath: string;
    newPath: string;
  }): Promise<void> {
    const mount = this.getWritableMount({ mountPath });
    const source = await this.resolveParent({ root: mount.handle, path: oldPath });
    const destination = await this.resolveParent({ root: mount.handle, path: newPath });
    await source.directory.moveEntry({
      name: source.name,
      destination: destination.directory,
      newName: destination.name,
      replace: true,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const files = [...this.openFiles.values()];
    this.openFiles.clear();
    await Promise.allSettled(files.map(file => file.abort()));
  }

  private getMount({ mountPath }: { mountPath: string }): StorageDirectoryMount {
    if (this.disposed) {
      throw new Error('Wesh storage directory remote is disposed');
    }
    const mount = this.mounts.get(mountPath);
    if (mount === undefined) {
      throw new Error(`Unknown storage directory mount: ${mountPath}`);
    }
    return mount;
  }

  private getWritableMount({ mountPath }: { mountPath: string }): StorageDirectoryMount {
    const mount = this.getMount({ mountPath });
    if (mount.readOnly) {
      throw new Error(`Read-only storage directory mount: ${mountPath}`);
    }
    return mount;
  }

  private getOpenFile({ handleId }: { handleId: string }): OpenStorageFile {
    if (this.disposed) {
      throw new Error('Wesh storage directory remote is disposed');
    }
    const file = this.openFiles.get(handleId);
    if (file === undefined) {
      throw new Error(`Unknown or closed Wesh storage file handle: ${handleId}`);
    }
    return file;
  }

  private async resolveParent({ root, path }: {
    root: StorageDirectoryHandle;
    path: string;
  }): Promise<{ readonly directory: StorageDirectoryHandle; readonly name: string }> {
    const parent = await this.resolve({
      root,
      path: dirname({ path }),
      followFinalSymlink: true,
      depth: 0,
    });
    return {
      directory: requireDirectoryEntry({ entry: parent, path: dirname({ path }) }),
      name: basename({ path }),
    };
  }

  private async resolve({ root, path, followFinalSymlink, depth }: {
    root: StorageDirectoryHandle;
    path: string;
    followFinalSymlink: boolean;
    depth: number;
  }): Promise<StorageEntryHandle> {
    if (depth > MAX_SYMLINK_DEPTH) {
      throw new Error(`Too many symbolic links: ${path}`);
    }
    const normalized = normalizePath({ path });
    const parts = pathParts({ path: normalized });
    if (parts.length === 0) {
      return root;
    }
    let directory = root;
    let currentPath = '';
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index] as string;
      currentPath = `${currentPath}/${name}`;
      const entry = await directory.getEntryHandle({ name });
      const isFinal = index === parts.length - 1;
      if (entry.kind === 'symlink' && (!isFinal || followFinalSymlink)) {
        const target = resolveSymlinkTarget({
          linkPath: currentPath,
          targetPath: await entry.readTarget(),
        });
        const remainder = parts.slice(index + 1).join('/');
        return this.resolve({
          root,
          path: remainder === '' ? target : `${target}/${remainder}`,
          followFinalSymlink,
          depth: depth + 1,
        });
      }
      if (isFinal) {
        return entry;
      }
      directory = requireDirectoryEntry({ entry, path: currentPath });
    }
    return directory;
  }
}

export function createWeshStorageDirectoryRemoteForMounts({
  mounts,
  storageDirectoryExecution,
}: {
  mounts: readonly WeshMount[];
  storageDirectoryExecution: WeshStorageDirectoryExecution;
}): WeshStorageDirectoryRemote | undefined {
  const storageDirectoryMounts = mounts.filter(
    (mount): mount is StorageDirectoryMount => {
      switch (mount.type) {
      case 'directory':
      case 'naidan_sysfs':
        return false;
      case 'storage_directory':
        switch (storageDirectoryExecution) {
        case 'worker_local':
          // Worker-reopenable mounts run beside Wesh and must never route
          // primitive I/O back through this UI-owned Comlink remote.
          return mount.handle.createWorkerMountGrant === undefined;
        case 'ui_remote':
          // File Explorer still uses the UI-owned handle capability. It must not
          // lose HizoFS-backed mounts merely because Wesh can reopen them locally.
          return true;
        default: {
          const _ex: never = storageDirectoryExecution;
          throw new Error(`Unhandled storage directory execution: ${String(_ex)}`);
        }
        }
      default: {
        const _ex: never = mount;
        throw new Error(
          `Unhandled Wesh mount type: ${((_ex satisfies never) as { readonly type: string }).type}`,
        );
      }
      }
    },
  );
  return storageDirectoryMounts.length === 0
    ? undefined
    : new StorageDirectoryWeshAccess({ mounts: storageDirectoryMounts });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  normalizePath,
  resolveSymlinkTarget,
};
