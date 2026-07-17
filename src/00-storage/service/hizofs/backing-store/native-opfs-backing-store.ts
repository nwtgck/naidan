import { bytesEqual, toExactArrayBuffer } from '@/00-storage/service/hizofs/bytes';
import type { HizoFSRuntimeDiagnostics } from '@/00-storage/service/hizofs/file-system/diagnostics';
import type {
  HizoFSBackingStore,
  HizoFSBackingStoreEntry,
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

export class NativeOpfsHizoFSBackingStore implements HizoFSBackingStore {
  constructor({
    root,
    fileHandleCacheEntryLimit,
    diagnostics,
  }: {
    root: FileSystemDirectoryHandle;
    fileHandleCacheEntryLimit: number;
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
  }) {
    this.root = root;
    this.diagnostics = diagnostics;
    this.fileHandleCache = new HizoFSFileHandleLruCache({
      entryLimit: fileHandleCacheEntryLimit,
      diagnostics,
    });
    this.directoryHandlePromises.set('', Promise.resolve(root));
  }

  private readonly root: FileSystemDirectoryHandle;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private readonly directoryHandlePromises = new Map<string, Promise<FileSystemDirectoryHandle>>();
  private readonly fileHandleCache: HizoFSFileHandleLruCache;

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
