import { describe, expect, it } from 'vitest';
import { createHizoFSBenchmarkPresetConfiguration } from './presets';
import {
  createHizoFSBenchmarkStudyPlan,
  createHizoFSBenchmarkStudyReport,
} from './studies';
import type {
  HizoFSBenchmarkConfiguration,
  HizoFSBenchmarkReport,
} from './types';

function createConfiguration(): HizoFSBenchmarkConfiguration {
  return {
    ...createHizoFSBenchmarkPresetConfiguration({ preset: 'standard' }),
    runLabel: 'baseline',
  };
}

function createReport({
  configuration,
  status,
}: {
  configuration: HizoFSBenchmarkConfiguration;
  status: HizoFSBenchmarkReport['status'];
}): HizoFSBenchmarkReport {
  return {
    schemaVersion: 12,
    benchmarkImplementationVersion: 12,
    hizofsFormatVersion: 1,
    reportType: 'hizofs_benchmark',
    runId: `run-${status}`,
    runLabel: configuration.runLabel,
    generatedAt: '2026-07-17T00:00:00.000Z',
    status,
    environment: {
      appVersion: 'test',
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
      hizoFSRuntimePolicy: {
        fileChunkSizeBytes: 256 * 1024,
        maxDirtyFileBytesPerWriter: 16 * 1024 * 1024,
        fileChunkWriteConcurrencyPerWriter:
          configuration.hizoFSRuntimePolicy.fileChunkWriteConcurrency,
        fileChunkReadPrefetchConcurrencyPerReader:
          configuration.hizoFSRuntimePolicy.fileChunkReadPrefetchConcurrency,
        backingFileHandleCacheEntryLimitPerRuntime:
          configuration.hizoFSRuntimePolicy.backingFileHandleCacheEntryLimit,
        backingFileSnapshotCacheEntryLimitPerRuntime: 128,
        maximumPlaintextChunkWriteBytesInFlightPerWriter: 1024 * 1024,
        maximumPlaintextChunkReadBytesInFlightPerReader:
          256 * 1024
          * configuration.hizoFSRuntimePolicy.fileChunkReadPrefetchConcurrency,
        metadataObjectCacheByteLimitPerRuntime: 8 * 1024 * 1024,
        metadataObjectCacheEntryLimitPerRuntime: 16 * 1024,
        fileChunkCacheByteLimitPerRuntime:
          configuration.hizoFSRuntimePolicy.fileChunkCacheByteLimit,
        fileChunkCacheEntryLimitPerRuntime:
          configuration.hizoFSRuntimePolicy.fileChunkCacheEntryLimit,
        fileChunkCacheAdmission:
          configuration.hizoFSRuntimePolicy.fileChunkCacheAdmission,
      },
    },
    configuration,
    lifecycleEvents: [],
    executionOrder: [],
    results: [],
    failure: undefined,
    cleanup: {
      attempted: true,
      completed: true,
      retainedByConfiguration: false,
      remainingPaths: [],
    },
  };
}

describe('HizoFS benchmark studies', () => {
  it('builds a bounded one-factor runtime policy matrix', () => {
    const variants = createHizoFSBenchmarkStudyPlan({
      studyKind: 'policy_matrix',
      baseConfiguration: createConfiguration(),
    });

    expect(variants).toHaveLength(17);
    expect(variants.map(variant => variant.variantId)).toEqual([
      'write-concurrency-1',
      'write-concurrency-2',
      'write-concurrency-4',
      'write-concurrency-8',
      'read-prefetch-1',
      'read-prefetch-2',
      'read-prefetch-4',
      'read-prefetch-8',
      'backing-handle-cache-0',
      'backing-handle-cache-256',
      'backing-handle-cache-1024',
      'backing-handle-cache-4096',
      'chunk-cache-disabled',
      'chunk-cache-8mib-read-only',
      'chunk-cache-16mib-read-only',
      'chunk-cache-32mib-read-only',
      'chunk-cache-8mib-read-write',
    ]);
    expect(variants.every(variant => (
      variant.configuration.backendMode === 'hizofs_only'
      && variant.configuration.storeLifecycle === 'fresh_per_iteration'
      && variant.configuration.benchmarkDataRetention === 'delete_after_run'
      && variant.configuration.measuredIterations <= 3
    ))).toBe(true);
    expect(variants[0]?.configuration.runLabel)
      .toBe('baseline / policy_matrix/write-concurrency-1');
  });

  it('builds bounded garbage-collection policy variants', () => {
    const variants = createHizoFSBenchmarkStudyPlan({
      studyKind: 'garbage_collection_policy',
      baseConfiguration: createConfiguration(),
    });

    expect(variants.map(variant => variant.variantId)).toEqual([
      'remove-concurrency-1',
      'remove-concurrency-2',
      'remove-concurrency-4',
      'remove-concurrency-8',
      'slice-removals-32',
      'slice-removals-64',
      'slice-removals-128',
      'slice-duration-50ms',
      'slice-duration-500ms',
      'large-candidate-set',
    ]);
    expect(variants.every(variant => (
      variant.configuration.backendMode === 'hizofs_only'
      && variant.configuration.workloads.length === 1
      && variant.configuration.workloads[0] === 'hizofs_maintenance'
      && variant.configuration.warmupIterations === 0
      && variant.configuration.measuredIterations === 1
      && variant.configuration.storeLifecycle === 'fresh_per_iteration'
      && variant.configuration.hizoFSMaintenance.cloneCount >= 100
    ))).toBe(true);
    expect(variants[0]?.configuration.runLabel)
      .toBe('baseline / garbage_collection_policy/remove-concurrency-1');
    expect(variants.at(-1)?.configuration.hizoFSMaintenance.cloneCount)
      .toBeGreaterThanOrEqual(1000);
  });

  it('covers 64 MiB and 256 MiB writes with fixed chunk-aligned blocks', () => {
    const variants = createHizoFSBenchmarkStudyPlan({
      studyKind: 'large_write',
      baseConfiguration: createConfiguration(),
    });

    expect(variants.map(variant => ({
      sequentialIo: variant.configuration.sequentialIo,
      writeConcurrency:
        variant.configuration.hizoFSRuntimePolicy.fileChunkWriteConcurrency,
    }))).toEqual([
      {
        sequentialIo: {
          fileSizeBytes: 64 * 1024 * 1024,
          blockSizeBytes: 256 * 1024,
        },
        writeConcurrency: 4,
      },
      ...[1, 2, 4, 8].map(writeConcurrency => ({
        sequentialIo: {
          fileSizeBytes: 256 * 1024 * 1024,
          blockSizeBytes: 256 * 1024,
        },
        writeConcurrency,
      })),
    ]);
    expect(variants.every(variant => (
      variant.configuration.workloads.length === 1
      && variant.configuration.workloads[0] === 'sequential_io'
      && variant.configuration.warmupIterations === 0
    ))).toBe(true);
  });

  it('covers every supported store lifecycle with repeated HizoFS measurements', () => {
    const variants = createHizoFSBenchmarkStudyPlan({
      studyKind: 'lifecycle_matrix',
      baseConfiguration: createConfiguration(),
    });

    expect(variants.map(variant => variant.configuration.storeLifecycle)).toEqual([
      'reuse_without_gc',
      'fresh_per_iteration',
      'reuse_with_gc_between_iterations',
      'reopen_between_iterations',
    ]);
    expect(variants.every(variant => (
      variant.configuration.backendMode === 'hizofs_only'
      && variant.configuration.measuredIterations >= 2
      && variant.configuration.measuredIterations <= 3
    ))).toBe(true);
  });

  it('builds an isolated bulk-transaction comparison', () => {
    const variants = createHizoFSBenchmarkStudyPlan({
      studyKind: 'bulk_transaction',
      baseConfiguration: createConfiguration(),
    });

    expect(variants).toHaveLength(1);
    expect(variants[0]?.configuration).toMatchObject({
      backendMode: 'compare',
      preset: 'custom',
      storeLifecycle: 'fresh_per_iteration',
      workloads: ['bulk_operations'],
      benchmarkDataRetention: 'delete_after_run',
    });
  });

  it('preserves the variant suffix when a base run label is long', () => {
    const variants = createHizoFSBenchmarkStudyPlan({
      studyKind: 'bulk_transaction',
      baseConfiguration: {
        ...createConfiguration(),
        runLabel: 'x'.repeat(200),
      },
    });

    expect(variants[0]?.configuration.runLabel).toHaveLength(200);
    expect(variants[0]?.configuration.runLabel)
      .toMatch(/ \/ bulk_transaction\/empty-files-one-commit$/u);
  });

  it('rejects duplicate or excess study results', () => {
    const baseConfiguration = createConfiguration();
    const configuration = createHizoFSBenchmarkStudyPlan({
      studyKind: 'bulk_transaction',
      baseConfiguration,
    })[0]?.configuration;
    if (configuration === undefined) {
      throw new Error('Expected a bulk benchmark study variant');
    }
    const report = createReport({ configuration, status: 'completed' });

    expect(() => createHizoFSBenchmarkStudyReport({
      studyId: 'duplicate-study',
      studyKind: 'bulk_transaction',
      generatedAt: '2026-07-17T00:00:00.000Z',
      baseConfiguration,
      plannedVariantCount: 2,
      variants: [
        { variantId: 'same', label: 'A', report },
        { variantId: 'same', label: 'B', report },
      ],
    })).toThrow('Duplicate HizoFS benchmark study variant');

    expect(() => createHizoFSBenchmarkStudyReport({
      studyId: 'excess-study',
      studyKind: 'bulk_transaction',
      generatedAt: '2026-07-17T00:00:00.000Z',
      baseConfiguration,
      plannedVariantCount: 1,
      variants: [
        { variantId: 'a', label: 'A', report },
        { variantId: 'b', label: 'B', report },
      ],
    })).toThrow('more variants than planned');
  });

  it('distinguishes completed variants from failed or missing variants', () => {
    const baseConfiguration = createConfiguration();
    const completedConfiguration = createHizoFSBenchmarkStudyPlan({
      studyKind: 'bulk_transaction',
      baseConfiguration,
    })[0]?.configuration;
    if (completedConfiguration === undefined) {
      throw new Error('Expected a bulk benchmark study variant');
    }
    const completedReport = createReport({
      configuration: completedConfiguration,
      status: 'completed',
    });
    const failedReport = createReport({
      configuration: completedConfiguration,
      status: 'failed',
    });

    const failedStudy = createHizoFSBenchmarkStudyReport({
      studyId: 'failed-study',
      studyKind: 'bulk_transaction',
      generatedAt: '2026-07-17T00:00:00.000Z',
      baseConfiguration,
      plannedVariantCount: 2,
      variants: [
        { variantId: 'completed', label: 'Completed', report: completedReport },
        { variantId: 'failed', label: 'Failed', report: failedReport },
      ],
    });
    expect(failedStudy).toMatchObject({
      status: 'failed',
      plannedVariantCount: 2,
      completedVariantCount: 1,
    });

    const partialStudy = createHizoFSBenchmarkStudyReport({
      studyId: 'partial-study',
      studyKind: 'bulk_transaction',
      generatedAt: '2026-07-17T00:00:00.000Z',
      baseConfiguration,
      plannedVariantCount: 2,
      variants: [
        { variantId: 'completed', label: 'Completed', report: completedReport },
      ],
    });
    expect(partialStudy).toMatchObject({
      status: 'cancelled',
      completedVariantCount: 1,
    });
  });
});
