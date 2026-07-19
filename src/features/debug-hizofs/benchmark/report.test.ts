import { describe, expect, it } from 'vitest';
import { createHizoFSRuntimeDiagnostics } from '@/00-storage/service/hizofs';
import { createHizoFSBenchmarkPresetConfiguration } from './presets';
import {
  serializeHizoFSBenchmarkFullReport,
  serializeHizoFSBenchmarkStudyFullReport,
  serializeHizoFSBenchmarkStudySummaryReport,
  serializeHizoFSBenchmarkSummaryReport,
} from './report';
import { createHizoFSBenchmarkStudyReport } from './studies';
import type { HizoFSBenchmarkReport } from './types';

function createReport(): HizoFSBenchmarkReport {
  return {
    schemaVersion: 18,
    benchmarkImplementationVersion: 20,
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
      caseDurationScope: 'workload_public_api_calls_only',
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
      hizoFSRuntimePolicy: {
        fileChunkSizeBytes: 1024 * 1024,
        maxDirtyFileBytesPerWriter: 16 * 1024 * 1024,
        fileChunkWriteConcurrencyPerWriter: 2,
        fileChunkReadPrefetchConcurrencyPerReader: 4,
        backingFileHandleCacheEntryLimitPerRuntime: 1024,
        backingFileSnapshotCacheEntryLimitPerRuntime: 128,
        maximumPlaintextChunkWriteBytesInFlightPerWriter: 2 * 1024 * 1024,
        maximumPlaintextChunkReadBytesInFlightPerReader: 4 * 1024 * 1024,
        metadataObjectCacheByteLimitPerRuntime: 8 * 1024 * 1024,
        metadataObjectCacheEntryLimitPerRuntime: 16 * 1024,
        decodedInodeIndexPageCacheEntryLimitPerRuntime: 128,
        inodeIndexPageEntryLimitPerRuntime: 32,
        directoryIndexPageEntryLimitPerRuntime: 64,
        fileExtentIndexPageEntryLimitPerRuntime: 64,
        fileChunkCacheByteLimitPerRuntime: 16 * 1024 * 1024 + 64 * 1024,
        fileChunkCacheEntryLimitPerRuntime: 2048,
        fileChunkCacheAdmission: 'read',
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
            backingStore: {
              fileSnapshotOperations: 2,
              readOperations: 2,
              writeOperations: 3,
              removeOperations: 0,
              listOperations: 1,
              bytesRead: 128,
              bytesWritten: 256,
            },
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
              superblockPublicationsPerOperation: 1,
            },
            runtime: createHizoFSRuntimeDiagnostics().snapshot(),
          },
          samples: [{
            iteration: 0,
            phase: 'measured',
            includedInAggregates: true,
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
              backingStore: {
                fileSnapshotOperations: 2,
                readOperations: 2,
                writeOperations: 3,
                removeOperations: 0,
                listOperations: 1,
                bytesRead: 128,
                bytesWritten: 256,
              },
              objects: { before: 1, after: 3, created: 2, removed: 0 },
              commits: { superblockPublications: 1 },
              crypto: {
                plaintextBytesProcessed: 64,
                ciphertextBytesWritten: 256,
              },
              amplification: {
                backingReadBytesPerLogicalByte: 2,
                backingWriteBytesPerLogicalByte: 4,
                objectCreatesPerOperation: 2,
                superblockPublicationsPerOperation: 1,
              },
              runtime: createHizoFSRuntimeDiagnostics().snapshot(),
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
        caseDurationScope: 'workload_public_api_calls_only',
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

});
