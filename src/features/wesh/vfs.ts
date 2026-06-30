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
  WeshEntryRef,
  WeshFinalSymlinkTreatment,
  WeshVirtualEntryRef,
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
  METADATA_DIR,
} from './dto';

const FIFO_BUFFER_LIMIT_BYTES = 64 * 1024;

// --- Domain Models ---

interface RegistryEntry {
  type: 'fifo' | 'chardev' | 'symlink',
  mode: number,
  targetPath?: string,
  uid?: number,
  gid?: number,
  mtime?: number,
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

function isFileSystemNotFoundError({ error }: { error: unknown }): boolean {
  if (error instanceof DOMException) {
    return error.name === 'NotFoundError';
  }
  if (error instanceof Error) {
    return error.message.includes('NotFoundError');
  }
  return false;
}

function isFileSystemTypeMismatchError({ error }: { error: unknown }): boolean {
  if (error instanceof DOMException) {
    return error.name === 'TypeMismatchError';
  }
  if (error instanceof Error) {
    return error.message.includes('TypeMismatchError');
  }
  return false;
}

function computeStableInode({
  kind,
  path,
}: {
  kind: 'handle' | 'registry' | 'synthetic_directory' | 'special',
  path: string,
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

interface WeshSyncAccessHandle {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the external FileSystemSyncAccessHandle API.
  read(buffer: Uint8Array, options?: { at?: number }): number,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the external FileSystemSyncAccessHandle API.
  write(buffer: Uint8Array, options?: { at?: number }): number,
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the external FileSystemSyncAccessHandle API.
  truncate(newSize: number): void,
  getSize(): number,
  flush(): void,
  close(): void,
}

interface WeshSyncAccessCapableFileHandle extends FileSystemFileHandle {
  createSyncAccessHandle?: () => Promise<WeshSyncAccessHandle>,
}

class StandardFileHandle implements WeshFileHandle {
  private readonly handle: FileSystemFileHandle;
  private readonly access: WeshOpenFlags['access'];
  private cursor = 0;
  private logicalSize = 0;
  private lastModified = 0;
  private closed = false;
  private readonly ready: Promise<void>;
  private fileSnapshot: File | undefined;
  private sequentialReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private pendingReadChunk: Uint8Array | undefined;
  private pendingReadOffset = 0;
  private writable: FileSystemWritableFileStream | undefined;
  private syncAccessHandle: WeshSyncAccessHandle | undefined;
  private closePromise: Promise<void> | undefined;

  constructor({
    handle,
    access,
    append,
  }: {
    handle: FileSystemFileHandle,
    access: WeshOpenFlags['access'],
    append: boolean,
  }) {
    this.handle = handle;
    this.access = access;
    this.ready = this.initialize({ append });
  }

  private async initialize({ append }: { append: boolean }): Promise<void> {
    const file = await this.handle.getFile();
    this.logicalSize = file.size;
    this.lastModified = file.lastModified;
    this.cursor = append ? file.size : 0;

    switch (this.access) {
    case 'read':
      this.fileSnapshot = file;
      this.sequentialReader = file.stream().getReader();
      return;
    case 'write':
      this.writable = await this.handle.createWritable({ keepExistingData: true });
      return;
    case 'read-write': {
      const syncCapableHandle = this.handle as WeshSyncAccessCapableFileHandle;
      const createSyncAccessHandle = syncCapableHandle.createSyncAccessHandle;
      if (createSyncAccessHandle === undefined) {
        return;
      }
      try {
        this.syncAccessHandle = await createSyncAccessHandle.call(syncCapableHandle);
        this.logicalSize = this.syncAccessHandle.getSize();
      } catch {
        // Sync access is available only for OPFS files in dedicated workers.
      }
      return;
    }
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled access mode: ${_ex}`);
    }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('File handle is closed');
    }
  }

  private async getFileSnapshot(): Promise<File> {
    if (this.fileSnapshot !== undefined) {
      return this.fileSnapshot;
    }
    const file = await this.handle.getFile();
    this.fileSnapshot = file;
    return file;
  }

  private async readSequential({
    buffer,
    offset,
    length,
  }: {
    buffer: Uint8Array,
    offset: number,
    length: number,
  }): Promise<WeshIOResult> {
    const reader = this.sequentialReader;
    if (reader === undefined) {
      throw new Error('Sequential reader is unavailable');
    }

    let bytesRead = 0;
    while (bytesRead < length) {
      if (this.pendingReadChunk === undefined) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        this.pendingReadChunk = result.value;
        this.pendingReadOffset = 0;
      }

      const chunk = this.pendingReadChunk;
      const available = chunk.length - this.pendingReadOffset;
      const copyLength = Math.min(available, length - bytesRead);
      buffer.set(
        chunk.subarray(this.pendingReadOffset, this.pendingReadOffset + copyLength),
        offset + bytesRead,
      );
      bytesRead += copyLength;
      this.pendingReadOffset += copyLength;

      if (this.pendingReadOffset >= chunk.length) {
        this.pendingReadChunk = undefined;
        this.pendingReadOffset = 0;
      }
    }

    this.cursor += bytesRead;
    return { bytesRead };
  }

  private async readFromSnapshot({
    buffer,
    offset,
    length,
    position,
  }: {
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  }): Promise<WeshIOResult> {
    const file = await this.getFileSnapshot();
    if (position >= file.size) {
      return { bytesRead: 0 };
    }

    const end = Math.min(position + length, file.size);
    const data = new Uint8Array(await file.slice(position, end).arrayBuffer());
    buffer.set(data, offset);
    return { bytesRead: data.length };
  }

  async read({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshIOResult> {
    await this.ready;
    this.assertOpen();
    switch (this.access) {
    case 'read':
    case 'read-write':
      break;
    case 'write':
      throw new Error('File is not open for reading');
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled access mode: ${_ex}`);
    }
    }

    const bufferOffset = offset ?? 0;
    const maximumLength = length ?? (buffer.length - bufferOffset);
    if (maximumLength <= 0) {
      return { bytesRead: 0 };
    }

    if (this.access === 'read' && position === undefined) {
      return this.readSequential({
        buffer,
        offset: bufferOffset,
        length: maximumLength,
      });
    }

    const readPosition = position ?? this.cursor;
    const syncAccessHandle = this.syncAccessHandle;
    const result = syncAccessHandle === undefined
      ? await this.readFromSnapshot({
        buffer,
        offset: bufferOffset,
        length: maximumLength,
        position: readPosition,
      })
      : {
        bytesRead: syncAccessHandle.read(
          buffer.subarray(bufferOffset, bufferOffset + maximumLength),
          { at: readPosition },
        ),
      };
    if (position === undefined) {
      this.cursor += result.bytesRead;
    }
    return result;
  }

  private async writeWithFallback({
    data,
    position,
  }: {
    data: Uint8Array,
    position: number,
  }): Promise<void> {
    const writable = await this.handle.createWritable({ keepExistingData: true });
    try {
      await writable.seek(position);
      await writable.write(data as BufferSource);
    } finally {
      await writable.close();
    }
    this.fileSnapshot = undefined;
  }

  async write({ buffer, offset, length: requestedLength, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshWriteResult> {
    await this.ready;
    this.assertOpen();
    switch (this.access) {
    case 'write':
    case 'read-write':
      break;
    case 'read':
      throw new Error('File is read-only');
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled access mode: ${_ex}`);
    }
    }

    const bufferOffset = offset ?? 0;
    const length = requestedLength ?? (buffer.length - bufferOffset);
    const data = buffer.subarray(bufferOffset, bufferOffset + length);
    const writePosition = position ?? this.cursor;

    const bytesWritten = await (async (): Promise<number> => {
      switch (this.access) {
      case 'write': {
        const writable = this.writable;
        if (writable === undefined) {
          throw new Error('Sequential writer is unavailable');
        }
        await writable.seek(writePosition);
        await writable.write(data as BufferSource);
        return length;
      }
      case 'read-write': {
        const syncAccessHandle = this.syncAccessHandle;
        if (syncAccessHandle !== undefined) {
          const written = syncAccessHandle.write(data, { at: writePosition });
          syncAccessHandle.flush();
          return written;
        }
        await this.writeWithFallback({ data, position: writePosition });
        return length;
      }
      case 'read':
        throw new Error('File is read-only');
      default: {
        const _ex: never = this.access;
        throw new Error(`Unhandled access mode: ${_ex}`);
      }
      }
    })();

    if (position === undefined) {
      this.cursor += bytesWritten;
    }
    this.logicalSize = Math.max(this.logicalSize, writePosition + bytesWritten);
    this.lastModified = Date.now();
    return { bytesWritten };
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = this.closeInitializedResources();
    return this.closePromise;
  }

  private async closeInitializedResources(): Promise<void> {
    await this.ready;

    const reader = this.sequentialReader;
    this.sequentialReader = undefined;
    this.pendingReadChunk = undefined;
    if (reader !== undefined) {
      await reader.cancel();
    }

    const writable = this.writable;
    this.writable = undefined;
    if (writable !== undefined) {
      await writable.close();
    }

    const syncAccessHandle = this.syncAccessHandle;
    this.syncAccessHandle = undefined;
    if (syncAccessHandle !== undefined) {
      syncAccessHandle.flush();
      syncAccessHandle.close();
    }
  }

  async stat(): Promise<WeshStat> {
    await this.ready;
    this.assertOpen();
    switch (this.access) {
    case 'read':
    case 'write':
      break;
    case 'read-write': {
      const syncAccessHandle = this.syncAccessHandle;
      if (syncAccessHandle !== undefined) {
        this.logicalSize = syncAccessHandle.getSize();
      } else {
        const file = await this.handle.getFile();
        this.logicalSize = file.size;
        this.lastModified = file.lastModified;
      }
      break;
    }
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled access mode: ${_ex}`);
    }
    }
    return {
      size: this.logicalSize,
      mode: 0o644,
      type: 'file',
      mtime: this.lastModified,
      ino: 0,
      uid: 0,
      gid: 0,
    };
  }

  async truncate({ size }: { size: number }): Promise<void> {
    await this.ready;
    this.assertOpen();
    switch (this.access) {
    case 'read':
      throw new Error('File is read-only');
    case 'write':
    case 'read-write':
      break;
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled access mode: ${_ex}`);
    }
    }

    switch (this.access) {
    case 'write': {
      const writable = this.writable;
      if (writable === undefined) {
        throw new Error('Sequential writer is unavailable');
      }
      await writable.truncate(size);
      break;
    }
    case 'read-write': {
      const syncAccessHandle = this.syncAccessHandle;
      if (syncAccessHandle !== undefined) {
        syncAccessHandle.truncate(size);
        syncAccessHandle.flush();
      } else {
        const writable = await this.handle.createWritable({ keepExistingData: true });
        try {
          await writable.truncate(size);
        } finally {
          await writable.close();
        }
        this.fileSnapshot = undefined;
      }
      break;
    }
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled access mode: ${_ex}`);
    }
    }

    this.logicalSize = size;
    this.lastModified = Date.now();
    if (this.cursor > size) {
      this.cursor = size;
    }
  }

  async ioctl(): Promise<{ ret: number }> {
    return { ret: -1 };
  }
}

interface FifoRuntimeState {
  buffer: Uint8Array[],
  bufferHeadIndex: number,
  bufferSize: number,
  headOffset: number,
  readWaiters: Array<ReturnType<typeof Promise.withResolvers<void>>['resolve']>,
  writeWaiters: Array<ReturnType<typeof Promise.withResolvers<void>>['resolve']>,
  readerCount: number,
  writerCount: number,
}

class FifoHandle implements WeshFileHandle {
  private readonly state: FifoRuntimeState;
  private readonly access: WeshOpenFlags['access'];
  private readonly onUnused: () => void;
  private closed = false;

  constructor({
    state,
    access,
    onUnused,
  }: {
    state: FifoRuntimeState,
    access: WeshOpenFlags['access'],
    onUnused: () => void,
  }) {
    this.state = state;
    this.access = access;
    this.onUnused = onUnused;
    switch (access) {
    case 'read':
      state.readerCount += 1;
      break;
    case 'write':
      state.writerCount += 1;
      break;
    case 'read-write':
      state.readerCount += 1;
      state.writerCount += 1;
      break;
    default: {
      const _ex: never = access;
      throw new Error(`Unhandled FIFO access mode: ${_ex}`);
    }
    }
  }

  private wakeReadWaiters(): void {
    const waiters = this.state.readWaiters;
    this.state.readWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private wakeWriteWaiters(): void {
    const waiters = this.state.writeWaiters;
    this.state.writeWaiters = [];
    for (const waiter of waiters) waiter();
  }

  async read({ buffer, offset, length }: { buffer: Uint8Array, offset?: number, length?: number }): Promise<WeshIOResult> {
    if (this.closed) return { bytesRead: 0 };
    switch (this.access) {
    case 'read':
    case 'read-write':
      break;
    case 'write':
      throw new Error('File is not open for reading');
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled FIFO access mode: ${_ex}`);
    }
    }

    while (this.state.bufferHeadIndex >= this.state.buffer.length) {
      if (this.closed || this.state.writerCount === 0) return { bytesRead: 0 };
      await new Promise<void>(resolve => this.state.readWaiters.push(resolve));
    }

    const chunk = this.state.buffer[this.state.bufferHeadIndex]!;
    const bufferOffset = offset ?? 0;
    const maxLen = length ?? (buffer.length - bufferOffset);
    const available = chunk.length - this.state.headOffset;
    const copyLen = Math.min(available, maxLen);

    buffer.set(chunk.subarray(this.state.headOffset, this.state.headOffset + copyLen), bufferOffset);

    if (copyLen === available) {
      this.state.bufferHeadIndex += 1;
      this.state.headOffset = 0;
      if (this.state.bufferHeadIndex >= this.state.buffer.length) {
        this.state.buffer = [];
        this.state.bufferHeadIndex = 0;
      } else if (
        this.state.bufferHeadIndex >= 32
        && this.state.bufferHeadIndex * 2 >= this.state.buffer.length
      ) {
        this.state.buffer = this.state.buffer.slice(this.state.bufferHeadIndex);
        this.state.bufferHeadIndex = 0;
      }
    } else {
      this.state.headOffset += copyLen;
    }
    this.state.bufferSize -= copyLen;
    this.wakeWriteWaiters();

    return { bytesRead: copyLen };
  }

  async write({ buffer, offset, length: requestedLength }: { buffer: Uint8Array, offset?: number, length?: number }): Promise<WeshWriteResult> {
    if (this.closed) throw new WeshBrokenPipeError();
    switch (this.access) {
    case 'write':
    case 'read-write':
      break;
    case 'read':
      throw new Error('File is not open for writing');
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled FIFO access mode: ${_ex}`);
    }
    }

    const bufferOffset = offset ?? 0;
    const length = requestedLength ?? (buffer.length - bufferOffset);
    let bytesWritten = 0;
    while (bytesWritten < length) {
      if (this.closed) {
        return { bytesWritten };
      }
      const availableCapacity = FIFO_BUFFER_LIMIT_BYTES - this.state.bufferSize;
      if (availableCapacity <= 0) {
        await new Promise<void>(resolve => this.state.writeWaiters.push(resolve));
        continue;
      }
      const chunkLength = Math.min(length - bytesWritten, availableCapacity);
      const start = bufferOffset + bytesWritten;
      const data = new Uint8Array(buffer.subarray(start, start + chunkLength));
      this.state.buffer.push(data);
      this.state.bufferSize += chunkLength;
      bytesWritten += chunkLength;
      this.wakeReadWaiters();
    }

    return { bytesWritten };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    switch (this.access) {
    case 'read':
      this.state.readerCount -= 1;
      break;
    case 'write':
      this.state.writerCount -= 1;
      break;
    case 'read-write':
      this.state.readerCount -= 1;
      this.state.writerCount -= 1;
      break;
    default: {
      const _ex: never = this.access;
      throw new Error(`Unhandled FIFO access mode: ${_ex}`);
    }
    }
    this.wakeReadWaiters();
    this.wakeWriteWaiters();
    if (this.state.readerCount === 0 && this.state.writerCount === 0) {
      this.onUnused();
    }
  }

  async stat(): Promise<WeshStat> {
    return {
      size: this.state.bufferSize,
      mode: 0o600,
      type: 'fifo',
      mtime: Date.now(),
      ino: 0,
      uid: 0,
      gid: 0,
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
  async write({ length, buffer, offset }: { length?: number, buffer: Uint8Array, offset?: number }): Promise<WeshWriteResult> {
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
  async read({ buffer, offset: requestedOffset, length: requestedLength }: { buffer: Uint8Array, offset?: number, length?: number }): Promise<WeshIOResult> {
    const offset = requestedOffset ?? 0;
    const length = requestedLength ?? (buffer.length - offset);
    buffer.fill(0, offset, offset + length);
    return { bytesRead: length };
  }
  async write({ length, buffer, offset }: { length?: number, buffer: Uint8Array, offset?: number }): Promise<WeshWriteResult> {
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
  type: 'directory',
  path: string,
  handle: FileSystemDirectoryHandle,
  readOnly: boolean,
  metadataHandle: FileSystemDirectoryHandle | undefined,
}

interface VirtualMountEntry {
  type: 'virtual',
  path: string,
  readOnly: boolean,
  provider: WeshVirtualMountProvider,
}

type MountEntry = DirectoryMountEntry | VirtualMountEntry;

interface RegistryResolution {
  mount: DirectoryMountEntry,
  relPath: string,
  entry: RegistryEntry,
}

type ResolvedNode =
  | {
    kind: 'handle',
    fullPath: string,
    readOnly: boolean,
    handle: FileSystemHandle,
  }
  | {
    kind: 'registry',
    fullPath: string,
    readOnly: boolean,
    resolution: RegistryResolution,
  }
  | {
    kind: 'special',
    fullPath: string,
    readOnly: boolean,
    handler: () => WeshFileHandle,
  }
  | {
    kind: 'synthetic_directory',
    fullPath: string,
    readOnly: boolean,
  };


type WeshEntryRefBackend =
  | {
      kind: 'resolved_node',
      resolved: ResolvedNode,
    }
  | {
      kind: 'virtual_entry',
      entry: WeshVirtualEntryRef,
      readOnly: boolean,
    }
  | {
      kind: 'virtual_path',
      provider: WeshVirtualMountProvider,
      path: string,
      readOnly: boolean,
    };

export class WeshVFS implements WeshIVirtualFileSystem {
  private mounts: MountEntry[] = [];
  private specialFiles: Map<string, { type: WeshSpecialFileType, handler: () => WeshFileHandle }> = new Map();
  private openFifos: Map<string, FifoRuntimeState> = new Map();
  private readonly entryRefBackends = new WeakMap<WeshEntryRef, WeshEntryRefBackend>();

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

  private basename({ path }: { path: string }): string {
    if (path === '/') {
      return '/';
    }
    const segments = path.split('/');
    return segments[segments.length - 1] ?? path;
  }

  private getResolvedNodeType({ resolved }: { resolved: ResolvedNode }): WeshFileType {
    switch (resolved.kind) {
    case 'handle':
      switch (resolved.handle.kind) {
      case 'file':
        return 'file';
      case 'directory':
        return 'directory';
      default: {
        const _ex: never = resolved.handle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
    case 'registry':
      return resolved.resolution.entry.type;
    case 'special':
      return this.specialFiles.get(resolved.fullPath)?.type ?? 'file';
    case 'synthetic_directory':
      return 'directory';
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${String(_ex)}`);
    }
    }
  }

  private createEntryRef({
    name,
    type,
    fullPath,
    backend,
  }: {
    name: string,
    type: WeshFileType,
    fullPath: string,
    backend: WeshEntryRefBackend,
  }): WeshEntryRef {
    const entry = Object.freeze({
      name,
      type,
      fullPath,
    }) as WeshEntryRef;
    this.entryRefBackends.set(entry, backend);
    return entry;
  }

  private createResolvedEntryRef({
    resolved,
    name,
  }: {
    resolved: ResolvedNode,
    name: string | undefined,
  }): WeshEntryRef {
    return this.createEntryRef({
      name: name ?? this.basename({ path: resolved.fullPath }),
      type: this.getResolvedNodeType({ resolved }),
      fullPath: resolved.fullPath,
      backend: {
        kind: 'resolved_node',
        resolved,
      },
    });
  }

  private getEntryRefBackend({ entry }: { entry: WeshEntryRef }): WeshEntryRefBackend {
    const backend = this.entryRefBackends.get(entry);
    if (backend === undefined) {
      throw new Error('Entry reference does not belong to this Wesh VFS');
    }
    return backend;
  }

  async mount({ path, handle, readOnly }: { path: string, handle: FileSystemDirectoryHandle, readOnly?: boolean }): Promise<void> {
    const normalizedPath = this.normalizePath({ path });
    this.mounts = this.mounts.filter((m) => m.path !== normalizedPath);
    this.mounts.push({
      type: 'directory',
      path: normalizedPath,
      handle,
      readOnly: !!readOnly,
      metadataHandle: undefined,
    });
    this.mounts.sort((a, b) => b.path.length - a.path.length);
  }

  mountVirtual({
    path,
    readOnly,
    provider,
  }: {
    path: string,
    readOnly: boolean,
    provider: WeshVirtualMountProvider,
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

  async unmount({ path }: { path: string }): Promise<void> {
    const normalizedPath = this.normalizePath({ path });
    if (normalizedPath === '/') throw new Error('Cannot unmount root');
    this.mounts = this.mounts.filter((m) => m.path !== normalizedPath);
  }

  registerSpecialFile({ path, type, handler }: { path: string, type: WeshSpecialFileType, handler: () => WeshFileHandle }): void {
    this.specialFiles.set(this.normalizePath({ path }), { type, handler });
  }

  unregisterSpecialFile({ path }: { path: string }): void {
    this.specialFiles.delete(this.normalizePath({ path }));
  }

  async open({ path, flags, mode }: { path: string, flags: WeshOpenFlags, mode?: number }): Promise<WeshFileHandle> {
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
    let pathExisted = true;

    try {
      resolved = await this.resolveNode({
        path: normalized,
        finalSymlinkTreatment: 'follow',
        depth: 0,
      });
    } catch (error: unknown) {
      if (!create || !isFileSystemNotFoundError({ error })) {
        throw error;
      }
      pathExisted = false;
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
    }

    if (pathExisted) {
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
    }

    switch (resolved.kind) {
    case 'special':
      return resolved.handler();
    case 'registry':
      switch (resolved.resolution.entry.type) {
      case 'fifo': {
        let state = this.openFifos.get(resolved.fullPath);
        if (state === undefined) {
          state = {
            buffer: [],
            bufferHeadIndex: 0,
            bufferSize: 0,
            headOffset: 0,
            readWaiters: [],
            writeWaiters: [],
            readerCount: 0,
            writerCount: 0,
          };
          this.openFifos.set(resolved.fullPath, state);
        }
        const fifoState = state;
        return new FifoHandle({
          state: fifoState,
          access: flags.access,
          onUnused: () => {
            if (this.openFifos.get(resolved.fullPath) === fifoState) {
              this.openFifos.delete(resolved.fullPath);
            }
          },
        });
      }
      case 'chardev':
        throw new Error('Open not implemented for chardev');
      case 'symlink':
        throw new Error(`Dangling symlink: ${normalized}`);
      default: {
        const _ex: never = resolved.resolution.entry.type;
        throw new Error(`Unhandled registry entry type: ${_ex}`);
      }
      }
    case 'synthetic_directory':
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

    if (resolved.readOnly && flags.access !== 'read') {
      throw new Error('File is read-only');
    }

    const fileHandle = new StandardFileHandle({
      handle: resolved.handle as FileSystemFileHandle,
      access: flags.access,
      append: flags.append === 'append',
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
    case 'synthetic_directory':
    case 'special':
      throw new Error(`Invalid argument: ${path}`);
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${_ex}`);
    }
    }
  }

  async resolve({ path }: { path: string }): Promise<{ fullPath: string, stat: WeshStat }> {
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
        kind: 'fallback_required',
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
          kind: 'fallback_required',
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
    case 'synthetic_directory':
      return {
        kind: 'fallback_required',
        reason: WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED,
      };
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${JSON.stringify(_ex)}`);
    }
    }
  }

  async tryCreateFileWriterEfficiently({ path, mode }: {
    path: string,
    mode: 'truncate' | 'append',
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
    case 'synthetic_directory':
      return {
        kind: 'fallback_required',
        reason: WESH_EFFICIENT_FILE_WRITE_FALLBACK_REQUIRED,
      };
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${JSON.stringify(_ex)}`);
    }
    }
  }

  async resolveEntry({
    path,
    finalSymlinkTreatment,
  }: {
    path: string,
    finalSymlinkTreatment: WeshFinalSymlinkTreatment,
  }): Promise<WeshEntryRef> {
    const normalized = this.normalizePath({ path });
    const virtualMount = this.findVirtualMount({ path: normalized });
    if (virtualMount !== undefined) {
      if (virtualMount.provider.resolveEntryRef !== undefined) {
        const virtualEntry = await virtualMount.provider.resolveEntryRef({
          path: normalized,
          finalSymlinkTreatment,
        });
        return this.createEntryRef({
          name: virtualEntry.name,
          type: virtualEntry.type,
          fullPath: virtualEntry.fullPath,
          backend: {
            kind: 'virtual_entry',
            entry: virtualEntry,
            readOnly: virtualMount.readOnly,
          },
        });
      }

      const stat = await (() => {
        switch (finalSymlinkTreatment) {
        case 'follow':
          return virtualMount.provider.stat({ path: normalized });
        case 'no-follow':
          return virtualMount.provider.lstat({ path: normalized });
        default: {
          const _ex: never = finalSymlinkTreatment;
          throw new Error(`Unhandled symlink treatment: ${_ex}`);
        }
        }
      })();
      return this.createEntryRef({
        name: this.basename({ path: normalized }),
        type: stat.type,
        fullPath: normalized,
        backend: {
          kind: 'virtual_path',
          provider: virtualMount.provider,
          path: normalized,
          readOnly: virtualMount.readOnly,
        },
      });
    }

    const resolved = await this.resolveNode({
      path: normalized,
      finalSymlinkTreatment,
      depth: 0,
    });
    return this.createResolvedEntryRef({
      resolved,
      name: undefined,
    });
  }

  async *readDirEntry({
    entry,
  }: {
    entry: WeshEntryRef<'directory'>,
  }): AsyncIterable<WeshEntryRef> {
    const backend = this.getEntryRefBackend({ entry });
    switch (backend.kind) {
    case 'virtual_entry': {
      const directoryEntry = (() => {
        switch (backend.entry.type) {
        case 'directory':
          return backend.entry;
        case 'file':
        case 'fifo':
        case 'chardev':
        case 'symlink':
          throw new Error(`Not a directory: ${entry.fullPath}`);
        default: {
          const _ex: never = backend.entry;
          throw new Error(`Unhandled virtual entry: ${String(_ex)}`);
        }
        }
      })();
      for await (const child of directoryEntry.readDir()) {
        yield this.createEntryRef({
          name: child.name,
          type: child.type,
          fullPath: child.fullPath,
          backend: {
            kind: 'virtual_entry',
            entry: child,
            readOnly: backend.readOnly,
          },
        });
      }
      return;
    }
    case 'virtual_path':
      for await (const child of backend.provider.readDir({ path: backend.path })) {
        yield this.createEntryRef({
          name: child.name,
          type: child.type,
          fullPath: child.fullPath,
          backend: {
            kind: 'virtual_path',
            provider: backend.provider,
            path: child.fullPath,
            readOnly: backend.readOnly,
          },
        });
      }
      return;
    case 'resolved_node':
      break;
    default: {
      const _ex: never = backend;
      throw new Error(`Unhandled entry backend: ${String(_ex)}`);
    }
    }

    const resolved = backend.resolved;
    const remainingOverlayNames = new Set([
      ...this.getDirectMountChildren({ path: resolved.fullPath }),
      ...this.getDirectSpecialChildren({ path: resolved.fullPath }),
    ]);
    switch (resolved.kind) {
    case 'synthetic_directory':
      break;
    case 'special':
    case 'registry':
      throw new Error(`Not a directory: ${entry.fullPath}`);
    case 'handle': {
      const directoryHandle = (() => {
        switch (resolved.handle.kind) {
        case 'directory':
          return resolved.handle as FileSystemDirectoryHandle;
        case 'file':
          throw new Error(`Not a directory: ${entry.fullPath}`);
        default: {
          const _ex: never = resolved.handle.kind;
          throw new Error(`Unhandled handle kind: ${_ex}`);
        }
        }
      })();
      const mount = this.findMount({ path: resolved.fullPath });
      const directRegistryEntries = await (() => {
        switch (mount?.type) {
        case 'directory':
          return this.loadDirectRegistryEntries({
            mount,
            directoryRelPath: this.getRelativePath({ path: resolved.fullPath, mount }),
          });
        case 'virtual':
        case undefined:
          return new Map<string, RegistryEntry>();
        default: {
          const _ex: never = mount;
          throw new Error(`Unhandled mount entry: ${String(_ex)}`);
        }
        }
      })();
      for await (const [name, childHandle] of directoryHandle.entries()) {
        if (name === WESH_SYSTEM_DIR) {
          continue;
        }
        const fullPath = resolved.fullPath === '/'
          ? `/${name}`
          : `${resolved.fullPath}/${name}`;
        let childResolved: ResolvedNode = {
          kind: 'handle',
          fullPath,
          readOnly: resolved.readOnly,
          handle: childHandle,
        };

        switch (mount?.type) {
        case 'directory': {
          const relPath = this.getRelativePath({ path: fullPath, mount });
          const registryEntry = directRegistryEntries.get(name);
          if (registryEntry !== undefined) {
            childResolved = {
              kind: 'registry',
              fullPath,
              readOnly: mount.readOnly,
              resolution: {
                mount,
                relPath,
                entry: registryEntry,
              },
            };
          }
          break;
        }
        case 'virtual':
        case undefined:
          break;
        default: {
          const _ex: never = mount;
          throw new Error(`Unhandled mount entry: ${String(_ex)}`);
        }
        }

        remainingOverlayNames.delete(name);
        yield this.createResolvedEntryRef({
          resolved: childResolved,
          name,
        });
      }
      break;
    }
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${String(_ex)}`);
    }
    }

    for (const name of remainingOverlayNames) {
      const fullPath = resolved.fullPath === '/'
        ? `/${name}`
        : `${resolved.fullPath}/${name}`;
      yield await this.resolveEntry({
        path: fullPath,
        finalSymlinkTreatment: 'no-follow',
      });
    }
  }

  async statEntry({ entry }: { entry: WeshEntryRef }): Promise<WeshStat> {
    const backend = this.getEntryRefBackend({ entry });
    switch (backend.kind) {
    case 'virtual_entry':
      return backend.entry.stat();
    case 'virtual_path':
      return backend.provider.lstat({ path: backend.path });
    case 'resolved_node':
      return this.statFromResolvedNode({ resolved: backend.resolved });
    default: {
      const _ex: never = backend;
      throw new Error(`Unhandled entry backend: ${String(_ex)}`);
    }
    }
  }

  async openEntry({
    entry,
    flags,
    mode,
  }: {
    entry: WeshEntryRef,
    flags: WeshOpenFlags,
    mode?: number,
  }): Promise<WeshFileHandle> {
    const backend = this.getEntryRefBackend({ entry });
    switch (backend.kind) {
    case 'virtual_entry':
      switch (backend.entry.type) {
      case 'file':
      case 'fifo':
      case 'chardev':
        return backend.entry.open({ flags, mode });
      case 'directory':
      case 'symlink':
        return this.open({ path: entry.fullPath, flags, mode });
      default: {
        const _ex: never = backend.entry;
        throw new Error(`Unhandled virtual entry: ${String(_ex)}`);
      }
      }
    case 'virtual_path':
      return backend.provider.open({
        path: backend.path,
        flags,
        mode,
      });
    case 'resolved_node':
      break;
    default: {
      const _ex: never = backend;
      throw new Error(`Unhandled entry backend: ${String(_ex)}`);
    }
    }

    const resolved = backend.resolved;
    if (resolved.kind !== 'handle' || resolved.handle.kind !== 'file') {
      return this.open({
        path: entry.fullPath,
        flags,
        mode,
      });
    }
    switch (flags.creation) {
    case 'always':
      throw new Error(`File exists: ${entry.fullPath}`);
    case 'never':
    case 'if-needed':
      break;
    default: {
      const _ex: never = flags.creation;
      throw new Error(`Unhandled creation flag: ${_ex}`);
    }
    }
    if (resolved.readOnly && flags.access !== 'read') {
      throw new Error('File is read-only');
    }

    const handle = new StandardFileHandle({
      handle: resolved.handle as FileSystemFileHandle,
      access: flags.access,
      append: flags.append === 'append',
    });
    switch (flags.truncate) {
    case 'truncate':
      await handle.truncate({ size: 0 });
      break;
    case 'preserve':
      break;
    default: {
      const _ex: never = flags.truncate;
      throw new Error(`Unhandled truncate flag: ${_ex}`);
    }
    }
    return handle;
  }

  async readlinkEntry({
    entry,
  }: {
    entry: WeshEntryRef<'symlink'>,
  }): Promise<string> {
    const backend = this.getEntryRefBackend({ entry });
    switch (backend.kind) {
    case 'virtual_entry':
      switch (backend.entry.type) {
      case 'symlink':
        return backend.entry.readlink();
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'directory':
        throw new Error(`Invalid argument: ${entry.fullPath}`);
      default: {
        const _ex: never = backend.entry;
        throw new Error(`Unhandled virtual entry: ${String(_ex)}`);
      }
      }
    case 'virtual_path':
      return backend.provider.readlink({ path: backend.path });
    case 'resolved_node':
      switch (backend.resolved.kind) {
      case 'registry':
        switch (backend.resolved.resolution.entry.type) {
        case 'symlink':
          return backend.resolved.resolution.entry.targetPath ?? '';
        case 'fifo':
        case 'chardev':
          throw new Error(`Invalid argument: ${entry.fullPath}`);
        default: {
          const _ex: never = backend.resolved.resolution.entry.type;
          throw new Error(`Unhandled registry entry type: ${_ex}`);
        }
        }
      case 'handle':
      case 'special':
      case 'synthetic_directory':
        throw new Error(`Invalid argument: ${entry.fullPath}`);
      default: {
        const _ex: never = backend.resolved;
        throw new Error(`Unhandled resolved node: ${String(_ex)}`);
      }
      }
    default: {
      const _ex: never = backend;
      throw new Error(`Unhandled entry backend: ${String(_ex)}`);
    }
    }
  }

  async *readDir({ path }: { path: string }): AsyncIterable<WeshDirEntry> {
    const entry = await this.resolveEntry({
      path,
      finalSymlinkTreatment: 'follow',
    });
    const directoryEntry = (() => {
      switch (entry.type) {
      case 'directory':
        return entry as WeshEntryRef<'directory'>;
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        throw new Error(`Not a directory: ${path}`);
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled entry type: ${String(_ex)}`);
      }
      }
    })();
    for await (const child of this.readDirEntry({
      entry: directoryEntry,
    })) {
      yield {
        name: child.name,
        type: child.type,
        fullPath: child.fullPath,
      };
    }
  }

  async mkdir({ path, mode: _mode, recursive }: { path: string, mode?: number, recursive?: boolean }): Promise<void> {
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
        case 'synthetic_directory':
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

  async symlink({ path, targetPath, mode }: { path: string, targetPath: string, mode?: number }): Promise<void> {
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
      await this.deleteRegistryEntry({ mount: resolved.resolution.mount, relPath: resolved.resolution.relPath });
      break;
    case 'handle':
    case 'synthetic_directory':
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

  async mknod({ path, type, mode }: { path: string, type: WeshFileType, mode?: number }): Promise<void> {
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

    await this.saveRegistryEntry({ mount, relPath, entry });
  }

  async rename({ oldPath, newPath }: { oldPath: string, newPath: string }): Promise<void> {
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
    const oldRegistryEntry = (() => {
      switch (oldResolved.kind) {
      case 'registry':
        return oldResolved.resolution.entry;
      case 'handle':
      case 'synthetic_directory':
        return undefined;
      default: {
        const _ex: never = oldResolved;
        throw new Error(`Unhandled resolved node: ${String(_ex)}`);
      }
      }
    })();

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
    case 'synthetic_directory':
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
      await this.deleteRegistryEntry({ mount: oldMount, relPath: oldRelPath });
      await this.saveRegistryEntry({ mount: newMount, relPath: newRelPath, entry: oldRegistryEntry });
    }
  }

  // --- Registry Persistence Helpers ---

  private async getMetadataRoot({
    mount,
    create,
  }: {
    mount: DirectoryMountEntry,
    create: boolean,
  }): Promise<FileSystemDirectoryHandle | undefined> {
    if (mount.metadataHandle !== undefined) {
      return mount.metadataHandle;
    }

    try {
      const systemDir = await mount.handle.getDirectoryHandle(WESH_SYSTEM_DIR, { create });
      mount.metadataHandle = await systemDir.getDirectoryHandle(METADATA_DIR, { create });
      return mount.metadataHandle;
    } catch {
      return undefined;
    }
  }

  private async getMetadataDirectory({
    mount,
    relPath,
    create,
  }: {
    mount: DirectoryMountEntry,
    relPath: string,
    create: boolean,
  }): Promise<FileSystemDirectoryHandle | undefined> {
    let current = await this.getMetadataRoot({ mount, create });
    if (current === undefined) {
      return undefined;
    }

    const parts = relPath === '.'
      ? []
      : relPath.split('/').filter((part) => part.length > 0 && part !== '.');
    try {
      for (const part of parts) {
        current = await current.getDirectoryHandle(part, { create });
      }
      return current;
    } catch {
      return undefined;
    }
  }

  private async parseRegistryEntryFile({
    fileHandle,
    relPath,
  }: {
    fileHandle: FileSystemFileHandle,
    relPath: string,
  }): Promise<RegistryEntry | undefined> {
    try {
      const file = await fileHandle.getFile();
      const dto = WeshRegistryEntrySchemaDto.parse(JSON.parse(await file.text()));
      return mapDtoToDomain({ dto });
    } catch (error: unknown) {
      console.warn(`Failed to parse registry entry ${relPath}:`, error);
      return undefined;
    }
  }

  private async loadRegistryEntry({
    mount,
    relPath,
  }: {
    mount: DirectoryMountEntry,
    relPath: string,
  }): Promise<RegistryEntry | undefined> {
    if (relPath === '.') {
      return undefined;
    }
    const parts = relPath.split('/');
    const fileName = parts.pop();
    if (fileName === undefined) {
      return undefined;
    }
    const directory = await this.getMetadataDirectory({
      mount,
      relPath: parts.join('/') || '.',
      create: false,
    });
    if (directory === undefined) {
      return undefined;
    }

    try {
      const fileHandle = await directory.getFileHandle(fileName);
      return await this.parseRegistryEntryFile({ fileHandle, relPath });
    } catch {
      return undefined;
    }
  }

  private async loadDirectRegistryEntries({
    mount,
    directoryRelPath,
  }: {
    mount: DirectoryMountEntry,
    directoryRelPath: string,
  }): Promise<Map<string, RegistryEntry>> {
    const entries = new Map<string, RegistryEntry>();
    const directory = await this.getMetadataDirectory({
      mount,
      relPath: directoryRelPath,
      create: false,
    });
    if (directory === undefined) {
      return entries;
    }

    for await (const [name, handle] of directory.entries()) {
      const fileHandle = (() => {
        switch (handle.kind) {
        case 'file':
          return handle as FileSystemFileHandle;
        case 'directory':
          return undefined;
        default: {
          const _ex: never = handle;
          throw new Error(`Unhandled handle kind: ${String(_ex)}`);
        }
        }
      })();
      if (fileHandle === undefined) {
        continue;
      }
      const relPath = directoryRelPath === '.'
        ? name
        : `${directoryRelPath}/${name}`;
      const entry = await this.parseRegistryEntryFile({
        fileHandle,
        relPath,
      });
      if (entry !== undefined) {
        entries.set(name, entry);
      }
    }
    return entries;
  }

  private async saveRegistryEntry({ mount, relPath, entry }: { mount: DirectoryMountEntry, relPath: string, entry: RegistryEntry }) {
    if (mount.readOnly) return;

    const metaDir = await this.getMetadataRoot({ mount, create: true });
    if (metaDir === undefined) {
      throw new Error(`Unable to create metadata directory for ${mount.path}`);
    }

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

  private async deleteRegistryEntry({ mount, relPath }: { mount: DirectoryMountEntry, relPath: string }) {
    if (mount.readOnly) return;
    try {
      const metaDir = await this.getMetadataRoot({ mount, create: false });
      if (metaDir === undefined) return;
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
      case 'synthetic_directory':
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

  private getRelativePath({ path, mount }: { path: string, mount: DirectoryMountEntry | VirtualMountEntry }): string {
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
    error: unknown,
  }): boolean {
    return error instanceof Error && error.message.includes('Name is not allowed');
  }

  private rethrowPathLookupError({
    error,
    path,
  }: {
    error: unknown,
    path: string,
  }): never {
    if (this.isInvalidHandleNameError({ error })) {
      throw new Error(`Path not found: ${path}`);
    }

    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error(`Permission denied: ${path}: ${error.message}`);
    }

    throw error;
  }

  private async _resolvePhysical({ path }: { path: string }): Promise<{ handle: FileSystemHandle, readOnly: boolean, fullPath: string }> {
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
      if (
        !isFileSystemNotFoundError({ error: fileError })
        && !isFileSystemTypeMismatchError({ error: fileError })
      ) {
        this.rethrowPathLookupError({
          error: fileError,
          path: normalized,
        });
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

  private async getRegistryResolution({
    path,
  }: {
    path: string,
  }): Promise<RegistryResolution | undefined> {
    const normalized = this.normalizePath({ path });
    const mount = (() => {
      const foundMount = this.findMount({ path: normalized });
      switch (foundMount?.type) {
      case 'directory':
        return foundMount;
      case 'virtual':
      case undefined:
        return undefined;
      default: {
        const _ex: never = foundMount;
        throw new Error(`Unhandled mount entry: ${String(_ex)}`);
      }
      }
    })();
    if (mount === undefined) {
      return undefined;
    }
    const relPath = this.getRelativePath({ path: normalized, mount });
    const entry = await this.loadRegistryEntry({ mount, relPath });
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
    linkPath: string,
    targetPath: string,
    remainder: string,
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
    path: string,
    finalSymlinkTreatment: 'follow' | 'no-follow',
    depth: number,
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

      const resolution = await this.getRegistryResolution({ path: candidate });
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
          kind: 'synthetic_directory',
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
    path: string,
    finalSymlinkTreatment: 'follow' | 'no-follow',
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
    path: string,
    finalSymlinkTreatment: 'follow' | 'no-follow',
  }): Promise<{ handle: FileSystemDirectoryHandle, readOnly: boolean, fullPath: string }> {
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
    case 'synthetic_directory':
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
    resolved: ResolvedNode,
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
    case 'synthetic_directory':
      return {
        size: 0,
        mode: 0o555,
        type: 'directory',
        mtime: Date.now(),
        ino: computeStableInode({
          kind: 'synthetic_directory',
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
