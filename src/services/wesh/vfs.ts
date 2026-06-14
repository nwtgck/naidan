import { ReadonlyDirectoryHandle } from './readonly-directory-handle';
import type {
  WeshDirEntry,
  WeshIVirtualFileSystem,
  WeshFileHandle,
  WeshFileType,
  WeshSpecialFileType,
  WeshStat,
  WeshIOResult,
  WeshWriteResult,
  WeshOpenFlags,
  WeshEfficientBlobReadResult,
  WeshEfficientFileWriteResult,
  WeshVirtualMountProvider,
} from './types';
import {
  WeshBrokenPipeError,
  WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED,
  WESH_EFFICIENT_FILE_WRITE_FALLBACK_REQUIRED,
} from './types';
import {
  WeshRegistryEntrySchemaDto,
  type WeshRegistryEntryDto,
  WESH_SYSTEM_DIR,
  METADATA_DIR
} from './dto';

// --- Domain Models ---

interface RegistryEntry {
  type: 'fifo' | 'chardev' | 'symlink';
  mode: number;
  targetPath?: string;
  uid?: number;
  gid?: number;
  mtime?: number;
}

// --- Mappers ---

function mapDtoToDomain({ dto }: { dto: WeshRegistryEntryDto }): RegistryEntry {
  switch (dto.type) {
  case 'symlink':
    return {
      type: 'symlink',
      mode: dto.mode,
      targetPath: dto.targetPath,
      uid: dto.uid,
      gid: dto.gid,
      mtime: dto.mtime,
    };
  case 'fifo':
    return {
      type: 'fifo',
      mode: dto.mode,
      uid: dto.uid,
      gid: dto.gid,
      mtime: dto.mtime,
    };
  case 'chardev':
    return {
      type: 'chardev',
      mode: dto.mode,
      uid: dto.uid,
      gid: dto.gid,
      mtime: dto.mtime,
    };
  default: {
    const _ex: never = dto;
    throw new Error(`Unhandled DTO: ${_ex}`);
  }
  }
}

function mapDomainToDto({ entry }: { entry: RegistryEntry }): WeshRegistryEntryDto {
  switch (entry.type) {
  case 'symlink':
    return {
      type: 'symlink',
      mode: entry.mode,
      targetPath: entry.targetPath ?? '',
      uid: entry.uid,
      gid: entry.gid,
      mtime: entry.mtime,
    };
  case 'fifo':
    return {
      type: 'fifo',
      mode: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
      mtime: entry.mtime,
    };
  case 'chardev':
    return {
      type: 'chardev',
      mode: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
      mtime: entry.mtime,
    };
  default: {
    const _ex: never = entry.type;
    throw new Error(`Unknown entry type: ${_ex}`);
  }
  }
}

function computeStableInode({
  kind,
  path,
}: {
  kind: 'handle' | 'registry' | 'synthetic-directory' | 'special';
  path: string;
}): number {
  let hash = 2166136261;
  const input = `${kind}:${path}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) || 1;
}

// --- File Handles ---

class StandardFileHandle implements WeshFileHandle {
  private handle: FileSystemFileHandle;
  private readOnly: boolean;
  private _cursor = 0;
  private ready: Promise<void>;

  constructor({ handle, readOnly, append }: { handle: FileSystemFileHandle; readOnly: boolean; append: boolean }) {
    this.handle = handle;
    this.readOnly = readOnly;
    this.ready = append ? this.initAppend() : Promise.resolve();
  }

  private async initAppend() {
    const file = await this.handle.getFile();
    this._cursor = file.size;
  }

  async read({ buffer, offset, length, position }: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshIOResult> {
    await this.ready;
    const file = await this.handle.getFile();
    const pos = position ?? this._cursor;

    if (pos >= file.size) return { bytesRead: 0 };

    const bufferOffset = offset ?? 0;
    const maxLen = length ?? (buffer.length - bufferOffset);
    const end = Math.min(pos + maxLen, file.size);

    const slice = file.slice(pos, end);
    const arrayBuffer = await slice.arrayBuffer();
    const result = new Uint8Array(arrayBuffer);

    buffer.set(result, bufferOffset);

    if (position === undefined) {
      this._cursor += result.length;
    }

    return { bytesRead: result.length };
  }

  async write({ buffer, offset, length: requestedLength, position }: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number
  }): Promise<WeshWriteResult> {
    await this.ready;
    if (this.readOnly) throw new Error('File is read-only');

    const bufferOffset = offset ?? 0;
    const length = requestedLength ?? (buffer.length - bufferOffset);
    const dataToWrite = buffer.subarray(bufferOffset, bufferOffset + length);

    const pos = position ?? this._cursor;

    const writable = await this.handle.createWritable({ keepExistingData: true });
    try {
      await writable.seek(pos);
      await writable.write(dataToWrite as BufferSource);
    } finally {
      await writable.close();
    }

    if (position === undefined) {
      this._cursor += length;
    }

    return { bytesWritten: length };
  }

  async close(): Promise<void> {}

  async stat(): Promise<WeshStat> {
    await this.ready;
    const file = await this.handle.getFile();
    return {
      size: file.size,
      mode: 0o644,
      type: 'file',
      mtime: file.lastModified,
      ino: 0,
      uid: 0,
      gid: 0
    };
  }

  async truncate({ size }: { size: number }): Promise<void> {
    await this.ready;
    if (this.readOnly) throw new Error('File is read-only');
    const writable = await this.handle.createWritable({ keepExistingData: true });
    try {
      await writable.truncate(size);
    } finally {
      await writable.close();
    }
  }

  async ioctl(): Promise<{ ret: number }> {
    return { ret: -1 };
  }
}

class FifoHandle implements WeshFileHandle {
  private buffer: Uint8Array[] = [];
  private bufferHeadIndex = 0;
  private bufferSize = 0;
  private headOffset = 0;
  private waiters: Array<ReturnType<typeof Promise.withResolvers<void>>['resolve']> = [];
  private closed = false;

  async read({ buffer, offset, length }: { buffer: Uint8Array; offset?: number; length?: number }): Promise<WeshIOResult> {
    if (this.bufferHeadIndex >= this.buffer.length && this.closed) return { bytesRead: 0 };

    while (this.bufferHeadIndex >= this.buffer.length) {
      if (this.closed) return { bytesRead: 0 };
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }

    const chunk = this.buffer[this.bufferHeadIndex]!;
    const bufferOffset = offset ?? 0;
    const maxLen = length ?? (buffer.length - bufferOffset);
    const available = chunk.length - this.headOffset;
    const copyLen = Math.min(available, maxLen);

    buffer.set(chunk.subarray(this.headOffset, this.headOffset + copyLen), bufferOffset);

    if (copyLen === available) {
      this.bufferHeadIndex += 1;
      this.headOffset = 0;
      if (this.bufferHeadIndex >= this.buffer.length) {
        this.buffer = [];
        this.bufferHeadIndex = 0;
      } else if (this.bufferHeadIndex >= 32 && this.bufferHeadIndex * 2 >= this.buffer.length) {
        this.buffer = this.buffer.slice(this.bufferHeadIndex);
        this.bufferHeadIndex = 0;
      }
    } else {
      this.headOffset += copyLen;
    }
    this.bufferSize -= copyLen;

    return { bytesRead: copyLen };
  }

  async write({ buffer, offset, length: requestedLength }: { buffer: Uint8Array; offset?: number; length?: number }): Promise<WeshWriteResult> {
    if (this.closed) throw new WeshBrokenPipeError();

    const bufferOffset = offset ?? 0;
    const length = requestedLength ?? (buffer.length - bufferOffset);
    const data = new Uint8Array(buffer.subarray(bufferOffset, bufferOffset + length));

    this.buffer.push(data);
    this.bufferSize += length;

    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();

    return { bytesWritten: length };
  }

  async close(): Promise<void> {
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  async stat(): Promise<WeshStat> {
    return {
      size: this.bufferSize,
      mode: 0o600,
      type: 'fifo',
      mtime: Date.now(),
      ino: 0,
      uid: 0,
      gid: 0
    };
  }

  async truncate(): Promise<void> {}
  async ioctl(): Promise<{ ret: number }> {
    return { ret: 0 };
  }
}

class DevNullHandle implements WeshFileHandle {
  async read(): Promise<WeshIOResult> {
    return { bytesRead: 0 };
  }
  async write({ length, buffer, offset }: { length?: number; buffer: Uint8Array; offset?: number }): Promise<WeshWriteResult> {
    const len = length ?? (buffer.length - (offset ?? 0));
    return { bytesWritten: len };
  }
  async close() {}
  async stat(): Promise<WeshStat> {
    return { size: 0, mode: 0o666, type: 'chardev', mtime: 0, ino: 0, uid: 0, gid: 0 };
  }
  async truncate() {}
  async ioctl() {
    return { ret: 0 };
  }
}

class DevZeroHandle implements WeshFileHandle {
  async read({ buffer, offset: requestedOffset, length: requestedLength }: { buffer: Uint8Array; offset?: number; length?: number }): Promise<WeshIOResult> {
    const offset = requestedOffset ?? 0;
    const length = requestedLength ?? (buffer.length - offset);
    buffer.fill(0, offset, offset + length);
    return { bytesRead: length };
  }
  async write({ length, buffer, offset }: { length?: number; buffer: Uint8Array; offset?: number }): Promise<WeshWriteResult> {
    const len = length ?? (buffer.length - (offset ?? 0));
    return { bytesWritten: len };
  }
  async close() {}
  async stat(): Promise<WeshStat> {
    return { size: 0, mode: 0o666, type: 'chardev', mtime: 0, ino: 0, uid: 0, gid: 0 };
  }
  async truncate() {}
  async ioctl() {
    return { ret: 0 };
  }
}

// --- VFS Implementation ---

interface DirectoryMountEntry {
  type: 'directory';
  path: string;
  handle: FileSystemDirectoryHandle;
  readOnly: boolean;
  registryCache: Map<string, RegistryEntry>;
}

interface VirtualMountEntry {
  type: 'virtual';
  path: string;
  readOnly: boolean;
  provider: WeshVirtualMountProvider;
}

type MountEntry = DirectoryMountEntry | VirtualMountEntry;

interface RegistryResolution {
  mount: DirectoryMountEntry;
  relPath: string;
  entry: RegistryEntry;
}

type ResolvedNode =
  | {
    kind: 'handle';
    fullPath: string;
    readOnly: boolean;
    handle: FileSystemHandle;
  }
  | {
    kind: 'registry';
    fullPath: string;
    readOnly: boolean;
    resolution: RegistryResolution;
  }
  | {
    kind: 'special';
    fullPath: string;
    readOnly: boolean;
    handler: () => WeshFileHandle;
  }
  | {
    kind: 'synthetic-directory';
    fullPath: string;
    readOnly: boolean;
  };

export class WeshVFS implements WeshIVirtualFileSystem {
  private mounts: MountEntry[] = [];
  private specialFiles: Map<string, { type: WeshSpecialFileType; handler: () => WeshFileHandle }> = new Map();
  private openFifos: Map<string, FifoHandle> = new Map();

  constructor({ rootHandle }: { rootHandle: FileSystemDirectoryHandle | ReadonlyDirectoryHandle | undefined }) {
    if (rootHandle !== undefined) {
      const rootReadOnly = rootHandle instanceof ReadonlyDirectoryHandle;
      this.mount({ path: '/', handle: rootHandle as FileSystemDirectoryHandle, readOnly: rootReadOnly });
      // Register standard device files only when a real root is present.
      // Standalone VFS instances (rootHandle: undefined) are mount-only and do not need /dev.
      this.registerSpecialFile({ path: '/dev/null', type: 'chardev', handler: () => new DevNullHandle() });
      this.registerSpecialFile({ path: '/dev/zero', type: 'chardev', handler: () => new DevZeroHandle() });
    }
  }

  async mount({ path, handle, readOnly }: { path: string; handle: FileSystemDirectoryHandle; readOnly?: boolean }): Promise<void> {
    const normalizedPath = this.normalizePath({ path });
    this.mounts = this.mounts.filter((m) => m.path !== normalizedPath);

    const registryCache = new Map<string, RegistryEntry>();
    try {
      const systemDir = await handle.getDirectoryHandle(WESH_SYSTEM_DIR);
      const metaDir = await systemDir.getDirectoryHandle(METADATA_DIR);
      await this.scanRegistryRecursive({ dirHandle: metaDir, relPath: '', cache: registryCache });
    } catch {
      // No metadata dir
    }

    this.mounts.push({ type: 'directory', path: normalizedPath, handle, readOnly: !!readOnly, registryCache });
    this.mounts.sort((a, b) => b.path.length - a.path.length);
  }

  mountVirtual({
    path,
    readOnly,
    provider,
  }: {
    path: string;
    readOnly: boolean;
    provider: WeshVirtualMountProvider;
  }): void {
    const normalizedPath = this.normalizePath({ path });
    this.mounts = this.mounts.filter((m) => m.path !== normalizedPath);
    this.mounts.push({
      type: 'virtual',
      path: normalizedPath,
      readOnly,
      provider,
    });
    this.mounts.sort((a, b) => b.path.length - a.path.length);
  }

  private async scanRegistryRecursive({
    dirHandle,
    relPath,
    cache,
  }: {
    dirHandle: FileSystemDirectoryHandle;
    relPath: string;
    cache: Map<string, RegistryEntry>;
  }) {
    for await (const [name, handle] of dirHandle.entries()) {
      const itemPath = relPath ? `${relPath}/${name}` : name;
      switch (handle.kind) {
      case 'file': {
        const file = await (handle as FileSystemFileHandle).getFile();
        try {
          const text = await file.text();
          const json = JSON.parse(text);
          const dto = WeshRegistryEntrySchemaDto.parse(json);
          cache.set(itemPath, mapDtoToDomain({ dto }));
        } catch (e) {
          console.warn(`Failed to parse registry entry ${itemPath}:`, e);
        }
        break;
      }
      case 'directory':
        await this.scanRegistryRecursive({ dirHandle: handle as FileSystemDirectoryHandle, relPath: itemPath, cache });
        break;
      default: {
        throw new Error(`Unhandled case: ${((handle satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    }
  }

  async unmount({ path }: { path: string }): Promise<void> {
    const normalizedPath = this.normalizePath({ path });
    if (normalizedPath === '/') throw new Error('Cannot unmount root');
    this.mounts = this.mounts.filter((m) => m.path !== normalizedPath);
  }

  registerSpecialFile({ path, type, handler }: { path: string; type: WeshSpecialFileType; handler: () => WeshFileHandle }): void {
    this.specialFiles.set(this.normalizePath({ path }), { type, handler });
  }

  unregisterSpecialFile({ path }: { path: string }): void {
    this.specialFiles.delete(this.normalizePath({ path }));
  }

  async open({ path, flags, mode }: { path: string; flags: WeshOpenFlags; mode?: number }): Promise<WeshFileHandle> {
    const normalized = this.normalizePath({ path: path });
    const virtualMount = this.findVirtualMount({ path: normalized });
    if (virtualMount !== undefined) {
      return virtualMount.provider.open({
        path: normalized,
        flags: flags,
        mode: mode,
      });
    }
    const create = flags.creation !== 'never';
    const truncate = flags.truncate === 'truncate';
    let resolved: ResolvedNode;

    try {
      resolved = await this.resolveNode({
        path: normalized,
        finalSymlinkTreatment: 'follow',
        depth: 0,
      });
      switch (flags.creation) {
      case 'always':
        throw new Error(`File exists: ${normalized}`);
      case 'never':
      case 'if-needed':
        break;
      default: {
        const _ex: never = flags.creation;
        throw new Error(`Unhandled creation flag: ${_ex}`);
      }
      }
    } catch (e) {
      if (create) {
        const parts = normalized.split('/');
        const name = parts.pop();
        if (name === undefined) throw new Error(`Invalid path: ${normalized}`);
        const parentPath = parts.join('/') || '/';
        const parent = await this.resolveExistingDirectory({
          path: parentPath,
          finalSymlinkTreatment: 'follow',
        });
        if (parent.readOnly) throw new Error(`Read-only file system: ${parentPath}`);

        const newHandle = await parent.handle.getFileHandle(name, { create: true });
        resolved = {
          kind: 'handle',
          handle: newHandle,
          readOnly: false,
          fullPath: normalized,
        };
      } else {
        throw e;
      }
    }

    switch (resolved.kind) {
    case 'special':
      return resolved.handler();
    case 'registry':
      switch (resolved.resolution.entry.type) {
      case 'fifo':
        if (!this.openFifos.has(resolved.fullPath)) {
          this.openFifos.set(resolved.fullPath, new FifoHandle());
        }
        return this.openFifos.get(resolved.fullPath)!;
      case 'chardev':
        throw new Error('Open not implemented for chardev');
      case 'symlink':
        throw new Error(`Dangling symlink: ${normalized}`);
      default: {
        const _ex: never = resolved.resolution.entry.type;
        throw new Error(`Unhandled registry entry type: ${_ex}`);
      }
      }
    case 'synthetic-directory':
      throw new Error(`Not a file: ${normalized}`);
    case 'handle':
      switch (resolved.handle.kind) {
      case 'file':
        break;
      case 'directory':
        throw new Error(`Not a file: ${normalized}`);
      default: {
        const _ex: never = resolved.handle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
      break;
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${_ex}`);
    }
    }

    const fileHandle = new StandardFileHandle({
      handle: resolved.handle as FileSystemFileHandle,
      readOnly: resolved.readOnly || flags.access === 'read',
      append: flags.append === 'append'
    });

    if (truncate) {
      await fileHandle.truncate({ size: 0 });
    }

    return fileHandle;
  }

  async stat({ path }: { path: string }): Promise<WeshStat> {
    const normalized = this.normalizePath({ path: path });
    const virtualMount = this.findVirtualMount({ path: normalized });
    if (virtualMount !== undefined) {
      return virtualMount.provider.stat({ path: normalized });
    }
    const resolved = await this.resolveNode({
      path: path,
      finalSymlinkTreatment: 'follow',
      depth: 0,
    });
    return this.statFromResolvedNode({ resolved });
  }

  async lstat({ path }: { path: string }): Promise<WeshStat> {
    const normalized = this.normalizePath({ path: path });
    const virtualMount = this.findVirtualMount({ path: normalized });
    if (virtualMount !== undefined) {
      return virtualMount.provider.lstat({ path: normalized });
    }
    const resolved = await this.resolveNode({
      path: path,
      finalSymlinkTreatment: 'no-follow',
      depth: 0,
    });
    return this.statFromResolvedNode({ resolved });
  }

  async readlink({ path }: { path: string }): Promise<string> {
    const normalized = this.normalizePath({ path: path });
    const virtualMount = this.findVirtualMount({ path: normalized });
    if (virtualMount !== undefined) {
      return virtualMount.provider.readlink({ path: normalized });
    }
    const resolved = await this.resolveNode({
      path: path,
      finalSymlinkTreatment: 'no-follow',
      depth: 0,
    });
    switch (resolved.kind) {
    case 'registry':
      switch (resolved.resolution.entry.type) {
      case 'symlink':
        return resolved.resolution.entry.targetPath ?? '';
      case 'fifo':
      case 'chardev':
        throw new Error(`Invalid argument: ${path}`);
      default: {
        const _ex: never = resolved.resolution.entry.type;
        throw new Error(`Unhandled registry entry type: ${_ex}`);
      }
      }
    case 'handle':
    case 'synthetic-directory':
    case 'special':
      throw new Error(`Invalid argument: ${path}`);
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${_ex}`);
    }
    }
  }

  async resolve({ path }: { path: string }): Promise<{ fullPath: string; stat: WeshStat }> {
    const normalized = this.normalizePath({ path: path });
    const virtualMount = this.findVirtualMount({ path: normalized });
    if (virtualMount !== undefined) {
      return {
        fullPath: normalized,
        stat: await virtualMount.provider.stat({ path: normalized }),
      };
    }
    const resolved = await this.resolveNode({
      path: path,
      finalSymlinkTreatment: 'follow',
      depth: 0,
    });
    return {
      fullPath: resolved.fullPath,
      stat: await this.statFromResolvedNode({ resolved }),
    };
  }

  async tryReadBlobEfficiently({ path }: { path: string }): Promise<WeshEfficientBlobReadResult> {
    const normalized = this.normalizePath({ path: path });
    if (this.findVirtualMount({ path: normalized }) !== undefined) {
      return {
        kind: 'fallback-required',
        reason: WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED,
      };
    }
    const resolved = await this.resolveNode({
      path: path,
      finalSymlinkTreatment: 'follow',
      depth: 0,
    });

    switch (resolved.kind) {
    case 'handle':
      switch (resolved.handle.kind) {
      case 'file': {
        const file = await (resolved.handle as FileSystemFileHandle).getFile();
        if (file instanceof Blob) {
          return {
            kind: 'blob',
            blob: file,
          };
        }

        return {
          kind: 'fallback-required',
          reason: WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED,
        };
      }
      case 'directory':
        throw new Error(`Not a file: ${path}`);
      default: {
        const _ex: never = resolved.handle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
    case 'registry':
    case 'special':
    case 'synthetic-directory':
      return {
        kind: 'fallback-required',
        reason: WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED,
      };
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${JSON.stringify(_ex)}`);
    }
    }
  }

  async tryCreateFileWriterEfficiently({ path, mode }: {
    path: string;
    mode: 'truncate' | 'append';
  }): Promise<WeshEfficientFileWriteResult> {
    const normalized = this.normalizePath({ path: path });
    if (this.findVirtualMount({ path: normalized }) !== undefined) {
      throw new Error(`Read-only filesystem: ${normalized}`);
    }
    let resolved: ResolvedNode;
    try {
      resolved = await this.resolveNode({
        path: path,
        finalSymlinkTreatment: 'follow',
        depth: 0,
      });
    } catch {
      const normalized = this.normalizePath({ path: path });
      const parts = normalized.split('/');
      const name = parts.pop();
      if (name === undefined) {
        throw new Error(`Invalid path: ${normalized}`);
      }
      const parentPath = parts.join('/') || '/';
      const parent = await this.resolveExistingDirectory({
        path: parentPath,
        finalSymlinkTreatment: 'follow',
      });
      if (parent.readOnly) {
        throw new Error(`Read-only file system: ${parentPath}`);
      }

      const newHandle = await parent.handle.getFileHandle(name, { create: true });
      resolved = {
        kind: 'handle',
        handle: newHandle,
        readOnly: false,
        fullPath: normalized,
      };
    }

    switch (resolved.kind) {
    case 'handle':
      switch (resolved.handle.kind) {
      case 'file': {
        const fileHandle = resolved.handle as FileSystemFileHandle;
        const writable = await fileHandle.createWritable({
          keepExistingData: (() => {
            switch (mode) {
            case 'append':
              return true;
            case 'truncate':
              return false;
            default: {
              const _ex: never = mode;
              throw new Error(`Unhandled writer mode: ${_ex}`);
            }
            }
          })(),
        });
        switch (mode) {
        case 'append': {
          const file = await fileHandle.getFile();
          await writable.seek(file.size);
          break;
        }
        case 'truncate':
          break;
        default: {
          const _ex: never = mode;
          throw new Error(`Unhandled writer mode: ${_ex}`);
        }
        }

        return {
          kind: 'writer',
          writer: {
            write: async ({ chunk }: { chunk: Uint8Array }) => {
              await writable.write(chunk as BufferSource);
            },
            close: async () => {
              await writable.close();
            },
            abort: async ({ reason }: { reason: unknown }) => {
              await writable.abort(reason);
            },
          },
        };
      }
      case 'directory':
        throw new Error(`Not a file: ${path}`);
      default: {
        const _ex: never = resolved.handle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
    case 'registry':
    case 'special':
    case 'synthetic-directory':
      return {
        kind: 'fallback-required',
        reason: WESH_EFFICIENT_FILE_WRITE_FALLBACK_REQUIRED,
      };
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${JSON.stringify(_ex)}`);
    }
    }
  }

  async *readDir({ path }: { path: string }): AsyncIterable<WeshDirEntry> {
    const normalized = this.normalizePath({ path: path });
    const virtualMount = this.findVirtualMount({ path: normalized });
    if (virtualMount !== undefined) {
      for await (const entry of virtualMount.provider.readDir({ path: normalized })) {
        yield entry;
      }
      return;
    }
    const resolved = await this.resolveNode({
      path: path,
      finalSymlinkTreatment: 'follow',
      depth: 0,
    });
    const seen = new Set<string>();

    switch (resolved.kind) {
    case 'synthetic-directory':
      break;
    case 'special':
      throw new Error(`Not a directory: ${path}`);
    case 'registry':
      throw new Error(`Not a directory: ${path}`);
    case 'handle': {
      switch (resolved.handle.kind) {
      case 'directory':
        break;
      case 'file':
        throw new Error(`Not a directory: ${path}`);
      default: {
        const _ex: never = resolved.handle.kind;
        throw new Error(`Unhandled case: ${_ex}`);
      }
      }

      const dirHandle = resolved.handle as FileSystemDirectoryHandle;
      const mount = this.findMount({ path: resolved.fullPath });
      for await (const [name, entry] of dirHandle.entries()) {
        if (name === WESH_SYSTEM_DIR) continue;

        let type: WeshFileType;
        switch (entry.kind) {
        case 'directory':
          type = 'directory';
          break;
        case 'file':
          type = 'file';
          break;
        default: {
          throw new Error(`Unhandled file kind: ${((entry satisfies never) as { readonly kind: string }).kind}`);
        }
        }

        switch (mount?.type) {
        case 'directory': {
          const childPath = resolved.fullPath === '/' ? `/${name}` : `${resolved.fullPath}/${name}`;
          const relPath = this.getRelativePath({ path: childPath, mount });
          const regEntry = mount.registryCache.get(relPath);
          if (regEntry) {
            type = regEntry.type;
          }
          break;
        }
        case 'virtual':
        case undefined:
          break;
        default: {
          const _ex: never = mount;
          throw new Error(`Unhandled mount entry: ${_ex}`);
        }
        }
        seen.add(name);
        const fullPath = resolved.fullPath === '/' ? `/${name}` : `${resolved.fullPath}/${name}`;
        yield { name, type, fullPath };
      }
      break;
    }
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${_ex}`);
    }
    }

    for (const name of this.getDirectMountChildren({ path: resolved.fullPath })) {
      if (!seen.has(name)) {
        seen.add(name);
        const fullPath = resolved.fullPath === '/' ? `/${name}` : `${resolved.fullPath}/${name}`;
        yield { name, type: 'directory', fullPath };
      }
    }
    for (const name of this.getDirectSpecialChildren({ path: resolved.fullPath })) {
      if (!seen.has(name)) {
        seen.add(name);
        const childPath = resolved.fullPath === '/' ? `/${name}` : `${resolved.fullPath}/${name}`;
        const type = this.specialFiles.get(childPath)?.type ?? 'directory';
        yield { name, type, fullPath: childPath };
      }
    }
  }

  async mkdir({ path, mode: _mode, recursive }: { path: string; mode?: number; recursive?: boolean }): Promise<void> {
    const normalized = this.normalizePath({ path: path });
    if (this.findVirtualMount({ path: normalized }) !== undefined) {
      throw new Error(`Read-only filesystem: ${normalized}`);
    }
    const parts = normalized.split('/').filter(p => p);

    let currentPath = '';
    for (let i = 0; i < parts.length; i++) {
      const nextPart = parts[i];
      if (nextPart === undefined) continue;
      const checkPath = currentPath + '/' + nextPart;
      try {
        const res = await this.resolveNode({
          path: checkPath,
          finalSymlinkTreatment: 'follow',
          depth: 0,
        });
        switch (res.kind) {
        case 'handle':
          switch (res.handle.kind) {
          case 'file':
            throw new Error(`File exists: ${checkPath}`);
          case 'directory':
            break;
          default: {
            const _ex: never = res.handle.kind;
            throw new Error(`Unhandled handle kind: ${_ex}`);
          }
          }
          break;
        case 'synthetic-directory':
          break;
        case 'special':
        case 'registry':
          throw new Error(`File exists: ${checkPath}`);
        default: {
          const _ex: never = res;
          throw new Error(`Unhandled resolved node: ${_ex}`);
        }
        }
      } catch {
        if (!recursive && i < parts.length - 1) throw new Error(`No such file or directory: ${currentPath}`);
        const parent = await this.resolveExistingDirectory({
          path: currentPath || '/',
          finalSymlinkTreatment: 'follow',
        });
        if (parent.readOnly) throw new Error(`Read-only fs: ${currentPath || '/'}`);
        await parent.handle.getDirectoryHandle(nextPart, { create: true });
      }
      currentPath = checkPath;
    }
  }

  async symlink({ path, targetPath, mode }: { path: string; targetPath: string; mode?: number }): Promise<void> {
    const normalized = this.normalizePath({ path: path });
    if (this.findVirtualMount({ path: normalized }) !== undefined) {
      throw new Error(`Read-only filesystem: ${normalized}`);
    }
    const mount = this.findMount({ path: normalized });
    switch (mount?.type) {
    case 'directory':
      break;
    case 'virtual':
    case undefined:
      throw new Error(`No mount point for ${normalized}`);
    default: {
      const _ex: never = mount;
      throw new Error(`Unhandled mount entry: ${_ex}`);
    }
    }
    if (mount.readOnly) throw new Error('Read-only filesystem');

    const existing = await this.tryResolveNode({
      path: normalized,
      finalSymlinkTreatment: 'no-follow',
    });
    if (existing !== undefined) {
      throw new Error(`File exists: ${normalized}`);
    }

    const parts = normalized.split('/');
    const name = parts.pop();
    if (name === undefined) throw new Error(`Invalid path: ${normalized}`);
    const parentPath = parts.join('/') || '/';
    const parent = await this.resolveExistingDirectory({
      path: parentPath,
      finalSymlinkTreatment: 'follow',
    });
    if (parent.readOnly) throw new Error(`Read-only filesystem: ${parentPath}`);

    await parent.handle.getFileHandle(name, { create: true });

    const relPath = this.getRelativePath({ path: normalized, mount });
    const entry: RegistryEntry = {
      type: 'symlink',
      mode: mode ?? 0o777,
      targetPath: targetPath,
    };
    mount.registryCache.set(relPath, entry);
    await this.saveRegistryEntry({ mount, relPath, entry });
  }

  async unlink({ path }: { path: string }): Promise<void> {
    const normalized = this.normalizePath({ path: path });
    if (this.findVirtualMount({ path: normalized }) !== undefined) {
      throw new Error(`Read-only filesystem: ${normalized}`);
    }
    if (this.isMountPoint({ path: normalized })) {
      throw new Error(`Cannot unlink mount point: ${normalized}`);
    }

    const resolved = await this.resolveNode({
      path: normalized,
      finalSymlinkTreatment: 'no-follow',
      depth: 0,
    });
    const stat = await this.statFromResolvedNode({ resolved });
    switch (stat.type) {
    case 'directory':
      throw new Error(`Is a directory: ${normalized}`);
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      break;
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled stat type: ${_ex}`);
    }
    }

    if (resolved.readOnly || resolved.kind === 'special') {
      throw new Error(`Read-only filesystem: ${normalized}`);
    }

    switch (resolved.kind) {
    case 'registry':
      resolved.resolution.mount.registryCache.delete(resolved.resolution.relPath);
      await this.deleteRegistryEntry({ mount: resolved.resolution.mount, relPath: resolved.resolution.relPath });
      break;
    case 'handle':
    case 'synthetic-directory':
      break;
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${_ex}`);
    }
    }
    const parts = normalized.split('/');
    const name = parts.pop();
    if (name === undefined) throw new Error(`Invalid path: ${normalized}`);
    const parentPath = parts.join('/') || '/';
    const parent = await this.resolveExistingDirectory({
      path: parentPath,
      finalSymlinkTreatment: 'follow',
    });
    if (parent.readOnly) {
      throw new Error(`Read-only filesystem: ${parentPath}`);
    }
    await parent.handle.removeEntry(name);
  }
  async rmdir({ path }: { path: string }): Promise<void> {
    const normalized = this.normalizePath({ path: path });
    if (this.findVirtualMount({ path: normalized }) !== undefined) {
      throw new Error(`Read-only filesystem: ${normalized}`);
    }
    if (this.isMountPoint({ path: normalized })) {
      throw new Error(`Cannot remove mount point: ${normalized}`);
    }

    const resolved = await this.resolveNode({
      path: normalized,
      finalSymlinkTreatment: 'no-follow',
      depth: 0,
    });
    const stat = await this.statFromResolvedNode({ resolved });
    switch (stat.type) {
    case 'directory':
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      throw new Error(`Not a directory: ${normalized}`);
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled stat type: ${_ex}`);
    }
    }

    if (resolved.readOnly || resolved.kind === 'special') {
      throw new Error(`Read-only filesystem: ${normalized}`);
    }

    for await (const _ of this.readDir({ path: normalized })) {
      throw new Error(`Directory not empty: ${normalized}`);
    }

    const parts = normalized.split('/');
    const name = parts.pop();
    if (name === undefined) throw new Error(`Invalid path: ${normalized}`);
    const parentPath = parts.join('/') || '/';
    const parent = await this.resolveExistingDirectory({
      path: parentPath,
      finalSymlinkTreatment: 'follow',
    });
    if (parent.readOnly) {
      throw new Error(`Read-only filesystem: ${parentPath}`);
    }
    await parent.handle.removeEntry(name);
  }

  async mknod({ path, type, mode }: { path: string; type: WeshFileType; mode?: number }): Promise<void> {
    const normalized = this.normalizePath({ path: path });
    const mount = this.findMount({ path: normalized });
    switch (mount?.type) {
    case 'directory':
      break;
    case 'virtual':
    case undefined:
      throw new Error(`No mount point for ${normalized}`);
    default: {
      const _ex: never = mount;
      throw new Error(`Unhandled mount entry: ${_ex}`);
    }
    }
    if (mount.readOnly) throw new Error(`Read-only filesystem`);

    const relPath = this.getRelativePath({ path: normalized, mount });
    const parts = normalized.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/') || '/';
    const parent = await this.resolveExistingDirectory({
      path: parentPath,
      finalSymlinkTreatment: 'follow',
    });
    await parent.handle.getFileHandle(name, { create: true });

    let entry: RegistryEntry;
    switch (type) {
    case 'fifo':
    case 'chardev':
      entry = { type: type, mode: mode ?? 0o644 };
      break;
    case 'symlink':
      throw new Error("Use ln -s for symlinks");
    case 'file':
    case 'directory':
      return;
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled option type: ${_ex}`);
    }
    }

    mount.registryCache.set(relPath, entry);
    await this.saveRegistryEntry({ mount, relPath, entry });
  }

  async rename({ oldPath, newPath }: { oldPath: string; newPath: string }): Promise<void> {
    const oldNormalized = this.normalizePath({ path: oldPath });
    const newNormalized = this.normalizePath({ path: newPath });
    if (oldNormalized === newNormalized) {
      return;
    }
    if (this.isMountPoint({ path: oldNormalized }) || this.isMountPoint({ path: newNormalized })) {
      throw new Error('Cannot rename mount point');
    }

    const oldResolved = await this.resolveNode({
      path: oldNormalized,
      finalSymlinkTreatment: 'no-follow',
      depth: 0,
    });
    if (oldResolved.readOnly || oldResolved.kind === 'special') {
      throw new Error(`Read-only source: ${oldNormalized}`);
    }

    const newParts = newNormalized.split('/');
    const newName = newParts.pop();
    if (newName === undefined) throw new Error(`Invalid path: ${newNormalized}`);
    const newParentPath = newParts.join('/') || '/';
    const newParentRes = await this.resolveExistingDirectory({
      path: newParentPath,
      finalSymlinkTreatment: 'follow',
    });
    if (newParentRes.readOnly) throw new Error(`Read-only destination: ${newParentPath}`);

    const existingDestination = await this.tryResolveNode({
      path: newNormalized,
      finalSymlinkTreatment: 'no-follow',
    });
    if (existingDestination !== undefined) {
      const destinationStat = await this.statFromResolvedNode({ resolved: existingDestination });
      switch (destinationStat.type) {
      case 'directory':
        throw new Error(`Is a directory: ${newNormalized}`);
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        await this.unlink({ path: newNormalized });
        break;
      default: {
        const _ex: never = destinationStat.type;
        throw new Error(`Unhandled destination type: ${_ex}`);
      }
      }
    }

    const oldMount = this.findMount({ path: oldNormalized });
    const newMount = this.findMount({ path: newNormalized });
    const oldRelPath = oldMount ? this.getRelativePath({ path: oldNormalized, mount: oldMount }) : undefined;
    const newRelPath = newMount ? this.getRelativePath({ path: newNormalized, mount: newMount }) : undefined;
    const oldRegistryEntry = oldMount?.type === 'directory' && oldRelPath ? oldMount.registryCache.get(oldRelPath) : undefined;

    let sourceHandle: FileSystemHandle;
    switch (oldResolved.kind) {
    case 'handle':
      sourceHandle = oldResolved.handle;
      break;
    case 'registry': {
      const physical = await this._resolvePhysical({ path: oldNormalized });
      sourceHandle = physical.handle;
      break;
    }
    case 'synthetic-directory':
      throw new Error(`Cannot rename: ${oldNormalized}`);
    default: {
      const _ex: never = oldResolved;
      throw new Error(`Unhandled resolved node: ${_ex}`);
    }
    }

    switch (sourceHandle.kind) {
    case 'file': {
      const oldFileHandle = sourceHandle as FileSystemFileHandle;
      const newParentDir = newParentRes.handle;

      // @ts-expect-error - move() is relatively new
      if (typeof oldFileHandle.move === 'function') {
        // @ts-expect-error - move() is relatively new
        await oldFileHandle.move(newParentDir, newName);
      } else {
        const newFileHandle = await newParentDir.getFileHandle(newName, { create: true });
        const writable = await newFileHandle.createWritable();
        const file = await oldFileHandle.getFile();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await writable.write(file as any);
        await writable.close();

        const oldParts = oldNormalized.split('/');
        const oldName = oldParts.pop();
        if (oldName === undefined) throw new Error(`Invalid path: ${oldNormalized}`);
        const oldParentPath = oldParts.join('/') || '/';
        const oldParentRes = await this.resolveExistingDirectory({
          path: oldParentPath,
          finalSymlinkTreatment: 'follow',
        });
        await oldParentRes.handle.removeEntry(oldName);
      }
      break;
    }
    case 'directory':
      throw new Error('Directory rename not yet implemented');
    default: {
      const _ex: never = sourceHandle.kind;
      throw new Error(`Unhandled kind: ${(_ex as string)}`);
    }
    }

    if (
      oldRegistryEntry !== undefined
      && oldMount?.type === 'directory'
      && oldRelPath !== undefined
      && newMount?.type === 'directory'
      && newRelPath !== undefined
    ) {
      oldMount.registryCache.delete(oldRelPath);
      await this.deleteRegistryEntry({ mount: oldMount, relPath: oldRelPath });
      newMount.registryCache.set(newRelPath, oldRegistryEntry);
      await this.saveRegistryEntry({ mount: newMount, relPath: newRelPath, entry: oldRegistryEntry });
    }
  }

  // --- Registry Persistence Helpers ---

  private async saveRegistryEntry({ mount, relPath, entry }: { mount: DirectoryMountEntry; relPath: string; entry: RegistryEntry }) {
    if (mount.readOnly) return;

    const systemDir = await mount.handle.getDirectoryHandle(WESH_SYSTEM_DIR, { create: true });
    const metaDir = await systemDir.getDirectoryHandle(METADATA_DIR, { create: true });

    const parts = relPath.split('/');
    const fileName = parts.pop();
    if (fileName === undefined) throw new Error(`Invalid relPath: ${relPath}`);
    let currentDir = metaDir;
    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part, { create: true });
    }
    const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    const dto = mapDomainToDto({ entry });
    await writable.write(JSON.stringify(dto));
    await writable.close();
  }

  private async deleteRegistryEntry({ mount, relPath }: { mount: DirectoryMountEntry; relPath: string }) {
    if (mount.readOnly) return;
    try {
      const systemDir = await mount.handle.getDirectoryHandle(WESH_SYSTEM_DIR);
      const metaDir = await systemDir.getDirectoryHandle(METADATA_DIR);
      const parts = relPath.split('/');
      const fileName = parts.pop();
      if (fileName === undefined) throw new Error(`Invalid relPath: ${relPath}`);
      let currentDir = metaDir;
      for (const part of parts) {
        currentDir = await currentDir.getDirectoryHandle(part);
      }
      await currentDir.removeEntry(fileName);
    } catch (e: unknown) {
      console.warn('Failed to delete registry entry:', e);
    }
  }

  // --- Path Helpers ---

  /**
   * Returns the underlying native FileSystemHandle if the path resolves to a
   * real filesystem entry (i.e. a handle-kind resolved node). Returns null for
   * synthetic directories, special files, and registry entries.
   */
  async getNativeHandle({ path }: { path: string }): Promise<FileSystemHandle | null> {
    try {
      const normalized = this.normalizePath({ path });
      if (this.findVirtualMount({ path: normalized }) !== undefined) {
        return null;
      }
      const resolved = await this.resolveNode({
        path,
        finalSymlinkTreatment: 'follow',
        depth: 0,
      });
      switch (resolved.kind) {
      case 'handle':
        return resolved.handle;
      case 'synthetic-directory':
      case 'special':
      case 'registry':
        return null;
      default: {
        const _ex: never = resolved;
        throw new Error(`Unhandled resolved node: ${JSON.stringify(_ex)}`);
      }
      }
    } catch {
      return null;
    }
  }

  /**
   * Returns whether the given path is read-only based on the owning mount.
   * Paths that fall outside every mount (synthetic intermediate directories)
   * are always read-only.
   */
  getReadOnlyForPath({ path }: { path: string }): boolean {
    const normalized = this.normalizePath({ path });
    const mount = this.findMount({ path: normalized });
    return mount?.readOnly ?? true;
  }

  private normalizePath({ path }: { path: string }): string {
    if (!path.startsWith('/')) path = '/' + path;
    const parts = path.split('/').filter((p) => p !== '' && p !== '.');
    const stack: string[] = [];
    for (const part of parts) {
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return '/' + stack.join('/');
  }

  private findMount({ path }: { path: string }): MountEntry | undefined {
    return this.mounts.find((m) => {
      if (path === m.path) return true;
      const prefix = m.path.endsWith('/') ? m.path : m.path + '/';
      return path.startsWith(prefix);
    });
  }

  private findVirtualMount({ path }: { path: string }): VirtualMountEntry | undefined {
    const mount = this.findMount({ path });
    switch (mount?.type) {
    case 'virtual':
      return mount;
    case 'directory':
    case undefined:
      return undefined;
    default: {
      const _ex: never = mount;
      throw new Error(`Unhandled mount entry: ${_ex}`);
    }
    }
  }

  private getRelativePath({ path, mount }: { path: string; mount: DirectoryMountEntry | VirtualMountEntry }): string {
    if (path === mount.path) return '.';
    const prefix = mount.path.endsWith('/') ? mount.path : mount.path + '/';
    return path.substring(prefix.length);
  }

  private getDirectMountChildren({ path }: { path: string }): Iterable<string> {
    const prefix = path === '/' ? '/' : `${path}/`;
    const childNames = new Set<string>();

    for (const mount of this.mounts) {
      if (!mount.path.startsWith(prefix)) continue;
      const remainder = mount.path.slice(prefix.length);
      if (remainder.length === 0) continue;
      const sep = remainder.indexOf('/');
      childNames.add(sep === -1 ? remainder : remainder.slice(0, sep));
    }

    return childNames;
  }

  private getDirectSpecialChildren({ path }: { path: string }): Iterable<string> {
    const prefix = path === '/' ? '/' : `${path}/`;
    const childNames = new Set<string>();

    for (const specialPath of this.specialFiles.keys()) {
      if (!specialPath.startsWith(prefix)) continue;
      const remainder = specialPath.slice(prefix.length);
      if (remainder.length === 0) continue;
      const sep = remainder.indexOf('/');
      childNames.add(sep === -1 ? remainder : remainder.slice(0, sep));
    }

    return childNames;
  }

  private hasSyntheticDirectory({ path }: { path: string }): boolean {
    const normalized = this.normalizePath({ path });
    const prefix = normalized === '/' ? '/' : `${normalized}/`;

    for (const mount of this.mounts) {
      if (mount.path !== normalized && mount.path.startsWith(prefix) && mount.path.length > prefix.length) {
        return true;
      }
    }

    for (const specialPath of this.specialFiles.keys()) {
      if (specialPath !== normalized && specialPath.startsWith(prefix) && specialPath.length > prefix.length) {
        return true;
      }
    }

    return false;
  }

  private isMountPoint({ path }: { path: string }): boolean {
    const normalized = this.normalizePath({ path });
    return this.mounts.some((mount) => mount.path === normalized && normalized !== '/');
  }

  private isInvalidHandleNameError({
    error,
  }: {
    error: unknown;
  }): boolean {
    return error instanceof Error && error.message.includes('Name is not allowed');
  }

  private rethrowPathLookupError({
    error,
    path,
  }: {
    error: unknown;
    path: string;
  }): never {
    if (this.isInvalidHandleNameError({ error })) {
      throw new Error(`Path not found: ${path}`);
    }

    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error(`Permission denied: ${path}: ${error.message}`);
    }

    throw error;
  }

  private async _resolvePhysical({ path }: { path: string }): Promise<{ handle: FileSystemHandle; readOnly: boolean; fullPath: string }> {
    const normalized = this.normalizePath({ path });
    const mount = this.findMount({ path: normalized });
    switch (mount?.type) {
    case 'directory':
      break;
    case 'virtual':
    case undefined:
      throw new Error(`Path not found: ${path}`);
    default: {
      const _ex: never = mount;
      throw new Error(`Unhandled mount entry: ${_ex}`);
    }
    }
    const relativePath = this.getRelativePath({ path: normalized, mount });
    if (relativePath === '.') {
      return { handle: mount.handle, readOnly: mount.readOnly, fullPath: normalized };
    }
    const parts = relativePath.split('/');
    let current: FileSystemDirectoryHandle = mount.handle;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (part === undefined) continue;
      try {
        current = await current.getDirectoryHandle(part);
      } catch (error: unknown) {
        this.rethrowPathLookupError({
          error,
          path: normalized,
        });
      }
    }
    const lastPart = parts[parts.length - 1];
    if (lastPart === undefined) return { handle: current, readOnly: mount.readOnly, fullPath: normalized };
    try {
      const fileHandle = await current.getFileHandle(lastPart);
      return { handle: fileHandle, readOnly: mount.readOnly, fullPath: normalized };
    } catch (fileError: unknown) {
      if (this.isInvalidHandleNameError({ error: fileError })) {
        throw new Error(`Path not found: ${normalized}`);
      }

      try {
        const dirHandle = await current.getDirectoryHandle(lastPart);
        switch (dirHandle.kind) {
        case 'directory':
          return { handle: dirHandle, readOnly: mount.readOnly, fullPath: normalized };
        default: {
          const _ex: never = dirHandle.kind;
          throw new Error(`Unhandled handle kind: ${_ex}`);
        }
        }
      } catch (dirError: unknown) {
        this.rethrowPathLookupError({
          error: dirError,
          path: normalized,
        });
      }
    }
  }

  private getRegistryResolution({ path }: { path: string }): RegistryResolution | undefined {
    const normalized = this.normalizePath({ path });
    const mount = this.findMount({ path: normalized });
    if (!mount || mount.type !== 'directory') {
      return undefined;
    }
    const relPath = this.getRelativePath({ path: normalized, mount });
    const entry = mount.registryCache.get(relPath);
    if (entry === undefined) {
      return undefined;
    }
    return { mount, relPath, entry };
  }

  private dirname({ path }: { path: string }): string {
    const normalized = this.normalizePath({ path });
    if (normalized === '/') {
      return '/';
    }
    const parts = normalized.split('/');
    parts.pop();
    return parts.join('/') || '/';
  }

  private resolveSymlinkTarget({
    linkPath,
    targetPath,
    remainder,
  }: {
    linkPath: string;
    targetPath: string;
    remainder: string;
  }): string {
    const basePath = targetPath.startsWith('/')
      ? targetPath
      : `${this.dirname({ path: linkPath })}/${targetPath}`;
    if (remainder.length === 0) {
      return this.normalizePath({ path: basePath });
    }
    return this.normalizePath({ path: `${basePath}/${remainder}` });
  }

  private async resolveNode({
    path,
    finalSymlinkTreatment,
    depth,
  }: {
    path: string;
    finalSymlinkTreatment: 'follow' | 'no-follow';
    depth: number;
  }): Promise<ResolvedNode> {
    const normalized = this.normalizePath({ path });
    if (depth > 40) {
      throw new Error(`Too many levels of symbolic links: ${normalized}`);
    }

    const directSpecial = this.specialFiles.get(normalized);
    if (directSpecial !== undefined) {
      return {
        kind: 'special',
        fullPath: normalized,
        readOnly: true,
        handler: directSpecial.handler,
      };
    }

    const parts = normalized.split('/').filter(part => part.length > 0);
    for (let i = 0; i < parts.length; i++) {
      const candidate = `/${parts.slice(0, i + 1).join('/')}`;
      if (this.specialFiles.has(candidate)) {
        if (i < parts.length - 1) {
          throw new Error(`Not a directory: ${candidate}`);
        }
        return {
          kind: 'special',
          fullPath: candidate,
          readOnly: true,
          handler: this.specialFiles.get(candidate)!.handler,
        };
      }

      const resolution = this.getRegistryResolution({ path: candidate });
      if (resolution === undefined) {
        continue;
      }

      const isFinalComponent = i === parts.length - 1;
      switch (resolution.entry.type) {
      case 'symlink':
        if (!isFinalComponent || finalSymlinkTreatment === 'follow') {
          return this.resolveNode({
            path: this.resolveSymlinkTarget({
              linkPath: candidate,
              targetPath: resolution.entry.targetPath ?? '',
              remainder: parts.slice(i + 1).join('/'),
            }),
            finalSymlinkTreatment,
            depth: depth + 1,
          });
        }
        return {
          kind: 'registry',
          fullPath: candidate,
          readOnly: resolution.mount.readOnly,
          resolution,
        };
      case 'fifo':
      case 'chardev':
        if (!isFinalComponent) {
          throw new Error(`Not a directory: ${candidate}`);
        }
        return {
          kind: 'registry',
          fullPath: candidate,
          readOnly: resolution.mount.readOnly,
          resolution,
        };
      default: {
        const _ex: never = resolution.entry.type;
        throw new Error(`Unhandled registry type: ${_ex}`);
      }
      }
    }

    try {
      const physical = await this._resolvePhysical({ path: normalized });
      return {
        kind: 'handle',
        fullPath: physical.fullPath,
        readOnly: physical.readOnly,
        handle: physical.handle,
      };
    } catch (error) {
      if (this.hasSyntheticDirectory({ path: normalized })) {
        return {
          kind: 'synthetic-directory',
          fullPath: normalized,
          readOnly: true,
        };
      }
      throw error;
    }
  }

  private async tryResolveNode({
    path,
    finalSymlinkTreatment,
  }: {
    path: string;
    finalSymlinkTreatment: 'follow' | 'no-follow';
  }): Promise<ResolvedNode | undefined> {
    try {
      return await this.resolveNode({
        path,
        finalSymlinkTreatment,
        depth: 0,
      });
    } catch {
      return undefined;
    }
  }

  private async resolveExistingDirectory({
    path,
    finalSymlinkTreatment,
  }: {
    path: string;
    finalSymlinkTreatment: 'follow' | 'no-follow';
  }): Promise<{ handle: FileSystemDirectoryHandle; readOnly: boolean; fullPath: string }> {
    const resolved = await this.resolveNode({
      path,
      finalSymlinkTreatment,
      depth: 0,
    });
    switch (resolved.kind) {
    case 'handle':
      switch (resolved.handle.kind) {
      case 'directory':
        return {
          handle: resolved.handle as FileSystemDirectoryHandle,
          readOnly: resolved.readOnly,
          fullPath: resolved.fullPath,
        };
      case 'file':
        throw new Error(`Not a directory: ${path}`);
      default: {
        const _ex: never = resolved.handle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
    case 'synthetic-directory':
      throw new Error(`Synthetic directory cannot be mutated: ${path}`);
    case 'registry':
    case 'special':
      throw new Error(`Not a directory: ${path}`);
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${_ex}`);
    }
    }
  }

  private async statFromResolvedNode({
    resolved,
  }: {
    resolved: ResolvedNode;
  }): Promise<WeshStat> {
    switch (resolved.kind) {
    case 'special': {
      const handle = resolved.handler();
      try {
        const stat = await handle.stat();
        return {
          ...stat,
          ino: computeStableInode({
            kind: 'special',
            path: resolved.fullPath,
          }),
        };
      } finally {
        await handle.close();
      }
    }
    case 'synthetic-directory':
      return {
        size: 0,
        mode: 0o555,
        type: 'directory',
        mtime: Date.now(),
        ino: computeStableInode({
          kind: 'synthetic-directory',
          path: resolved.fullPath,
        }),
        uid: 0,
        gid: 0,
      };
    case 'registry': {
      const size = (() => {
        switch (resolved.resolution.entry.type) {
        case 'symlink':
          return (resolved.resolution.entry.targetPath ?? '').length;
        case 'fifo':
        case 'chardev':
          return 0;
        default: {
          const _ex: never = resolved.resolution.entry.type;
          throw new Error(`Unhandled registry entry type: ${_ex}`);
        }
        }
      })();
      return {
        size,
        mode: resolved.resolution.entry.mode,
        type: resolved.resolution.entry.type,
        mtime: resolved.resolution.entry.mtime ?? Date.now(),
        ino: computeStableInode({
          kind: 'registry',
          path: resolved.fullPath,
        }),
        uid: resolved.resolution.entry.uid ?? 0,
        gid: resolved.resolution.entry.gid ?? 0,
      };
    }
    case 'handle':
      switch (resolved.handle.kind) {
      case 'file': {
        const file = await (resolved.handle as FileSystemFileHandle).getFile();
        return {
          size: file.size,
          mode: resolved.readOnly ? 0o444 : 0o644,
          type: 'file',
          mtime: file.lastModified,
          ino: computeStableInode({
            kind: 'handle',
            path: resolved.fullPath,
          }),
          uid: 0,
          gid: 0,
        };
      }
      case 'directory':
        return {
          size: 0,
          mode: resolved.readOnly ? 0o555 : 0o755,
          type: 'directory',
          mtime: Date.now(),
          ino: computeStableInode({
            kind: 'handle',
            path: resolved.fullPath,
          }),
          uid: 0,
          gid: 0,
        };
      default: {
        const _ex: never = resolved.handle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${_ex}`);
    }
    }
  }
}
