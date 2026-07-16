import { describe, expect, it } from 'vitest';
import { createHizoFSBenchmarkPresetConfiguration } from './presets';
import {
  serializeHizoFSBenchmarkFullReport,
  serializeHizoFSBenchmarkSummaryReport,
} from './report';
import type { HizoFSBenchmarkReport } from './types';

function createReport(): HizoFSBenchmarkReport {
  return {
    schemaVersion: 2,
    benchmarkImplementationVersion: 2,
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
          apiOperationTotals: { directoryHandleLookups: 0, directoryCreates: 0, fileHandleLookups: 0, fileCreates: 0, writableOpens: 0, writeCalls: 0, truncateCalls: 0, readableOpens: 0, readCalls: 0, directoryLists: 0, removeCalls: 0, cloneCalls: 0 },
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
              cloneCalls: 0,
            },
            memory: {
              maximumTrackedBytes: 0,
              largestTrackedAllocationBytes: 0,
              scope: 'benchmark_harness_buffers_only',
            },
            hizoFSDiagnostics: undefined,
          }],
        },
        hizofs: {
          sampleCount: 1,
          durationMs: { median: 2, p95: 2, minimum: 2, maximum: 2 },
          operationsPerSecond: 0.5,
          throughputBytesPerSecond: undefined,
          apiOperationTotals: { directoryHandleLookups: 0, directoryCreates: 0, fileHandleLookups: 0, fileCreates: 0, writableOpens: 0, writeCalls: 0, truncateCalls: 0, readableOpens: 0, readCalls: 0, directoryLists: 0, removeCalls: 0, cloneCalls: 0 },
          memoryHighWater: { maximumTrackedBytes: 0, largestTrackedAllocationBytes: 0, scope: 'benchmark_harness_buffers_only' },
          hizoFSDiagnosticsTotals: {
            backingStore: {
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
              cloneCalls: 0,
            },
            memory: {
              maximumTrackedBytes: 64,
              largestTrackedAllocationBytes: 64,
              scope: 'benchmark_harness_buffers_only',
            },
            hizoFSDiagnostics: {
              backingStore: {
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
            },
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
      backingStore: { writeOperations: 3 },
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
});
