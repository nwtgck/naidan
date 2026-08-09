import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHizoFSBenchmarkPresetConfiguration } from '@/features/debug-hizofs/benchmark/presets';
import { serializeHizoFSBenchmarkFullReport } from '@/features/debug-hizofs/benchmark/report';
import type {
  HizoFSBenchmarkConfiguration,
  HizoFSBenchmarkReport,
} from '@/features/debug-hizofs/benchmark/types';
import HizoFSBenchmarkPanel from './HizoFSBenchmarkPanel.vue';

const mocks = vi.hoisted(() => ({
  runBenchmark: vi.fn(),
  cancelCurrentOperation: vi.fn(),
  cleanBenchmarkData: vi.fn(),
  dispose: vi.fn(),
  terminate: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('@/features/debug-hizofs/benchmark/client', () => ({
  createHizoFSBenchmarkWorkerClient: mocks.createClient,
}));

function createReport({
  status = 'completed',
  configuration = createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
}: {
  status?: HizoFSBenchmarkReport['status'];
  configuration?: HizoFSBenchmarkConfiguration;
} = {}): HizoFSBenchmarkReport {
  return {
    schemaVersion: 33,
    benchmarkImplementationVersion: 53,
    hizofsFormatVersion: 1,
    reportType: 'hizofs_benchmark',
    runId: 'run-a',
    runLabel: undefined,
    generatedAt: '2026-07-15T00:00:00.000Z',
    status,
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
      hizoFSRuntimePolicy: {
        fileChunkSizeBytes: configuration.hizoFSRuntimePolicy.fileChunkSize,
        maxDirtyFileBytesPerWriter: 16 * 1024 * 1024,
        fileChunkWriteConcurrencyPerWriter: 2,
        fileChunkReadPrefetchConcurrencyPerReader: 4,
        backingFileHandleCacheEntryLimitPerRuntime: 1024,
        backingFileSnapshotCacheEntryLimitPerRuntime: 128,
        maximumPlaintextChunkWriteBytesInFlightPerWriter:
          configuration.hizoFSRuntimePolicy.fileChunkSize
          * configuration.hizoFSRuntimePolicy.fileChunkWriteConcurrency,
        maximumPlaintextChunkReadBytesInFlightPerReader:
          configuration.hizoFSRuntimePolicy.fileChunkSize
          * configuration.hizoFSRuntimePolicy.fileChunkReadPrefetchConcurrency,
        metadataObjectCacheByteLimitPerRuntime: 8 * 1024 * 1024,
        metadataObjectCacheEntryLimitPerRuntime: 16 * 1024,
        decodedInodeIndexPageCacheEntryLimitPerRuntime: 128,
        inodeIndexLeafEntryLimitPerRuntime: 32,
        directoryIndexLeafEntryLimitPerRuntime: 64,
        fileExtentIndexLeafEntryLimitPerRuntime: 64,
        fileChunkCacheByteLimitPerRuntime: 16 * 1024 * 1024 + 64 * 1024,
        fileChunkCacheEntryLimitPerRuntime: 2048,
        fileChunkCacheAdmission: 'read',
      },
    },
    configuration,
    lifecycleEvents: [],
    executionOrder: [],
    results: [{
      workload: 'small_files',
      caseId: 'small_files_write_existing',
      label: 'Create and write small files',
      parameters: { fileCount: 32 },
      backends: {
        rawOpfs: {
          sampleCount: 1,
          durationMs: { median: 10, p95: 10, minimum: 10, maximum: 10 },
          operationsPerSecond: 100,
          throughputBytesPerSecond: undefined,
          apiOperationTotals: { directoryHandleLookups: 0, directoryCreates: 0, fileHandleLookups: 0, fileCreates: 0, writableOpens: 0, writeCalls: 0, truncateCalls: 0, readableOpens: 0, readCalls: 0, directoryLists: 0, removeCalls: 0, cloneCalls: 0, bulkBuilderCreates: 0, bulkEntryCreates: 0, bulkCommits: 0 },
          memoryHighWater: { maximumTrackedBytes: 0, largestTrackedAllocationBytes: 0, scope: 'benchmark_harness_buffers_only' },
          hizoFSDiagnosticsTotals: undefined,
          samples: [],
        },
        hizofs: {
          sampleCount: 1,
          durationMs: { median: 20, p95: 20, minimum: 20, maximum: 20 },
          operationsPerSecond: 50,
          throughputBytesPerSecond: undefined,
          apiOperationTotals: { directoryHandleLookups: 0, directoryCreates: 0, fileHandleLookups: 0, fileCreates: 0, writableOpens: 0, writeCalls: 0, truncateCalls: 0, readableOpens: 0, readCalls: 0, directoryLists: 0, removeCalls: 0, cloneCalls: 0, bulkBuilderCreates: 0, bulkEntryCreates: 0, bulkCommits: 0 },
          memoryHighWater: { maximumTrackedBytes: 0, largestTrackedAllocationBytes: 0, scope: 'benchmark_harness_buffers_only' },
          hizoFSDiagnosticsTotals: undefined,
          samples: [],
        },
      },
      comparison: {
        durationRatio: 2,
        operationsPerSecondRatio: 0.5,
        throughputRatio: undefined,
      },
    }],
    failure: undefined,
    cleanup: {
      attempted: true,
      completed: true,
      retainedByConfiguration: false,
      remainingPaths: [],
    },
  };
}

describe('HizoFSBenchmarkPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:benchmark-download');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mocks.createClient.mockResolvedValue({
      runBenchmark: mocks.runBenchmark,
      cancelCurrentOperation: mocks.cancelCurrentOperation,
      cleanBenchmarkData: mocks.cleanBenchmarkData,
      dispose: mocks.dispose,
      terminate: mocks.terminate,
    });
    mocks.runBenchmark.mockImplementation(async ({ configuration, onProgress }) => {
      onProgress({
        progress: {
          stage: 'measuring',
          workload: 'small_files',
          caseId: 'small_files_write_existing',
          backend: 'hizofs',
          iteration: 0,
          completedUnits: 1,
          totalUnits: 2,
          message: 'Running small files',
        },
      });
      return createReport({ configuration });
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
  });

  it('selects a preset, runs the Worker benchmark, and renders comparison results', async () => {
    const wrapper = mount(HizoFSBenchmarkPanel);

    await wrapper.get('[data-testid="hizofs-benchmark-preset-quick"]').trigger('click');
    await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
    await flushPromises();

    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(mocks.runBenchmark).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({ preset: 'quick' }),
      onProgress: expect.any(Function),
    }));
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="hizofs-benchmark-report"]').text())
      .toContain('Create and write small files');
    expect(wrapper.text()).toContain('2.00×');
  });

  it('removes the HizoFS-only maintenance pack when raw OPFS is selected before Stress', async () => {
    const wrapper = mount(HizoFSBenchmarkPanel);

    await wrapper.get('[data-testid="hizofs-benchmark-backend-mode"]')
      .setValue('raw_opfs_only');
    await wrapper.get('[data-testid="hizofs-benchmark-preset-stress"]').trigger('click');
    await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
    await flushPromises();

    expect(mocks.runBenchmark).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({
        backendMode: 'raw_opfs_only',
        preset: 'stress',
        workloads: expect.not.arrayContaining(['hizofs_maintenance']),
      }),
    }));
  });

  it('loads a strict configuration JSON for reproducible reruns', async () => {
    const wrapper = mount(HizoFSBenchmarkPanel);
    const imported = {
      ...createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
      backendMode: 'raw_opfs_only' as const,
      preset: 'custom' as const,
      runLabel: 'shared configuration',
    };

    await wrapper.get('[data-testid="hizofs-benchmark-load-config"]').trigger('click');
    await wrapper.get('[data-testid="hizofs-benchmark-config-json-input"]')
      .setValue(JSON.stringify(imported));
    await wrapper.get('[data-testid="hizofs-benchmark-apply-config"]').trigger('click');
    await wrapper.get('[data-testid="hizofs-benchmark-copy-config"]').trigger('click');
    await flushPromises();

    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      expect.stringContaining('"runLabel": "shared configuration"'),
    );
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      expect.stringContaining('"backendMode": "raw_opfs_only"'),
    );
  });

  it('passes the selected store lifecycle to the Worker benchmark', async () => {
    const wrapper = mount(HizoFSBenchmarkPanel);

    await wrapper.get('[data-testid="hizofs-benchmark-advanced-toggle"]').trigger('click');
    await wrapper.get('[data-testid="hizofs-benchmark-store-lifecycle"]')
      .setValue('fresh_per_iteration');
    await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
    await flushPromises();

    expect(mocks.runBenchmark).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({
        storeLifecycle: 'fresh_per_iteration',
      }),
    }));
  });

  it('cleans retained benchmark data through the Worker', async () => {
    const wrapper = mount(HizoFSBenchmarkPanel);

    await wrapper.get('[data-testid="hizofs-benchmark-clean-data"]').trigger('click');
    await flushPromises();

    expect(mocks.cleanBenchmarkData).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('Benchmark data cleaned');
  });

  it('copies configuration and summary JSON for machine-readable sharing', async () => {
    const wrapper = mount(HizoFSBenchmarkPanel);
    await wrapper.get('[data-testid="hizofs-benchmark-copy-config"]').trigger('click');
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('"backendMode": "compare"'),
    );

    await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-benchmark-copy-summary"]').trigger('click');
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      expect.stringContaining('"reportType": "hizofs_benchmark"'),
    );
  });

  it('downloads the full JSON as a compressed ZIP archive', async () => {
    const expectedReport = createReport({
      configuration: createHizoFSBenchmarkPresetConfiguration({ preset: 'standard' }),
    });
    mocks.runBenchmark.mockResolvedValueOnce(expectedReport);
    const wrapper = mount(HizoFSBenchmarkPanel);

    await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-benchmark-download-full-zip"]').trigger('click');
    await flushPromises();

    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    if (!(blob instanceof Blob)) throw new Error('ZIP download did not create a Blob');
    expect(blob.type).toBe('application/zip');

    expect(blob.size).toBeGreaterThan(0);
    const { default: JSZip } = await import('jszip');
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    const file = archive.file('hizofs-benchmark-run-a.json');
    expect(file).not.toBeNull();
    if (file === null) throw new Error('ZIP archive did not contain the full benchmark JSON');
    await expect(file.async('string')).resolves.toBe(
      serializeHizoFSBenchmarkFullReport({ report: expectedReport }),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:benchmark-download');
  });

  it('runs a benchmark study sequentially and exports a combined report', async () => {
    const wrapper = mount(HizoFSBenchmarkPanel);

    await wrapper.get('[data-testid="hizofs-benchmark-run-mode"]')
      .setValue('bulk_transaction');
    await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
    await flushPromises();

    expect(mocks.runBenchmark).toHaveBeenCalledTimes(1);
    expect(mocks.runBenchmark).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({
        backendMode: 'compare',
        preset: 'custom',
        workloads: ['bulk_operations'],
        storeLifecycle: 'fresh_per_iteration',
      }),
    }));
    expect(wrapper.get('[data-testid="hizofs-benchmark-study-report"]').text())
      .toContain('Completed 1 of 1 planned variants');

    await wrapper.get('[data-testid="hizofs-benchmark-copy-summary"]').trigger('click');
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      expect.stringContaining('"reportType": "hizofs_benchmark_study"'),
    );
  });

  it('force-terminates a benchmark Worker when cooperative cancellation cannot settle the run', async () => {
    vi.useFakeTimers();
    try {
      const pending = Promise.withResolvers<HizoFSBenchmarkReport>();
      mocks.runBenchmark.mockReturnValueOnce(pending.promise);
      mocks.terminate.mockImplementationOnce(() => {
        pending.reject(new DOMException('benchmark Worker terminated', 'AbortError'));
      });
      const wrapper = mount(HizoFSBenchmarkPanel);

      await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
      await flushPromises();
      await wrapper.get('[data-testid="hizofs-benchmark-cancel"]').trigger('click');
      await flushPromises();

      expect(mocks.cancelCurrentOperation).toHaveBeenCalledOnce();
      expect(mocks.terminate).not.toHaveBeenCalled();
      expect(wrapper.get('[data-testid="hizofs-benchmark-cancel"]').text()).toContain('Cancelling');

      await vi.advanceTimersByTimeAsync(1_000);
      await flushPromises();

      expect(mocks.terminate).toHaveBeenCalledOnce();
      expect(mocks.dispose).toHaveBeenCalledOnce();
      expect(wrapper.find('[data-testid="hizofs-benchmark-cancel"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('benchmark Worker terminated');
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves completed study variants and stops after cancellation', async () => {
    mocks.runBenchmark
      .mockImplementationOnce(async ({ configuration }) => createReport({ configuration }))
      .mockImplementationOnce(async ({ configuration }) => createReport({
        status: 'cancelled',
        configuration,
      }));
    const wrapper = mount(HizoFSBenchmarkPanel);

    await wrapper.get('[data-testid="hizofs-benchmark-run-mode"]')
      .setValue('policy_matrix');
    await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
    await flushPromises();

    expect(mocks.runBenchmark).toHaveBeenCalledTimes(2);
    const studyResult = wrapper.get('[data-testid="hizofs-benchmark-study-report"]');
    expect(studyResult.text()).toContain('Study result: cancelled');
    expect(studyResult.text()).toContain('Completed 1 of 4 planned variants');
    expect(studyResult.text()).toContain('chunk=256.00 KiB');
  });

});
