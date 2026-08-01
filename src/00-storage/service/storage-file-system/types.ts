import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';

export type StorageFileSystemEntryKind =
  | 'file'
  | 'directory'
  | 'symlink';

export type StorageFileSystemCapabilities = {
  readonly directBlob: 'supported' | 'unsupported';
  readonly symbolicLink: 'supported' | 'unsupported';
  readonly atomicMove: 'supported' | 'unsupported';
  readonly wholeFileClone: 'supported' | 'unsupported';
};


export type StorageDirectoryWorkerMountAccessMode = "read" | "read_write";

export type StorageDirectoryWorkerMountGrant = Readonly<{
  accessMode: StorageDirectoryWorkerMountAccessMode;
  grantId: string;
  implementation: "hizofs";
  opaquePayload: unknown;
  type: "storage_directory_worker_mount_grant";
  version: 1;
}>;

export type StorageDirectoryWorkerMountOpener = ({ grant }: {
  grant: StorageDirectoryWorkerMountGrant;
}) => Promise<StorageFileSystemSession>;

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

  /**
   * Creates a new file whose initial bytes are a snapshot of one direct child.
   * Implementations may share immutable physical storage while preserving
   * independent file identity and copy-on-write behavior after the operation.
   */
  cloneFile({ name, destination, newName, replace }: {
    name: string;
    destination: StorageDirectoryHandle;
    newName: string;
    replace: boolean;
  }): Promise<StorageFileHandle>;

  /**
   * Issues a structured-cloneable, scope-bound grant for this exact directory.
   * The generic storage layer transports but never interprets implementation
   * payloads. Implementations that cannot reopen inside a Worker leave it
   * undefined.
   */
  createWorkerMountGrant?({ accessMode }: {
    accessMode: StorageDirectoryWorkerMountAccessMode;
  }): Promise<StorageDirectoryWorkerMountGrant>;
}

export interface StorageFileSystemSession {
  readonly root: StorageDirectoryHandle;
  readonly capabilities: StorageFileSystemCapabilities;

  /**
   * Opens a stable read-only generation when the implementation supports
   * immutable snapshots. Transition copy and verification can then traverse
   * one generation without re-reading mutable filesystem control state for
   * every file.
   */
  createReadSnapshot?(): Promise<StorageFileSystemSession>;

  close(): Promise<void>;
}



// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
