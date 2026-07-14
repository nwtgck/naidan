import {
  createBlobStorageBinaryObjectReadHandle,
  type StorageBinaryObjectReadHandle,
} from '@/00-storage/service/binary-object-io';
import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
  StorageFileHandle,
  StorageFileStat,
  StorageFileSystemSession,
  StorageWritableFile,
} from './types';

interface NativeFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream>;
}

type NativeWritableCompatibility = Partial<Pick<
  FileSystemWritableFileStream,
  'seek' | 'truncate' | 'abort'
>>;

interface NativeDirectoryCompatibility {
  entries?: () => AsyncIterable<readonly [string, FileSystemHandle]>;
  values?: () => AsyncIterable<FileSystemHandle>;
}

function assertNonNegativeSafeInteger({ value, fieldName }: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

class NativeStorageWritableFile implements StorageWritableFile {
  constructor({ writable }: {
    writable: FileSystemWritableFileStream;
  }) {
    this.writable = writable;
  }

  private readonly writable: FileSystemWritableFileStream;
  private position = 0;
  private settled = false;

  async write({ position, data }: {
    position: number;
    data: Uint8Array;
  }): Promise<void> {
    this.assertOpen();
    assertNonNegativeSafeInteger({ value: position, fieldName: 'Write position' });
    if (position !== this.position) {
      const seek = (this.writable as NativeWritableCompatibility).seek;
      if (seek === undefined) {
        throw new Error('Native OPFS writable does not support random writes');
      }
      await seek.call(this.writable, position);
      this.position = position;
    }
    const writeBuffer = data.buffer instanceof ArrayBuffer
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : Uint8Array.from(data).buffer;
    await this.writable.write(writeBuffer);
    this.position += data.byteLength;
  }

  async truncate({ size }: {
    size: number;
  }): Promise<void> {
    this.assertOpen();
    assertNonNegativeSafeInteger({ value: size, fieldName: 'Truncate size' });
    const truncate = (this.writable as NativeWritableCompatibility).truncate;
    if (truncate === undefined) {
      throw new Error('Native OPFS writable does not support truncate');
    }
    await truncate.call(this.writable, size);
    this.position = Math.min(this.position, size);
  }

  async close(): Promise<void> {
    this.assertOpen();
    this.settled = true;
    await this.writable.close();
  }

  async abort({ reason }: {
    reason: unknown;
  }): Promise<void> {
    if (this.settled) {
      return;
    }
    this.settled = true;
    const abort = (this.writable as NativeWritableCompatibility).abort;
    if (abort !== undefined) {
      await abort.call(this.writable, reason);
    }
  }

  private assertOpen(): void {
    if (this.settled) {
      throw new Error('Storage writable file is already closed or aborted');
    }
  }
}

class NativeStorageFileHandle implements StorageFileHandle {
  readonly kind = 'file' as const;

  constructor({ handle }: {
    handle: FileSystemFileHandle;
  }) {
    this.handle = handle;
    this.name = handle.name;
  }

  readonly name: string;
  private readonly handle: FileSystemFileHandle;

  async stat(): Promise<StorageFileStat> {
    const file = await this.handle.getFile();
    return {
      size: file.size,
      createdAt: undefined,
      modifiedAt: file.lastModified,
    };
  }

  async openReadable({ mimeType }: {
    mimeType: string;
  }): Promise<StorageBinaryObjectReadHandle> {
    const file = await this.handle.getFile();
    return createBlobStorageBinaryObjectReadHandle({
      blob: file,
      mimeType: file.type || mimeType,
    });
  }

  async createWritable({ keepExistingData }: {
    keepExistingData: boolean;
  }): Promise<StorageWritableFile> {
    const writable = await (this.handle as NativeFileHandleWithWritable).createWritable({
      keepExistingData,
    });
    return new NativeStorageWritableFile({ writable });
  }
}

class NativeStorageDirectoryHandle implements StorageDirectoryHandle {
  readonly kind = 'directory' as const;

  constructor({ handle }: {
    handle: FileSystemDirectoryHandle;
  }) {
    this.handle = handle;
    this.name = handle.name;
  }

  readonly name: string;
  readonly handle: FileSystemDirectoryHandle;

  async stat(): Promise<StorageFileStat> {
    return {
      size: 0,
      createdAt: undefined,
      modifiedAt: undefined,
    };
  }

  async getFileHandle({ name, create }: {
    name: string;
    create: boolean;
  }): Promise<StorageFileHandle> {
    return new NativeStorageFileHandle({
      handle: await this.handle.getFileHandle(name, { create }),
    });
  }

  async getDirectoryHandle({ name, create }: {
    name: string;
    create: boolean;
  }): Promise<StorageDirectoryHandle> {
    return new NativeStorageDirectoryHandle({
      handle: await this.handle.getDirectoryHandle(name, { create }),
    });
  }

  async getEntryHandle({ name }: {
    name: string;
  }): Promise<StorageEntryHandle> {
    for await (const [entryName, handle] of this.entries()) {
      if (entryName === name) {
        return handle;
      }
    }
    const error = new Error(`NotFoundError: Entry '${name}' was not found`);
    error.name = 'NotFoundError';
    throw error;
  }

  async *entries(): AsyncIterable<readonly [string, StorageEntryHandle]> {
    const compatible = this.handle as FileSystemDirectoryHandle & NativeDirectoryCompatibility;
    const entries: unknown = compatible.entries;
    if (typeof entries === 'function') {
      const entriesFunction = entries as NonNullable<NativeDirectoryCompatibility['entries']>;
      for await (const [name, handle] of entriesFunction.call(this.handle)) {
        yield [name, wrapNativeEntry({ handle })];
      }
      return;
    }
    if (entries instanceof Map) {
      for (const [name, handle] of entries as Map<string, FileSystemHandle>) {
        yield [name, wrapNativeEntry({ handle })];
      }
      return;
    }

    const values = compatible.values;
    if (typeof values !== 'function') {
      throw new Error('Native OPFS directory does not support enumeration');
    }
    for await (const handle of values.call(this.handle)) {
      yield [handle.name, wrapNativeEntry({ handle })];
    }
  }

  async removeEntry({ name, recursive }: {
    name: string;
    recursive: boolean;
  }): Promise<void> {
    await this.handle.removeEntry(name, { recursive });
  }

  async createSymlink({ name: _name, target: _target }: {
    name: string;
    target: string;
  }): Promise<never> {
    throw new Error('Native OPFS does not support symbolic links');
  }

  async moveEntry({
    name: _name,
    destination: _destination,
    newName: _newName,
    replace: _replace,
  }: {
    name: string;
    destination: StorageDirectoryHandle;
    newName: string;
    replace: boolean;
  }): Promise<void> {
    throw new Error('The native OPFS adapter does not provide an atomic move operation');
  }

  async cloneFile({
    name: _name,
    destination: _destination,
    newName: _newName,
    replace: _replace,
  }: {
    name: string;
    destination: StorageDirectoryHandle;
    newName: string;
    replace: boolean;
  }): Promise<StorageFileHandle> {
    throw new Error('The native OPFS adapter does not provide a whole-file clone operation');
  }
}

function wrapNativeEntry({ handle }: {
  handle: FileSystemHandle;
}): StorageEntryHandle {
  switch (handle.kind) {
  case 'file':
    return new NativeStorageFileHandle({ handle: handle as FileSystemFileHandle });
  case 'directory':
    return new NativeStorageDirectoryHandle({ handle: handle as FileSystemDirectoryHandle });
  default: {
    const _ex: never = handle.kind;
    throw new Error(`Unhandled native OPFS entry: ${String(_ex)}`);
  }
  }
}

export function createNativeOpfsFileSystemSession({ root }: {
  root: FileSystemDirectoryHandle;
}): StorageFileSystemSession {
  return {
    root: new NativeStorageDirectoryHandle({ handle: root }),
    capabilities: {
      directBlob: 'supported',
      symbolicLink: 'unsupported',
      atomicMove: 'unsupported',
      wholeFileClone: 'unsupported',
    },
    async close() {},
  };
}

export function unwrapNativeOpfsDirectoryHandle({ handle }: {
  handle: StorageDirectoryHandle;
}): FileSystemDirectoryHandle | undefined {
  return handle instanceof NativeStorageDirectoryHandle
    ? handle.handle
    : undefined;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
