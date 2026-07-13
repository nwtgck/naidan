export type EncryptedOpfsBackingStoreEntry = {
  readonly name: string;
  readonly kind: 'file' | 'directory';
};

export interface EncryptedOpfsBackingStore {
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
  }): AsyncIterable<EncryptedOpfsBackingStoreEntry>;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
