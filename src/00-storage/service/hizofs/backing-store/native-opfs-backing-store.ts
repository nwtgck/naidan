import { bytesEqual, toExactArrayBuffer } from '@/00-storage/service/hizofs/bytes';
import type { HizoFSRuntimeDiagnostics } from '@/00-storage/service/hizofs/file-system/diagnostics';
import type {
  HizoFSBackingStore,
  HizoFSBackingStoreEntry,
  HizoFSRandomAccessFile,
  HizoFSRandomAccessFileMode,
} from './backing-store';

interface FileHandleWithWritable extends FileSystemFileHandle {
  createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream>;
}

class HizoFSFileHandleLruCache {
  constructor({
    entryLimit,
    diagnostics,
  }: {
    entryLimit: number;
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
  }) {
    if (!Number.isSafeInteger(entryLimit) || entryLimit < 0) {
      throw new Error(
        'HizoFS backing file-handle cache limit must be a non-negative safe integer',
      );
    }
    this.entryLimit = entryLimit;
    this.diagnostics = diagnostics;
    this.recordState();
  }

  private readonly entryLimit: number;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private readonly entries = new Map<string, Promise<FileSystemFileHandle>>();

  get({ path }: { path: readonly string[] }): Promise<FileSystemFileHandle> | undefined {
    const key = path.join('/');
    const pending = this.entries.get(key);
    if (pending === undefined) {
      this.diagnostics?.recordCacheMiss({ cache: 'backing_file_handle' });
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, pending);
    this.diagnostics?.recordCacheHit({ cache: 'backing_file_handle' });
    return pending;
  }

  set({
    path,
    pending,
  }: {
    path: readonly string[];
    pending: Promise<FileSystemFileHandle>;
  }): void {
    const key = path.join('/');
    this.entries.delete(key);
    if (this.entryLimit === 0) return;
    this.entries.set(key, pending);
    while (this.entries.size > this.entryLimit) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
      this.diagnostics?.recordCacheEviction({ cache: 'backing_file_handle' });
    }
    this.recordState();
  }

  delete({ path }: { path: readonly string[] }): void {
    if (this.entries.delete(path.join('/'))) this.recordState();
  }

  deleteAtOrBelow({ path }: { path: readonly string[] }): void {
    const removedPath = path.join('/');
    let changed = false;
    for (const key of this.entries.keys()) {
      if (key === removedPath || key.startsWith(`${removedPath}/`)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.recordState();
  }

  private recordState(): void {
    this.diagnostics?.recordCacheState({
      cache: 'backing_file_handle',
      byteLength: 0,
      entryCount: this.entries.size,
    });
  }
}

class HizoFSFileSnapshotLruCache {
  constructor({
    entryLimit,
    diagnostics,
  }: {
    entryLimit: number;
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
  }) {
    if (!Number.isSafeInteger(entryLimit) || entryLimit < 0) {
      throw new Error(
        'HizoFS backing file-snapshot cache limit must be a non-negative safe integer',
      );
    }
    this.entryLimit = entryLimit;
    this.diagnostics = diagnostics;
    this.recordState();
  }

  private readonly entryLimit: number;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private readonly entries = new Map<string, Promise<File>>();

  async get({ path, minimumByteLength }: {
    path: readonly string[];
    minimumByteLength: number;
  }): Promise<File | undefined> {
    const key = path.join('/');
    const pending = this.entries.get(key);
    if (pending === undefined) {
      this.diagnostics?.recordCacheMiss({ cache: 'backing_file_snapshot' });
      return undefined;
    }
    let file: File;
    try {
      file = await pending;
    } catch (error) {
      if (this.entries.get(key) === pending) {
        this.entries.delete(key);
        this.recordState();
      }
      throw error;
    }
    if (file.size < minimumByteLength) {
      if (this.entries.get(key) === pending) {
        this.entries.delete(key);
        this.recordState();
      }
      this.diagnostics?.recordCacheMiss({ cache: 'backing_file_snapshot' });
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, pending);
    this.diagnostics?.recordCacheHit({ cache: 'backing_file_snapshot' });
    return file;
  }

  set({ path, pending }: {
    path: readonly string[];
    pending: Promise<File>;
  }): void {
    const key = path.join('/');
    this.entries.delete(key);
    if (this.entryLimit === 0) return;
    this.entries.set(key, pending);
    while (this.entries.size > this.entryLimit) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
      this.diagnostics?.recordCacheEviction({ cache: 'backing_file_snapshot' });
    }
    this.recordState();
  }

  delete({ path }: { path: readonly string[] }): void {
    if (this.entries.delete(path.join('/'))) this.recordState();
  }

  deleteAtOrBelow({ path }: { path: readonly string[] }): void {
    const removedPath = path.join('/');
    let changed = false;
    for (const key of this.entries.keys()) {
      if (key === removedPath || key.startsWith(`${removedPath}/`)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.recordState();
  }

  private recordState(): void {
    this.diagnostics?.recordCacheState({
      cache: 'backing_file_snapshot',
      byteLength: 0,
      entryCount: this.entries.size,
    });
  }
}

function validatePath({ path }: {
  path: readonly string[];
}): void {
  if (path.length === 0) {
    throw new Error('HizoFS backing-store file path must not be empty');
  }
  for (const segment of path) {
    if (segment.length === 0 || segment === '.' || segment === '..' || segment.includes('/')) {
      throw new Error(`Invalid HizoFS backing-store path segment: ${segment}`);
    }
  }
}

function validateDirectoryPath({ path }: {
  path: readonly string[];
}): void {
  for (const segment of path) {
    if (segment.length === 0 || segment === '.' || segment === '..' || segment.includes('/')) {
      throw new Error(`Invalid HizoFS backing-store path segment: ${segment}`);
    }
  }
}

function isNotFoundError({ error }: {
  error: unknown;
}): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : error instanceof Error
      && (error.name === 'NotFoundError' || error.message.startsWith('NotFoundError'));
}

function toBackingStoreEntry({
  name,
  handle,
}: {
  name: string;
  handle: FileSystemHandle;
}): HizoFSBackingStoreEntry {
  switch (handle.kind) {
  case 'file':
    return { name, kind: 'file' };
  case 'directory':
    return { name, kind: 'directory' };
  default: {
    const _ex: never = handle.kind;
    throw new Error(`Unhandled backing-store entry kind: ${String(_ex)}`);
  }
  }
}


interface HizoFSSyncAccessHandle {
  getSize(): number;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the browser's positional SyncAccessHandle API.
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the browser's positional SyncAccessHandle API.
  write(buffer: BufferSource, options?: { at?: number }): number;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the browser's positional SyncAccessHandle API.
  truncate(newSize: number): void;
  flush(): void;
  close(): void;
}

interface FileHandleWithSyncAccess extends FileHandleWithWritable {
  createSyncAccessHandle?: () => Promise<HizoFSSyncAccessHandle>;
}

function assertSafeNonNegativeInteger({ value, fieldName }: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

class NativeSyncHizoFSRandomAccessFile implements HizoFSRandomAccessFile {
  constructor({ handle, mode, diagnostics }: {
    handle: HizoFSSyncAccessHandle;
    mode: HizoFSRandomAccessFileMode;
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
  }) {
    this.handle = handle;
    this.mode = mode;
    this.diagnostics = diagnostics;
  }

  private readonly handle: HizoFSSyncAccessHandle;
  private readonly mode: HizoFSRandomAccessFileMode;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private closed = false;

  async getSize(): Promise<number> {
    this.assertOpen();
    return this.handle.getSize();
  }

  async readAt({ offset, byteLength }: {
    offset: number;
    byteLength: number;
  }): Promise<Uint8Array> {
    this.assertOpen();
    assertSafeNonNegativeInteger({ value: offset, fieldName: 'HizoFS random-access read offset' });
    assertSafeNonNegativeInteger({ value: byteLength, fieldName: 'HizoFS random-access read length' });
    const operation = () => {
      if (offset + byteLength > this.handle.getSize()) {
        throw new Error('HizoFS random-access read exceeds the physical file size');
      }
      const bytes = new Uint8Array(byteLength);
      let completed = 0;
      while (completed < byteLength) {
        const read = this.handle.read(bytes.subarray(completed), { at: offset + completed });
        if (read <= 0) throw new Error('HizoFS random-access read made no progress');
        completed += read;
      }
      return bytes;
    };
    return this.diagnostics === undefined
      ? operation()
      : this.diagnostics.measureSync({ phase: 'backing_read_at', operation });
  }

  async writeAt({ offset, bytes }: {
    offset: number;
    bytes: Uint8Array;
  }): Promise<void> {
    this.assertWritable();
    assertSafeNonNegativeInteger({ value: offset, fieldName: 'HizoFS random-access write offset' });
    const operation = () => {
      let completed = 0;
      while (completed < bytes.byteLength) {
        const written = this.handle.write(
          toExactArrayBuffer({ bytes: bytes.subarray(completed) }),
          { at: offset + completed },
        );
        if (written <= 0) throw new Error('HizoFS random-access write made no progress');
        completed += written;
      }
    };
    if (this.diagnostics === undefined) operation();
    else this.diagnostics.measureSync({ phase: 'backing_write_at', operation });
  }

  async truncate({ size }: { size: number }): Promise<void> {
    this.assertWritable();
    assertSafeNonNegativeInteger({ value: size, fieldName: 'HizoFS random-access truncate size' });
    const operation = () => this.handle.truncate(size);
    if (this.diagnostics === undefined) operation();
    else this.diagnostics.measureSync({ phase: 'backing_truncate', operation });
  }

  async flush(): Promise<void> {
    this.assertOpen();
    const operation = () => this.handle.flush();
    if (this.diagnostics === undefined) operation();
    else this.diagnostics.measureSync({ phase: 'backing_flush', operation });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const operation = () => this.handle.close();
    if (this.diagnostics === undefined) operation();
    else this.diagnostics.measureSync({ phase: 'backing_close_random_access', operation });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('HizoFS random-access file is closed');
  }

  private assertWritable(): void {
    this.assertOpen();
    switch (this.mode) {
    case 'read_write':
      return;
    case 'read_only':
      throw new Error('HizoFS random-access file is read-only');
    default: {
      const _ex: never = this.mode;
      throw new Error(`Unhandled HizoFS random-access mode: ${String(_ex)}`);
    }
    }
  }
}

class BufferedHizoFSRandomAccessFile implements HizoFSRandomAccessFile {
  constructor({ handle, mode, initialBytes, diagnostics }: {
    handle: FileHandleWithWritable;
    mode: HizoFSRandomAccessFileMode;
    initialBytes: Uint8Array;
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
  }) {
    this.handle = handle;
    this.mode = mode;
    this.bytes = initialBytes;
    this.diagnostics = diagnostics;
  }

  private readonly handle: FileHandleWithWritable;
  private readonly mode: HizoFSRandomAccessFileMode;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private bytes: Uint8Array;
  private dirty = false;
  private closed = false;

  async getSize(): Promise<number> {
    this.assertOpen();
    return this.bytes.byteLength;
  }

  async readAt({ offset, byteLength }: {
    offset: number;
    byteLength: number;
  }): Promise<Uint8Array> {
    this.assertOpen();
    assertSafeNonNegativeInteger({ value: offset, fieldName: 'HizoFS random-access read offset' });
    assertSafeNonNegativeInteger({ value: byteLength, fieldName: 'HizoFS random-access read length' });
    const operation = () => {
      if (offset + byteLength > this.bytes.byteLength) {
        throw new Error('HizoFS random-access read exceeds the physical file size');
      }
      return this.bytes.slice(offset, offset + byteLength);
    };
    return this.diagnostics === undefined
      ? operation()
      : this.diagnostics.measureSync({ phase: 'backing_read_at', operation });
  }

  async writeAt({ offset, bytes }: {
    offset: number;
    bytes: Uint8Array;
  }): Promise<void> {
    this.assertWritable();
    assertSafeNonNegativeInteger({ value: offset, fieldName: 'HizoFS random-access write offset' });
    const operation = () => {
      const requiredLength = offset + bytes.byteLength;
      if (!Number.isSafeInteger(requiredLength)) {
        throw new Error('HizoFS random-access write exceeds the safe integer range');
      }
      if (requiredLength > this.bytes.byteLength) {
        const expanded = new Uint8Array(requiredLength);
        expanded.set(this.bytes);
        this.bytes.fill(0);
        this.bytes = expanded;
      }
      this.bytes.set(bytes, offset);
      this.dirty = true;
    };
    if (this.diagnostics === undefined) operation();
    else this.diagnostics.measureSync({ phase: 'backing_write_at', operation });
  }

  async truncate({ size }: { size: number }): Promise<void> {
    this.assertWritable();
    assertSafeNonNegativeInteger({ value: size, fieldName: 'HizoFS random-access truncate size' });
    const operation = () => {
      if (size === this.bytes.byteLength) return;
      const next = new Uint8Array(size);
      next.set(this.bytes.subarray(0, Math.min(size, this.bytes.byteLength)));
      this.bytes.fill(0);
      this.bytes = next;
      this.dirty = true;
    };
    if (this.diagnostics === undefined) operation();
    else this.diagnostics.measureSync({ phase: 'backing_truncate', operation });
  }

  async flush(): Promise<void> {
    this.assertOpen();
    if (!this.dirty) return;
    const operation = async () => {
      const writable = await this.handle.createWritable({ keepExistingData: false });
      try {
        await writable.write(toExactArrayBuffer({ bytes: this.bytes }));
        await writable.close();
      } catch (error) {
        try {
          await writable.abort(error);
        } catch {
          // Preserve the original flush error.
        }
        throw error;
      }
      this.dirty = false;
    };
    if (this.diagnostics === undefined) await operation();
    else await this.diagnostics.measureAsync({ phase: 'backing_flush', operation });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.bytes.fill(0);
    this.bytes = new Uint8Array();
    this.diagnostics?.measureSync({
      phase: 'backing_close_random_access',
      operation: () => undefined,
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('HizoFS random-access file is closed');
  }

  private assertWritable(): void {
    this.assertOpen();
    switch (this.mode) {
    case 'read_write':
      return;
    case 'read_only':
      throw new Error('HizoFS random-access file is read-only');
    default: {
      const _ex: never = this.mode;
      throw new Error(`Unhandled HizoFS random-access mode: ${String(_ex)}`);
    }
    }
  }
}

export class NativeOpfsHizoFSBackingStore implements HizoFSBackingStore {
  constructor({
    root,
    fileHandleCacheEntryLimit,
    fileSnapshotCacheEntryLimit,
    diagnostics,
  }: {
    root: FileSystemDirectoryHandle;
    fileHandleCacheEntryLimit: number;
    fileSnapshotCacheEntryLimit: number;
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
  }) {
    this.root = root;
    this.diagnostics = diagnostics;
    this.fileHandleCache = new HizoFSFileHandleLruCache({
      entryLimit: fileHandleCacheEntryLimit,
      diagnostics,
    });
    this.fileSnapshotCache = new HizoFSFileSnapshotLruCache({
      entryLimit: fileSnapshotCacheEntryLimit,
      diagnostics,
    });
    this.directoryHandlePromises.set('', Promise.resolve(root));
  }

  private readonly root: FileSystemDirectoryHandle;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;

  getCoordinationIdentity(): object {
    return this.root;
  }
  private readonly directoryHandlePromises = new Map<string, Promise<FileSystemDirectoryHandle>>();
  private readonly fileHandleCache: HizoFSFileHandleLruCache;
  private readonly fileSnapshotCache: HizoFSFileSnapshotLruCache;

  async read({ path }: {
    path: readonly string[];
  }): Promise<Uint8Array | undefined> {
    validatePath({ path });
    if (this.diagnostics === undefined) {
      return this.readWithoutDiagnostics({ path });
    }
    try {
      const { directory, name } = await this.diagnostics.measureAsync({
        phase: 'backing_resolve_parent',
        operation: async () => this.resolveParent({ path, create: false }),
      });
      const handle = await this.diagnostics.measureAsync({
        phase: 'backing_get_file_handle',
        operation: async () => this.resolveFileHandle({
          directory,
          parentPath: path.slice(0, -1),
          name,
          create: false,
        }),
      });
      const file = await this.diagnostics.measureAsync({
        phase: 'backing_get_file',
        operation: async () => handle.getFile(),
      });
      const buffer = await this.diagnostics.measureAsync({
        phase: 'backing_array_buffer',
        operation: async () => file.arrayBuffer(),
      });
      return new Uint8Array(buffer);
    } catch (error) {
      if (isNotFoundError({ error })) {
        this.fileHandleCache.delete({ path });
        return undefined;
      }
      throw error;
    }
  }

  async write({ path, bytes }: {
    path: readonly string[];
    bytes: Uint8Array;
  }): Promise<void> {
    validatePath({ path });
    this.fileSnapshotCache.delete({ path });
    if (this.diagnostics === undefined) {
      await this.writeWithoutDiagnostics({ path, bytes });
      return;
    }
    const { directory, name } = await this.diagnostics.measureAsync({
      phase: 'backing_resolve_parent',
      operation: async () => this.resolveParent({ path, create: true }),
    });
    const handle = await this.diagnostics.measureAsync({
      phase: 'backing_get_file_handle',
      operation: async () => this.resolveFileHandle({
        directory,
        parentPath: path.slice(0, -1),
        name,
        create: true,
      }),
    }) as FileHandleWithWritable;
    const writable = await this.diagnostics.measureAsync({
      phase: 'backing_create_writable',
      operation: async () => handle.createWritable({ keepExistingData: false }),
    });
    try {
      await this.diagnostics.measureAsync({
        phase: 'backing_write',
        operation: async () => writable.write(toExactArrayBuffer({ bytes })),
      });
      await this.diagnostics.measureAsync({
        phase: 'backing_close',
        operation: async () => writable.close(),
      });
    } catch (error) {
      try {
        await writable.abort(error);
      } catch {
        // Preserve the original write error.
      }

      try {
        const persisted = await this.diagnostics.measureAsync({
          phase: 'backing_failure_verification',
          operation: async () => new Uint8Array(await (await handle.getFile()).arrayBuffer()),
        });
        if (bytesEqual({ left: persisted, right: bytes })) {
          // A failed close may still have durably committed the complete replacement.
          return;
        }
      } catch {
        // Preserve the original error when exact durable completion cannot be proven.
      }
      this.fileHandleCache.delete({ path });
      throw error;
    }
  }

  async remove({ path, recursive }: {
    path: readonly string[];
    recursive: boolean;
  }): Promise<void> {
    validatePath({ path });
    if (this.diagnostics === undefined) {
      await this.removeWithoutDiagnostics({ path, recursive });
      return;
    }
    try {
      const { directory, name } = await this.diagnostics.measureAsync({
        phase: 'backing_resolve_parent',
        operation: async () => this.resolveParent({ path, create: false }),
      });
      await this.diagnostics.measureAsync({
        phase: 'backing_remove',
        operation: async () => directory.removeEntry(name, { recursive }),
      });
      this.invalidateAfterRemoval({ path });
    } catch (error) {
      if (!isNotFoundError({ error })) throw error;
      this.invalidateAfterRemoval({ path });
    }
  }

  async *list({ path }: {
    path: readonly string[];
  }): AsyncIterable<HizoFSBackingStoreEntry> {
    validateDirectoryPath({ path });
    if (this.diagnostics === undefined) {
      const directory = await this.resolveDirectory({ path, create: false });
      for await (const [name, handle] of directory.entries()) {
        yield toBackingStoreEntry({ name, handle });
      }
      return;
    }

    const directory = await this.diagnostics.measureAsync({
      phase: 'backing_resolve_parent',
      operation: async () => this.resolveDirectory({ path, create: false }),
    });
    const iterator = directory.entries()[Symbol.asyncIterator]();
    while (true) {
      const next = await this.diagnostics.measureAsync({
        phase: 'backing_list',
        operation: async () => iterator.next(),
      });
      if (next.done === true) return;
      const [name, handle] = next.value;
      yield toBackingStoreEntry({ name, handle });
    }
  }


  async openRandomAccessFile({ path, mode, create }: {
    path: readonly string[];
    mode: HizoFSRandomAccessFileMode;
    create: boolean;
  }): Promise<HizoFSRandomAccessFile> {
    validatePath({ path });
    switch (mode) {
    case 'read_write':
      this.fileSnapshotCache.delete({ path });
      break;
    case 'read_only':
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled HizoFS random-access mode: ${String(_ex)}`);
    }
    }
    const operation = async (): Promise<HizoFSRandomAccessFile> => {
      const { directory, name } = await this.resolveParent({ path, create });
      const handle = await this.resolveFileHandle({
        directory,
        parentPath: path.slice(0, -1),
        name,
        create,
      }) as FileHandleWithSyncAccess;
      if (handle.createSyncAccessHandle !== undefined) {
        const syncHandle = await handle.createSyncAccessHandle();
        return new NativeSyncHizoFSRandomAccessFile({
          handle: syncHandle,
          mode,
          diagnostics: this.diagnostics,
        });
      }
      const initialBytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      return new BufferedHizoFSRandomAccessFile({
        handle,
        mode,
        initialBytes,
        diagnostics: this.diagnostics,
      });
    };
    return this.diagnostics === undefined
      ? await operation()
      : await this.diagnostics.measureAsync({
        phase: 'backing_open_random_access',
        operation,
      });
  }

  async getFileSize({ path }: {
    path: readonly string[];
  }): Promise<number | undefined> {
    validatePath({ path });
    try {
      const operation = async () => {
        const { directory, name } = await this.resolveParent({ path, create: false });
        const handle = await this.resolveFileHandle({
          directory,
          parentPath: path.slice(0, -1),
          name,
          create: false,
        });
        return (await handle.getFile()).size;
      };
      return this.diagnostics === undefined
        ? await operation()
        : await this.diagnostics.measureAsync({ phase: 'backing_get_file', operation });
    } catch (error) {
      if (isNotFoundError({ error })) {
        this.fileHandleCache.delete({ path });
        return undefined;
      }
      throw error;
    }
  }

  async readRange({ path, offset, byteLength }: {
    path: readonly string[];
    offset: number;
    byteLength: number;
  }): Promise<Uint8Array | undefined> {
    validatePath({ path });
    assertSafeNonNegativeInteger({ value: offset, fieldName: 'HizoFS range-read offset' });
    assertSafeNonNegativeInteger({ value: byteLength, fieldName: 'HizoFS range-read length' });
    try {
      const operation = async () => {
        const requestedEnd = offset + byteLength;
        if (!Number.isSafeInteger(requestedEnd)) {
          throw new Error('HizoFS range read exceeds the safe integer range');
        }
        const cached = await this.fileSnapshotCache.get({
          path,
          minimumByteLength: requestedEnd,
        });
        if (cached !== undefined) {
          return new Uint8Array(await cached.slice(offset, requestedEnd).arrayBuffer());
        }
        const { directory, name } = await this.resolveParent({ path, create: false });
        const handle = await this.resolveFileHandle({
          directory,
          parentPath: path.slice(0, -1),
          name,
          create: false,
        });
        const pendingFile = handle.getFile();
        this.fileSnapshotCache.set({ path, pending: pendingFile });
        const file = await pendingFile;
        if (requestedEnd > file.size) {
          throw new Error('HizoFS range read exceeds the physical file size');
        }
        return new Uint8Array(await file.slice(offset, requestedEnd).arrayBuffer());
      };
      return this.diagnostics === undefined
        ? await operation()
        : await this.diagnostics.measureAsync({
          phase: 'backing_read_at',
          operation,
        });
    } catch (error) {
      if (isNotFoundError({ error })) {
        this.fileHandleCache.delete({ path });
        return undefined;
      }
      throw error;
    }
  }

  private async readWithoutDiagnostics({
    path,
  }: {
    path: readonly string[];
  }): Promise<Uint8Array | undefined> {
    try {
      const { directory, name } = await this.resolveParent({ path, create: false });
      const handle = await this.resolveFileHandle({
        directory,
        parentPath: path.slice(0, -1),
        name,
        create: false,
      });
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (error) {
      if (isNotFoundError({ error })) {
        this.fileHandleCache.delete({ path });
        return undefined;
      }
      throw error;
    }
  }

  private async writeWithoutDiagnostics({
    path,
    bytes,
  }: {
    path: readonly string[];
    bytes: Uint8Array;
  }): Promise<void> {
    const { directory, name } = await this.resolveParent({ path, create: true });
    const handle = await this.resolveFileHandle({
      directory,
      parentPath: path.slice(0, -1),
      name,
      create: true,
    }) as FileHandleWithWritable;
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      await writable.write(toExactArrayBuffer({ bytes }));
      await writable.close();
    } catch (error) {
      try {
        await writable.abort(error);
      } catch {
        // Preserve the original write error.
      }
      try {
        const persisted = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        if (bytesEqual({ left: persisted, right: bytes })) return;
      } catch {
        // Preserve the original error when exact durable completion cannot be proven.
      }
      this.fileHandleCache.delete({ path });
      throw error;
    }
  }

  private async removeWithoutDiagnostics({
    path,
    recursive,
  }: {
    path: readonly string[];
    recursive: boolean;
  }): Promise<void> {
    try {
      const { directory, name } = await this.resolveParent({ path, create: false });
      await directory.removeEntry(name, { recursive });
      this.invalidateAfterRemoval({ path });
    } catch (error) {
      if (!isNotFoundError({ error })) throw error;
      this.invalidateAfterRemoval({ path });
    }
  }

  private async resolveParent({ path, create }: {
    path: readonly string[];
    create: boolean;
  }): Promise<{
    readonly directory: FileSystemDirectoryHandle;
    readonly name: string;
  }> {
    const name = path.at(-1);
    if (name === undefined) {
      throw new Error('HizoFS backing-store file path must not be empty');
    }

    const directory = await this.resolveDirectory({
      path: path.slice(0, -1),
      create,
    });
    return { directory, name };
  }

  private async resolveDirectory({ path, create }: {
    path: readonly string[];
    create: boolean;
  }): Promise<FileSystemDirectoryHandle> {
    let parent = this.root;
    const resolvedSegments: string[] = [];
    for (const segment of path) {
      resolvedSegments.push(segment);
      const cacheKey = resolvedSegments.join('/');
      const cached = this.directoryHandlePromises.get(cacheKey);
      if (cached !== undefined) {
        try {
          parent = await cached;
          continue;
        } catch (error) {
          if (!create || !isNotFoundError({ error })) throw error;
          if (this.directoryHandlePromises.get(cacheKey) === cached) {
            this.directoryHandlePromises.delete(cacheKey);
          }
        }
      }

      const pending = parent.getDirectoryHandle(segment, { create });
      this.directoryHandlePromises.set(cacheKey, pending);
      try {
        parent = await pending;
      } catch (error) {
        if (this.directoryHandlePromises.get(cacheKey) === pending) {
          this.directoryHandlePromises.delete(cacheKey);
        }
        throw error;
      }
    }
    return parent;
  }

  private async resolveFileHandle({ directory, parentPath, name, create }: {
    directory: FileSystemDirectoryHandle;
    parentPath: readonly string[];
    name: string;
    create: boolean;
  }): Promise<FileSystemFileHandle> {
    const path = [...parentPath, name];
    const cached = this.fileHandleCache.get({ path });
    if (cached !== undefined) {
      try {
        return await cached;
      } catch (error) {
        this.fileHandleCache.delete({ path });
        if (!create || !isNotFoundError({ error })) throw error;
      }
    }
    const pending = directory.getFileHandle(name, { create });
    this.fileHandleCache.set({ path, pending });
    try {
      return await pending;
    } catch (error) {
      this.fileHandleCache.delete({ path });
      throw error;
    }
  }

  private invalidateAfterRemoval({
    path,
  }: {
    path: readonly string[];
  }): void {
    this.fileHandleCache.deleteAtOrBelow({ path });
    this.fileSnapshotCache.deleteAtOrBelow({ path });
    this.invalidateDirectoryHandlesAtOrBelow({ path });
  }

  private invalidateDirectoryHandlesAtOrBelow({ path }: {
    path: readonly string[];
  }): void {
    const removedPath = path.join('/');
    for (const key of this.directoryHandlePromises.keys()) {
      if (key === removedPath || key.startsWith(`${removedPath}/`)) {
        this.directoryHandlePromises.delete(key);
      }
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
