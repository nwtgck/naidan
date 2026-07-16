import { bytesEqual, toExactArrayBuffer } from '@/00-storage/service/hizofs/bytes';
import type {
  HizoFSBackingStore,
  HizoFSBackingStoreEntry,
} from './backing-store';

interface FileHandleWithWritable extends FileSystemFileHandle {
  createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream>;
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

export class NativeOpfsHizoFSBackingStore implements HizoFSBackingStore {
  constructor({ root }: {
    root: FileSystemDirectoryHandle;
  }) {
    this.root = root;
    this.directoryHandlePromises.set('', Promise.resolve(root));
  }

  private readonly root: FileSystemDirectoryHandle;
  private readonly directoryHandlePromises = new Map<string, Promise<FileSystemDirectoryHandle>>();
  private readonly rootFileHandlePromises = new Map<string, Promise<FileSystemFileHandle>>();

  async read({ path }: {
    path: readonly string[];
  }): Promise<Uint8Array | undefined> {
    validatePath({ path });
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
        if (bytesEqual({ left: persisted, right: bytes })) {
          // A failed close may still have durably committed the complete replacement.
          return;
        }
      } catch {
        // Preserve the original error when exact durable completion cannot be proven.
      }
      throw error;
    }
  }

  async remove({ path, recursive }: {
    path: readonly string[];
    recursive: boolean;
  }): Promise<void> {
    validatePath({ path });
    try {
      const { directory, name } = await this.resolveParent({ path, create: false });
      await directory.removeEntry(name, { recursive });
      this.invalidateRootFileHandle({ path });
      this.invalidateDirectoryHandlesAtOrBelow({ path });
    } catch (error) {
      if (!isNotFoundError({ error })) {
        throw error;
      }
      this.invalidateRootFileHandle({ path });
      this.invalidateDirectoryHandlesAtOrBelow({ path });
    }
  }

  async *list({ path }: {
    path: readonly string[];
  }): AsyncIterable<HizoFSBackingStoreEntry> {
    validateDirectoryPath({ path });
    const directory = await this.resolveDirectory({ path, create: false });

    for await (const [name, handle] of directory.entries()) {
      switch (handle.kind) {
      case 'file':
        yield { name, kind: 'file' };
        break;
      case 'directory':
        yield { name, kind: 'directory' };
        break;
      default: {
        const _ex: never = handle;
        throw new Error(`Unhandled backing-store entry kind: ${String(_ex)}`);
      }
      }
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
    if (parentPath.length !== 0) {
      return directory.getFileHandle(name, { create });
    }
    const cached = this.rootFileHandlePromises.get(name);
    if (cached !== undefined) {
      try {
        return await cached;
      } catch (error) {
        if (!create || !isNotFoundError({ error })) throw error;
        if (this.rootFileHandlePromises.get(name) === cached) {
          this.rootFileHandlePromises.delete(name);
        }
      }
    }
    const pending = directory.getFileHandle(name, { create });
    this.rootFileHandlePromises.set(name, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.rootFileHandlePromises.get(name) === pending) {
        this.rootFileHandlePromises.delete(name);
      }
      throw error;
    }
  }

  private invalidateRootFileHandle({ path }: {
    path: readonly string[];
  }): void {
    if (path.length === 1) this.rootFileHandlePromises.delete(path[0]!);
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
