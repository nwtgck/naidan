export type HizoFSBackingStoreEntry = {
  readonly name: string;
  readonly kind: 'file' | 'directory';
};

export type HizoFSRandomAccessFileMode = 'read_only' | 'read_write';

/**
 * A bounded random-access file used by the segmented HizoFS physical layer.
 * Implementations may use a Worker-only sync access handle or an async buffered
 * fallback, but callers observe the same explicit flush boundary.
 */
export interface HizoFSRandomAccessFile {
  getSize(): Promise<number>;

  readAt({ offset, byteLength }: {
    offset: number;
    byteLength: number;
  }): Promise<Uint8Array>;

  writeAt({ offset, bytes }: {
    offset: number;
    bytes: Uint8Array;
  }): Promise<void>;

  truncate({ size }: {
    size: number;
  }): Promise<void>;

  flush(): Promise<void>;

  close(): Promise<void>;
}

export interface HizoFSBackingStore {
  read({ path }: {
    path: readonly string[];
  }): Promise<Uint8Array | undefined>;

  write({ path, bytes }: {
    path: readonly string[];
    bytes: Uint8Array;
  }): Promise<void>;

  remove({ path, recursive }: {
    path: readonly string[];
    recursive: boolean;
  }): Promise<void>;

  list({ path }: {
    path: readonly string[];
  }): AsyncIterable<HizoFSBackingStoreEntry>;

  openRandomAccessFile({ path, mode, create }: {
    path: readonly string[];
    mode: HizoFSRandomAccessFileMode;
    create: boolean;
  }): Promise<HizoFSRandomAccessFile>;

  getFileSize({ path }: {
    path: readonly string[];
  }): Promise<number | undefined>;

  readRange({ path, offset, byteLength }: {
    path: readonly string[];
    offset: number;
    byteLength: number;
  }): Promise<Uint8Array | undefined>;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
