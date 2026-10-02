import { describe, expect, it } from 'vitest';
import { AUTHENTICATED_PHYSICAL_ACCESS_REASONS } from '@/00-storage/service/hizofs/diagnostics/authenticated-store-diagnostics';
import { IMMUTABLE_BTREE_DIAGNOSTIC_OPERATIONS } from '@/00-storage/service/hizofs/diagnostics/immutable-btree-diagnostics';
import { createHizoFSBenchmarkPresetConfiguration } from './presets';
import { HIZOFS_BENCHMARK_RUNTIME_PHASES } from './runtime-port';
import {
  serializeHizoFSBenchmarkFullReport,
  serializeHizoFSBenchmarkStudyFullReport,
  serializeHizoFSBenchmarkStudySummaryReport,
  serializeHizoFSBenchmarkSummaryReport,
} from './report';
import { createHizoFSBenchmarkStudyReport } from './studies';
import {
  hizoFSBenchmarkReportSchema,
  type HizoFSBenchmarkDiagnostics,
  type HizoFSBenchmarkReport,
} from './types';

function createZeroRuntimeDiagnostics(): HizoFSBenchmarkDiagnostics['runtime'] {
  const phase = () => ({ operationCount: 0, totalDurationMs: 0 });
  const record = () => ({
    readOperations: 0,
    writeOperations: 0,
    cacheHits: 0,
    cacheMisses: 0,
    plaintextBytesRead: 0,
    plaintextBytesWritten: 0,
    physicalBytesRead: 0,
    physicalBytesWritten: 0,
  });
  const cache = () => ({
    hits: 0,
    misses: 0,
    evictions: 0,
    currentBytes: 0,
    maximumBytes: 0,
    currentEntries: 0,
    maximumEntries: 0,
  });
  const resource = () => ({
    currentBytes: 0,
    maximumBytes: 0,
    currentOperations: 0,
    maximumOperations: 0,
  });
  const scopedAccess = () => ({
    duplicateOperations: 0,
    maximumOperationsPerScope: 0,
    operations: 0,
    observedUniqueTargets: 0,
    truncatedScopes: 0,
    unclassifiedOperations: 0,
  });
  const segmentWriter = () => ({
    appendOperations: 0,
    appendReadBackVerifications: 0,
    appendedFrameBytes: 0,
    appendedRecords: 0,
    multiRecordAppendOperations: 0,
    created: 0,
    descriptorValidations: 0,
    rollovers: 0,
    trustedTailMatches: 0,
    trustedTailMismatches: 0,
  });
  return {
    schemaVersion: 10,
    type: 'measured',
    phases: Object.fromEntries(HIZOFS_BENCHMARK_RUNTIME_PHASES.map(name => [name, phase()])) as HizoFSBenchmarkDiagnostics['runtime'] extends { readonly type: 'measured'; readonly phases: infer T } ? T : never,
    records: {
      file_system_commit: record(), inode_table_page: record(), nested_subvolume_table_page: record(),
      directory_page: record(), file_extent_page: record(), file_data: record(), relocation_index_page: record(),
    },
    caches: {
      metadata: cache(), mutationMetadata: cache(), fileChunk: cache(), backingFileHandle: cache(),
      backingFileSnapshot: cache(), decodedInodeIndexPage: cache(),
    },
    resources: {
      writerDirtyChunks: resource(), writerPendingChunkWrites: resource(), readerPrefetch: resource(),
    },
    coordinator: {
      activeStateCacheHits: 0, durableReloads: 0, leadershipAcquisitions: 0,
      failovers: 0, localRequests: 0, remoteRequests: 0,
    },
    indexes: Object.fromEntries(IMMUTABLE_BTREE_DIAGNOSTIC_OPERATIONS.map(operation => [operation, {
      inputMutations: 0, maximumPageLevel: 0, operations: 0, pageReads: 0,
      pageWrites: 0, rootCollapses: 0, splitOperations: 0,
      splitOutputPages: 0, unchangedPageReuses: 0,
    }])) as Extract<HizoFSBenchmarkDiagnostics['runtime'], { readonly type: 'measured' }>['indexes'],
    inodeLeafLookup: {
      branchPageDecodes: 0,
      branchPageBytesDecoded: 0,
      decodedEntryBytes: 0,
      indexBuilds: 0,
      indexBytesCreated: 0,
      indexedEntries: 0,
      indexedPageBytes: 0,
      selectiveEntryHits: 0,
      selectiveEntryMisses: 0,
      skippedPageBytes: 0,
    },
    mutation: {
      abandoned: 0,
      completed: 0,
      failed: 0,
      overlapping: 0,
      getFileSize: scopedAccess(),
      physicalAccessReasons: Object.fromEntries(AUTHENTICATED_PHYSICAL_ACCESS_REASONS.map(reason => [reason, {
        getFileSize: scopedAccess(),
        readExact: scopedAccess(),
      }])) as Extract<HizoFSBenchmarkDiagnostics['runtime'], { readonly type: 'measured' }>['mutation']['physicalAccessReasons'],
      readExact: scopedAccess(),
    },
    publication: {
      completed: 0,
      overlapping: 0,
      getFileSize: scopedAccess(),
      readExact: scopedAccess(),
    },
    segmentWriters: {
      data: segmentWriter(),
      metadata: segmentWriter(),
      relocation: segmentWriter(),
    },
  };
}


function createBackingStoreDiagnostics(): HizoFSBenchmarkDiagnostics['backingStore'] {
  return {
    directoryHandleLookups: 4,
    directoryHandleCreateRequests: 1,
    fileHandleLookups: 3,
    fileHandleCreateRequests: 1,
    fileSnapshotOperations: 2,
    readOperations: 2,
    writeOperations: 3,
    removeOperations: 0,
    listOperations: 1,
    listEntriesMaterialized: 7,
    bytesRead: 128,
    bytesWritten: 256,
    pathAttribution: {
      directoryHandleLookups: {
        root: 0,
        segmentRoot: 1,
        segmentClass: 1,
        segmentShard: 2,
        other: 0,
      },
      directoryHandleCreateRequests: {
        root: 0,
        segmentRoot: 0,
        segmentClass: 0,
        segmentShard: 1,
        other: 0,
      },
      fileHandleLookups: {
        superblock: 1,
        unlockEnvelope: 0,
        metadataSegment: 2,
        dataSegment: 0,
        relocationSegment: 0,
        other: 0,
      },
      fileHandleCreateRequests: {
        superblock: 0,
        unlockEnvelope: 0,
        metadataSegment: 1,
        dataSegment: 0,
        relocationSegment: 0,
        other: 0,
      },
      fileSnapshotOperations: {
        superblock: 1,
        unlockEnvelope: 0,
        metadataSegment: 1,
        dataSegment: 0,
        relocationSegment: 0,
        other: 0,
      },
      listOperations: {
        root: 0,
        segmentRoot: 0,
        segmentClass: 0,
        segmentShard: 1,
        other: 0,
      },
      listEntriesMaterialized: {
        root: 0,
        segmentRoot: 0,
        segmentClass: 0,
        segmentShard: 7,
        other: 0,
      },
    },
  };
}

function createReport(): HizoFSBenchmarkReport {
  return {
    schemaVersion: 38,
    benchmarkImplementationVersion: 112,
    hizofsFormatVersion: 1,
    reportType: 'hizofs_benchmark',
    runId: 'run-id',
    runLabel: undefined,
    generatedAt: '2026-07-15T00:00:00.000Z',
    status: 'failed',
    environment: {
      appVersion: 'test-version',
      userAgent: 'test',
      crossOriginIsolated: false,
      hardwareConcurrency: 2,
    },
    measurementModel: {
      caseDurationScope: 'workload_public_api_calls_plus_hizofs_settlement',
      acceptedDurationScope: 'workload_public_api_calls_only',
      settlementDurationScope: 'hizofs_product_clean_head_barrier_only',
      lifecycleDurationScope: 'separate_lifecycle_events',
      memoryScope: 'benchmark_harness_buffers_only',
      browserHeapMeasured: false,
      hizoFSInternalMemoryMeasured: false,
      hizoFSOwnedResourceDiagnosticsEnabled: true,
      hizoFSRuntimeDiagnosticsEnabled: true,
      phaseDurationsAreNested: true,
      physicalObjectScope: 'immutable_segment_files',
      backingStoreFileSnapshotOperationScope: 'get_file_snapshot_calls',
      backingStoreReadOperationScope: 'materialized_blob_or_sync_access_reads',
      backingStoreHandleLookupOperationScope: 'get_directory_handle_and_get_file_handle_calls',
      backingStoreHandleCreateRequestScope: 'handle_lookup_calls_with_create_true',
      backingStorePathAttributionScope: 'canonical_container_path_kind',
      backingStoreListEntryMaterializationScope: 'entries_values_and_keys_yields',
      physicalStoreShapeScope: 'tracked_immutable_segment_files_and_distinct_shards',
      caseParameterScope: "common_to_recorded_measured_samples",
      sampleParameterScope: "each_recorded_iteration_including_warmup",
      hizoFSRuntimePolicy: {
        application: { type: "unavailable", reason: "artificial report fixture" },
        fileDataAppendBatchFrameByteLimitPerWriter: 16 * 1024 * 1024 + 128 * (64 + 16 + 7),
        fileDataAppendBatchPlaintextByteLimitPerWriter: 16 * 1024 * 1024,
        fileDataAppendBatchRecordLimitPerWriter: 128,
        fileExtentMutationBatchEntryLimitPerWriter: 64,
        fileExtentTailAppendBatchPlaintextByteLimitPerWriter: 16 * 1024 * 1024,
      },
    },
    configuration: createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
    lifecycleEvents: [],
    executionOrder: [],
    results: [{
      workload: 'small_files',
      caseId: 'small_files_write_existing',
      label: 'write',
      parameters: { count: 1 },
      backends: {
        rawOpfs: {
          sampleCount: 1,
          durationMs: { median: 1, p95: 1, minimum: 1, maximum: 1 },
          operationsPerSecond: 1,
          throughputBytesPerSecond: undefined,
          apiOperationTotals: { directoryHandleLookups: 0, directoryCreates: 0, fileHandleLookups: 0, fileCreates: 0, writableOpens: 0, writeCalls: 0, truncateCalls: 0, readableOpens: 0, readCalls: 0, directoryLists: 0, removeCalls: 0, cloneCalls: 0, bulkBuilderCreates: 0, bulkEntryCreates: 0, bulkCommits: 0 },
          memoryHighWater: { maximumTrackedBytes: 0, largestTrackedAllocationBytes: 0, scope: 'benchmark_harness_buffers_only' },
          hizoFSDiagnosticsTotals: undefined,
          samples: [{
            iteration: 0,
            phase: 'measured',
            includedInAggregates: true,
            parameters: { count: 1 },
            acceptedDurationMs: 1,
            settlementDurationMs: undefined,
            durationMs: 1,
            operationCount: 1,
            bytesProcessed: 0,
            checksum: 0,
            apiOperations: {
              directoryHandleLookups: 0,
              directoryCreates: 0,
              fileHandleLookups: 1,
              fileCreates: 0,
              writableOpens: 0,
              writeCalls: 0,
              truncateCalls: 0,
              readableOpens: 0,
              readCalls: 0,
              directoryLists: 0,
              removeCalls: 0,
              cloneCalls: 0, bulkBuilderCreates: 0, bulkEntryCreates: 0, bulkCommits: 0,
            },
            memory: {
              maximumTrackedBytes: 0,
              largestTrackedAllocationBytes: 0,
              scope: 'benchmark_harness_buffers_only',
            },
            hizoFSDiagnostics: undefined,
            garbageCollection: undefined,
            foregroundLatency: undefined,
          }],
        },
        hizofs: {
          sampleCount: 1,
          durationMs: { median: 2, p95: 2, minimum: 2, maximum: 2 },
          operationsPerSecond: 0.5,
          throughputBytesPerSecond: undefined,
          apiOperationTotals: { directoryHandleLookups: 0, directoryCreates: 0, fileHandleLookups: 0, fileCreates: 0, writableOpens: 0, writeCalls: 0, truncateCalls: 0, readableOpens: 0, readCalls: 0, directoryLists: 0, removeCalls: 0, cloneCalls: 0, bulkBuilderCreates: 0, bulkEntryCreates: 0, bulkCommits: 0 },
          memoryHighWater: { maximumTrackedBytes: 0, largestTrackedAllocationBytes: 0, scope: 'benchmark_harness_buffers_only' },
          hizoFSDiagnosticsTotals: {
            backingStore: createBackingStoreDiagnostics(),
            objectChanges: { created: 2, removed: 0 },
            commits: { superblockPublications: 1 },
            crypto: {
              plaintextBytesProcessed: 64,
              ciphertextBytesWritten: 256,
            },
            amplification: {
              backingReadBytesPerLogicalByte: 2,
              backingWriteBytesPerLogicalByte: 4,
              objectCreatesPerOperation: 2,
              commitMaterializationsPerOperation: 1,
              superblockPublicationsPerOperation: 1,
            },
            runtime: createZeroRuntimeDiagnostics(),
          },
          samples: [{
            iteration: 0,
            phase: 'measured',
            includedInAggregates: true,
            parameters: { count: 1 },
            acceptedDurationMs: 1,
            settlementDurationMs: 1,
            durationMs: 2,
            operationCount: 1,
            bytesProcessed: 64,
            checksum: 0,
            apiOperations: {
              directoryHandleLookups: 0,
              directoryCreates: 0,
              fileHandleLookups: 1,
              fileCreates: 0,
              writableOpens: 1,
              writeCalls: 1,
              truncateCalls: 0,
              readableOpens: 0,
              readCalls: 0,
              directoryLists: 0,
              removeCalls: 0,
              cloneCalls: 0, bulkBuilderCreates: 0, bulkEntryCreates: 0, bulkCommits: 0,
            },
            memory: {
              maximumTrackedBytes: 64,
              largestTrackedAllocationBytes: 64,
              scope: 'benchmark_harness_buffers_only',
            },
            hizoFSDiagnostics: {
              backingStore: createBackingStoreDiagnostics(),
              objects: { before: 1, after: 3, created: 2, removed: 0 },
              physicalStore: {
                before: {
                  segmentFiles: { metadata: 1, data: 0, total: 1 },
                  segmentShards: { metadata: 1, data: 0, total: 1 },
                },
                after: {
                  segmentFiles: { metadata: 3, data: 0, total: 3 },
                  segmentShards: { metadata: 2, data: 0, total: 2 },
                },
              },
              commits: { superblockPublications: 1 },
              crypto: {
                plaintextBytesProcessed: 64,
                ciphertextBytesWritten: 256,
              },
              amplification: {
                backingReadBytesPerLogicalByte: 2,
                backingWriteBytesPerLogicalByte: 4,
                objectCreatesPerOperation: 2,
                commitMaterializationsPerOperation: 1,
                superblockPublicationsPerOperation: 1,
              },
              runtime: createZeroRuntimeDiagnostics(),
            },
            garbageCollection: undefined,
            foregroundLatency: undefined,
          }],
        },
      },
      comparison: {
        durationRatio: 2,
        operationsPerSecondRatio: 0.5,
        throughputRatio: undefined,
      },
    }],
    failure: {
      workload: 'small_files',
      caseId: 'small_files_write_existing',
      backend: 'raw_opfs',
      iteration: 0,
      errorName: 'Error',
      errorMessage: 'failed',
      errorStack: 'private stack',
      phase: 'measured',
    },
    cleanup: {
      attempted: true,
      completed: true,
      retainedByConfiguration: false,
      remainingPaths: [],
    },
  };
}

describe('HizoFS benchmark report serialization', () => {
  it('retains iteration parameters in full reports and explicitly omits them from summaries', () => {
    const report = createReport();
    const rawOpfs = report.results[0]?.backends.rawOpfs;
    const measured = rawOpfs?.samples[0];
    if (rawOpfs === undefined || measured === undefined) throw new TypeError('missing report fixture sample');
    rawOpfs.sampleCount = 2;
    rawOpfs.samples = [
      { ...measured, phase: 'warmup', includedInAggregates: false, parameters: { count: 1, uniqueBlockPositions: 99 } },
      { ...measured, parameters: { count: 1, uniqueBlockPositions: 7 } },
      { ...measured, iteration: 1, parameters: { count: 1, uniqueBlockPositions: 8 } },
    ];
    const validated = hizoFSBenchmarkReportSchema.parse(report);
    const full = JSON.parse(serializeHizoFSBenchmarkFullReport({ report: validated })) as {
      results: Array<{ backends: { rawOpfs: {
        samples: Array<{ parameters: Record<string, number> }>;
      } } }>;
    };
    expect(full.results[0]?.backends.rawOpfs?.samples.map(sample => sample.parameters.uniqueBlockPositions))
      .toEqual([99, 7, 8]);
    const summary = JSON.parse(serializeHizoFSBenchmarkSummaryReport({ report })) as {
      measurementModel: { caseParameterScope: string; sampleParameterScope: string };
      results: Array<{ parameters: object; backends: { rawOpfs: {
        sampleCount: number; samples?: unknown; sampleDetailScope: string;
      } } }>;
    };
    expect(summary.measurementModel.caseParameterScope).toBe('common_to_recorded_measured_samples');
    expect(summary.results[0]?.parameters).toEqual({ count: 1 });
    expect(summary.results[0]?.backends.rawOpfs.sampleCount).toBe(2);
    expect(summary.results[0]?.backends.rawOpfs.samples).toBeUndefined();
    expect(summary.results[0]?.backends.rawOpfs.sampleDetailScope)
      .toBe('samples_and_per_iteration_parameters_omitted');
  });

  it('keeps samples and error stacks only in the full report', () => {
    const report = createReport();
    const full = JSON.parse(serializeHizoFSBenchmarkFullReport({ report })) as object;
    const summary = JSON.parse(serializeHizoFSBenchmarkSummaryReport({ report })) as {
      results: Array<{ backends: {
        rawOpfs: { samples?: unknown };
        hizofs: { samples?: unknown; hizoFSDiagnosticsTotals?: unknown };
      } }>;
      failure: { errorStack?: unknown };
    };

    expect(full).toMatchObject({
      reportType: 'hizofs_benchmark',
      measurementModel: {
        caseDurationScope: 'workload_public_api_calls_plus_hizofs_settlement',
        acceptedDurationScope: 'workload_public_api_calls_only',
        settlementDurationScope: 'hizofs_product_clean_head_barrier_only',
        lifecycleDurationScope: 'separate_lifecycle_events',
        memoryScope: 'benchmark_harness_buffers_only',
      },
      failure: { errorStack: 'private stack' },
      results: [{
        backends: {
          rawOpfs: { samples: [expect.objectContaining({ durationMs: 1 })] },
        },
      }],
    });
    expect(summary.results[0]?.backends.rawOpfs.samples).toBeUndefined();
    expect(summary.results[0]?.backends.hizofs.samples).toBeUndefined();
    expect(summary.results[0]?.backends.hizofs.hizoFSDiagnosticsTotals).toMatchObject({
      backingStore: { fileSnapshotOperations: 2, writeOperations: 3 },
      commits: { superblockPublications: 1 },
      amplification: {
        backingReadBytesPerLogicalByte: 2,
        backingWriteBytesPerLogicalByte: 4,
      },
    });
    expect(summary.results[0]?.backends.hizofs).toMatchObject({
      apiOperationTotals: { writableOpens: 0 },
      memoryHighWater: {
        maximumTrackedBytes: 0,
        scope: 'benchmark_harness_buffers_only',
      },
    });
    expect(summary.failure.errorStack).toBeUndefined();
  });

  it('serializes full and summary study reports without duplicating samples', () => {
    const benchmarkReport = createReport();
    const report = createHizoFSBenchmarkStudyReport({
      studyId: 'study-id',
      studyKind: 'bulk_transaction',
      generatedAt: '2026-07-17T00:00:00.000Z',
      baseConfiguration: benchmarkReport.configuration,
      plannedVariantCount: 1,
      variants: [{
        variantId: 'bulk',
        label: 'Bulk comparison',
        report: benchmarkReport,
      }],
    });

    const full = JSON.parse(serializeHizoFSBenchmarkStudyFullReport({ report })) as {
      variants: Array<{ report: { results: Array<{ backends: {
        rawOpfs: { samples?: unknown };
      } }> } }>;
    };
    const summary = JSON.parse(serializeHizoFSBenchmarkStudySummaryReport({ report })) as {
      variants: Array<{ report: { results: Array<{ backends: {
        rawOpfs: { samples?: unknown };
      } }> } }>;
    };

    expect(full.variants[0]?.report.results[0]?.backends.rawOpfs.samples)
      .toBeDefined();
    expect(summary.variants[0]?.report.results[0]?.backends.rawOpfs.samples)
      .toBeUndefined();
  });

  it('accepts explicit unavailable diagnostics without manufacturing zero counters', () => {
    const report = createReport();
    const results = report.results.map(result => {
      const hizofs = result.backends.hizofs;
      if (hizofs === undefined) return result;
      return {
        ...result,
        backends: {
          ...result.backends,
          hizofs: {
            ...hizofs,
            hizoFSDiagnosticsTotals: hizofs.hizoFSDiagnosticsTotals === undefined
              ? undefined
              : {
                ...hizofs.hizoFSDiagnosticsTotals,
                runtime: {
                  schemaVersion: 10 as const,
                  type: 'unavailable' as const,
                  reason: 'production counters are unavailable',
                },
              },
            samples: hizofs.samples.map(sample => ({
              ...sample,
              hizoFSDiagnostics: sample.hizoFSDiagnostics === undefined
                ? undefined
                : {
                  ...sample.hizoFSDiagnostics,
                  runtime: {
                    schemaVersion: 10 as const,
                    type: 'unavailable' as const,
                    reason: 'production counters are unavailable',
                  },
                },
            })),
          },
        },
      };
    });

    const parsed = hizoFSBenchmarkReportSchema.parse({ ...report, results });
    expect(parsed.results[0]?.backends.hizofs?.samples[0]?.hizoFSDiagnostics?.runtime)
      .toEqual({
        schemaVersion: 10,
        type: 'unavailable',
        reason: 'production counters are unavailable',
      });
  });

  it('rejects measured diagnostics whose current V1 record counters are absent', () => {
    const report = createReport();
    const result = report.results[0];
    const hizofs = result?.backends.hizofs;
    const sample = hizofs?.samples[0];
    if (result === undefined || hizofs === undefined || sample?.hizoFSDiagnostics === undefined) {
      throw new TypeError('benchmark report fixture is incomplete');
    }
    const malformed = {
      ...report,
      results: [{
        ...result,
        backends: {
          ...result.backends,
          hizofs: {
            ...hizofs,
            samples: [{
              ...sample,
              hizoFSDiagnostics: {
                ...sample.hizoFSDiagnostics,
                runtime: {
                  ...createZeroRuntimeDiagnostics(),
                  records: {},
                },
              },
            }],
          },
        },
      }],
    };

    expect(() => hizoFSBenchmarkReportSchema.parse(malformed)).toThrow();
  });

  it('rejects the previous report schema and implementation versions', () => {
    const report = createReport();
    expect(() => hizoFSBenchmarkReportSchema.parse({
      ...report,
      schemaVersion: 25,
      benchmarkImplementationVersion: 34,
    })).toThrow();
    expect(() => hizoFSBenchmarkReportSchema.parse({
      ...report,
      schemaVersion: 37,
      benchmarkImplementationVersion: 111,
    })).toThrow();
  });

});
