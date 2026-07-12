export type StorageVolumeAccess =
  | {
      readonly type: 'direct_directory',
      readonly handle: FileSystemDirectoryHandle,
    }
  | {
      readonly type: 'encrypted_directory',
      readonly storeDirectory: FileSystemDirectoryHandle,
      readonly encryptedStoreId: string,
      readonly fileSystemId: string,
      readonly physicalArea: 'durable' | 'temporary',
      readonly rootDirectoryId: string,
      readonly objectEncryptionKey: CryptoKey,
      readonly objectAddressKey: CryptoKey,
    };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
