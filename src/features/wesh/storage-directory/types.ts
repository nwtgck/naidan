import type {
  WeshDirEntry,
  WeshOpenFlags,
  WeshStat,
} from '@/features/wesh/types';

export interface WeshStorageDirectoryOpenResult {
  readonly handleId: string;
}

export interface WeshStorageDirectoryReadResult {
  readonly buffer: ArrayBuffer;
  readonly bytesRead: number;
}

export interface WeshStorageDirectoryWriteResult {
  readonly bytesWritten: number;
}

/**
 * Path-based, structured-clone-safe access to StorageDirectoryHandle mounts.
 *
 * The actual handles and all cryptographic state stay in the storage-owning
 * realm. Wesh workers receive only this proxied capability and mount paths.
 */
export interface WeshStorageDirectoryRemote {
  stat({ mountPath, path, followFinalSymlink }: {
    mountPath: string;
    path: string;
    followFinalSymlink: boolean;
  }): Promise<WeshStat>;

  readDir({ mountPath, path }: {
    mountPath: string;
    path: string;
  }): Promise<readonly WeshDirEntry[]>;

  readlink({ mountPath, path }: {
    mountPath: string;
    path: string;
  }): Promise<string>;

  open({ mountPath, path, flags }: {
    mountPath: string;
    path: string;
    flags: WeshOpenFlags;
  }): Promise<WeshStorageDirectoryOpenResult>;

  read({ handleId, length, position }: {
    handleId: string;
    length: number;
    position: number | undefined;
  }): Promise<WeshStorageDirectoryReadResult>;

  write({ handleId, buffer, position }: {
    handleId: string;
    buffer: ArrayBuffer;
    position: number | undefined;
  }): Promise<WeshStorageDirectoryWriteResult>;

  statHandle({ handleId }: {
    handleId: string;
  }): Promise<WeshStat>;

  truncate({ handleId, size }: {
    handleId: string;
    size: number;
  }): Promise<void>;

  close({ handleId }: {
    handleId: string;
  }): Promise<void>;

  mkdir({ mountPath, path, recursive }: {
    mountPath: string;
    path: string;
    recursive: boolean;
  }): Promise<void>;

  symlink({ mountPath, path, targetPath }: {
    mountPath: string;
    path: string;
    targetPath: string;
  }): Promise<void>;

  unlink({ mountPath, path }: {
    mountPath: string;
    path: string;
  }): Promise<void>;

  rmdir({ mountPath, path }: {
    mountPath: string;
    path: string;
  }): Promise<void>;

  rename({ mountPath, oldPath, newPath }: {
    mountPath: string;
    oldPath: string;
    newPath: string;
  }): Promise<void>;

  dispose(): Promise<void>;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
