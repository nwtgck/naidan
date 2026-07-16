/**
 * Runtime policy only. None of these values are persisted in the HizoFS format.
 * Memory limits are explicit so performance work cannot silently introduce
 * unbounded plaintext retention. Cache limits apply per runtime and the dirty
 * file limit applies per open writer, so aggregate usage still scales with
 * concurrently open HizoFS runtimes and writers.
 */
export type HizoFSPolicy = {
  readonly inlineFileByteLimit: number;
  readonly inlineDirectoryEntryLimit: number;
  readonly fileChunkSize: number;
  readonly indexPageEntryLimit: number;
  readonly readerStreamChunkSize: number;
  readonly maxDirtyFileBytes: number;
  readonly metadataObjectCacheByteLimit: number;
  readonly metadataObjectCacheEntryLimit: number;
  readonly fileChunkCacheByteLimit: number;
  readonly fileChunkCacheEntryLimit: number;
};

export const DEFAULT_HIZOFS_POLICY: HizoFSPolicy = {
  inlineFileByteLimit: 64 * 1024,
  inlineDirectoryEntryLimit: 32,
  fileChunkSize: 256 * 1024,
  indexPageEntryLimit: 64,
  readerStreamChunkSize: 256 * 1024,
  maxDirtyFileBytes: 16 * 1024 * 1024,
  metadataObjectCacheByteLimit: 8 * 1024 * 1024,
  metadataObjectCacheEntryLimit: 16 * 1024,
  fileChunkCacheByteLimit: 8 * 1024 * 1024,
  fileChunkCacheEntryLimit: 1024,
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
