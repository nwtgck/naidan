export type EncryptedOpfsPolicy = {
  readonly inlineFileByteLimit: number;
  readonly inlineDirectoryEntryLimit: number;
  readonly fileChunkSize: number;
  readonly indexPageEntryLimit: number;
  readonly readerStreamChunkSize: number;
};

export const DEFAULT_ENCRYPTED_OPFS_POLICY: EncryptedOpfsPolicy = {
  inlineFileByteLimit: 64 * 1024,
  inlineDirectoryEntryLimit: 32,
  fileChunkSize: 256 * 1024,
  indexPageEntryLimit: 64,
  readerStreamChunkSize: 256 * 1024,
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
