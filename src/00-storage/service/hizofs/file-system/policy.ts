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
  readonly inodeIndexPageEntryLimit: number;
  readonly directoryIndexPageEntryLimit: number;
  readonly fileExtentIndexPageEntryLimit: number;
  readonly decodedInodeIndexPageCacheEntryLimit: number;
  readonly readerStreamChunkSize: number;
  readonly fileChunkReadPrefetchConcurrency: number;
  readonly backingFileHandleCacheEntryLimit: number;
  readonly backingFileSnapshotCacheEntryLimit: number;
  readonly maxDirtyFileBytes: number;
  readonly fileChunkWriteConcurrency: number;
  readonly metadataObjectCacheByteLimit: number;
  readonly metadataObjectCacheEntryLimit: number;
  readonly fileChunkCacheByteLimit: number;
  readonly fileChunkCacheEntryLimit: number;
  readonly fileChunkCacheAdmission: 'read_only' | 'read_write';
};

export const DEFAULT_HIZOFS_POLICY: HizoFSPolicy = {
  inlineFileByteLimit: 64 * 1024,
  inlineDirectoryEntryLimit: 32,
  // One MiB aligns sixteen encrypted chunks with the 16 MiB data-segment
  // target while keeping the per-writer in-flight plaintext bound at 2 MiB.
  fileChunkSize: 1024 * 1024,
  // Inode-index entries are fixed-size stable IDs plus ObjectRefs. Smaller
  // pages reduce copy-on-write bytes for per-operation inode publications.
  inodeIndexPageEntryLimit: 32,
  directoryIndexPageEntryLimit: 64,
  fileExtentIndexPageEntryLimit: 64,
  // Inode-index pages contain only fixed-size stable IDs and ObjectRefs. Keep
  // this parsed-page cache separate and explicitly bounded per runtime.
  decodedInodeIndexPageCacheEntryLimit: 128,
  readerStreamChunkSize: 256 * 1024,
  fileChunkReadPrefetchConcurrency: 4,
  backingFileHandleCacheEntryLimit: 1024,
  backingFileSnapshotCacheEntryLimit: 128,
  maxDirtyFileBytes: 16 * 1024 * 1024,
  fileChunkWriteConcurrency: 2,
  metadataObjectCacheByteLimit: 8 * 1024 * 1024,
  metadataObjectCacheEntryLimit: 16 * 1024,
  // One encoded 1 MiB chunk includes a small record header and metadata. Keep
  // the byte bound explicit while allowing one complete 16-chunk working set
  // to remain resident instead of deterministically evicting the 16th item.
  fileChunkCacheByteLimit: 16 * 1024 * 1024 + 64 * 1024,
  fileChunkCacheEntryLimit: 2048,
  fileChunkCacheAdmission: 'read_only',
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
