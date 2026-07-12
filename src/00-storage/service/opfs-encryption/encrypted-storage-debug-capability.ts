/**
 * Read-only, structured-cloneable access granted to Encrypted Storage Inspector.
 *
 * Storage owns the unlocked handles and non-extractable keys, but it deliberately
 * does not map persisted DTOs into debug presentation models. The debug feature
 * consumes this narrow capability and reads the persistence protocol directly.
 */
export interface EncryptedStorageDebugCapability {
  readonly storageRoot: FileSystemDirectoryHandle,
  readonly storeDirectory: FileSystemDirectoryHandle,
  readonly encryptedStoreId: string,
  readonly objectEncryptionKey: CryptoKey,
  readonly objectAddressKey: CryptoKey,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
