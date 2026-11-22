import { ReadonlyDirectoryHandle } from './readonly-directory-handle';
import { optionalFile } from '@/utils/file-system-publication';
import { canCompareFileSystemEntryIdentity } from '@/utils/remote-directory-handle-identity';
import { OPEN_FILE_DESCRIPTION } from './utils/file-input';
import { WeshFileOutput } from './file-output';
import type {
  WeshDirEntry,
  WeshIVirtualFileSystem,
  WeshPreparedRename,
  WeshFileHandle,
  WeshFileHandleCloseSemantics,
  WeshFileType,
  WeshSpecialFileType,
  WeshStat,
  WeshIOResult,
  WeshWriteResult,
  WeshOpenFlags,
  WeshVirtualMountProvider,
  WeshEntryLookup,
  WeshEntryRef,
  WeshFinalSymlinkTreatment,
  WeshTemporaryEntry,
  WeshVirtualEntryRef,
} from './types';
import {
  WeshBrokenPipeError,
  WeshCommandInterruptedError,
  WeshEntryChangedError,
  WeshNotDirectoryError,
  WeshRenameIncompleteError,
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

function hasFileSystemErrorName({ error, name }: { error: unknown, name: string }): boolean {
  return (error instanceof Error || error instanceof DOMException) && error.name === name;
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

class WeshFilePublications {
  private pending = 0;

  get hasPending(): boolean {
    return this.pending > 0;
  }

  begin(): () => void {
    this.start();
    return () => this.finish();
  }

  start(): void {
    this.pending += 1;
  }

  finish(): void {
    this.pending -= 1;
  }

  async run<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
    this.start();
    try {
      return await operation();
    } finally {
      this.finish();
    }
  }
}

type PublishWritable = ({ writable }: { writable: FileSystemWritableFileStream }) => Promise<void>;

class StandardFileHandle implements WeshFileHandle {
  private readonly handle: FileSystemFileHandle;
  private readonly access: WeshOpenFlags['access'];
  private readonly publications: WeshFilePublications;
  private readonly publishWritable: PublishWritable | undefined;
  private readonly releaseOutput: (() => void) | undefined;
  private readonly append: boolean;
  private cursor = 0;
  private logicalSize = 0;
  private lastModified = 0;
  private closed = false;
  private fileSnapshot: File | undefined;
  private sequentialReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private pendingReadChunk: Uint8Array | undefined;
  private pendingReadOffset = 0;
  private writable: FileSystemWritableFileStream | undefined;
  private hasStagedWrites = false;
  private syncAccessHandle: WeshSyncAccessHandle | undefined;
  private closePromise: Promise<void> | undefined;
  private pendingMutations = 0;
  private mutationsFinished: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  private constructor({
    handle,
    access,
    publications,
    publishWritable,
    releaseOutput,
    append,
  }: {
    handle: FileSystemFileHandle,
    access: WeshOpenFlags['access'],
    publications: WeshFilePublications,
    publishWritable: PublishWritable | undefined,
    releaseOutput: (() => void) | undefined,
    append: boolean,
  }) {
    this.handle = handle;
    this.access = access;
    this.publications = publications;
    this.publishWritable = publishWritable;
    this.releaseOutput = releaseOutput;
    this.append = append;
  }

  static async open({ handle, flags, checkActive, publications, publishWritable, releaseOutput }: {
    handle: FileSystemFileHandle,
    flags: WeshOpenFlags,
    checkActive: (() => void) | undefined,
    publications: WeshFilePublications,
    publishWritable?: PublishWritable,
    releaseOutput?: () => void,
  }): Promise<WeshFileHandle> {
    const opened = new StandardFileHandle({ handle, access: flags.access, publications, publishWritable, releaseOutput, append: flags.append === 'append' });
    try {
      await opened.initialize({ checkActive });
      checkActive?.();
      switch (flags.truncate) {
      case 'truncate':
        await opened.truncate({ size: 0 });
        break;
      case 'preserve':
        break;
      default: {
        const _ex: never = flags.truncate;
        throw new Error(`Unhandled truncate flag: ${_ex}`);
      }
      }
    } catch (error: unknown) {
      try {
        await opened.close();
      } catch (cause: unknown) {
        throw new AggregateError([error, cause], 'Could not open or close file', { cause });
      }
      throw error;
    }
    return opened;
  }

  private async initialize({ checkActive }: { checkActive: (() => void) | undefined }): Promise<void> {
    const file = await this.handle.getFile();
    checkActive?.();
    this.logicalSize = file.size;
    this.lastModified = file.lastModified;

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
      } catch (error) {
        if (hasFileSystemErrorName({ error, name: 'NoModificationAllowedError' })) {
          throw error;
        }
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
    this.assertOpen();
    this.startMutation();
    try {
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
      const writePosition = this.append
        ? this.syncAccessHandle?.getSize() ?? (await this.handle.getFile()).size
        : position ?? this.cursor;

      const bytesWritten = await (async (): Promise<number> => {
        switch (this.access) {
        case 'write': {
          const writable = this.writable;
          if (writable === undefined) {
            throw new Error('Sequential writer is unavailable');
          }
          await writable.seek(writePosition);
          await writable.write(data as BufferSource);
          this.hasStagedWrites = true;
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
        this.cursor = writePosition + bytesWritten;
      }
      this.logicalSize = Math.max(this.logicalSize, writePosition + bytesWritten);
      this.lastModified = Date.now();
      return { bytesWritten };
    } finally {
      this.finishMutation();
    }
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = this.closeInitializedResources();
    if (this.releaseOutput !== undefined) {
      this.closePromise = this.closePromise.finally(this.releaseOutput);
    }
    return this.closePromise;
  }

  getCloseSemantics(): WeshFileHandleCloseSemantics {
    return 'hard';
  }

  private startMutation(): void {
    this.pendingMutations += 1;
    this.publications.start();
  }

  private finishMutation(): void {
    this.publications.finish();
    this.pendingMutations -= 1;
    if (this.pendingMutations === 0) {
      this.mutationsFinished?.resolve();
    }
  }

  private async closeInitializedResources(): Promise<void> {
    if (this.pendingMutations !== 0) {
      // A write may still be between seek() and write().
      this.mutationsFinished = Promise.withResolvers<void>();
      await this.mutationsFinished.promise;
      this.mutationsFinished = undefined;
    }

    const reader = this.sequentialReader;
    this.sequentialReader = undefined;
    this.pendingReadChunk = undefined;
    if (reader !== undefined) {
      await reader.cancel();
    }

    const writable = this.writable;
    this.writable = undefined;
    if (writable !== undefined) {
      if (this.hasStagedWrites) {
        if (this.publishWritable === undefined) {
          await this.publications.run({ operation: () => writable.close() });
        } else {
          try {
            await this.publishWritable({ writable });
          } catch (error: unknown) {
            try {
              await writable.abort(error);
            } catch (cause: unknown) {
              throw new AggregateError([error, cause], 'Could not abort file writer', { cause });
            }
            if (!(error instanceof WeshCommandInterruptedError)) {
              throw error;
            }
          }
        }
      } else {
        // A keepExistingData stream may hold an older snapshot of the file.
        await writable.abort();
      }
    }

    const syncAccessHandle = this.syncAccessHandle;
    this.syncAccessHandle = undefined;
    if (syncAccessHandle !== undefined) {
      syncAccessHandle.flush();
      syncAccessHandle.close();
    }
  }

  async stat(): Promise<WeshStat> {
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
    this.assertOpen();
    this.startMutation();
    try {
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
        this.hasStagedWrites = true;
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
    } finally {
      this.finishMutation();
    }
  }

  async ioctl(): Promise<{ ret: number }> {
    return { ret: -1 };
  }
}

interface FifoRuntimeState {
  paths: Set<string>,
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
  readonly [OPEN_FILE_DESCRIPTION]: object;
  private readonly state: FifoRuntimeState;
  private readonly access: WeshOpenFlags['access'];
  private readonly onUnused: () => void;
  private closed = false;

  constructor({
    state,
    access,
    onUnused,
    description,
  }: {
    state: FifoRuntimeState,
    access: WeshOpenFlags['access'],
    onUnused: () => void,
    description?: object,
  }) {
    this.state = state;
    this.access = access;
    this.onUnused = onUnused;
    this[OPEN_FILE_DESCRIPTION] = description ?? this;
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
    for (const waiter of waiters) {
      waiter();
    }
  }

  private wakeWriteWaiters(): void {
    const waiters = this.state.writeWaiters;
    this.state.writeWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  async read({ buffer, offset, length }: { buffer: Uint8Array, offset?: number, length?: number }): Promise<WeshIOResult> {
    if (this.closed) {
      return { bytesRead: 0 };
    }
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
      if (this.closed || this.state.writerCount === 0) {
        return { bytesRead: 0 };
      }
      await new Promise<void>(resolve => this.state.readWaiters.push(resolve));
    }

    if (this.closed) {
      return { bytesRead: 0 };
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
    if (this.closed) {
      throw new WeshBrokenPipeError();
    }
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
    if (this.closed) {
      return;
    }
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

  cloneReference(): WeshFileHandle {
    return new FifoHandle({
      state: this.state,
      access: this.access,
      onUnused: this.onUnused,
      description: this[OPEN_FILE_DESCRIPTION],
    });
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

interface ActiveFileOutput {
  file: FileSystemFileHandle,
  mount: DirectoryMountEntry,
  output: WeshFileOutput,
  references: number,
  uncheckedReferences: number,
}

interface RegistryResolution {
  mount: DirectoryMountEntry,
  relPath: string,
  entry: RegistryEntry,
  file?: FileSystemFileHandle,
}

interface StoredRegistryResolution extends RegistryResolution {
  file: FileSystemFileHandle,
  directory: FileSystemDirectoryHandle,
}

interface FileEntryLocation {
  path: string,
  parent: FileSystemDirectoryHandle,
  name: string,
  mount: DirectoryMountEntry,
  readOnly: boolean,
  symlinkTreatment?: 'no-follow',
}

interface FileEntry {
  file: FileSystemFileHandle,
  registry: StoredRegistryResolution | undefined,
}

type MovableFile = FileSystemFileHandle & {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native FileSystemFileHandle.move signature.
  move?: (directory: FileSystemDirectoryHandle, name: string) => Promise<void>,
};

type ResolvedNode =
  | {
    kind: 'handle',
    fullPath: string,
    readOnly: boolean,
    handle: FileSystemHandle,
    mount: DirectoryMountEntry,
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


type ResolvedPath = ResolvedNode | {
  kind: 'virtual',
  fullPath: string,
  readOnly: boolean,
  provider: WeshVirtualMountProvider,
  finalSymlinkTreatment: WeshFinalSymlinkTreatment,
};

class MissingFileEntry extends Error {
  readonly fullPath: string;
  readonly parent: FileSystemDirectoryHandle;
  readonly nameInParent: string;
  readonly readOnly: boolean;
  readonly mount: DirectoryMountEntry;

  constructor({ fullPath, parent, nameInParent, mount }: {
    fullPath: string, parent: FileSystemDirectoryHandle, nameInParent: string, mount: DirectoryMountEntry,
  }) {
    super(`Path not found: ${fullPath}`);
    this.fullPath = fullPath;
    this.parent = parent;
    this.nameInParent = nameInParent;
    this.readOnly = mount.readOnly;
    this.mount = mount;
  }
}

type RegistryLookup = 'cached-root' | 'fresh-root';
type RegistryRoots = Map<DirectoryMountEntry, {
  readonly handle: FileSystemDirectoryHandle | undefined,
  reused: boolean,
}>;
type SymlinkTraversal = { followed: number };

type WeshEntryRefBackend =
  | {
      kind: 'resolved_node',
      resolved: ResolvedNode,
      pinnedBacking?: FileSystemHandle,
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
  private pendingEntryChanges = Promise.resolve();
  private readonly entryRefBackends = new WeakMap<WeshEntryRef, WeshEntryRefBackend>();
  private readonly temporaryLookups = new WeakMap<WeshEntryRef, WeshEntryLookup>();
  private readonly entryLookups = new Map<WeshEntryLookup, {
    mount: DirectoryMountEntry,
    missingParent: FileSystemDirectoryHandle | undefined,
    changed: boolean,
  }>();
  private readonly publications = new WeshFilePublications();
  private readonly fileOutputs = new Map<string, Set<ActiveFileOutput>>();

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

  hasPendingFilePublications(): boolean {
    return this.publications.hasPending;
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

  private createResolvedEntryRef({ resolved, name, pinnedBacking }: {
    resolved: ResolvedNode,
    name: string | undefined,
    pinnedBacking?: FileSystemHandle,
  }): WeshEntryRef {
    const backend: Extract<WeshEntryRefBackend, { kind: 'resolved_node' }> = { kind: 'resolved_node', resolved };
    if (pinnedBacking !== undefined) {
      backend.pinnedBacking = pinnedBacking;
    }
    return this.createEntryRef({
      name: name ?? this.basename({ path: resolved.fullPath }),
      type: this.getResolvedNodeType({ resolved }),
      fullPath: resolved.fullPath,
      backend,
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
    this.invalidateEntryLookups({ path: normalizedPath });
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
    this.invalidateEntryLookups({ path: normalizedPath });
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
    if (normalizedPath === '/') {
      throw new Error('Cannot unmount root');
    }
    if (this.isMountPoint({ path: normalizedPath })) {
      this.invalidateEntryLookups({ path: normalizedPath });
    }
    this.mounts = this.mounts.filter((m) => m.path !== normalizedPath);
  }

  registerSpecialFile({ path, type, handler }: { path: string, type: WeshSpecialFileType, handler: () => WeshFileHandle }): void {
    const normalized = this.normalizePath({ path });
    this.invalidateEntryLookups({ path: normalized });
    this.specialFiles.set(normalized, { type, handler });
  }

  unregisterSpecialFile({ path }: { path: string }): void {
    const normalized = this.normalizePath({ path });
    if (this.specialFiles.delete(normalized)) {
      this.invalidateEntryLookups({ path: normalized });
    }
  }

  private async resolveOpenPath({ path, creation, write, checkActive }: {
    path: string,
    creation: WeshOpenFlags['creation'],
    write: boolean,
    checkActive: (() => void) | undefined,
  }): Promise<ResolvedPath> {
    if (path.length === 0) {
      throw new DOMException('Path not found: empty pathname', 'NotFoundError');
    }
    const finalSymlinkTreatment: WeshFinalSymlinkTreatment = (() => {
      switch (creation) {
      case 'always':
        return 'no-follow';
      case 'never':
      case 'if-needed':
        return 'follow';
      default: {
        const _ex: never = creation;
        throw new Error(`Unhandled creation flag: ${_ex}`);
      }
      }
    })();
    let resolved: ResolvedPath;
    try {
      resolved = await this.resolveNode({
        path,
        finalSymlinkTreatment,
        allowMissingLeaf: creation !== 'never',
        strictRegistry: write || creation !== 'never' ? 'cached-root' : undefined,
      });
    } catch (error: unknown) {
      if (!(error instanceof MissingFileEntry)) {
        throw error;
      }
      if (error.readOnly) {
        throw new Error(`Read-only file system: ${error.fullPath}`);
      }
      if (this.findMount({ path: error.fullPath }) !== error.mount) {
        throw new WeshEntryChangedError({ path: error.fullPath });
      }
      checkActive?.();
      return {
        kind: 'handle',
        handle: await error.parent.getFileHandle(error.nameInParent, { create: true }),
        readOnly: false,
        fullPath: error.fullPath,
        mount: error.mount,
      };
    }
    if (creation === 'always' && resolved.kind !== 'virtual') {
      throw new Error(`File exists: ${resolved.fullPath}`);
    }
    return resolved;
  }

  async open({ path, flags, mode, checkActive }: {
    path: string,
    flags: WeshOpenFlags,
    mode?: number,
    checkActive?: () => void,
  }): Promise<WeshFileHandle> {
    const truncate = flags.truncate === 'truncate';
    const write = flags.access !== 'read' || truncate || flags.append === 'append';
    const resolve = () => this.resolveOpenPath({ path, creation: flags.creation, write, checkActive });
    const { creation } = flags;
    const resolved = await (() => {
      switch (creation) {
      case 'never':
        return resolve();
      case 'always':
      case 'if-needed':
        return this.serializeEntryChange({ change: resolve });
      default: {
        const _ex: never = creation;
        throw new Error(`Unhandled creation flag: ${_ex}`);
      }
      }
    })();
    checkActive?.();

    switch (resolved.kind) {
    case 'virtual':
      this.assertVirtualOpenAllowed({ path: resolved.fullPath, flags, readOnly: resolved.readOnly });
      return resolved.provider.open({ path: resolved.fullPath, flags, mode });
    case 'special':
      return resolved.handler();
    case 'registry':
      switch (resolved.resolution.entry.type) {
      case 'fifo':
        return this.openFifo({ path: resolved.fullPath, access: flags.access });
      case 'chardev':
        throw new Error('Open not implemented for chardev');
      case 'symlink':
        throw new Error(`Dangling symlink: ${resolved.fullPath}`);
      default: {
        const _ex: never = resolved.resolution.entry.type;
        throw new Error(`Unhandled registry entry type: ${_ex}`);
      }
      }
    case 'synthetic_directory':
      throw new Error(`Not a file: ${resolved.fullPath}`);
    case 'handle':
      switch (resolved.handle.kind) {
      case 'file':
        break;
      case 'directory':
        throw new Error(`Not a file: ${resolved.fullPath}`);
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

    if (resolved.readOnly && write) {
      throw new Error('File is read-only');
    }

    return this.openNativeFile({ handle: resolved.handle as FileSystemFileHandle, path: resolved.fullPath, mount: resolved.mount, flags, checkActive });
  }

  private openFifo({ path, access }: { path: string, access: WeshOpenFlags['access'] }): WeshFileHandle {
    let state = this.openFifos.get(path);
    if (state === undefined) {
      state = {
        paths: new Set([path]),
        buffer: [],
        bufferHeadIndex: 0,
        bufferSize: 0,
        headOffset: 0,
        readWaiters: [],
        writeWaiters: [],
        readerCount: 0,
        writerCount: 0,
      };
      this.openFifos.set(path, state);
    }
    const fifoState = state;
    return new FifoHandle({
      state: fifoState,
      access,
      onUnused: () => {
        for (const path of fifoState.paths) {
          if (this.openFifos.get(path) === fifoState) {
            this.openFifos.delete(path);
          }
        }
        fifoState.paths.clear();
      },
    });
  }

  private async findFileOutput({ file }: { file: FileSystemFileHandle }): Promise<ActiveFileOutput | undefined> {
    // Opens by name preserve the basename across directory aliases. Only look at
    // currently open writers, and compare their handles before sharing output.
    const outputs = this.fileOutputs.get(file.name);
    for (const active of outputs ?? []) {
      if (canCompareFileSystemEntryIdentity({ first: file, second: active.file })
          && await this.isSameFile({ first: file, second: active.file }) && active.references !== 0) {
        return active;
      }
    }
    return undefined;
  }

  private async assertNoOpenWriter({ file, path }: { file: FileSystemFileHandle, path: string }): Promise<void> {
    const active = await this.findFileOutput({ file });
    if (active !== undefined && active.uncheckedReferences !== 0) {
      throw new DOMException(`File has an active writer: ${path}`, 'NoModificationAllowedError');
    }
  }

  private checkFileOutputGrant({ path, mount }: { path: string, mount: DirectoryMountEntry }): void {
    if (this.findMount({ path }) !== mount || mount.readOnly) {
      throw new WeshEntryChangedError({ path });
    }
  }

  private async retainFileOutput({ file, path, mount, checkActive, checkedClose }: {
    file: FileSystemFileHandle,
    path: string,
    mount: DirectoryMountEntry,
    checkActive: (() => void) | undefined,
    checkedClose?: boolean,
  }): Promise<{ output: WeshFileOutput, release: () => void }> {
    return this.serializeEntryChange({
      change: async () => {
        let active = await this.findFileOutput({ file });
        if (active?.references === 0) {
          active = undefined;
        }
        checkActive?.();
        this.checkFileOutputGrant({ path, mount });
        if (active !== undefined && active.mount !== mount) {
          throw new DOMException(`File has an active writer: ${path}`, 'NoModificationAllowedError');
        }
        const name = file.name;
        let outputs = this.fileOutputs.get(name);
        if (outputs === undefined) {
          outputs = new Set();
          this.fileOutputs.set(name, outputs);
        }
        if (active === undefined) {
          active = {
            file,
            mount,
            references: 0,
            uncheckedReferences: 0,
            output: new WeshFileOutput({ file, beginPublication: () => this.publications.begin() }),
          };
          outputs.add(active);
        }
        const retained = active;
        const retainedOutputs = outputs;
        retained.references++;
        if (checkedClose !== true) {
          retained.uncheckedReferences++;
        }
        return {
          output: retained.output,
          release: () => {
            if (checkedClose !== true) {
              retained.uncheckedReferences--;
            }
            if (--retained.references === 0) {
              retainedOutputs.delete(retained);
              if (retainedOutputs.size === 0) {
                this.fileOutputs.delete(name);
              }
            }
          },
        };
      },
    });
  }

  private async reserveExclusiveFileOutput({ file, path, mount, checkActive, checkedClose }: {
    file: FileSystemFileHandle,
    path: string,
    mount: DirectoryMountEntry,
    checkActive: (() => void) | undefined,
    checkedClose: boolean,
  }): Promise<() => void> {
    const { output, release } = await this.retainFileOutput({ file, path, mount, checkActive, checkedClose });
    try {
      const unlock = await output.reserveExclusive({ checkActive });
      return () => {
        unlock();
        release();
      };
    } catch (error: unknown) {
      release();
      throw error;
    }
  }

  private async openNativeFile({ handle, path, mount, flags, checkActive, publishWritable }: {
    handle: FileSystemFileHandle,
    path: string,
    mount: DirectoryMountEntry,
    flags: WeshOpenFlags,
    checkActive: (() => void) | undefined,
    publishWritable?: PublishWritable,
  }): Promise<WeshFileHandle> {
    switch (flags.access) {
    case 'read':
      return StandardFileHandle.open({ handle, flags, checkActive, publications: this.publications });
    case 'write':
    case 'read-write':
      break;
    default: {
      const _ex: never = flags.access;
      throw new Error(`Unhandled access mode: ${_ex}`);
    }
    }
    const checkBeforeOpen = () => {
      checkActive?.();
      this.checkFileOutputGrant({ path, mount });
    };
    if (flags.access === 'write' && publishWritable === undefined) {
      const { output, release } = await this.retainFileOutput({ file: handle, path, mount, checkActive });
      return output.open({ flags, checkActive: checkBeforeOpen, release });
    }
    const releaseOutput = await this.reserveExclusiveFileOutput({ file: handle, path, mount, checkActive, checkedClose: publishWritable !== undefined });
    return StandardFileHandle.open({ handle, flags, checkActive: checkBeforeOpen, publications: this.publications, publishWritable, releaseOutput });
  }

  createTemporaryFile: WeshIVirtualFileSystem['createTemporaryFile'] = async ({ path, siblingOf, checkActive }) => {
    const { source, file, temporary } = await this.serializeEntryChange({
      change: async () => {
        checkActive?.();
        const source = siblingOf === undefined
          ? await this.resolveRenameLocation({ path, role: 'destination' })
          : await this.resolveTemporarySibling({ path, siblingOf });
        if (await this.findFileEntry({ location: source }) !== undefined) {
          throw new DOMException(`File exists: ${source.path}`, 'InvalidModificationError');
        }
        if (this.findMount({ path: source.path }) !== source.mount) {
          throw new Error(`Mount changed: ${source.path}`);
        }
        checkActive?.();
        const create = () => source.parent.getFileHandle(source.name, { create: true });
        if (siblingOf !== undefined) {
          this.checkEntryLookup({ lookup: siblingOf });
        }
        const file = siblingOf === undefined ? await create() : await this.publications.run({ operation: create });
        // The provider may return a file created by another writer after the vacancy check.
        if ((await file.getFile()).size !== 0) {
          throw new DOMException(`File exists: ${source.path}`, 'InvalidModificationError');
        }
        const temporary = this.temporaryEntry({ location: source, entry: { file, registry: undefined } });
        return { source, file, temporary };
      },
    });
    const lookup = this.temporaryLookups.get(temporary.entry);
    const checkBeforeOpen = () => {
      if (this.findMount({ path: source.path }) !== source.mount) {
        throw new Error(`Mount changed: ${source.path}`);
      }
      if (lookup !== undefined) {
        this.checkEntryLookup({ lookup });
      }
      checkActive?.();
    };
    try {
      checkBeforeOpen();
      const handle = await this.openNativeFile({
        handle: file,
        path: source.path,
        mount: source.mount,
        flags: { access: 'write', creation: 'always', truncate: 'preserve', append: 'preserve' },
        checkActive: checkBeforeOpen,
        publishWritable: lookup === undefined ? undefined : ({ writable }) => this.closeCheckedFileWriter({
          lookup,
          expected: temporary.entry,
          checkActive,
          writable,
        }),
      });
      return { handle, ...temporary };
    } catch (error: unknown) {
      try {
        await temporary.discard();
      } catch (cause: unknown) {
        throw new AggregateError([error, cause], 'Could not open or discard temporary file', { cause });
      }
      throw error;
    }
  };

  createTemporarySymlink: WeshIVirtualFileSystem['createTemporarySymlink'] = async ({ path, targetPath, mode, siblingOf, checkActive }) => {
    const created = await this.createSymlinkEntry({ path, targetPath, mode, expected: undefined, siblingOf, checkActive });
    return created.temporary ?? this.temporaryEntry(created);
  };

  private temporaryEntry({ location: originalLocation, entry: original }: { location: FileEntryLocation, entry: FileEntry }): WeshTemporaryEntry {
    const entry = this.referenceFileEntry({ location: originalLocation, entry: original });
    const { path, mount } = originalLocation;
    const lookup = originalLocation.symlinkTreatment === undefined ? undefined
      : this.trackEntryLookup({ path, entry, mount, missingParent: undefined });
    if (lookup !== undefined) {
      this.temporaryLookups.set(entry, lookup);
    }
    return {
      entry,
      release: lookup?.release,
      discard: () => this.serializeEntryChange({
        change: async () => {
          const { path, mount, parent } = originalLocation;
          if (lookup !== undefined && this.entryLookups.get(lookup)?.changed !== false) {
            return;
          }
          if (this.findMount({ path }) !== mount) {
            return;
          }
          const location = await this.resolveFileEntryLocation({ path, symlinkTreatment: originalLocation.symlinkTreatment });
          if (location.path !== path || location.mount !== mount || location.readOnly
            || !canCompareFileSystemEntryIdentity({ first: parent, second: location.parent })
            || (parent !== location.parent && !await parent.isSameEntry(location.parent))) {
            return;
          }
          const current = await this.findFileEntry({ location });
          if (current === undefined || !await this.matchesExpectedEntry({ expected: entry, actual: current, location })
            || this.findMount({ path }) !== mount || (lookup !== undefined && this.entryLookups.get(lookup)?.changed !== false)) {
            return;
          }
          await this.removePinnedEntry({ source: location, original: current });
        },
      }).finally(lookup?.release),
    };
  }

  private assertVirtualOpenAllowed({ path, flags, readOnly }: {
    path: string, flags: WeshOpenFlags, readOnly: boolean,
  }): void {
    if (readOnly && (flags.access !== 'read' || flags.creation !== 'never' || flags.truncate === 'truncate' || flags.append === 'append')) {
      throw new Error(`Read-only filesystem: ${path}`);
    }
  }

  async stat({ path }: { path: string }): Promise<WeshStat> {
    const resolved = await this.resolveNode({
      path: path,
      finalSymlinkTreatment: 'follow',
    });
    return this.statFromResolvedNode({ resolved });
  }

  async lstat({ path }: { path: string }): Promise<WeshStat> {
    const resolved = await this.resolveNode({
      path: path,
      finalSymlinkTreatment: 'no-follow',
    });
    return this.statFromResolvedNode({ resolved });
  }

  async readlink({ path }: { path: string }): Promise<string> {
    const resolved = await this.resolveNode({
      path: path,
      finalSymlinkTreatment: 'no-follow',
    });
    switch (resolved.kind) {
    case 'virtual':
      return resolved.provider.readlink({ path: resolved.fullPath });
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
    const resolved = await this.resolveNode({
      path: path,
      finalSymlinkTreatment: 'follow',
    });
    return {
      fullPath: resolved.fullPath,
      stat: await this.statFromResolvedNode({ resolved }),
    };
  }

  tryReadBlobEfficiently: WeshIVirtualFileSystem['tryReadBlobEfficiently'] = async ({ path, entry }) => {
    const resolved = entry === undefined ? await this.resolveNode({
      path: path,
      finalSymlinkTreatment: 'follow',
    }) : this.getResolvedEntry({ entry })?.resolved;

    switch (resolved?.kind) {
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
        throw new Error(`Not a file: ${resolved.fullPath}`);
      default: {
        const _ex: never = resolved.handle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
    case 'registry':
    case 'special':
    case 'synthetic_directory':
    case 'virtual':
    case undefined:
      return {
        kind: 'fallback_required',
        reason: WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED,
      };
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${JSON.stringify(_ex)}`);
    }
    }
  };

  tryCreateFileWriterEfficiently: WeshIVirtualFileSystem['tryCreateFileWriterEfficiently'] = async ({ path, lookup, expected, mode, sharedOutput, checkActive }) => {
    const expectedMount = expected === undefined ? undefined : this.findMount({ path: expected.fullPath });
    const resolved = lookup === undefined
      ? expected === undefined
        ? await this.serializeEntryChange({ change: () => this.resolveOpenPath({ path, creation: 'if-needed', write: true, checkActive }) })
        : await this.resolveOpenPath({ path, creation: 'never', write: true, checkActive })
      : await this.serializeEntryChange({ change: () => this.resolveFileWriterLookup({ lookup, expected: lookup.entry, checkActive }) });
    if (expected !== undefined) {
      await this.checkFileWriterTarget({ expected, resolved, mount: expectedMount });
    }

    switch (resolved.kind) {
    case 'handle':
      switch (resolved.handle.kind) {
      case 'file': {
        if (resolved.readOnly) {
          throw new Error(`Read-only file system: ${resolved.fullPath}`);
        }
        const fileHandle = resolved.handle as FileSystemFileHandle;
        if (sharedOutput !== undefined && expected === undefined && this.fileOutputs.has(fileHandle.name)) {
          const active = await this.findFileOutput({ file: fileHandle });
          if (active !== undefined && active.mount === resolved.mount && this.findMount({ path: resolved.fullPath }) === resolved.mount
              && active.output.ownsDescriptor({ handle: sharedOutput })) {
            return { kind: 'fallback_required', reason: WESH_EFFICIENT_FILE_WRITE_FALLBACK_REQUIRED };
          }
        }
        if (lookup !== undefined) {
          this.checkEntryLookup({ lookup });
        }
        const release = await this.reserveExclusiveFileOutput({
          file: fileHandle,
          path: resolved.fullPath,
          mount: resolved.mount,
          checkActive,
          checkedClose: lookup !== undefined || expected !== undefined,
        });
        let acquired: FileSystemWritableFileStream | undefined;
        try {
          if (lookup !== undefined) {
            this.checkEntryLookup({ lookup });
          }
          checkActive?.();
          this.checkFileOutputGrant({ path: resolved.fullPath, mount: resolved.mount });
          switch (mode) {
          case 'append': {
            acquired = await fileHandle.createWritable({ keepExistingData: true });
            checkActive?.();
            const file = await fileHandle.getFile();
            checkActive?.();
            await acquired.seek(file.size);
            break;
          }
          case 'truncate':
            acquired = await fileHandle.createWritable({ keepExistingData: false });
            break;
          default: {
            const _ex: never = mode;
            throw new Error(`Unhandled writer mode: ${_ex}`);
          }
          }
          checkActive?.();
          this.checkFileOutputGrant({ path: resolved.fullPath, mount: resolved.mount });
        } catch (error: unknown) {
          try {
            await acquired?.abort(error);
          } catch (cause: unknown) {
            throw new AggregateError([error, cause], 'Could not initialize or abort file writer', { cause });
          } finally {
            release();
          }
          throw error;
        }

        const writable = acquired;
        const openedEntry = lookup === undefined ? undefined : lookup.entry ?? this.createResolvedEntryRef({
          resolved,
          name: undefined,
          pinnedBacking: undefined,
        });
        let finishing: Promise<void> | undefined;
        const close = async () => {
          try {
            if (lookup !== undefined) {
              await this.closeCheckedFileWriter({ lookup, expected: openedEntry, checkActive, writable });
              return;
            }
            if (expected !== undefined) {
              await this.serializeEntryChange({
                change: async () => {
                  const current = await this.resolveOpenPath({ path, creation: 'never', write: true, checkActive });
                  await this.checkFileWriterTarget({ expected, resolved: current, mount: expectedMount });
                  checkActive?.();
                  await this.publications.run({ operation: () => writable.close() });
                },
              });
              return;
            }
            await this.publications.run({ operation: () => writable.close() });
          } catch (error: unknown) {
            try {
              await writable.abort(error);
            } catch (cause: unknown) {
              throw new AggregateError([error, cause], 'Could not abort file writer', { cause });
            }
            throw error;
          }
        };
        return {
          kind: 'writer',
          writer: {
            write: async ({ chunk }: { chunk: Uint8Array }) => {
              if (finishing !== undefined) {
                throw new Error('File writer is closed');
              }
              await writable.write(chunk as BufferSource);
            },
            close: () => finishing ??= close().finally(release),
            abort: ({ reason }: { reason: unknown }) => finishing === undefined
              ? (finishing = writable.abort(reason).finally(release))
              : finishing.catch(() => {}),
          },
        };
      }
      case 'directory':
        throw new Error(`Not a file: ${path ?? resolved.fullPath}`);
      default: {
        const _ex: never = resolved.handle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
    case 'virtual':
      throw new Error(`Read-only filesystem: ${resolved.fullPath}`);
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
  };

  private checkEntryLookup({ lookup }: { lookup: WeshEntryLookup }): void {
    const observed = this.entryLookups.get(lookup);
    if (observed === undefined || observed.changed) {
      throw new WeshEntryChangedError({ path: lookup.path });
    }
  }

  private closeCheckedFileWriter({ lookup, expected, checkActive, writable }: {
    lookup: WeshEntryLookup,
    expected: WeshEntryRef | undefined,
    checkActive: (() => void) | undefined,
    writable: FileSystemWritableFileStream,
  }): Promise<void> {
    return this.serializeEntryChange({
      change: async () => {
        await this.resolveFileWriterLookup({ lookup, expected, checkActive });
        checkActive?.();
        await this.publications.run({ operation: () => writable.close() });
      },
    });
  }

  private async resolveFileWriterLookup({ lookup, expected, checkActive }: {
    lookup: WeshEntryLookup,
    expected: WeshEntryRef | undefined,
    checkActive: (() => void) | undefined,
  }): Promise<ResolvedPath> {
    const { path } = lookup;
    const observed = this.entryLookups.get(lookup);
    if (observed === undefined) {
      throw new Error('Entry lookup does not belong to this Wesh VFS');
    }
    this.checkEntryLookup({ lookup });
    checkActive?.();
    let resolved: ResolvedPath;
    try {
      resolved = await this.resolveNodeWithoutFollowingSymlinks({ path, mount: observed.mount, strictRegistry: 'cached-root' });
    } catch (error: unknown) {
      if (!(error instanceof MissingFileEntry && error.fullPath === path && expected === undefined && observed.missingParent !== undefined)) {
        if (error instanceof MissingFileEntry || isFileSystemNotFoundError({ error })
          || (error instanceof Error && error.message.startsWith('Not a directory:'))) {
          throw new WeshEntryChangedError({ path, cause: error });
        }
        throw error;
      }
      const { parent } = error;
      if (parent !== observed.missingParent
        && (!canCompareFileSystemEntryIdentity({ first: parent, second: observed.missingParent }) || !await parent.isSameEntry(observed.missingParent))) {
        throw new WeshEntryChangedError({ path });
      }
      if (error.readOnly) {
        throw new Error(`Read-only file system: ${path}`);
      }
      this.checkEntryLookup({ lookup });
      checkActive?.();
      const handle = await this.publications.run({ operation: () => parent.getFileHandle(error.nameInParent, { create: true }) });
      return { kind: 'handle', fullPath: path, readOnly: false, handle, mount: observed.mount };
    }
    switch (expected?.type) {
    case 'file':
      await this.checkFileWriterTarget({ expected, resolved, mount: observed.mount });
      break;
    case 'directory':
    case 'symlink':
    case 'chardev':
    case 'fifo':
    case undefined:
      throw new WeshEntryChangedError({ path });
    default: {
      const _ex: never = expected;
      throw new Error(`Unhandled writer target: ${_ex}`);
    }
    }
    this.checkEntryLookup({ lookup });
    return resolved;
  }

  private async checkFileWriterTarget({ expected, resolved, mount }: {
    expected: WeshEntryRef<'file'>,
    resolved: ResolvedPath,
    mount: MountEntry | undefined,
  }): Promise<void> {
    const original = this.getResolvedEntry({ entry: expected })?.resolved;
    if (resolved.kind !== 'handle' || resolved.handle.kind !== 'file' || resolved.fullPath !== expected.fullPath
      || original?.kind !== 'handle' || !canCompareFileSystemEntryIdentity({ first: original.handle, second: resolved.handle })
      || (original.handle !== resolved.handle && !await original.handle.isSameEntry(resolved.handle))) {
      throw new WeshEntryChangedError({ path: expected.fullPath });
    }
    if (resolved.readOnly) {
      throw new Error('File is read-only');
    }
    if (this.findMount({ path: expected.fullPath }) !== mount) {
      throw new Error(`Mount changed: ${expected.fullPath}`);
    }
  }

  async resolveEntry({
    path,
    finalSymlinkTreatment,
    pinBacking,
  }: {
    path: string,
    finalSymlinkTreatment: WeshFinalSymlinkTreatment,
    pinBacking?: true,
  }): Promise<WeshEntryRef> {
    const resolved = await this.resolveNode({ path, finalSymlinkTreatment });
    switch (resolved.kind) {
    case 'virtual': {
      if (resolved.provider.resolveEntryRef !== undefined) {
        const virtualEntry = await resolved.provider.resolveEntryRef({
          path: resolved.fullPath,
          finalSymlinkTreatment,
        });
        return this.createEntryRef({
          name: virtualEntry.name,
          type: virtualEntry.type,
          fullPath: virtualEntry.fullPath,
          backend: {
            kind: 'virtual_entry',
            entry: virtualEntry,
            readOnly: resolved.readOnly,
          },
        });
      }

      const stat = await this.statFromResolvedNode({ resolved });
      return this.createEntryRef({
        name: this.basename({ path: resolved.fullPath }),
        type: stat.type,
        fullPath: resolved.fullPath,
        backend: {
          kind: 'virtual_path',
          provider: resolved.provider,
          path: resolved.fullPath,
          readOnly: resolved.readOnly,
        },
      });
    }
    case 'handle':
    case 'registry':
    case 'special':
    case 'synthetic_directory':
      break;
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved entry: ${String(_ex)}`);
    }
    }

    const pinnedBacking = pinBacking && resolved.kind === 'registry'
      ? (await this._resolvePhysical({ path: resolved.fullPath })).handle
      : undefined;
    return this.createResolvedEntryRef({
      resolved,
      name: undefined,
      pinnedBacking,
    });
  }

  tryLookupEntryWithoutFollowingSymlinks: WeshIVirtualFileSystem['tryLookupEntryWithoutFollowingSymlinks'] = ({ path, checkActive }) =>
    this.serializeEntryChange({
      change: async () => {
        checkActive?.();
        const lookup = await this.lookupEntryWithoutFollowingSymlinks({ path });
        try {
          checkActive?.();
          return lookup;
        } catch (error: unknown) {
          lookup?.release();
          throw error;
        }
      },
    });

  private async lookupEntryWithoutFollowingSymlinks({ path }: { path: string }): Promise<WeshEntryLookup | undefined> {
    if (this.normalizePath({ path }) !== path) {
      return undefined;
    }
    const mount = this.findMount({ path });
    switch (mount?.type) {
    case 'directory':
      break;
    case 'virtual':
    case undefined:
      return undefined;
    default: {
      const _ex: never = mount;
      throw new Error(`Unhandled mount entry: ${_ex}`);
    }
    }
    const mounts = this.mounts;
    try {
      const resolved = await this.resolveNodeWithoutFollowingSymlinks({ path, mount, strictRegistry: undefined });
      if (this.mounts !== mounts || resolved.fullPath !== path) {
        return undefined;
      }
      switch (resolved.kind) {
      case 'handle': {
        const entry = this.createResolvedEntryRef({ resolved, name: undefined, pinnedBacking: undefined });
        return this.trackEntryLookup({ path, entry, mount, missingParent: undefined });
      }
      case 'registry': {
        const { handle } = await this._resolvePhysical({ path });
        if (this.mounts !== mounts || handle.kind !== 'file') {
          return undefined;
        }
        const entry = this.createResolvedEntryRef({ resolved, name: undefined, pinnedBacking: handle });
        return this.trackEntryLookup({ path, entry, mount, missingParent: undefined });
      }
      case 'special':
      case 'synthetic_directory':
      case 'virtual':
        return undefined;
      default: {
        const _ex: never = resolved;
        throw new Error(`Unhandled resolved entry: ${_ex}`);
      }
      }
    } catch (error: unknown) {
      if (this.mounts === mounts && error instanceof MissingFileEntry && error.fullPath === path) {
        return this.trackEntryLookup({ path, entry: undefined, mount, missingParent: error.parent });
      }
      return undefined;
    }
  }

  private trackEntryLookup({ path, entry, mount, missingParent }: {
    path: string,
    entry: WeshEntryRef | undefined,
    mount: DirectoryMountEntry,
    missingParent: FileSystemDirectoryHandle | undefined,
  }): WeshEntryLookup {
    const lookup: WeshEntryLookup = {
      path,
      entry,
      release: () => {
        this.entryLookups.delete(lookup);
      },
    };
    this.entryLookups.set(lookup, { mount, missingParent, changed: false });
    return lookup;
  }

  private invalidateEntryLookups({ path, mount }: { path: string, mount?: MountEntry }): void {
    if (this.entryLookups.size === 0) {
      return;
    }
    const prefix = path === '/' ? path : `${path}/`;
    for (const [lookup, state] of this.entryLookups) {
      if (lookup.path === path || lookup.path.startsWith(prefix)) {
        state.changed = true;
      } else if (mount !== undefined && 'handle' in mount && state.mount.handle === mount.handle) {
        // Two views of the same handle share physical names even when their
        // mount paths differ.
        const changed = this.getRelativePath({ path, mount });
        const observed = this.getRelativePath({ path: lookup.path, mount: state.mount });
        if (changed === '.' || observed === changed || observed.startsWith(`${changed}/`)) {
          state.changed = true;
        }
      }
    }
  }

  private async removeTrackedEntry({ parent, name, path, mount }: {
    parent: FileSystemDirectoryHandle,
    name: string,
    path: string,
    mount: MountEntry | undefined,
  }): Promise<void> {
    let rejectedBeforeMutation = false;
    try {
      await parent.removeEntry(name);
    } catch (error: unknown) {
      // A provider can refuse a removal while a writable stream is open.
      rejectedBeforeMutation = hasFileSystemErrorName({ error, name: 'NoModificationAllowedError' });
      throw error;
    } finally {
      if (!rejectedBeforeMutation) {
        this.invalidateEntryLookups({ path, mount });
      }
    }
  }

  private async resolveNodeWithoutFollowingSymlinks({ path, mount, strictRegistry }: {
    path: string,
    mount: MountEntry | undefined,
    strictRegistry: RegistryLookup | undefined,
  }): Promise<ResolvedPath> {
    // A missing metadata root applies to the entire traversal. Never retain
    // this observation across a separate lookup or an entry publication.
    const registryRoots: RegistryRoots = new Map();
    // Physical lookup starts at the owning mount. Check any ancestors above it first.
    const mountPath = mount?.path ?? '/';
    for (let boundary = mountPath.indexOf('/', 1); boundary !== -1; boundary = mountPath.indexOf('/', boundary + 1)) {
      const ancestorPath = mountPath.slice(0, boundary);
      const ancestor = await this.resolveNode({ path: ancestorPath, finalSymlinkTreatment: 'no-follow', rejectIntermediateSymlinks: true, strictRegistry, registryRoots });
      switch (ancestor.kind) {
      case 'synthetic_directory':
        continue;
      case 'virtual': {
        const { type } = await ancestor.provider.lstat({ path: ancestorPath });
        switch (type) {
        case 'directory':
          continue;
        case 'file':
        case 'symlink':
        case 'fifo':
        case 'chardev':
          break;
        default: {
          const _ex: never = type;
          throw new Error(`Unhandled virtual entry type: ${_ex}`);
        }
        }
        break;
      }
      case 'handle':
        switch (ancestor.handle.kind) {
        case 'directory':
          continue;
        case 'file':
          break;
        default: {
          const _ex: never = ancestor.handle.kind;
          throw new Error(`Unhandled handle kind: ${_ex}`);
        }
        }
        break;
      case 'registry':
      case 'special':
        break;
      default: {
        const _ex: never = ancestor;
        throw new Error(`Unhandled ancestor: ${_ex}`);
      }
      }
      throw new WeshNotDirectoryError({ path: ancestorPath });
    }
    return this.resolveNode({ path, finalSymlinkTreatment: 'no-follow', rejectIntermediateSymlinks: true, allowMissingLeaf: true, strictRegistry, registryRoots });
  }

  async *readDirEntry({
    entry,
    checkActive,
  }: {
    entry: WeshEntryRef<'directory'>,
    checkActive?: () => void,
  }): AsyncIterable<WeshEntryRef> {
    checkActive?.();
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
        checkActive?.();
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
        checkActive?.();
      }
      return;
    }
    case 'virtual_path':
      for await (const child of backend.provider.readDir({ path: backend.path })) {
        checkActive?.();
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
        checkActive?.();
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
      checkActive?.();
      for await (const [name, childHandle] of directoryHandle.entries()) {
        checkActive?.();
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
          mount: resolved.mount,
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
        checkActive?.();
      }
      break;
    }
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${String(_ex)}`);
    }
    }

    for (const name of remainingOverlayNames) {
      checkActive?.();
      const fullPath = resolved.fullPath === '/'
        ? `/${name}`
        : `${resolved.fullPath}/${name}`;
      const child = await this.resolveEntry({
        path: fullPath,
        finalSymlinkTreatment: 'no-follow',
      });
      checkActive?.();
      yield child;
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

  openEntry: WeshIVirtualFileSystem['openEntry'] = async ({ entry, flags, mode, checkActive }) => {
    checkActive?.();
    const backend = this.getEntryRefBackend({ entry });
    switch (backend.kind) {
    case 'virtual_entry':
      this.assertVirtualOpenAllowed({ path: entry.fullPath, flags, readOnly: backend.readOnly });
      switch (backend.entry.type) {
      case 'file':
      case 'fifo':
      case 'chardev':
        return backend.entry.open({ flags, mode });
      case 'directory':
      case 'symlink':
        return this.open({ path: entry.fullPath, flags, mode, checkActive });
      default: {
        const _ex: never = backend.entry;
        throw new Error(`Unhandled virtual entry: ${String(_ex)}`);
      }
      }
    case 'virtual_path':
      this.assertVirtualOpenAllowed({ path: entry.fullPath, flags, readOnly: backend.readOnly });
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
    switch (resolved.kind) {
    case 'special': {
      const current = this.specialFiles.get(entry.fullPath);
      if (current?.handler !== resolved.handler || current.type !== entry.type) {
        throw new WeshEntryChangedError({ path: entry.fullPath });
      }
      return resolved.handler();
    }
    case 'registry':
      if (resolved.resolution.entry.type === 'fifo' && backend.pinnedBacking !== undefined) {
        return this.serializeEntryChange({
          change: async () => {
            checkActive?.();
            const location = await this.resolveFileEntryLocation({ path: entry.fullPath });
            await this.requireEntry({ location, expected: entry });
            if (location.mount !== resolved.resolution.mount || this.findMount({ path: location.path }) !== location.mount
                || this.specialFiles.has(entry.fullPath)) {
              throw new WeshEntryChangedError({ path: entry.fullPath });
            }
            checkActive?.();
            return this.openFifo({ path: location.path, access: flags.access });
          },
        });
      }
      break;
    case 'handle':
      switch (resolved.handle.kind) {
      case 'file':
        if (resolved.readOnly && flags.access !== 'read') {
          throw new Error('File is read-only');
        }
        return this.openNativeFile({ handle: resolved.handle as FileSystemFileHandle, path: resolved.fullPath, mount: resolved.mount, flags, checkActive });
      case 'directory':
        break;
      default: {
        const _ex: never = resolved.handle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
      break;
    case 'synthetic_directory':
      break;
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${String(_ex)}`);
    }
    }
    return this.open({ path: entry.fullPath, flags, mode, checkActive });
  };

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

  async *readDir({ path, checkActive }: { path: string, checkActive?: () => void }): AsyncIterable<WeshDirEntry> {
    checkActive?.();
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
      checkActive,
    })) {
      yield {
        name: child.name,
        type: child.type,
        fullPath: child.fullPath,
      };
    }
  }

  mkdir: WeshIVirtualFileSystem['mkdir'] = async ({ path, recursive, symlinkTreatment, onCreate, checkActive }) => {
    if (path.length === 0) {
      throw new DOMException('Path not found: empty pathname', 'NotFoundError');
    }
    const withoutTrailingSlash = path.replace(/\/+$/u, '');
    if (withoutTrailingSlash.length === 0) {
      return;
    }
    if (symlinkTreatment !== undefined && this.normalizePath({ path: withoutTrailingSlash }) !== withoutTrailingSlash) {
      throw new Error(`Invalid path: ${path}`);
    }
    const mounts = this.mounts;
    const ensure = ({ path: componentPath, final }: { path: string, final: boolean }) => {
      const change = () => {
        if (symlinkTreatment !== undefined && this.mounts !== mounts) {
          throw new WeshEntryChangedError({ path: withoutTrailingSlash });
        }
        return this.ensureDirectory({ path: componentPath, final, symlinkTreatment, checkActive });
      };
      return symlinkTreatment === undefined ? change() : this.serializeEntryChange({ change });
    };
    if (!recursive) {
      const result = await ensure({ path: withoutTrailingSlash, final: true });
      if (result.created) {
        await onCreate?.({ path });
      }
      return;
    }

    const components = [...path.matchAll(/[^/]+/gu)];
    let parent = '/';
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index]!;
      const name = component[0];
      if (name === '.') {
        continue;
      }
      if (name === '..') {
        parent = this.dirname({ path: parent });
        continue;
      }
      const candidate = parent === '/' ? `/${name}` : `${parent}/${name}`;
      const final = index === components.length - 1;
      checkActive?.();
      const result = await ensure({ path: candidate, final });
      parent = result.fullPath;
      if (result.created) {
        await onCreate?.({ path: final ? path : path.slice(0, component.index + name.length) });
      }
    }
  };

  private async ensureDirectory({ path, final, symlinkTreatment, checkActive }: {
    path: string,
    final: boolean,
    symlinkTreatment: 'no-follow' | undefined,
    checkActive: (() => void) | undefined,
  }): Promise<{ fullPath: string, created: boolean }> {
    const wrongType = () => symlinkTreatment === undefined
      ? new Error(final ? 'File exists' : 'Not a directory')
      : new WeshNotDirectoryError({ path });
    const symlinks = { followed: 0 };
    const mounts = this.mounts;
    const checkMounts = () => {
      if (symlinkTreatment !== undefined && mounts !== this.mounts) {
        throw new WeshEntryChangedError({ path });
      }
    };
    checkActive?.();
    let resolved: ResolvedPath;
    try {
      resolved = symlinkTreatment === undefined
        ? await this.resolveNode({ path, finalSymlinkTreatment: 'no-follow', symlinks, strictRegistry: 'cached-root', allowMissingLeaf: true })
        : await this.resolveNodeWithoutFollowingSymlinks({ path, mount: this.findMount({ path }), strictRegistry: 'cached-root' });
    } catch (error: unknown) {
      if (!(error instanceof MissingFileEntry)) {
        throw error;
      }
      if (error.readOnly) {
        throw new Error(`Read-only filesystem: ${error.fullPath}`);
      }
      checkActive?.();
      checkMounts();
      if (symlinkTreatment === undefined) {
        await error.parent.getDirectoryHandle(error.nameInParent, { create: true });
      } else {
        await this.publications.run({ operation: () => error.parent.getDirectoryHandle(error.nameInParent, { create: true }) });
      }
      return { fullPath: error.fullPath, created: true };
    }
    checkMounts();
    switch (resolved.kind) {
    case 'synthetic_directory':
      return { fullPath: resolved.fullPath, created: false };
    case 'handle':
      switch (resolved.handle.kind) {
      case 'directory':
        return { fullPath: resolved.fullPath, created: false };
      case 'file':
        throw wrongType();
      default: {
        const _ex: never = resolved.handle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
    case 'virtual': {
      if (symlinkTreatment !== undefined) {
        const { type } = await resolved.provider.lstat({ path: resolved.fullPath });
        checkMounts();
        switch (type) {
        case 'directory':
          return { fullPath: resolved.fullPath, created: false };
        case 'file':
        case 'symlink':
        case 'fifo':
        case 'chardev':
          throw wrongType();
        default: {
          const _ex: never = type;
          throw new Error(`Unhandled virtual entry type: ${_ex}`);
        }
        }
      }
      const directory = await this.resolveVirtualTraversalDirectory({ resolved, symlinks });
      return { fullPath: directory.fullPath, created: false };
    }
    case 'registry':
      if (symlinkTreatment !== undefined) {
        throw wrongType();
      }
      switch (resolved.resolution.entry.type) {
      case 'symlink': {
        const target = this.followSymlink({ linkPath: resolved.fullPath, targetPath: resolved.resolution.entry.targetPath ?? '', remainder: '', symlinks });
        try {
          const directory = await this.resolveTraversalDirectory({ path: target, symlinks, strictRegistry: 'cached-root' });
          return { fullPath: directory.fullPath, created: false };
        } catch (error: unknown) {
          if (isFileSystemNotFoundError({ error }) || (error instanceof Error && error.message.startsWith('Path not found:'))) {
            throw new Error('File exists');
          }
          if (final && error instanceof Error && error.message.startsWith('Not a directory:')) {
            throw new Error('File exists');
          }
          throw error;
        }
      }
      case 'chardev':
      case 'fifo':
        throw wrongType();
      default: {
        const _ex: never = resolved.resolution.entry.type;
        throw new Error(`Unhandled registry entry type: ${_ex}`);
      }
      }
    case 'special':
      throw wrongType();
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${String(_ex)}`);
    }
    }
  }

  symlink: WeshIVirtualFileSystem['symlink'] = async ({ path, targetPath, mode, expected, checkActive }) => {
    await this.createSymlinkEntry({ path, targetPath, mode, expected, siblingOf: undefined, checkActive });
  };

  private async createSymlinkEntry({ path, targetPath, mode, expected, siblingOf, checkActive }: {
    path: string,
    targetPath: string,
    mode: number | undefined,
    expected: WeshEntryLookup | undefined,
    siblingOf: WeshEntryLookup | undefined,
    checkActive: (() => void) | undefined,
  }): Promise<{ location: FileEntryLocation, entry: FileEntry, temporary?: WeshTemporaryEntry }> {
    if (targetPath.length === 0) {
      throw new DOMException(`Path not found: ${path}`, 'NotFoundError');
    }
    return this.createFileEntry({ path, registry: { type: 'symlink', mode: mode ?? 0o777, targetPath }, expected, siblingOf, checkActive });
  }

  unlink: WeshIVirtualFileSystem['unlink'] = async ({ path, expected, checkActive }) => {
    if (expected !== undefined) {
      await this.serializeEntryChange({
        change: async () => {
          checkActive?.();
          const destinations: FileEntryLocation[] = [];
          for (const retainedEntry of expected.retainedEntries ?? []) {
            const destination = await this.resolveRenameLocation({ path: retainedEntry.fullPath, role: 'destination' });
            const relation = await this.compareEntryIdentity({ first: expected.entry, second: retainedEntry });
            switch (relation) {
            case 'unknown':
              throw new Error(`Cannot verify that '${path}' and '${destination.path}' are different entries`);
            case 'same':
            case 'shared-backing':
              throw new Error(`Source aliases retained entry: ${path}`);
            case 'different':
              break;
            default: {
              const _ex: never = relation;
              throw new Error(`Unhandled entry identity: ${_ex}`);
            }
            }
            const retained = await this.findFileEntry({ location: destination });
            if (!await this.matchesExpectedEntry({ expected: retainedEntry, actual: retained, location: destination })) {
              throw new Error(`Destination entry changed: ${destination.path}`);
            }
            destinations.push(destination);
          }
          const source = await this.resolveRenameLocation({ path, role: 'source' });
          const original = await this.findFileEntry({ location: source });
          if (original === undefined) {
            throw new DOMException(`Path not found: ${path}`, 'NotFoundError');
          }
          if (!await this.matchesExpectedEntry({ expected: expected.entry, actual: original, location: source })) {
            throw new Error(`Source entry changed: ${source.path}`);
          }
          for (const destination of destinations) {
            if (this.findMount({ path: destination.path }) !== destination.mount) {
              throw new Error(`Mount changed while retaining '${destination.path}'`);
            }
          }
          checkActive?.();
          await this.publications.run({ operation: () => this.removePinnedEntry({ source, original }) });
        },
      });
      return;
    }

    await this.serializeEntryChange({ change: () => this.unlinkPath({ path, checkActive }) });
  };

  private async unlinkPath({ path, checkActive }: { path: string, checkActive: (() => void) | undefined }): Promise<void> {
    checkActive?.();
    const resolved = await this.resolveRemovalEntry({ path });
    const normalized = resolved.fullPath;
    const mount = this.findMount({ path: normalized });
    if (this.isMountPoint({ path: normalized })) {
      throw new Error(`Cannot unlink mount point: ${normalized}`);
    }
    const type = this.getResolvedNodeType({ resolved });
    switch (type) {
    case 'directory':
      throw new Error(`Is a directory: ${normalized}`);
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      break;
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled stat type: ${_ex}`);
    }
    }

    if (resolved.readOnly || resolved.kind === 'special') {
      throw new Error(`Read-only filesystem: ${normalized}`);
    }

    switch (resolved.kind) {
    case 'registry': {
      const source = await this.resolveFileEntryLocation({ path: normalized, symlinkTreatment: 'no-follow' });
      if (source.path !== normalized || source.mount !== resolved.resolution.mount || source.readOnly) {
        throw new Error(`Source entry changed: ${normalized}`);
      }
      const original = await this.findFileEntry({ location: source });
      if (original === undefined || !await this.matchesRegistryEntry({ expected: resolved.resolution, actual: original.registry })) {
        throw new Error(`Source entry changed: ${normalized}`);
      }
      checkActive?.();
      await this.publications.run({ operation: () => this.removePinnedEntry({ source, original }) });
      return;
    }
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
    if (name === undefined) {
      throw new Error(`Invalid path: ${normalized}`);
    }
    const parentPath = parts.join('/') || '/';
    const parent = await this.resolveExistingDirectory({
      path: parentPath,
      finalSymlinkTreatment: 'follow',
    });
    if (parent.readOnly) {
      throw new Error(`Read-only filesystem: ${parentPath}`);
    }
    checkActive?.();
    await this.removeTrackedEntry({ parent: parent.handle, name, path: normalized, mount });
    this.detachOpenFifo({ path: resolved.fullPath });
  }

  async rmdir({ path, checkActive }: { path: string, checkActive?: () => void }): Promise<void> {
    const entryPath = path.replace(/\/+$/u, '') || '/';
    const last = this.basename({ path: entryPath });
    if (path.length === 0 || last === '.' || last === '..') {
      throw new Error(`Invalid argument: ${path}`);
    }
    const resolved = await this.resolveRemovalEntry({ path: entryPath });
    const normalized = resolved.fullPath;
    const mount = this.findMount({ path: normalized });
    if (normalized === '/' || this.isMountPoint({ path: normalized })) {
      throw new Error(`Cannot remove mount point: ${normalized}`);
    }
    const type = this.getResolvedNodeType({ resolved });
    switch (type) {
    case 'directory':
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      throw new Error(`Not a directory: ${normalized}`);
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled stat type: ${_ex}`);
    }
    }

    if (resolved.readOnly || resolved.kind === 'special') {
      throw new Error(`Read-only filesystem: ${normalized}`);
    }

    for await (const _ of this.readDir({ path: normalized, checkActive })) {
      throw new Error(`Directory not empty: ${normalized}`);
    }

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
      throw new Error(`Read-only filesystem: ${parentPath}`);
    }
    await this.serializeEntryChange({
      change: async () => {
        checkActive?.();
        await this.removeTrackedEntry({ parent: parent.handle, name, path: normalized, mount });
      },
    });
  }

  private async resolveRemovalEntry({ path }: { path: string }): Promise<ResolvedNode> {
    const resolved = await this.resolveNode({ path, finalSymlinkTreatment: 'no-follow', strictRegistry: 'cached-root' });
    switch (resolved.kind) {
    case 'virtual':
      throw new Error(`Read-only filesystem: ${resolved.fullPath}`);
    case 'handle':
    case 'registry':
    case 'special':
    case 'synthetic_directory':
      return resolved;
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${String(_ex)}`);
    }
    }
  }

  async mknod({ path, type, mode, checkActive }: { path: string, type: WeshFileType, mode?: number, checkActive?: () => void }): Promise<void> {
    switch (type) {
    case 'fifo':
    case 'chardev':
      await this.createFileEntry({ path, registry: { type, mode: mode ?? 0o644 }, checkActive });
      break;
    case 'symlink':
      throw new Error('Use ln -s for symlinks');
    case 'file':
      await this.createFileEntry({ path, registry: undefined, checkActive });
      break;
    case 'directory':
      throw new Error(`Cannot create ${type} with mknod`);
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled option type: ${_ex}`);
    }
    }
  }

  private createFileEntry({ path, registry, expected, siblingOf, checkActive }: {
    path: string,
    registry: RegistryEntry | undefined,
    expected?: WeshEntryLookup,
    siblingOf?: WeshEntryLookup,
    checkActive: (() => void) | undefined,
  }): Promise<{ location: FileEntryLocation, entry: FileEntry, temporary?: WeshTemporaryEntry }> {
    return this.serializeEntryChange({
      change: async () => {
        const lookup = expected ?? siblingOf;
        const checkBeforeChange = () => {
          checkActive?.();
          if (lookup !== undefined) {
            this.checkEntryLookup({ lookup });
          }
        };
        checkBeforeChange();
        const destination = expected !== undefined
          ? await this.resolveFileLookupLocation({ path, lookup: expected })
          : siblingOf === undefined
            ? await this.resolveFileEntryLocation({ path })
            : await this.resolveTemporarySibling({ path, siblingOf });
        if (destination.readOnly) {
          throw new Error(`Read-only filesystem: ${path}`);
        }
        if (this.isMountPoint({ path: destination.path }) || this.specialFiles.has(destination.path)
          || await this.findFileEntry({ location: destination }) !== undefined) {
          throw new Error(`File exists: ${path}`);
        }
        const checkMounts = () => {
          if (this.findMount({ path: destination.path }) !== destination.mount) {
            throw new Error(`Mount changed: ${destination.path}`);
          }
        };
        checkBeforeChange();
        checkMounts();
        if (registry === undefined) {
          const file = await destination.parent.getFileHandle(destination.name, { create: true });
          return { location: destination, entry: { file, registry: undefined } };
        }
        const entry = await this.publishRegistryEntry({ entry: registry, destination, existing: undefined, source: undefined, checkActive: checkBeforeChange, checkMounts });
        const temporary = siblingOf === undefined ? undefined : this.temporaryEntry({ location: destination, entry });
        return { location: destination, entry, temporary };
      },
    });
  }

  rename: WeshIVirtualFileSystem['rename'] = async ({ oldPath, newPath, expectedSource, expectedDestination, noReplace, checkActive }) => {
    await this.serializeEntryChange({ change: () => this.renameEntry({ oldPath, newPath, expectedSource, expectedDestination, noReplace, checkActive }) });
  };

  publishEntries: WeshIVirtualFileSystem['publishEntries'] = async ({ changes, checkActive }) => {
    await this.serializeEntryChange({
      change: async () => {
        const pathsByName = new Map<string, FileEntryLocation[]>();
        const prepared: (
          | { operation: 'unlink', source: FileEntryLocation, entry: WeshEntryRef }
          | { operation: 'rename', source: FileEntryLocation, destination: FileEntryLocation, rename: WeshPreparedRename }
        )[] = [];
        async function rememberLocation({ location }: { location: FileEntryLocation }): Promise<void> {
          const previous = pathsByName.get(location.name) ?? [];
          for (const other of previous) {
            if (other.path === location.path || other.parent === location.parent
              || !canCompareFileSystemEntryIdentity({ first: other.parent, second: location.parent })
              || await other.parent.isSameEntry(location.parent)) {
              throw new Error(`Cannot verify distinct publication paths: ${other.path} and ${location.path}`);
            }
          }
          previous.push(location);
          pathsByName.set(location.name, previous);
        }

        for (const change of changes) {
          checkActive?.();
          const source = await this.resolveRenameLocation({ path: change.entry.fullPath, role: 'source' });
          await rememberLocation({ location: source });
          const stage = await this.requireEntry({ location: source, expected: change.entry });
          if (this.fileOutputs.size !== 0) {
            await this.assertNoOpenWriter({ file: stage.file, path: source.path });
          }
          switch (change.operation) {
          case 'unlink':
            prepared.push({ operation: 'unlink', source, entry: change.entry });
            break;
          case 'rename': {
            const destination = await this.resolveRenameLocation({ path: change.path, role: 'destination' });
            await rememberLocation({ location: destination });
            if (change.expected === undefined) {
              if (await this.findFileEntry({ location: destination }) !== undefined) {
                throw new DOMException(`File exists: ${destination.path}`, 'InvalidModificationError');
              }
            } else {
              const current = await this.requireEntry({ location: destination, expected: change.expected });
              if (this.fileOutputs.size !== 0) {
                await this.assertNoOpenWriter({ file: current.file, path: destination.path });
              }
              this.assertCompatibleRenameEntries({ source: stage, destination: current });
              if (await this.isSameFile({ first: stage.file, second: current.file })) {
                throw new Error(`Publication paths alias: ${destination.path}`);
              }
            }
            prepared.push({ operation: 'rename', source, destination, rename: change });
            break;
          }
          default: {
            const _ex: never = change;
            throw new Error(`Unhandled entry change: ${String(_ex)}`);
          }
          }
        }

        checkActive?.();
        let finish: (() => void) | undefined;
        const onPublicationStart = () => {
          finish ??= this.publications.begin();
        };
        const published: string[] = [];
        try {
          for (const change of prepared) {
            const path = 'destination' in change ? change.destination.path : change.source.path;
            const checkBeforeAdmission = published.length === 0 ? checkActive : undefined;
            try {
              switch (change.operation) {
              case 'unlink':
                await this.unlinkPreparedEntry({
                  source: change.source,
                  entry: change.entry,
                  checkActive: checkBeforeAdmission,
                  onPublicationStart,
                });
                break;
              case 'rename': {
                const { source, destination, rename } = change;
                const installed = await this.renameEntry({
                  oldPath: source.path,
                  newPath: destination.path,
                  expectedSource: rename.entry,
                  expectedDestination: rename.expected,
                  noReplace: rename.expected === undefined || undefined,
                  locations: { source, destination },
                  checkActive: checkBeforeAdmission,
                  onPublicationStart,
                });
                if (installed === undefined) {
                  throw new Error(`Publication paths alias: ${path}`);
                }
                break;
              }
              default: {
                const _ex: never = change;
                throw new Error(`Unhandled prepared entry change: ${String(_ex)}`);
              }
              }
              published.push(path);
            } catch (cause: unknown) {
              if (published.length === 0) {
                throw cause;
              }
              throw new WeshRenameIncompleteError({
                message: `Could not publish '${path}' after publishing ${published.join(', ')}`,
                cause,
              });
            }
          }
        } finally {
          finish?.();
        }
      },
    });
  };

  private async unlinkPreparedEntry({ source, entry, checkActive, onPublicationStart }: {
    source: FileEntryLocation,
    entry: WeshEntryRef,
    checkActive: (() => void) | undefined,
    onPublicationStart: () => void,
  }): Promise<void> {
    const location = await this.resolveRenameLocation({ path: source.path, role: 'source', expected: source });
    const original = await this.requireEntry({ location, expected: entry });
    checkActive?.();
    let started = false;
    try {
      await this.removePinnedEntry({
        source: location,
        original,
        onPublicationStart: () => {
          onPublicationStart();
          started = true;
        },
      });
    } catch (cause: unknown) {
      if (!started) {
        throw cause;
      }
      const unchanged = await this.findFileEntry({ location }).then(actual =>
        this.matchesExpectedEntry({ expected: entry, actual, location })).catch(() => false);
      if (unchanged && this.findMount({ path: location.path }) === location.mount) {
        throw cause;
      }
      throw new WeshRenameIncompleteError({ message: `Could not confirm removal of '${location.path}'`, cause });
    }
  }

  replaceEntry: WeshIVirtualFileSystem['replaceEntry'] = async ({ entry, path, expected: observation, backupPath, expectedBackup, checkActive }) => {
    return this.serializeEntryChange({
      change: async () => {
        const lookup = observation !== undefined && 'entry' in observation ? observation : undefined;
        const expected = observation !== undefined && 'entry' in observation ? observation.entry : observation;
        const stagedLookup = this.temporaryLookups.get(entry);
        const checkStaging = () => {
          if (stagedLookup !== undefined) {
            this.checkEntryLookup({ lookup: stagedLookup });
          }
        };
        const checkBeforeChange = () => {
          checkActive?.();
          checkStaging();
          if (lookup !== undefined) {
            this.checkEntryLookup({ lookup });
          }
        };
        checkBeforeChange();
        const checkedTarget = lookup === undefined ? undefined : await this.resolveFileLookupLocation({ path, lookup });
        const symlinkTreatment = checkedTarget?.symlinkTreatment;
        const checkedStaging = checkedTarget === undefined ? undefined : await this.resolveRenameLocation({
          path: entry.fullPath,
          role: 'source',
          symlinkTreatment,
        });
        const locations = checkedTarget === undefined || checkedStaging === undefined ? undefined : {
          source: checkedStaging,
          destination: checkedTarget,
        };
        if (expected === undefined || (backupPath === undefined && entry.type === expected.type)) {
          const installed = await this.renameEntry({
            oldPath: entry.fullPath,
            newPath: path,
            expectedSource: entry,
            expectedDestination: expected,
            noReplace: expected === undefined ? true : undefined,
            checkActive: checkBeforeChange,
            locations,
          });
          if (installed === undefined) {
            throw new Error(`Replacement is the same entry: ${path}`);
          }
          return this.referenceFileEntry(installed);
        }

        const target = checkedTarget ?? await this.resolveRenameLocation({ path, role: 'destination' });
        const backup = backupPath === undefined ? undefined : await this.resolveRenameLocation({ path: backupPath, role: 'destination', symlinkTreatment });
        // A backup name that resolves to the target does not require a separate entry.
        const keepBackup = backup !== undefined && backup.path !== target.path;
        if (!keepBackup && entry.type === expected.type) {
          const installed = await this.renameEntry({ oldPath: entry.fullPath, newPath: path, expectedSource: entry, expectedDestination: expected, checkActive: checkBeforeChange, locations });
          if (installed === undefined) {
            throw new Error(`Replacement is the same entry: ${path}`);
          }
          return this.referenceFileEntry(installed);
        }

        const staged = checkedStaging ?? await this.resolveRenameLocation({ path: entry.fullPath, role: 'source' });
        const recoveryLocation = keepBackup ? backup : await this.resolveRenameLocation({ path: `${entry.fullPath}.original`, role: 'destination', symlinkTreatment });
        if (staged.path === target.path || recoveryLocation.path === staged.path || recoveryLocation.path === target.path) {
          throw new Error(`Replacement paths must be distinct: ${target.path}`);
        }
        const candidate = await this.requireEntry({ location: staged, expected: entry });
        if (this.fileOutputs.size !== 0) {
          await this.assertNoOpenWriter({ file: candidate.file, path: staged.path });
        }
        const original = await this.requireEntry({ location: target, expected });
        if (await this.isSameFile({ first: original.file, second: candidate.file })) {
          throw new Error(`Replacement is the same entry: ${target.path}`);
        }
        const previousBackup = keepBackup ? await this.findFileEntry({ location: recoveryLocation }) : undefined;
        if (expectedBackup !== undefined && keepBackup) {
          if (expectedBackup.entry === undefined) {
            if (previousBackup !== undefined) {
              throw new DOMException(`File exists: ${recoveryLocation.path}`, 'InvalidModificationError');
            }
          } else if (!await this.matchesExpectedEntry({ expected: expectedBackup.entry, actual: previousBackup, location: recoveryLocation })) {
            throw new Error(`Destination entry changed: ${recoveryLocation.path}`);
          }
        }
        if (previousBackup !== undefined && (await this.isSameFile({ first: original.file, second: previousBackup.file })
        || await this.isSameFile({ first: candidate.file, second: previousBackup.file }))) {
          throw new Error(`Backup aliases another replacement entry: ${recoveryLocation.path}`);
        }
        const saved = await this.renameEntry({
          oldPath: target.path,
          newPath: recoveryLocation.path,
          expectedSource: expected,
          expectedDestination: previousBackup === undefined ? undefined : this.referenceFileEntry({ location: recoveryLocation, entry: previousBackup }),
          noReplace: previousBackup === undefined ? true : undefined,
          locations: { source: target, destination: recoveryLocation },
          checkActive: checkBeforeChange,
        });
        if (saved === undefined) {
          throw new Error(`Backup aliases another replacement entry: ${recoveryLocation.path}`);
        }

        // The old entry has moved. Finish or restore using the actual published identity.
        return this.publications.run({
          operation: async () => {
            const savedEntry = this.referenceFileEntry(saved);
            const verifyBackup = async () => {
              const current = await this.resolveRenameLocation({ path: saved.location.path, role: 'source', expected: saved.location });
              await this.requireEntry({ location: current, expected: savedEntry });
            };
            let installed: typeof saved;
            try {
              await verifyBackup();
              const result = await this.renameEntry({
                oldPath: staged.path,
                newPath: target.path,
                expectedSource: entry,
                noReplace: true,
                locations: { source: staged, destination: target },
                beforePublication: async () => {
                  await verifyBackup();
                  checkStaging();
                },
              });
              if (result === undefined) {
                throw new Error(`Replacement is the same entry: ${target.path}`);
              }
              installed = result;
            } catch (error: unknown) {
              if (error instanceof WeshRenameIncompleteError) {
                throw error;
              }
              try {
                await this.renameEntry({
                  oldPath: saved.location.path,
                  newPath: target.path,
                  expectedSource: savedEntry,
                  noReplace: true,
                  locations: { source: saved.location, destination: target },
                });
              } catch (cause: unknown) {
                throw new WeshRenameIncompleteError({
                  message: `Could not replace '${target.path}' or restore from '${saved.location.path}'`,
                  cause: new AggregateError([error, cause], `${String(error)}; ${String(cause)}`),
                });
              }
              throw error;
            }
            try {
              if (keepBackup) {
                await verifyBackup();
              } else {
                const source = await this.resolveRenameLocation({ path: saved.location.path, role: 'source', expected: saved.location });
                await this.requireEntry({ location: source, expected: savedEntry });
                const destination = await this.resolveRenameLocation({ path: installed.location.path, role: 'destination', expected: target });
                await this.requireEntry({ location: destination, expected: this.referenceFileEntry(installed) });
                const original = await this.requireEntry({ location: source, expected: savedEntry });
                if (this.findMount({ path: source.path }) !== saved.location.mount || this.findMount({ path: destination.path }) !== installed.location.mount) {
                  throw new Error('Mount changed during replacement');
                }
                await this.removePinnedEntry({ source, original });
              }
            } catch (cause: unknown) {
              throw new WeshRenameIncompleteError({ message: `Could not finish backup '${saved.location.path}' after replacing '${target.path}'`, cause });
            }
            return this.referenceFileEntry(installed);
          },
        });
      },
    });
  };

  private referenceFileEntry({ location, entry }: { location: FileEntryLocation, entry: FileEntry }): WeshEntryRef {
    return this.createResolvedEntryRef({
      resolved: entry.registry === undefined
        ? { kind: 'handle', handle: entry.file, fullPath: location.path, readOnly: location.readOnly, mount: location.mount }
        : { kind: 'registry', resolution: entry.registry, fullPath: location.path, readOnly: location.readOnly },
      name: location.name,
      pinnedBacking: entry.registry === undefined ? undefined : entry.file,
    });
  }

  private async requireEntry({ location, expected }: { location: FileEntryLocation, expected: WeshEntryRef }): Promise<FileEntry> {
    const actual = await this.findFileEntry({ location });
    if (actual === undefined || !await this.matchesExpectedEntry({ expected, actual, location })) {
      throw new Error(`Entry changed: ${location.path}`);
    }
    return actual;
  }

  private serializeEntryChange<T>({ change }: { change: () => Promise<T> }): Promise<T> {
    const operation = this.pendingEntryChanges.then(change);
    this.pendingEntryChanges = operation.then(() => {}, () => {});
    return operation;
  }

  private assertCompatibleRenameEntries({ source, destination }: { source: FileEntry, destination: FileEntry }): void {
    if (!canCompareFileSystemEntryIdentity({ first: source.file, second: destination.file })) {
      throw new DOMException('Cannot compare entries across filesystem grants', 'InvalidModificationError');
    }
    if ((source.registry === undefined) !== (destination.registry === undefined)) {
      throw new Error('Cannot replace a regular file with a registry entry or vice versa');
    }
  }

  private async renameEntry({ oldPath, newPath, expectedSource, expectedDestination, noReplace, checkActive, locations, beforePublication, onPublicationStart }: {
    oldPath: string,
    newPath: string,
    expectedSource?: WeshEntryRef,
    expectedDestination?: WeshEntryRef,
    noReplace?: true,
    checkActive?: () => void,
    locations?: { source: FileEntryLocation, destination: FileEntryLocation },
    beforePublication?: () => Promise<void>,
    onPublicationStart?: () => void,
  }): Promise<{ location: FileEntryLocation, entry: FileEntry } | undefined> {
    checkActive?.();
    const source = await this.resolveRenameLocation({ path: oldPath, role: 'source', expected: locations?.source });
    const original = await this.findFileEntry({ location: source });
    if (original === undefined) {
      throw new DOMException(`Path not found: ${oldPath}`, 'NotFoundError');
    }
    if (expectedSource !== undefined && !await this.matchesExpectedEntry({ expected: expectedSource, actual: original, location: source })) {
      throw new Error(`Source entry changed: ${source.path}`);
    }
    const destination = await this.resolveRenameLocation({ path: newPath, role: 'destination', expected: locations?.destination });
    const checkMounts = () => {
      if (this.findMount({ path: source.path }) !== source.mount || this.findMount({ path: destination.path }) !== destination.mount) {
        throw new Error(`Mount changed during rename: ${source.path}`);
      }
    };
    const checkBeforeChange = () => {
      checkActive?.();
      checkMounts();
    };
    const existing = source.path === destination.path ? original : await this.findFileEntry({ location: destination });
    if (noReplace && existing !== undefined) {
      throw new DOMException(`File exists: ${destination.path}`, 'InvalidModificationError');
    }
    if (expectedDestination !== undefined && !await this.matchesExpectedEntry({ expected: expectedDestination, actual: existing, location: destination })) {
      throw new Error(`Destination entry changed: ${destination.path}`);
    }
    if (source.path === destination.path) {
      return undefined;
    }
    if (existing !== undefined) {
      this.assertCompatibleRenameEntries({ source: original, destination: existing });
      if (await this.isSameFile({ first: original.file, second: existing.file })) {
        if (original.registry !== undefined && !await this.isSameFile({ first: original.registry.file, second: existing.registry?.file })) {
          throw new Error('Cannot rename between different registry entries for the same backing file');
        }
        return undefined;
      }
    }

    if (this.fileOutputs.size !== 0) {
      await this.assertNoOpenWriter({ file: original.file, path: source.path });
      if (existing !== undefined) {
        await this.assertNoOpenWriter({ file: existing.file, path: destination.path });
      }
    }

    const registry = original.registry;
    if (registry !== undefined) {
      const contents = await original.file.getFile();
      const published = await this.publishRegistryEntry({
        entry: registry.entry,
        destination,
        existing,
        source: { location: source, original, contents, verifyPublished: noReplace === true || locations !== undefined },
        checkActive: checkBeforeChange,
        checkMounts,
        beforePublication,
        onPublicationStart,
      });
      return { location: destination, entry: published };
    }

    const movable: MovableFile = original.file;
    // The browser's native move has no no-replace flag.
    const move = movable.move;
    if (!noReplace && existing === undefined && source.mount === destination.mount && typeof move === 'function') {
      if (beforePublication !== undefined) {
        await beforePublication();
      }
      checkBeforeChange();
      const invalidateMove = () => {
        this.invalidateEntryLookups({ path: source.path, mount: source.mount });
        this.invalidateEntryLookups({ path: destination.path, mount: destination.mount });
      };
      onPublicationStart?.();
      const moved = await this.publications.run({
        operation: async () => {
          try {
            await move.call(movable, destination.parent, destination.name);
          } catch (error: unknown) {
            try {
              const current = await this.findFileEntry({ location: source });
              if (current?.registry !== undefined || !await this.isSameFile({ first: original.file, second: current?.file })) {
                throw new Error('source changed during native move');
              }
            } catch (cause: unknown) {
              throw new WeshRenameIncompleteError({ message: `Native move failed and source could not be verified: ${source.path}`, cause });
            }
            if (!(error instanceof DOMException) || error.name !== 'NotSupportedError'
            || await this.findFileEntry({ location: destination }) !== undefined) {
              throw error;
            }
            return false;
          }
          try {
            const published = await optionalFile({ directory: destination.parent, name: destination.name });
            const remaining = await optionalFile({ directory: source.parent, name: source.name });
            if (!await this.isSameFile({ first: original.file, second: published })
            || await this.isSameFile({ first: original.file, second: remaining })) {
              throw new Error('original entry did not move to the destination');
            }
          } catch (cause: unknown) {
            throw new WeshRenameIncompleteError({ message: `Native move could not be verified: ${destination.path}`, cause });
          }
          return true;
        },
      }).catch((error: unknown) => {
        invalidateMove();
        throw error;
      });
      if (moved) {
        invalidateMove();
        return { location: destination, entry: original };
      }
    }

    const contents = await original.file.getFile();
    const verifyNewDestination = noReplace === true || locations !== undefined;
    if (existing === undefined && await this.findFileEntry({ location: destination }) !== undefined) {
      throw new Error(`Rename destination changed: ${destination.path}`);
    }
    checkBeforeChange();
    let finishPublication: (() => void) | undefined;
    try {
      // A missing destination becomes visible at create; an existing file changes at close.
      if (existing === undefined) {
        this.invalidateEntryLookups({ path: destination.path, mount: destination.mount });
        onPublicationStart?.();
        finishPublication = this.publications.begin();
      }
      const file = existing?.file ?? await destination.parent.getFileHandle(destination.name, { create: true });
      try {
        await this.writeRenameFile({
          directory: destination.parent,
          name: destination.name,
          file,
          data: contents,
          requireEmpty: existing === undefined && verifyNewDestination,
          checkActive: existing === undefined ? checkMounts : checkBeforeChange,
          beforePublication: existing === undefined && verifyNewDestination ? async () => {
            await beforePublication?.();
            if (await this.getRegistryResolution({ path: destination.path, strict: 'fresh-root' }) !== undefined) {
              throw new Error(`Rename destination changed: ${destination.path}`);
            }
          } : beforePublication,
          beforeClose: () => {
            checkMounts();
            if (finishPublication === undefined) {
              checkActive?.();
              this.invalidateEntryLookups({ path: destination.path, mount: destination.mount });
              onPublicationStart?.();
              finishPublication = this.publications.begin();
            }
          },
        });
      } catch (error: unknown) {
        if (existing === undefined && !(error instanceof WeshRenameIncompleteError)
          && this.findMount({ path: destination.path }) === destination.mount) {
          try {
            const current = await this.findFileEntry({ location: destination });
            if (current !== undefined && current.registry === undefined && await this.isSameFile({ first: file, second: current.file })
              && (await file.getFile()).size === 0 && this.findMount({ path: destination.path }) === destination.mount) {
              await destination.parent.removeEntry(destination.name);
            }
          } catch (cause: unknown) {
            throw new WeshRenameIncompleteError({ message: `Could not remove unpublished destination '${destination.path}'`, cause: new AggregateError([error, cause]) });
          }
        }
        throw error;
      }
      let published: FileEntry;
      try {
        const current = await this.findFileEntry({ location: destination });
        if (current === undefined || current.registry !== undefined || !await this.isSameFile({ first: file, second: current.file })) {
          throw new Error(`Rename destination changed: ${destination.path}`);
        }
        published = current;
      } catch (cause: unknown) {
        throw new WeshRenameIncompleteError({ message: `Could not verify committed destination '${destination.path}'`, cause });
      }
      await this.removeRenamedSource({
        source,
        original,
        destination,
        contents,
        published: verifyNewDestination ? published : undefined,
      });
      return { location: destination, entry: published };
    } finally {
      finishPublication?.();
    }
  }

  private async resolveFileLookupLocation({ path, lookup }: { path: string, lookup: WeshEntryLookup }): Promise<FileEntryLocation> {
    const observed = this.entryLookups.get(lookup);
    if (observed === undefined || path !== lookup.path) {
      throw new WeshEntryChangedError({ path });
    }
    this.checkEntryLookup({ lookup });
    let location: FileEntryLocation;
    try {
      location = await this.resolveRenameLocation({ path, role: 'destination', symlinkTreatment: 'no-follow' });
    } catch (error: unknown) {
      if (error instanceof WeshNotDirectoryError || isFileSystemNotFoundError({ error })) {
        throw new WeshEntryChangedError({ path, cause: error });
      }
      throw error;
    }
    if (location.mount !== observed.mount) {
      throw new WeshEntryChangedError({ path });
    }
    const actual = await this.findFileEntry({ location });
    if (lookup.entry !== undefined) {
      if (!await this.matchesExpectedEntry({ expected: lookup.entry, actual, location })) {
        throw new WeshEntryChangedError({ path });
      }
    } else {
      const parent = observed.missingParent;
      if (actual !== undefined || parent === undefined
        || (location.parent !== parent && (!canCompareFileSystemEntryIdentity({ first: parent, second: location.parent })
          || !await parent.isSameEntry(location.parent)))) {
        throw new WeshEntryChangedError({ path });
      }
    }
    this.checkEntryLookup({ lookup });
    return location;
  }

  private async resolveTemporarySibling({ path, siblingOf }: { path: string, siblingOf: WeshEntryLookup }): Promise<FileEntryLocation> {
    const sibling = await this.resolveFileLookupLocation({ path: siblingOf.path, lookup: siblingOf });
    if (path === sibling.path || this.normalizePath({ path }) !== path || this.dirname({ path }) !== this.dirname({ path: sibling.path })
      || this.findMount({ path }) !== sibling.mount || this.isMountPoint({ path }) || this.specialFiles.has(path)) {
      throw new Error(`Invalid temporary sibling: ${path}`);
    }
    return { ...sibling, path, name: this.basename({ path }) };
  }

  private async resolveRenameLocation({ path, role, expected, symlinkTreatment }: {
    path: string,
    role: 'source' | 'destination',
    expected?: FileEntryLocation,
    symlinkTreatment?: 'no-follow',
  }): Promise<FileEntryLocation> {
    const location = await this.resolveFileEntryLocation({ path, symlinkTreatment: expected?.symlinkTreatment ?? symlinkTreatment });
    if (this.isMountPoint({ path: location.path })) {
      throw new Error('Cannot rename mount point');
    }
    if (location.readOnly || this.specialFiles.has(location.path)) {
      throw new Error(`Read-only ${role}: ${path}`);
    }
    if (expected !== undefined && (location.path !== expected.path || location.mount !== expected.mount
      || !canCompareFileSystemEntryIdentity({ first: expected.parent, second: location.parent })
      || (expected.parent !== location.parent && !await expected.parent.isSameEntry(location.parent)))) {
      throw new Error(`Directory changed during replacement: ${path}`);
    }
    return location;
  }

  private async resolveFileEntryLocation({ path, symlinkTreatment }: { path: string, symlinkTreatment?: 'no-follow' }): Promise<FileEntryLocation> {
    if (path.endsWith('/')) {
      throw new Error(`Not a directory: ${path}`);
    }
    const separator = path.lastIndexOf('/');
    const name = path.slice(separator + 1);
    if (name.length === 0 || name === '.' || name === '..') {
      throw new Error(`Invalid argument: ${path}`);
    }
    const directory = await this.resolveExistingDirectory({
      path: separator <= 0 ? '/' : path.slice(0, separator),
      finalSymlinkTreatment: 'follow',
      strictRegistry: 'fresh-root',
      symlinkTreatment,
    });
    const fullPath = directory.fullPath === '/' ? `/${name}` : `${directory.fullPath}/${name}`;
    if (this.findMount({ path: directory.fullPath }) !== directory.mount) {
      throw new WeshEntryChangedError({ path: fullPath });
    }
    return { path: fullPath, parent: directory.handle, mount: directory.mount, name, readOnly: directory.readOnly, symlinkTreatment };
  }

  private async findFileEntry({ location }: { location: FileEntryLocation }): Promise<FileEntry | undefined> {
    const registry = await this.getRegistryResolution({ path: location.path, strict: 'fresh-root' });
    const file = await optionalFile({ directory: location.parent, name: location.name });
    if (file === undefined) {
      if (registry !== undefined) {
        throw new Error(`Missing backing file for registry entry: ${location.path}`);
      }
      if (this.hasSyntheticDirectory({ path: location.path })) {
        throw new Error(`Is a directory: ${location.path}`);
      }
      return undefined;
    }
    return { file, registry };
  }

  private async isSameFile({ first, second }: { first: FileSystemFileHandle, second: FileSystemFileHandle | undefined }): Promise<boolean> {
    return second !== undefined && (first === second || await first.isSameEntry(second));
  }

  compareEntryIdentity: WeshIVirtualFileSystem['compareEntryIdentity'] = async ({ first, second }) => {
    const left = this.getEntryIdentity({ entry: first });
    const right = this.getEntryIdentity({ entry: second });
    if (left === undefined || right === undefined
      || !canCompareFileSystemEntryIdentity({ first: left.handle, second: right.handle })) {
      return 'unknown';
    }
    if (left.handle !== right.handle && !await left.handle.isSameEntry(right.handle)) {
      return 'different';
    }
    return (left.registry === undefined && right.registry === undefined)
      || (left.registry !== undefined && await this.matchesRegistryEntry({ expected: left.registry, actual: right.registry }))
      ? 'same'
      : 'shared-backing';
  };

  private getEntryIdentity({ entry }: { entry: WeshEntryRef }): { handle: FileSystemHandle, registry?: RegistryResolution } | undefined {
    const backend = this.getResolvedEntry({ entry });
    const resolved = backend?.resolved;
    switch (resolved?.kind) {
    case 'handle':
      return { handle: resolved.handle };
    case 'registry':
      return backend?.pinnedBacking === undefined ? undefined : { handle: backend.pinnedBacking, registry: resolved.resolution };
    case 'special':
    case 'synthetic_directory':
    case undefined:
      return undefined;
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled entry: ${String(_ex)}`);
    }
    }
  }

  private getResolvedEntry({ entry }: { entry: WeshEntryRef }): Extract<WeshEntryRefBackend, { kind: 'resolved_node' }> | undefined {
    const backend = this.getEntryRefBackend({ entry });
    switch (backend.kind) {
    case 'resolved_node':
      return backend;
    case 'virtual_entry':
    case 'virtual_path':
      return undefined;
    default: {
      const _ex: never = backend;
      throw new Error(`Unhandled entry backend: ${String(_ex)}`);
    }
    }
  }

  private async matchesExpectedEntry({ expected, actual, location }: {
    expected: WeshEntryRef,
    actual: FileEntry | undefined,
    location: FileEntryLocation,
  }): Promise<boolean> {
    const backend = this.getResolvedEntry({ entry: expected });
    if (actual === undefined || backend === undefined || expected.fullPath !== location.path) {
      return false;
    }
    const { resolved, pinnedBacking } = backend;
    switch (resolved.kind) {
    case 'handle':
      return actual.registry === undefined && canCompareFileSystemEntryIdentity({ first: resolved.handle, second: actual.file })
        && (resolved.handle === actual.file || await resolved.handle.isSameEntry(actual.file));
    case 'registry':
      return pinnedBacking !== undefined && canCompareFileSystemEntryIdentity({ first: pinnedBacking, second: actual.file })
        && (pinnedBacking === actual.file || await pinnedBacking.isSameEntry(actual.file))
        && await this.matchesRegistryEntry({ expected: resolved.resolution, actual: actual.registry });
    case 'special':
    case 'synthetic_directory':
      return false;
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled entry: ${String(_ex)}`);
    }
    }
  }

  private async matchesRegistryEntry({ expected, actual }: {
    expected: RegistryResolution,
    actual: RegistryResolution | undefined,
  }): Promise<boolean> {
    return expected.file !== undefined && actual?.file !== undefined
      && await this.isSameFile({ first: expected.file, second: actual.file })
      && JSON.stringify(mapDomainToDto({ entry: expected.entry })) === JSON.stringify(mapDomainToDto({ entry: actual.entry }));
  }

  private async writeRenameFile({ directory, name, file, data, requireEmpty, checkActive, beforePublication, beforeClose }: {
    directory: FileSystemDirectoryHandle,
    name: string,
    file: FileSystemFileHandle,
    data: File | string,
    requireEmpty: boolean,
    checkActive: (() => void) | undefined,
    beforePublication: (() => Promise<void>) | undefined,
    beforeClose: () => void,
  }): Promise<void> {
    const writable = await file.createWritable({ keepExistingData: false });
    let committing = false;
    try {
      checkActive?.();
      await writable.write(data);
      checkActive?.();
      if (beforePublication !== undefined) {
        await beforePublication();
      }
      const current = await optionalFile({ directory, name });
      if (!await this.isSameFile({ first: file, second: current }) || (requireEmpty && (await file.getFile()).size !== 0)) {
        throw new Error(`Rename destination changed: ${name}`);
      }
      beforeClose();
      committing = true;
      await writable.close();
    } catch (error: unknown) {
      await writable.abort().catch(() => {});
      if (committing) {
        throw new WeshRenameIncompleteError({ message: `Could not confirm destination commit: ${name}`, cause: error });
      }
      throw error;
    }
  }

  private async publishRegistryEntry({ entry, destination, existing, source, checkActive, checkMounts, beforePublication, onPublicationStart }: {
    entry: RegistryEntry,
    source: { location: FileEntryLocation, original: FileEntry, contents: File, verifyPublished: boolean } | undefined,
    destination: FileEntryLocation,
    existing: FileEntry | undefined,
    checkActive: (() => void) | undefined,
    checkMounts?: () => void,
    beforePublication?: () => Promise<void>,
    onPublicationStart?: () => void,
  }): Promise<FileEntry> {
    checkActive?.();
    const relPath = this.getRelativePath({ path: destination.path, mount: destination.mount });
    const directory = existing?.registry?.directory ?? await this.getMetadataDirectory({
      mount: destination.mount,
      relPath: relPath.slice(0, Math.max(0, relPath.lastIndexOf('/'))) || '.',
      create: true,
      strict: 'fresh-root',
    });
    if (directory === undefined) {
      throw new Error(`Unable to create metadata directory: ${destination.path}`);
    }
    if (existing === undefined && await optionalFile({ directory, name: destination.name }) !== undefined) {
      throw new Error(`Registry destination changed: ${destination.path}`);
    }
    checkMounts?.();
    checkActive?.();
    let finishPublication: (() => void) | undefined;
    const checkBeforePublication = () => {
      checkMounts?.();
      if (finishPublication === undefined) {
        checkActive?.();
      }
    };
    try {
      if (existing === undefined) {
        this.invalidateEntryLookups({ path: destination.path, mount: destination.mount });
        onPublicationStart?.();
        finishPublication = this.publications.begin();
      }
      const metadata = existing?.registry?.file ?? await directory.getFileHandle(destination.name, { create: true });
      const data = JSON.stringify(mapDomainToDto({ entry }));
      let writer: FileSystemWritableFileStream | undefined;
      let backingWriter: FileSystemWritableFileStream | undefined;
      let committing = false;
      let file: FileSystemFileHandle | undefined;
      let published: FileEntry;
      try {
        if (existing === undefined && (await metadata.getFile()).size !== 0) {
          throw new Error(`Registry destination changed: ${destination.path}`);
        }
        checkBeforePublication();
        writer = await metadata.createWritable({ keepExistingData: false });
        checkBeforePublication();
        await writer.write(data);
        checkBeforePublication();
        if (existing === undefined && await optionalFile({ directory: destination.parent, name: destination.name }) !== undefined) {
          throw new Error(`Registry destination changed: ${destination.path}`);
        }
        checkBeforePublication();
        file = existing?.file ?? await destination.parent.getFileHandle(destination.name, { create: true });
        if (source !== undefined && (source.contents.size > 0 || (existing !== undefined && (await existing.file.getFile()).size > 0))) {
          checkBeforePublication();
          backingWriter = await file.createWritable({ keepExistingData: false });
          checkBeforePublication();
          await backingWriter.write(source.contents);
        }
        if (!await this.isSameFile({ first: file, second: await optionalFile({ directory: destination.parent, name: destination.name }) })
        || !await this.isSameFile({ first: metadata, second: await optionalFile({ directory, name: destination.name }) })) {
          throw new Error(`Registry destination changed: ${destination.path}`);
        }
        if (beforePublication !== undefined) {
          await beforePublication();
        }
        if (existing === undefined && (source === undefined || source.verifyPublished)
          && ((await metadata.getFile()).size !== 0 || (await file.getFile()).size !== 0)) {
          throw new Error(`Registry destination changed: ${destination.path}`);
        }
        checkBeforePublication();
        if (finishPublication === undefined) {
          this.invalidateEntryLookups({ path: destination.path, mount: destination.mount });
          onPublicationStart?.();
          finishPublication = this.publications.begin();
        }
        committing = true;
        await writer.close();
        published = await this.verifyRegistryPublication({ destination, file, metadata, data });
        if (source !== undefined) {
          this.publishFifoName({ sourcePath: source.location.path, destinationPath: destination.path });
        }
        if (backingWriter !== undefined) {
          checkMounts?.();
          await backingWriter.close();
          published = await this.verifyRegistryPublication({ destination, file, metadata, data });
        }
      } catch (error: unknown) {
        await writer?.abort().catch(() => {});
        await backingWriter?.abort().catch(() => {});
        // A visible empty sidecar of the same identity proves the registry entry was never installed.
        const unpublished = existing === undefined && this.findMount({ path: destination.path }) === destination.mount
          && await this.removeUnwrittenRegistryFile({ directory, name: destination.name, metadata, destination, file }).catch(() => false);
        if (committing && !unpublished) {
          const message = `Could not confirm publication of registry entry '${destination.path}'`;
          if (source !== undefined) {
            throw new WeshRenameIncompleteError({ message, cause: error });
          }
          throw new Error(message, { cause: error });
        }
        throw error;
      }
      if (source !== undefined) {
        await this.removeRenamedSource({
          source: source.location,
          original: source.original,
          destination,
          contents: source.contents,
          published: source.verifyPublished ? published : undefined,
        });
      }
      return published;
    } finally {
      finishPublication?.();
    }
  }

  private async verifyRegistryPublication({ destination, file, metadata, data }: {
    destination: FileEntryLocation,
    file: FileSystemFileHandle,
    metadata: FileSystemFileHandle,
    data: string,
  }): Promise<FileEntry> {
    const published = await this.findFileEntry({ location: destination });
    if (!await this.isSameFile({ first: file, second: published?.file })
      || !await this.isSameFile({ first: metadata, second: published?.registry?.file })
      || published?.registry === undefined || JSON.stringify(mapDomainToDto({ entry: published.registry.entry })) !== data) {
      throw new Error(`Registry destination changed: ${destination.path}`);
    }
    return published;
  }

  private async removeUnwrittenRegistryFile({ directory, name, metadata, destination, file }: {
    directory: FileSystemDirectoryHandle,
    name: string,
    metadata: FileSystemFileHandle,
    destination: FileEntryLocation,
    file: FileSystemFileHandle | undefined,
  }): Promise<boolean> {
    const current = await optionalFile({ directory, name });
    if (!await this.isSameFile({ first: metadata, second: current }) || (await metadata.getFile()).size !== 0
      || this.findMount({ path: destination.path }) !== destination.mount) {
      return false;
    }
    await directory.removeEntry(name);
    if (file !== undefined && await this.isSameFile({ first: file, second: await optionalFile({ directory: destination.parent, name }) })
      && (await file.getFile()).size === 0) {
      if (this.findMount({ path: destination.path }) !== destination.mount) {
        return false;
      }
      await destination.parent.removeEntry(name);
    }
    return true;
  }

  private async removeRenamedSource({ source, original, destination, contents, published }: {
    source: FileEntryLocation,
    original: FileEntry,
    destination: FileEntryLocation,
    contents: File,
    published: FileEntry | undefined,
  }): Promise<void> {
    try {
      const current = await this.findFileEntry({ location: source });
      if (!await this.isSameFile({ first: original.file, second: current?.file })) {
        throw new Error('source changed during rename');
      }
      const sourceContents = await original.file.getFile();
      if (sourceContents.size !== contents.size || sourceContents.lastModified !== contents.lastModified) {
        throw new Error('source changed during rename');
      }
      if (original.registry !== undefined) {
        if (!await this.matchesRegistryEntry({ expected: original.registry, actual: current?.registry })) {
          throw new Error('source changed during rename');
        }
      } else if (current?.registry !== undefined) {
        throw new Error('source changed during rename');
      }
      if (published !== undefined) {
        await this.requireEntry({ location: destination, expected: this.referenceFileEntry({ location: destination, entry: published }) });
        await this.requireEntry({ location: source, expected: this.referenceFileEntry({ location: source, entry: original }) });
      }
      if (this.findMount({ path: source.path }) !== source.mount || this.findMount({ path: destination.path }) !== destination.mount) {
        throw new Error('mount changed during rename');
      }
      await this.removePinnedEntry({ source, original });
    } catch (cause: unknown) {
      throw new WeshRenameIncompleteError({ message: `Destination '${destination.path}' committed, but could not remove source '${source.path}'`, cause });
    }
  }

  private async removePinnedEntry({ source, original, onPublicationStart }: {
    source: FileEntryLocation,
    original: FileEntry,
    onPublicationStart?: () => void,
  }): Promise<void> {
    if (this.findMount({ path: source.path }) !== source.mount) {
      throw new Error(`Mount changed while removing '${source.path}'`);
    }
    if (original.registry !== undefined) {
      onPublicationStart?.();
      this.invalidateEntryLookups({ path: source.path, mount: source.mount });
      await original.registry.directory.removeEntry(source.name);
      const current = await this.findFileEntry({ location: source });
      if (current?.registry !== undefined || !await this.isSameFile({ first: original.file, second: current?.file })) {
        throw new Error(`Source backing changed while removing '${source.path}'`);
      }
    }
    if (this.findMount({ path: source.path }) !== source.mount) {
      throw new Error(`Mount changed while removing '${source.path}'`);
    }
    if (original.registry !== undefined) {
      this.detachOpenFifo({ path: source.path });
    } else {
      onPublicationStart?.();
    }
    await this.removeTrackedEntry({ parent: source.parent, name: source.name, path: source.path, mount: source.mount });
  }

  private detachOpenFifo({ path }: { path: string }): void {
    const state = this.openFifos.get(path);
    if (state !== undefined) {
      this.openFifos.delete(path);
      state.paths.delete(path);
    }
  }

  private publishFifoName({ sourcePath, destinationPath }: { sourcePath: string, destinationPath: string }): void {
    const state = this.openFifos.get(sourcePath);
    this.detachOpenFifo({ path: destinationPath });
    if (state !== undefined) {
      state.paths.add(destinationPath);
      this.openFifos.set(destinationPath, state);
    }
  }

  // --- Registry Persistence Helpers ---

  private async getMetadataRoot({
    mount,
    create,
    strict,
    registryRoots,
  }: {
    mount: DirectoryMountEntry,
    create: boolean,
    strict?: RegistryLookup,
    registryRoots?: RegistryRoots,
  }): Promise<FileSystemDirectoryHandle | undefined> {
    if (strict !== 'fresh-root' && mount.metadataHandle !== undefined) {
      return mount.metadataHandle;
    }

    const observedRoots = create ? undefined : registryRoots;
    const observed = observedRoots?.get(mount);
    if (observed !== undefined) {
      observed.reused = true;
      return observed.handle;
    }

    try {
      const systemDir = await mount.handle.getDirectoryHandle(WESH_SYSTEM_DIR, { create });
      const metadata = await systemDir.getDirectoryHandle(METADATA_DIR, { create });
      mount.metadataHandle = metadata;
      observedRoots?.set(mount, { handle: metadata, reused: false });
      return metadata;
    } catch (error: unknown) {
      if (hasFileSystemErrorName({ error, name: 'NotFoundError' })) {
        observedRoots?.set(mount, { handle: undefined, reused: false });
      } else if (strict !== undefined) {
        throw error;
      }
      return undefined;
    }
  }

  private async getMetadataDirectory({
    mount,
    relPath,
    create,
    strict,
    registryRoots,
  }: {
    mount: DirectoryMountEntry,
    relPath: string,
    create: boolean,
    strict?: RegistryLookup,
    registryRoots?: RegistryRoots,
  }): Promise<FileSystemDirectoryHandle | undefined> {
    let current = await this.getMetadataRoot({ mount, create, strict, registryRoots });
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
    } catch (error: unknown) {
      if (strict && !hasFileSystemErrorName({ error, name: 'NotFoundError' })) {
        throw error;
      }
      return undefined;
    }
  }

  private async missedRegistryRootsChanged({ roots, mounts }: { roots: RegistryRoots, mounts: readonly MountEntry[] }): Promise<boolean> {
    for (const [mount, observation] of roots) {
      if (observation.handle !== undefined || !observation.reused) {
        continue;
      }
      if (this.mounts !== mounts) {
        return true;
      }
      try {
        const metadata = await this.getMetadataRoot({ mount, create: false, strict: 'cached-root' });
        if (metadata !== undefined || this.mounts !== mounts) {
          return true;
        }
      } catch {
        // The provider could not confirm the miss. Restore the ordinary walk.
        return true;
      }
    }
    return false;
  }

  private async parseRegistryEntryFile({
    fileHandle,
    relPath,
    strict,
  }: {
    fileHandle: FileSystemFileHandle,
    relPath: string,
    strict?: RegistryLookup,
  }): Promise<RegistryEntry | undefined> {
    try {
      const file = await fileHandle.getFile();
      const dto = WeshRegistryEntrySchemaDto.parse(JSON.parse(await file.text()));
      return mapDtoToDomain({ dto });
    } catch (error: unknown) {
      if (strict) {
        throw error;
      }
      console.warn(`Failed to parse registry entry ${relPath}:`, error);
      return undefined;
    }
  }

  private async loadRegistryEntry({
    mount,
    relPath,
    strict,
    registryRoots,
  }: {
    mount: DirectoryMountEntry,
    relPath: string,
    strict?: RegistryLookup,
    registryRoots?: RegistryRoots,
  }): Promise<StoredRegistryResolution | undefined> {
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
      strict,
      registryRoots,
    });
    if (directory === undefined) {
      return undefined;
    }

    let file: FileSystemFileHandle;
    try {
      file = await directory.getFileHandle(fileName);
    } catch (error: unknown) {
      if (strict && !hasFileSystemErrorName({ error, name: 'NotFoundError' }) && !hasFileSystemErrorName({ error, name: 'TypeMismatchError' })) {
        throw error;
      }
      return undefined;
    }
    const entry = await this.parseRegistryEntryFile({ fileHandle: file, relPath, strict });
    return entry === undefined ? undefined : { mount, relPath, entry, file, directory };
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

  // --- Path Helpers ---

  /**
   * Returns the underlying native FileSystemHandle if the path resolves to a
   * real filesystem entry (i.e. a handle-kind resolved node). Returns null for
   * synthetic directories, special files, and registry entries.
   */
  async getNativeHandle({ path }: { path: string }): Promise<FileSystemHandle | null> {
    try {
      const resolved = await this.resolveNode({
        path,
        finalSymlinkTreatment: 'follow',
      });
      switch (resolved.kind) {
      case 'handle':
        return resolved.handle;
      case 'synthetic_directory':
      case 'special':
      case 'registry':
      case 'virtual':
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
    if (!path.startsWith('/')) {
      path = '/' + path;
    }
    const parts = path.split('/').filter((p) => p !== '' && p !== '.');
    const stack: string[] = [];
    for (const part of parts) {
      if (part === '..') {
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    return '/' + stack.join('/');
  }

  private findMount({ path }: { path: string }): MountEntry | undefined {
    return this.mounts.find((m) => {
      if (path === m.path) {
        return true;
      }
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
    if (path === mount.path) {
      return '.';
    }
    const prefix = mount.path.endsWith('/') ? mount.path : mount.path + '/';
    return path.substring(prefix.length);
  }

  private getDirectMountChildren({ path }: { path: string }): Iterable<string> {
    const prefix = path === '/' ? '/' : `${path}/`;
    const childNames = new Set<string>();

    for (const mount of this.mounts) {
      if (!mount.path.startsWith(prefix)) {
        continue;
      }
      const remainder = mount.path.slice(prefix.length);
      if (remainder.length === 0) {
        continue;
      }
      const sep = remainder.indexOf('/');
      childNames.add(sep === -1 ? remainder : remainder.slice(0, sep));
    }

    return childNames;
  }

  private getDirectSpecialChildren({ path }: { path: string }): Iterable<string> {
    const prefix = path === '/' ? '/' : `${path}/`;
    const childNames = new Set<string>();

    for (const specialPath of this.specialFiles.keys()) {
      if (!specialPath.startsWith(prefix)) {
        continue;
      }
      const remainder = specialPath.slice(prefix.length);
      if (remainder.length === 0) {
        continue;
      }
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

  private async _resolvePhysical({ path, allowMissingLeaf }: {
    path: string, allowMissingLeaf?: boolean,
  }): Promise<{ handle: FileSystemHandle, readOnly: boolean, fullPath: string, mount: DirectoryMountEntry }> {
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
      return { handle: mount.handle, readOnly: mount.readOnly, fullPath: normalized, mount };
    }
    const parts = relativePath.split('/');
    let current: FileSystemDirectoryHandle = mount.handle;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (part === undefined) {
        continue;
      }
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
    if (lastPart === undefined) {
      return { handle: current, readOnly: mount.readOnly, fullPath: normalized, mount };
    }
    try {
      const fileHandle = await current.getFileHandle(lastPart);
      return { handle: fileHandle, readOnly: mount.readOnly, fullPath: normalized, mount };
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
          return { handle: dirHandle, readOnly: mount.readOnly, fullPath: normalized, mount };
        default: {
          const _ex: never = dirHandle.kind;
          throw new Error(`Unhandled handle kind: ${_ex}`);
        }
        }
      } catch (dirError: unknown) {
        if (allowMissingLeaf
          && hasFileSystemErrorName({ error: fileError, name: 'NotFoundError' })
          && hasFileSystemErrorName({ error: dirError, name: 'NotFoundError' })) {
          throw new MissingFileEntry({ fullPath: normalized, parent: current, nameInParent: lastPart, mount });
        }
        this.rethrowPathLookupError({
          error: dirError,
          path: normalized,
        });
      }
    }
  }

  private async getRegistryResolution({
    path,
    strict,
    registryRoots,
  }: {
    path: string,
    strict?: RegistryLookup,
    registryRoots?: RegistryRoots,
  }): Promise<StoredRegistryResolution | undefined> {
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
    return this.loadRegistryEntry({ mount, relPath, strict, registryRoots });
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

  private followSymlink({
    linkPath,
    targetPath,
    remainder,
    symlinks,
  }: {
    linkPath: string,
    targetPath: string,
    remainder: string,
    symlinks: SymlinkTraversal,
  }): string {
    if (symlinks.followed >= 40) {
      throw new Error(`Too many levels of symbolic links: ${linkPath}`);
    }
    symlinks.followed += 1;
    if (targetPath.length === 0) {
      throw new DOMException(`Path not found: ${linkPath}`, 'NotFoundError');
    }
    const basePath = targetPath.startsWith('/')
      ? targetPath
      : `${this.dirname({ path: linkPath })}/${targetPath}`;
    return remainder.length === 0 ? basePath : `${basePath}/${remainder}`;
  }

  private async resolveNode({
    path,
    finalSymlinkTreatment,
    symlinks,
    strictRegistry,
    allowMissingLeaf,
    rejectIntermediateSymlinks,
    registryRoots,
  }: {
    path: string,
    finalSymlinkTreatment: 'follow' | 'no-follow',
    symlinks?: SymlinkTraversal,
    strictRegistry?: RegistryLookup,
    allowMissingLeaf?: boolean,
    rejectIntermediateSymlinks?: true,
    registryRoots?: RegistryRoots,
  }): Promise<ResolvedPath> {
    // A middle `.` has the same directory requirement as the component that follows it.
    const dot = /(?:^|\/)(\.\.(?=\/|$)|\.\/*$)/u.exec(path);
    if (dot !== null) {
      const traversal = symlinks ?? { followed: 0 };
      const prefix = path.slice(0, dot.index).replace(/\/+$/u, '') || '/';
      const directory = await this.resolveTraversalDirectory({ path: prefix, symlinks: traversal, strictRegistry });
      if (dot[1] !== '..') {
        return directory;
      }
      const parent = this.dirname({ path: directory.fullPath });
      const rest = path.slice(dot.index + dot[0].length);
      if (rest.length === 0) {
        return this.resolveTraversalDirectory({ path: parent, symlinks: traversal, strictRegistry });
      }
      return this.resolveNode({ path: `${parent}${rest}`, finalSymlinkTreatment, symlinks: traversal, strictRegistry, allowMissingLeaf });
    }
    if (path.endsWith('/')) {
      const withoutTrailingSlash = path.replace(/\/+$/u, '');
      if (withoutTrailingSlash.length > 0) {
        return this.resolveTraversalDirectory({ path: withoutTrailingSlash, symlinks: symlinks ?? { followed: 0 }, strictRegistry });
      }
    }

    const normalized = this.normalizePath({ path });
    const virtualMount = this.findVirtualMount({ path: normalized });
    if (virtualMount !== undefined) {
      return {
        kind: 'virtual',
        fullPath: normalized,
        provider: virtualMount.provider,
        readOnly: virtualMount.readOnly,
        finalSymlinkTreatment,
      };
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
    // Reuse root observations only between prefixes of this path. A new lookup
    // or a symlink restart must observe the registry again.
    let observedRoots: RegistryRoots | undefined = registryRoots
      ?? (strictRegistry === undefined && parts.length > 1 ? new Map() : undefined);
    const mounts = this.mounts;
    let candidate: string;
    let component: number;
    let special: { handler: () => WeshFileHandle } | undefined;
    let resolution: StoredRegistryResolution | undefined;
    for (;;) {
      candidate = '';
      special = undefined;
      resolution = undefined;
      for (component = 0; component < parts.length; component++) {
        candidate += `/${parts[component]}`;
        special = this.specialFiles.get(candidate);
        if (special !== undefined) {
          break;
        }
        resolution = await this.getRegistryResolution({ path: candidate, strict: strictRegistry, registryRoots: observedRoots });
        if (resolution !== undefined) {
          break;
        }
      }
      if (registryRoots !== undefined || !observedRoots?.size || !await this.missedRegistryRootsChanged({ roots: observedRoots, mounts })) {
        break;
      }
      // A new registry can contain one of the prefixes skipped above. Restart once.
      observedRoots = undefined;
    }

    const isFinalComponent = component === parts.length - 1;
    if (special !== undefined) {
      if (!isFinalComponent) {
        throw new Error(`Not a directory: ${candidate}`);
      }
      return {
        kind: 'special',
        fullPath: candidate,
        readOnly: true,
        handler: special.handler,
      };
    }
    if (resolution !== undefined) {
      switch (resolution.entry.type) {
      case 'symlink':
        if (rejectIntermediateSymlinks && !isFinalComponent) {
          throw new WeshNotDirectoryError({ path: candidate });
        }
        if (!isFinalComponent || finalSymlinkTreatment === 'follow') {
          const traversal = symlinks ?? { followed: 0 };
          return this.resolveNode({
            path: this.followSymlink({
              linkPath: candidate,
              targetPath: resolution.entry.targetPath ?? '',
              remainder: parts.slice(component + 1).join('/'),
              symlinks: traversal,
            }),
            finalSymlinkTreatment,
            symlinks: traversal,
            strictRegistry,
            allowMissingLeaf,
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
      const physical = await this._resolvePhysical({ path: normalized, allowMissingLeaf });
      return {
        kind: 'handle',
        fullPath: physical.fullPath,
        readOnly: physical.readOnly,
        handle: physical.handle,
        mount: physical.mount,
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

  private async resolveTraversalDirectory({ path, symlinks, strictRegistry }: {
    path: string, symlinks: SymlinkTraversal, strictRegistry: RegistryLookup | undefined,
  }): Promise<ResolvedPath> {
    const resolved = await this.resolveNode({ path, finalSymlinkTreatment: 'follow', symlinks, strictRegistry });
    switch (resolved.kind) {
    case 'virtual':
      return this.resolveVirtualTraversalDirectory({ resolved, symlinks });
    case 'synthetic_directory':
      return resolved;
    case 'handle':
      switch (resolved.handle.kind) {
      case 'directory':
        return resolved;
      case 'file':
        break;
      default: {
        const _ex: never = resolved.handle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
      break;
    case 'special':
    case 'registry':
      break;
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${String(_ex)}`);
    }
    }
    throw new Error(`Not a directory: ${path}`);
  }

  private async resolveVirtualTraversalDirectory({ resolved, symlinks }: {
    resolved: Extract<ResolvedPath, { kind: 'virtual' }>, symlinks: SymlinkTraversal,
  }): Promise<ResolvedPath> {
    const mount = this.findVirtualMount({ path: resolved.fullPath });
    if (mount === undefined) {
      throw new Error(`Path not found: ${resolved.fullPath}`);
    }
    const provider = resolved.provider;
    const pending = this.getRelativePath({ path: resolved.fullPath, mount }).split('/').reverse();
    let directory = mount.path;
    const { type: rootType } = await provider.lstat({ path: directory });
    switch (rootType) {
    case 'directory':
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      throw new Error(`Not a directory: ${directory}`);
    default: {
      const _ex: never = rootType;
      throw new Error(`Unhandled entry type: ${_ex}`);
    }
    }
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      if (name === '' || name === '.') {
        continue;
      }
      if (name === '..') {
        if (directory === mount.path) {
          throw new Error(`Path not found: ${resolved.fullPath}`);
        }
        directory = this.dirname({ path: directory });
        continue;
      }
      const path = directory === '/' ? `/${name}` : `${directory}/${name}`;
      const { type } = await provider.lstat({ path });
      switch (type) {
      case 'directory':
        directory = path;
        break;
      case 'symlink': {
        const target = this.followSymlink({ linkPath: path, targetPath: await provider.readlink({ path }), remainder: '', symlinks });
        const prefix = mount.path.endsWith('/') ? mount.path : `${mount.path}/`;
        if (target !== mount.path && !target.startsWith(prefix)) {
          throw new Error(`Path not found: ${target}`);
        }
        const parts = target.slice(prefix.length).split('/');
        for (let index = parts.length - 1; index >= 0; index -= 1) {
          pending.push(parts[index]!);
        }
        directory = mount.path;
        break;
      }
      case 'file':
      case 'fifo':
      case 'chardev':
        throw new Error(`Not a directory: ${path}`);
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled entry type: ${_ex}`);
      }
      }
    }
    return { ...resolved, fullPath: directory };
  }

  private async resolveExistingDirectory({
    path,
    finalSymlinkTreatment,
    strictRegistry,
    symlinkTreatment,
  }: {
    path: string,
    finalSymlinkTreatment: 'follow' | 'no-follow',
    strictRegistry?: RegistryLookup,
    symlinkTreatment?: 'no-follow',
  }): Promise<{ handle: FileSystemDirectoryHandle, readOnly: boolean, fullPath: string, mount: DirectoryMountEntry }> {
    const resolved = symlinkTreatment === undefined
      ? await this.resolveNode({ path, finalSymlinkTreatment, strictRegistry })
      : await this.resolveNodeWithoutFollowingSymlinks({ path, mount: this.findMount({ path }), strictRegistry });
    switch (resolved.kind) {
    case 'handle':
      switch (resolved.handle.kind) {
      case 'directory':
        return {
          handle: resolved.handle as FileSystemDirectoryHandle,
          readOnly: resolved.readOnly,
          fullPath: resolved.fullPath,
          mount: resolved.mount,
        };
      case 'file':
        throw new WeshNotDirectoryError({ path });
      default: {
        const _ex: never = resolved.handle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
    case 'synthetic_directory':
      throw new Error(`Synthetic directory cannot be mutated: ${path}`);
    case 'registry':
    case 'special':
      throw new WeshNotDirectoryError({ path });
    case 'virtual':
      throw new Error(`Read-only filesystem: ${resolved.fullPath}`);
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved node: ${_ex}`);
    }
    }
  }

  private async statFromResolvedNode({
    resolved,
  }: {
    resolved: ResolvedPath,
  }): Promise<WeshStat> {
    switch (resolved.kind) {
    case 'virtual': {
      const { provider, fullPath, finalSymlinkTreatment } = resolved;
      switch (finalSymlinkTreatment) {
      case 'follow':
        return provider.stat({ path: fullPath });
      case 'no-follow':
        return provider.lstat({ path: fullPath });
      default: {
        const _ex: never = finalSymlinkTreatment;
        throw new Error(`Unhandled symlink treatment: ${_ex}`);
      }
      }
    }
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
export const TEST_ONLY = {
};
