import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';

export type StorageFileSystemEntryKind =
  | 'file'
  | 'directory'
  | 'symlink';

export type StorageFileSystemCapabilities = {
  readonly directBlob: 'supported' | 'unsupported';
  readonly symbolicLink: 'supported' | 'unsupported';
  readonly atomicMove: 'supported' | 'unsupported';
};

export type StorageFileStat = {
  readonly size: number;
  readonly createdAt: number | undefined;
  readonly modifiedAt: number | undefined;
};

export interface StorageWritableFile {
  write({ position, data }: {
    position: number;
    data: Uint8Array;
  }): Promise<void>;

  truncate({ size }: {
    size: number;
  }): Promise<void>;

  close(): Promise<void>;

  abort({ reason }: {
    reason: unknown;
  }): Promise<void>;
}

export interface StorageFileHandle {
  readonly kind: 'file';
  readonly name: string;

  stat(): Promise<StorageFileStat>;

  openReadable({ mimeType }: {
    mimeType: string;
  }): Promise<StorageBinaryObjectReadHandle>;

  createWritable({ keepExistingData }: {
    keepExistingData: boolean;
  }): Promise<StorageWritableFile>;
}

export interface StorageSymlinkHandle {
  readonly kind: 'symlink';
  readonly name: string;

  stat(): Promise<StorageFileStat>;

  readTarget(): Promise<string>;
}

export type StorageEntryHandle =
  | StorageFileHandle
  | StorageDirectoryHandle
  | StorageSymlinkHandle;

export interface StorageDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;

  stat(): Promise<StorageFileStat>;

  getFileHandle({ name, create }: {
    name: string;
    create: boolean;
  }): Promise<StorageFileHandle>;

  getDirectoryHandle({ name, create }: {
    name: string;
    create: boolean;
  }): Promise<StorageDirectoryHandle>;

  /**
   * Resolves one direct child without requiring callers to enumerate the whole
   * directory. Implementations may fall back to enumeration when the backing
   * filesystem does not expose a generic child lookup operation.
   */
  getEntryHandle({ name }: {
    name: string;
  }): Promise<StorageEntryHandle>;

  entries(): AsyncIterable<readonly [name: string, handle: StorageEntryHandle]>;

  removeEntry({ name, recursive }: {
    name: string;
    recursive: boolean;
  }): Promise<void>;

  createSymlink({ name, target }: {
    name: string;
    target: string;
  }): Promise<StorageSymlinkHandle>;

  moveEntry({ name, destination, newName, replace }: {
    name: string;
    destination: StorageDirectoryHandle;
    newName: string;
    replace: boolean;
  }): Promise<void>;
}

export interface StorageFileSystemSession {
  readonly root: StorageDirectoryHandle;
  readonly capabilities: StorageFileSystemCapabilities;

  close(): Promise<void>;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
