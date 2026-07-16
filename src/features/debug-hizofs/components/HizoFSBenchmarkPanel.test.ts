import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHizoFSBenchmarkPresetConfiguration } from '@/features/debug-hizofs/benchmark/presets';
import type { HizoFSBenchmarkReport } from '@/features/debug-hizofs/benchmark/types';
import HizoFSBenchmarkPanel from './HizoFSBenchmarkPanel.vue';

const mocks = vi.hoisted(() => ({
  runBenchmark: vi.fn(),
  cancelCurrentOperation: vi.fn(),
  cleanBenchmarkData: vi.fn(),
  dispose: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('@/features/debug-hizofs/worker/client', () => ({
  createHizoFSBenchmarkWorkerClient: mocks.createClient,
}));

function createReport(): HizoFSBenchmarkReport {
  return {
    schemaVersion: 4,
    benchmarkImplementationVersion: 4,
    hizofsFormatVersion: 1,
    reportType: 'hizofs_benchmark',
    runId: 'run-a',
    runLabel: undefined,
    generatedAt: '2026-07-15T00:00:00.000Z',
    status: 'completed',
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
      hizoFSRuntimePolicy: {
        fileChunkSizeBytes: 256 * 1024,
        maxDirtyFileBytesPerWriter: 16 * 1024 * 1024,
        fileChunkWriteConcurrencyPerWriter: 4,
        maximumPlaintextChunkWriteBytesInFlightPerWriter: 1024 * 1024,
        metadataObjectCacheByteLimitPerRuntime: 8 * 1024 * 1024,
        metadataObjectCacheEntryLimitPerRuntime: 16 * 1024,
        fileChunkCacheByteLimitPerRuntime: 8 * 1024 * 1024,
        fileChunkCacheEntryLimitPerRuntime: 1024,
      },
    },
    configuration: createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
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
          apiOperationTotals: { directoryHandleLookups: 0, directoryCreates: 0, fileHandleLookups: 0, fileCreates: 0, writableOpens: 0, writeCalls: 0, truncateCalls: 0, readableOpens: 0, readCalls: 0, directoryLists: 0, removeCalls: 0, cloneCalls: 0 },
          memoryHighWater: { maximumTrackedBytes: 0, largestTrackedAllocationBytes: 0, scope: 'benchmark_harness_buffers_only' },
          hizoFSDiagnosticsTotals: undefined,
          samples: [],
        },
        hizofs: {
          sampleCount: 1,
          durationMs: { median: 20, p95: 20, minimum: 20, maximum: 20 },
          operationsPerSecond: 50,
          throughputBytesPerSecond: undefined,
          apiOperationTotals: { directoryHandleLookups: 0, directoryCreates: 0, fileHandleLookups: 0, fileCreates: 0, writableOpens: 0, writeCalls: 0, truncateCalls: 0, readableOpens: 0, readCalls: 0, directoryLists: 0, removeCalls: 0, cloneCalls: 0 },
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
    mocks.createClient.mockResolvedValue({
      runBenchmark: mocks.runBenchmark,
      cancelCurrentOperation: mocks.cancelCurrentOperation,
      cleanBenchmarkData: mocks.cleanBenchmarkData,
      dispose: mocks.dispose,
    });
    mocks.runBenchmark.mockImplementation(async ({ onProgress }) => {
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
      return createReport();
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
});
