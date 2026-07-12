import type {
  EncryptedStorageDebugCapability,
  EncryptedStorageDebugIntegrityReport,
  EncryptedStorageDebugNode,
  EncryptedStorageDebugNodeRef,
  EncryptedStorageDebugSearchResult,
} from '@/00-storage/service/opfs-encryption/debug/encrypted-storage-debug-types';

export interface IDebugEncryptedStorageWorker {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- The capability is a structured-cloned Comlink boundary value.
  configure(capability: EncryptedStorageDebugCapability): Promise<void>;

  loadNode({ ref }: {
    ref: EncryptedStorageDebugNodeRef,
  }): Promise<EncryptedStorageDebugNode>;

  search({ query }: {
    query: string,
  }): Promise<EncryptedStorageDebugSearchResult[]>;

  scanIntegrity(): Promise<EncryptedStorageDebugIntegrityReport>;

  dispose(): Promise<void>;
}

export interface DebugEncryptedStorageWorkerClient {
  loadNode({ ref }: {
    ref: EncryptedStorageDebugNodeRef,
  }): Promise<EncryptedStorageDebugNode>;

  search({ query }: {
    query: string,
  }): Promise<EncryptedStorageDebugSearchResult[]>;

  scanIntegrity(): Promise<EncryptedStorageDebugIntegrityReport>;

  dispose(): Promise<void>;
}

export type {
  EncryptedStorageDebugIntegrityReport,
  EncryptedStorageDebugNode,
  EncryptedStorageDebugNodeRef,
  EncryptedStorageDebugSearchResult,
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
