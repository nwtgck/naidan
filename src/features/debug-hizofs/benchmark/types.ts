import { z } from 'zod';

// IMPORTANT: Benchmark configuration and report JSON are ephemeral developer
// diagnostics, not Naidan persistent data or import/export contracts. Their
// structures may change destructively between Naidan versions. Do not add
// backward-compatible readers or migrations for old benchmark JSON. Configuration
// import intentionally accepts only the schema implemented by the current build.

export const hizoFSBenchmarkBackendModeSchema = z.union([
  z.literal('compare'),
  z.literal('hizofs_only'),
  z.literal('raw_opfs_only'),
]);

export const hizoFSBenchmarkPresetSchema = z.union([
  z.literal('quick'),
  z.literal('standard'),
  z.literal('stress'),
  z.literal('custom'),
]);

export const hizoFSBenchmarkStoreLifecycleSchema = z.union([
  z.literal('reuse_without_gc'),
  z.literal('fresh_per_iteration'),
  z.literal('reuse_with_gc_between_iterations'),
  z.literal('reopen_between_iterations'),
]);

export const hizoFSBenchmarkWorkloadSchema = z.union([
  z.literal('small_files'),
  z.literal('sequential_io'),
  z.literal('random_access'),
  z.literal('directory_operations'),
  z.literal('bulk_operations'),
  z.literal('hizofs_maintenance'),
]);

export const hizoFSBenchmarkConfigurationSchema = z.object({
  backendMode: hizoFSBenchmarkBackendModeSchema,
  preset: hizoFSBenchmarkPresetSchema,
  runLabel: z.union([z.string().max(200), z.undefined()]),
  randomSeed: z.number().int().min(1).max(0xffff_ffff),
  warmupIterations: z.number().int().min(0).max(5),
  measuredIterations: z.number().int().min(1).max(20),
  storeLifecycle: hizoFSBenchmarkStoreLifecycleSchema,
  workloads: z.array(hizoFSBenchmarkWorkloadSchema).min(1),
  smallFiles: z.object({
    count: z.number().int().min(1).max(100_000),
    sizeBytes: z.number().int().min(0).max(16 * 1024 * 1024),
  }),
  sequentialIo: z.object({
    fileSizeBytes: z.number().int().min(1).max(4 * 1024 * 1024 * 1024),
    blockSizeBytes: z.number().int().min(1024).max(16 * 1024 * 1024),
  }),
  randomAccess: z.object({
    fileSizeBytes: z.number().int().min(1).max(4 * 1024 * 1024 * 1024),
    operationCount: z.number().int().min(1).max(1_000_000),
    blockSizeBytes: z.number().int().min(1).max(16 * 1024 * 1024),
  }),
  directoryOperations: z.object({
    entryCount: z.number().int().min(1).max(100_000),
  }),
  hizoFSMaintenance: z.object({
    cloneCount: z.number().int().min(1).max(10_000),
    sourceFileSizeBytes: z.number().int().min(1).max(1024 * 1024 * 1024),
    garbageCollectionSweep: z.object({
      removeConcurrency: z.number().int().min(1).max(32),
      maximumRemovalsPerSlice: z.number().int().min(1).max(10_000),
      maximumSliceDurationMs: z.number().min(1).max(60_000),
    }).strict(),
  }).strict(),
  hizoFSRuntimePolicy: z.object({
    fileChunkWriteConcurrency: z.number().int().min(1).max(16),
    fileChunkReadPrefetchConcurrency: z.number().int().min(1).max(16),
    backingFileHandleCacheEntryLimit: z.number().int().min(0).max(1_000_000),
    fileChunkCacheByteLimit: z.number().int().min(0).max(1024 * 1024 * 1024),
    fileChunkCacheEntryLimit: z.number().int().min(0).max(1_000_000),
    fileChunkCacheAdmission: z.union([
      z.literal('read_only'),
      z.literal('read_write'),
    ]),
  }).strict(),
  benchmarkDataRetention: z.union([
    z.literal('delete_after_run'),
    z.literal('keep_after_run'),
  ]),
}).strict();

const benchmarkParametersSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

const durationSummarySchema = z.object({
  median: z.number().nonnegative(),
  p95: z.number().nonnegative(),
  minimum: z.number().nonnegative(),
  maximum: z.number().nonnegative(),
}).strict();

const hizoFSBackingStoreCountersSchema = z.object({
  fileSnapshotOperations: z.number().int().nonnegative(),
  readOperations: z.number().int().nonnegative(),
  writeOperations: z.number().int().nonnegative(),
  removeOperations: z.number().int().nonnegative(),
  listOperations: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
}).strict();


const benchmarkApiCountersSchema = z.object({
  directoryHandleLookups: z.number().int().nonnegative(),
  directoryCreates: z.number().int().nonnegative(),
  fileHandleLookups: z.number().int().nonnegative(),
  fileCreates: z.number().int().nonnegative(),
  writableOpens: z.number().int().nonnegative(),
  writeCalls: z.number().int().nonnegative(),
  truncateCalls: z.number().int().nonnegative(),
  readableOpens: z.number().int().nonnegative(),
  readCalls: z.number().int().nonnegative(),
  directoryLists: z.number().int().nonnegative(),
  removeCalls: z.number().int().nonnegative(),
  cloneCalls: z.number().int().nonnegative(),
  bulkBuilderCreates: z.number().int().nonnegative(),
  bulkEntryCreates: z.number().int().nonnegative(),
  bulkCommits: z.number().int().nonnegative(),
}).strict();

const benchmarkMemoryDiagnosticsSchema = z.object({
  maximumTrackedBytes: z.number().int().nonnegative(),
  largestTrackedAllocationBytes: z.number().int().nonnegative(),
  scope: z.literal('benchmark_harness_buffers_only'),
}).strict();

const benchmarkAmplificationSchema = z.object({
  backingReadBytesPerLogicalByte: z.union([z.number().nonnegative(), z.undefined()]),
  backingWriteBytesPerLogicalByte: z.union([z.number().nonnegative(), z.undefined()]),
  objectCreatesPerOperation: z.union([z.number().nonnegative(), z.undefined()]),
  superblockPublicationsPerOperation: z.union([z.number().nonnegative(), z.undefined()]),
}).strict();


const hizoFSRuntimePhaseCounterSchema = z.object({
  operationCount: z.number().int().nonnegative(),
  totalDurationMs: z.number().nonnegative(),
}).strict();

const hizoFSRuntimeRecordCounterSchema = z.object({
  readOperations: z.number().int().nonnegative(),
  writeOperations: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(),
  cacheMisses: z.number().int().nonnegative(),
  plaintextBytesRead: z.number().int().nonnegative(),
  plaintextBytesWritten: z.number().int().nonnegative(),
  physicalBytesRead: z.number().int().nonnegative(),
  physicalBytesWritten: z.number().int().nonnegative(),
}).strict();

const hizoFSRuntimeCacheCounterSchema = z.object({
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  evictions: z.number().int().nonnegative(),
  currentBytes: z.number().int().nonnegative(),
  maximumBytes: z.number().int().nonnegative(),
  currentEntries: z.number().int().nonnegative(),
  maximumEntries: z.number().int().nonnegative(),
}).strict();

const hizoFSRuntimeResourceCounterSchema = z.object({
  currentBytes: z.number().int().nonnegative(),
  maximumBytes: z.number().int().nonnegative(),
  currentOperations: z.number().int().nonnegative(),
  maximumOperations: z.number().int().nonnegative(),
}).strict();

const hizoFSRuntimeDiagnosticsSchema = z.object({
  phases: z.object({
    record_encode: hizoFSRuntimePhaseCounterSchema,
    record_decode: hizoFSRuntimePhaseCounterSchema,
    object_encrypt: hizoFSRuntimePhaseCounterSchema,
    object_decrypt: hizoFSRuntimePhaseCounterSchema,
    envelope_encode: hizoFSRuntimePhaseCounterSchema,
    envelope_decode: hizoFSRuntimePhaseCounterSchema,
    backing_resolve_parent: hizoFSRuntimePhaseCounterSchema,
    backing_get_file_handle: hizoFSRuntimePhaseCounterSchema,
    backing_get_file: hizoFSRuntimePhaseCounterSchema,
    backing_array_buffer: hizoFSRuntimePhaseCounterSchema,
    backing_create_writable: hizoFSRuntimePhaseCounterSchema,
    backing_write: hizoFSRuntimePhaseCounterSchema,
    backing_close: hizoFSRuntimePhaseCounterSchema,
    backing_open_random_access: hizoFSRuntimePhaseCounterSchema,
    backing_read_at: hizoFSRuntimePhaseCounterSchema,
    backing_write_at: hizoFSRuntimePhaseCounterSchema,
    backing_truncate: hizoFSRuntimePhaseCounterSchema,
    backing_flush: hizoFSRuntimePhaseCounterSchema,
    backing_close_random_access: hizoFSRuntimePhaseCounterSchema,
    backing_failure_verification: hizoFSRuntimePhaseCounterSchema,
    backing_remove: hizoFSRuntimePhaseCounterSchema,
    backing_list: hizoFSRuntimePhaseCounterSchema,
    index_build: hizoFSRuntimePhaseCounterSchema,
    index_update: hizoFSRuntimePhaseCounterSchema,
    commit_publication: hizoFSRuntimePhaseCounterSchema,
  }).strict(),
  records: z.object({
    commit: hizoFSRuntimeRecordCounterSchema,
    inode_index_page: hizoFSRuntimeRecordCounterSchema,
    file_inode: hizoFSRuntimeRecordCounterSchema,
    directory_inode: hizoFSRuntimeRecordCounterSchema,
    symlink_inode: hizoFSRuntimeRecordCounterSchema,
    directory_index_page: hizoFSRuntimeRecordCounterSchema,
    file_extent_page: hizoFSRuntimeRecordCounterSchema,
    file_chunk: hizoFSRuntimeRecordCounterSchema,
    superblock: hizoFSRuntimeRecordCounterSchema,
  }).strict(),
  caches: z.object({
    metadata: hizoFSRuntimeCacheCounterSchema,
    fileChunk: hizoFSRuntimeCacheCounterSchema,
    backingFileHandle: hizoFSRuntimeCacheCounterSchema,
    backingFileSnapshot: hizoFSRuntimeCacheCounterSchema,
    decodedInodeIndexPage: hizoFSRuntimeCacheCounterSchema,
  }).strict(),
  resources: z.object({
    writerDirtyChunks: hizoFSRuntimeResourceCounterSchema,
    writerPendingChunkWrites: hizoFSRuntimeResourceCounterSchema,
    readerPrefetch: hizoFSRuntimeResourceCounterSchema,
  }).strict(),
  coordinator: z.object({
    activeStateCacheHits: z.number().int().nonnegative(),
    durableReloads: z.number().int().nonnegative(),
    leadershipAcquisitions: z.number().int().nonnegative(),
    failovers: z.number().int().nonnegative(),
    localRequests: z.number().int().nonnegative(),
    remoteRequests: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const hizoFSBenchmarkDiagnosticsSchema = z.object({
  backingStore: hizoFSBackingStoreCountersSchema,
  objects: z.object({
    before: z.number().int().nonnegative(),
    after: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  }).strict(),
  commits: z.object({
    superblockPublications: z.number().int().nonnegative(),
  }).strict(),
  crypto: z.object({
    plaintextBytesProcessed: z.number().int().nonnegative(),
    ciphertextBytesWritten: z.number().int().nonnegative(),
  }).strict(),
  amplification: benchmarkAmplificationSchema,
  runtime: hizoFSRuntimeDiagnosticsSchema,
}).strict();

const hizoFSBenchmarkDiagnosticsTotalsSchema = z.object({
  backingStore: hizoFSBackingStoreCountersSchema,
  objectChanges: z.object({
    created: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  }).strict(),
  commits: z.object({
    superblockPublications: z.number().int().nonnegative(),
  }).strict(),
  crypto: z.object({
    plaintextBytesProcessed: z.number().int().nonnegative(),
    ciphertextBytesWritten: z.number().int().nonnegative(),
  }).strict(),
  amplification: benchmarkAmplificationSchema,
  runtime: hizoFSRuntimeDiagnosticsSchema,
}).strict();

const hizoFSGarbageCollectionDiagnosticsSchema = z.object({
  reachableObjectCount: z.number().int().nonnegative(),
  candidateObjectCount: z.number().int().nonnegative(),
  removedObjectCount: z.number().int().nonnegative(),
  changedSegmentCount: z.number().int().nonnegative(),
  ignoredPhysicalPathCount: z.number().int().nonnegative(),
  configuredRemoveConcurrency: z.number().int().positive(),
  configuredMaximumRemovalsPerSlice: z.number().int().positive(),
  configuredMaximumSliceDurationMs: z.number().positive(),
  initialFenceWaitDurationMs: z.number().nonnegative(),
  initialFenceHoldDurationMs: z.number().nonnegative(),
  rootSnapshotDurationMs: z.number().nonnegative(),
  markDurationMs: z.number().nonnegative(),
  chunkVerificationDurationMs: z.number().nonnegative(),
  objectListingDurationMs: z.number().nonnegative(),
  candidateBuildDurationMs: z.number().nonnegative(),
  sweepWallDurationMs: z.number().nonnegative(),
  sweepLockWaitDurationMs: z.number().nonnegative(),
  sweepLockHoldDurationMs: z.number().nonnegative(),
  yieldDurationMs: z.number().nonnegative(),
  totalDurationMs: z.number().nonnegative(),
  sweepSliceCount: z.number().int().nonnegative(),
  maximumPauseDurationMs: z.number().nonnegative(),
  maximumSweepSliceDurationMs: z.number().nonnegative(),
  maximumRemovesInFlight: z.number().int().nonnegative(),
  maximumRemovalsInSlice: z.number().int().nonnegative(),
  sliceDurationBudgetOverrunCount: z.number().int().nonnegative(),
}).strict();

const benchmarkForegroundLatencySchema = z.object({
  operationCount: z.number().int().nonnegative(),
  durationMs: durationSummarySchema,
}).strict();

const benchmarkSampleSchema = z.object({
  iteration: z.number().int().nonnegative(),
  phase: z.union([z.literal('warmup'), z.literal('measured')]),
  includedInAggregates: z.boolean(),
  durationMs: z.number().nonnegative(),
  operationCount: z.number().int().nonnegative(),
  bytesProcessed: z.number().int().nonnegative(),
  checksum: z.number().int().nonnegative(),
  apiOperations: benchmarkApiCountersSchema,
  memory: benchmarkMemoryDiagnosticsSchema,
  hizoFSDiagnostics: z.union([hizoFSBenchmarkDiagnosticsSchema, z.undefined()]),
  garbageCollection: z.union([
    hizoFSGarbageCollectionDiagnosticsSchema,
    z.undefined(),
  ]),
  foregroundLatency: z.union([
    benchmarkForegroundLatencySchema,
    z.undefined(),
  ]),
}).strict();

const benchmarkBackendCaseResultSchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  durationMs: durationSummarySchema,
  operationsPerSecond: z.union([z.number().nonnegative(), z.undefined()]),
  throughputBytesPerSecond: z.union([z.number().nonnegative(), z.undefined()]),
  apiOperationTotals: benchmarkApiCountersSchema,
  memoryHighWater: benchmarkMemoryDiagnosticsSchema,
  hizoFSDiagnosticsTotals: z.union([hizoFSBenchmarkDiagnosticsTotalsSchema, z.undefined()]),
  samples: z.array(benchmarkSampleSchema),
}).strict();

const benchmarkCaseResultSchema = z.object({
  workload: hizoFSBenchmarkWorkloadSchema,
  caseId: z.string(),
  label: z.string(),
  parameters: benchmarkParametersSchema,
  backends: z.object({
    rawOpfs: z.union([benchmarkBackendCaseResultSchema, z.undefined()]),
    hizofs: z.union([benchmarkBackendCaseResultSchema, z.undefined()]),
  }).strict(),
  comparison: z.union([
    z.object({
      durationRatio: z.union([z.number().nonnegative(), z.undefined()]),
      operationsPerSecondRatio: z.union([z.number().nonnegative(), z.undefined()]),
      throughputRatio: z.union([z.number().nonnegative(), z.undefined()]),
    }).strict(),
    z.undefined(),
  ]),
}).strict();

export const hizoFSBenchmarkProgressSchema = z.object({
  stage: z.union([
    z.literal('preparing'),
    z.literal('warmup'),
    z.literal('measuring'),
    z.literal('cleaning'),
  ]),
  workload: z.union([hizoFSBenchmarkWorkloadSchema, z.undefined()]),
  caseId: z.union([z.string(), z.undefined()]),
  backend: z.union([z.literal('raw_opfs'), z.literal('hizofs'), z.undefined()]),
  iteration: z.union([z.number().int().nonnegative(), z.undefined()]),
  completedUnits: z.number().int().nonnegative(),
  totalUnits: z.number().int().positive(),
  message: z.string(),
}).strict();


const hizoFSBenchmarkLifecycleEventSchema = z.object({
  phase: z.union([z.literal('preparing'), z.literal('warmup'), z.literal('measured')]),
  iteration: z.union([z.number().int().nonnegative(), z.undefined()]),
  backend: z.union([z.literal('raw_opfs'), z.literal('hizofs')]),
  action: z.union([
    z.literal('create_context'),
    z.literal('reopen_context'),
    z.literal('garbage_collection'),
  ]),
  durationMs: z.number().nonnegative(),
  hizoFS: z.union([
    z.object({
      objectsBefore: z.number().int().nonnegative(),
      objectsAfter: z.number().int().nonnegative(),
      reachableObjectCount: z.union([z.number().int().nonnegative(), z.undefined()]),
      unreachableObjectCount: z.union([z.number().int().nonnegative(), z.undefined()]),
      removedObjectCount: z.union([z.number().int().nonnegative(), z.undefined()]),
      garbageCollection: z.union([
        hizoFSGarbageCollectionDiagnosticsSchema,
        z.undefined(),
      ]),
      backingStore: hizoFSBackingStoreCountersSchema,
      superblockPublications: z.number().int().nonnegative(),
    }).strict(),
    z.undefined(),
  ]),
}).strict();

export const hizoFSBenchmarkReportSchema = z.object({
  schemaVersion: z.literal(15),
  benchmarkImplementationVersion: z.literal(15),
  hizofsFormatVersion: z.literal(1),
  reportType: z.literal('hizofs_benchmark'),
  runId: z.string(),
  runLabel: z.union([z.string(), z.undefined()]),
  generatedAt: z.string(),
  status: z.union([
    z.literal('completed'),
    z.literal('cancelled'),
    z.literal('failed'),
  ]),
  environment: z.object({
    appVersion: z.string(),
    userAgent: z.string(),
    crossOriginIsolated: z.boolean(),
    hardwareConcurrency: z.union([z.number().int().positive(), z.undefined()]),
  }).strict(),
  measurementModel: z.object({
    caseDurationScope: z.literal('workload_public_api_calls_only'),
    lifecycleDurationScope: z.literal('separate_lifecycle_events'),
    memoryScope: z.literal('benchmark_harness_buffers_only'),
    browserHeapMeasured: z.literal(false),
    hizoFSInternalMemoryMeasured: z.literal(false),
    hizoFSOwnedResourceDiagnosticsEnabled: z.literal(true),
    hizoFSRuntimeDiagnosticsEnabled: z.literal(true),
    phaseDurationsAreNested: z.literal(true),
    physicalObjectScope: z.literal('immutable_segment_files'),
    backingStoreFileSnapshotOperationScope: z.literal('get_file_snapshot_calls'),
    backingStoreReadOperationScope: z.literal('materialized_blob_or_sync_access_reads'),
    hizoFSRuntimePolicy: z.object({
      fileChunkSizeBytes: z.number().int().positive(),
      maxDirtyFileBytesPerWriter: z.number().int().positive(),
      fileChunkWriteConcurrencyPerWriter: z.number().int().positive(),
      fileChunkReadPrefetchConcurrencyPerReader: z.number().int().positive(),
      backingFileHandleCacheEntryLimitPerRuntime: z.number().int().nonnegative(),
      backingFileSnapshotCacheEntryLimitPerRuntime: z.number().int().nonnegative(),
      maximumPlaintextChunkWriteBytesInFlightPerWriter: z.number().int().positive(),
      maximumPlaintextChunkReadBytesInFlightPerReader: z.number().int().positive(),
      metadataObjectCacheByteLimitPerRuntime: z.number().int().nonnegative(),
      metadataObjectCacheEntryLimitPerRuntime: z.number().int().nonnegative(),
      decodedInodeIndexPageCacheEntryLimitPerRuntime:
        z.number().int().nonnegative(),
      fileChunkCacheByteLimitPerRuntime: z.number().int().nonnegative(),
      fileChunkCacheEntryLimitPerRuntime: z.number().int().nonnegative(),
      fileChunkCacheAdmission: z.union([
        z.literal('read_only'),
        z.literal('read_write'),
      ]),
    }).strict(),
  }).strict(),
  configuration: hizoFSBenchmarkConfigurationSchema,
  lifecycleEvents: z.array(hizoFSBenchmarkLifecycleEventSchema),
  executionOrder: z.array(z.object({
    iteration: z.number().int().nonnegative(),
    phase: z.union([z.literal('warmup'), z.literal('measured')]),
    order: z.array(z.union([z.literal('raw_opfs'), z.literal('hizofs')])),
  }).strict()),
  results: z.array(benchmarkCaseResultSchema),
  failure: z.union([
    z.object({
      workload: z.union([hizoFSBenchmarkWorkloadSchema, z.undefined()]),
      caseId: z.union([z.string(), z.undefined()]),
      backend: z.union([z.literal('raw_opfs'), z.literal('hizofs'), z.undefined()]),
      iteration: z.union([z.number().int().nonnegative(), z.undefined()]),
      errorName: z.string(),
      errorMessage: z.string(),
      errorStack: z.union([z.string(), z.undefined()]),
      phase: z.string(),
    }).strict(),
    z.undefined(),
  ]),
  cleanup: z.object({
    attempted: z.boolean(),
    completed: z.boolean(),
    retainedByConfiguration: z.boolean(),
    remainingPaths: z.array(z.string()),
  }).strict(),
}).strict();

export const hizoFSBenchmarkStudyKindSchema = z.union([
  z.literal('policy_matrix'),
  z.literal('large_write'),
  z.literal('lifecycle_matrix'),
  z.literal('bulk_transaction'),
  z.literal('garbage_collection_policy'),
]);

export const hizoFSBenchmarkStudyReportSchema = z.object({
  schemaVersion: z.literal(1),
  studyImplementationVersion: z.literal(5),
  reportType: z.literal('hizofs_benchmark_study'),
  studyId: z.string(),
  studyKind: hizoFSBenchmarkStudyKindSchema,
  generatedAt: z.string(),
  status: z.union([
    z.literal('completed'),
    z.literal('cancelled'),
    z.literal('failed'),
  ]),
  baseConfiguration: hizoFSBenchmarkConfigurationSchema,
  plannedVariantCount: z.number().int().positive(),
  completedVariantCount: z.number().int().nonnegative(),
  variants: z.array(z.object({
    variantId: z.string(),
    label: z.string(),
    report: hizoFSBenchmarkReportSchema,
  }).strict()),
}).strict();

export type HizoFSBenchmarkBackendMode = z.infer<typeof hizoFSBenchmarkBackendModeSchema>;
export type HizoFSBenchmarkPreset = z.infer<typeof hizoFSBenchmarkPresetSchema>;
export type HizoFSBenchmarkStoreLifecycle = z.infer<typeof hizoFSBenchmarkStoreLifecycleSchema>;
export type HizoFSBenchmarkWorkload = z.infer<typeof hizoFSBenchmarkWorkloadSchema>;
export type HizoFSBenchmarkStudyKind = z.infer<typeof hizoFSBenchmarkStudyKindSchema>;
export type HizoFSBenchmarkConfiguration = z.infer<typeof hizoFSBenchmarkConfigurationSchema>;
export type HizoFSBenchmarkLifecycleEvent = HizoFSBenchmarkReport['lifecycleEvents'][number];
export type HizoFSBenchmarkProgress = z.infer<typeof hizoFSBenchmarkProgressSchema>;
export type HizoFSBenchmarkReport = z.infer<typeof hizoFSBenchmarkReportSchema>;
export type HizoFSBenchmarkStudyReport = z.infer<typeof hizoFSBenchmarkStudyReportSchema>;
export type HizoFSBenchmarkCaseResult = HizoFSBenchmarkReport['results'][number];
export type HizoFSBenchmarkBackendCaseResult = NonNullable<
  HizoFSBenchmarkCaseResult['backends']['rawOpfs']
>;
export type HizoFSBenchmarkSample = HizoFSBenchmarkBackendCaseResult['samples'][number];
export type HizoFSBenchmarkDiagnostics = NonNullable<HizoFSBenchmarkSample['hizoFSDiagnostics']>;
export type HizoFSBenchmarkDiagnosticsTotals = NonNullable<
  HizoFSBenchmarkBackendCaseResult['hizoFSDiagnosticsTotals']
>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
