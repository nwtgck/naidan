import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHizoFSBenchmarkWorkerClient as createHostedClient } from '@/features/debug-hizofs/benchmark/client-hosted';
import type { HizoFSBenchmarkWorkerClient } from '@/features/debug-hizofs/benchmark/worker-client';
import { createHizoFSBenchmarkPresetConfiguration } from '@/features/debug-hizofs/benchmark/presets';
import {
  serializeHizoFSBenchmarkConfiguration,
  serializeHizoFSBenchmarkFullReport,
  serializeHizoFSBenchmarkSummaryReport,
  serializeHizoFSBenchmarkStudyFullReport,
  serializeHizoFSBenchmarkStudySummaryReport,
} from '@/features/debug-hizofs/benchmark/report';
import type {
  HizoFSBenchmarkConfiguration,
  HizoFSBenchmarkReport,
  HizoFSBenchmarkStudyReport,
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
    schemaVersion: 38,
    benchmarkImplementationVersion: 112,
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

function createPolicyReport({ configuration, backingFileHandleCacheEntryLimit }: {
  configuration: HizoFSBenchmarkConfiguration;
  backingFileHandleCacheEntryLimit: number;
}): HizoFSBenchmarkReport {
  const report = createReport({ configuration });
  report.measurementModel.hizoFSRuntimePolicy.application = {
    type: 'production_options',
    options: {
      backingFileHandleCacheEntryLimit,
      decodedInodeIndexPageCacheEntryLimit: 17,
      metadataRecordCachePolicy: { maximumBytes: 4096, maximumEntries: 19 },
    },
    notAppliedConfigurationFields: [
      'fileChunkSize', 'fileChunkWriteConcurrency', 'fileChunkReadPrefetchConcurrency',
      'fileChunkCacheByteLimit', 'fileChunkCacheEntryLimit', 'fileChunkCacheAdmission',
    ],
  };
  return report;
}

describe('HizoFSBenchmarkPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  describe('runtime policy application display', () => {
    afterEach(() => {
      mocks.runBenchmark.mockReset();
    });

    it('keeps unapplied requests visible and unchanged through import, copy, and run', async () => {
      const imported = createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' });
      imported.runLabel = 'imported policy request';
      imported.hizoFSRuntimePolicy = {
        fileChunkSize: 131072,
        fileChunkWriteConcurrency: 3,
        fileChunkReadPrefetchConcurrency: 5,
        backingFileHandleCacheEntryLimit: 4096,
        fileChunkCacheByteLimit: 12345,
        fileChunkCacheEntryLimit: 27,
        fileChunkCacheAdmission: 'read_write',
      };
      const pending = Promise.withResolvers<HizoFSBenchmarkReport>();
      mocks.runBenchmark.mockReturnValueOnce(pending.promise);
      const wrapper = mount(HizoFSBenchmarkPanel);
      try {
        await wrapper.get('[data-testid="hizofs-benchmark-load-config"]').trigger('click');
        await wrapper.get('[data-testid="hizofs-benchmark-config-json-input"]').setValue(JSON.stringify(imported));
        await wrapper.get('[data-testid="hizofs-benchmark-apply-config"]').trigger('click');
        await wrapper.get('[data-testid="hizofs-benchmark-advanced-toggle"]').trigger('click');
        for (const [id, requested] of [
          ['write-concurrency', '3'], ['read-prefetch', '5'],
          ['file-chunk-cache', '12345'], ['file-chunk-cache-admission', 'read_write'],
        ]) {
          const select = wrapper.get(`[data-testid="hizofs-benchmark-${id}"]`);
          expect(select.attributes('disabled')).toBeDefined();
          expect(select.element.parentElement?.textContent).toContain(`requested: ${requested}`);
          expect(select.element.parentElement?.textContent).toContain('Not applied by production benchmark');
        }
        const backing = wrapper.get('[data-testid="hizofs-benchmark-backing-file-handle-cache"]');
        expect(backing.attributes('disabled')).toBeUndefined();
        await backing.setValue('1024');
        const requested = { ...imported, preset: 'custom', hizoFSRuntimePolicy: {
          ...imported.hizoFSRuntimePolicy, backingFileHandleCacheEntryLimit: 1024,
        } };
        await wrapper.get('[data-testid="hizofs-benchmark-copy-config"]').trigger('click');
        expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(JSON.stringify(requested, undefined, 2));
        await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
        await flushPromises();
        expect(mocks.runBenchmark).toHaveBeenCalledWith(expect.objectContaining({ configuration: requested }));
        expect(backing.attributes('disabled')).toBeDefined();
      } finally {
        pending.resolve(createReport({ configuration: imported }));
        await flushPromises();
        wrapper.unmount();
      }
    });

    it('projects the settled report receipt into results and Markdown without changing JSON', async () => {
      const configuration = createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' });
      configuration.hizoFSRuntimePolicy = {
        fileChunkSize: 131072, fileChunkWriteConcurrency: 3, fileChunkReadPrefetchConcurrency: 5,
        backingFileHandleCacheEntryLimit: 4096, fileChunkCacheByteLimit: 12345,
        fileChunkCacheEntryLimit: 27, fileChunkCacheAdmission: 'read_write',
      };
      const report = createPolicyReport({ configuration, backingFileHandleCacheEntryLimit: 13 });
      const before = structuredClone(report);
      mocks.runBenchmark.mockResolvedValueOnce(report);
      const expectedPolicy = [
        'Runtime policy application: production_options',
        'options.backingFileHandleCacheEntryLimit: 13 (requested: 4096)',
        'options.decodedInodeIndexPageCacheEntryLimit: 17',
        'options.metadataRecordCachePolicy.maximumBytes: 4096',
        'options.metadataRecordCachePolicy.maximumEntries: 19',
        'notAppliedConfigurationFields:',
        'fileChunkSize: requested 131072',
        'fileChunkWriteConcurrency: requested 3',
        'fileChunkReadPrefetchConcurrency: requested 5',
        'fileChunkCacheByteLimit: requested 12345',
        'fileChunkCacheEntryLimit: requested 27',
        'fileChunkCacheAdmission: requested read_write',
      ].join('\n');
      const wrapper = mount(HizoFSBenchmarkPanel);
      try {
        await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
        await flushPromises();
        expect(wrapper.get('[data-testid="hizofs-benchmark-policy-application"]').text()).toBe(expectedPolicy);
        await wrapper.get('[data-testid="hizofs-benchmark-load-config"]').trigger('click');
        await wrapper.get('[data-testid="hizofs-benchmark-config-json-input"]')
          .setValue(JSON.stringify({ ...createHizoFSBenchmarkPresetConfiguration({ preset: 'stress' }), runLabel: 'later request' }));
        await wrapper.get('[data-testid="hizofs-benchmark-apply-config"]').trigger('click');
        expect(wrapper.find('[data-testid="hizofs-benchmark-config-json-input"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="hizofs-benchmark-policy-application"]').text()).toBe(expectedPolicy);
        await wrapper.get('[data-testid="hizofs-benchmark-copy-markdown"]').trigger('click');
        expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining(expectedPolicy));
        expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining('| Create and write small files | 10.00 ms | 20.00 ms | 2.00× |'));
        await wrapper.get('[data-testid="hizofs-benchmark-copy-summary"]').trigger('click');
        expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(serializeHizoFSBenchmarkSummaryReport({ report: before }));
        await wrapper.get('[data-testid="hizofs-benchmark-download-full"]').trigger('click');
        const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0];
        if (!(blob instanceof Blob)) throw new Error('Expected full report Blob');
        expect(await blob.text()).toBe(serializeHizoFSBenchmarkFullReport({ report: before }));
        expect(report).toEqual(before);
      } finally {
        wrapper.unmount();
      }
    });

    it.each(['failed', 'cancelled'] as const)('keeps an unavailable reason for an empty %s run', async status => {
      const report = createReport({ status });
      report.results = [];
      report.measurementModel.hizoFSRuntimePolicy.application = { type: 'unavailable', reason: 'runtime was not created' };
      mocks.runBenchmark.mockResolvedValueOnce(report);
      const wrapper = mount(HizoFSBenchmarkPanel);
      try {
        await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
        await flushPromises();
        const expected = `\
Runtime policy application: unavailable
reason: runtime was not created`;
        expect(wrapper.get('[data-testid="hizofs-benchmark-policy-application"]').text()).toBe(expected);
        expect(wrapper.get('[data-testid="hizofs-benchmark-report"]').text()).toContain(`Result: ${status}`);
        await wrapper.get('[data-testid="hizofs-benchmark-copy-markdown"]').trigger('click');
        expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining(expected));
        expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.not.stringContaining('options.'));
      } finally {
        wrapper.unmount();
      }
    });

    it.each(['failed', 'cancelled'] as const)('keeps each study receipt including its empty %s variant', async status => {
      const reports: HizoFSBenchmarkReport[] = [];
      mocks.runBenchmark.mockImplementation(async ({ configuration }: { configuration: HizoFSBenchmarkConfiguration }) => {
        const index = reports.length;
        const report = createPolicyReport({
          configuration: { ...configuration, hizoFSRuntimePolicy: {
            ...configuration.hizoFSRuntimePolicy, fileChunkWriteConcurrency: index + 3,
          } },
          backingFileHandleCacheEntryLimit: index === 0 ? 13 : 23,
        });
        if (index === 2) {
          report.status = status;
          report.results = [];
          report.measurementModel.hizoFSRuntimePolicy.application = { type: 'unavailable', reason: 'variant runtime absent' };
        }
        reports.push(report);
        return report;
      });
      const wrapper = mount(HizoFSBenchmarkPanel);
      try {
        await wrapper.get('[data-testid="hizofs-benchmark-run-mode"]').setValue('policy_matrix');
        await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
        await flushPromises();
        expect(reports).toHaveLength(3);
        const before = structuredClone(reports);
        const variants = wrapper.findAll('[data-testid="hizofs-benchmark-variant-policy"]');
        expect(variants).toHaveLength(3);
        const study: HizoFSBenchmarkStudyReport | undefined = wrapper.vm.TEST_ONLY?.studyReport.value;
        if (study === undefined) throw new Error('Expected settled study report');
        for (const [index, variant] of variants.entries()) {
          const recorded = study.variants[index];
          if (recorded === undefined) throw new Error('Expected recorded variant');
          expect(variant.element).toBeInstanceOf(HTMLDetailsElement);
          expect(variant.attributes('open')).toBeUndefined();
          expect(variant.get('summary').text()).toBe(`${recorded.label} · ${recorded.variantId} · ${recorded.report.status} · ${recorded.report.measurementModel.hizoFSRuntimePolicy.application.type}`);
          await variant.get('summary').trigger('click');
          expect(variant.element).toHaveProperty('open', true);
          expect(variant.get('pre').text()).toContain(`Runtime policy application: ${recorded.report.measurementModel.hizoFSRuntimePolicy.application.type}`);
        }
        expect(variants[0]?.text()).toContain('backing-handle-cache-0');
        expect(variants[0]?.text()).toContain('options.backingFileHandleCacheEntryLimit: 13 (requested: 0)');
        expect(variants[0]?.text()).toContain('fileChunkWriteConcurrency: requested 3');
        expect(variants[1]?.text()).toContain('backing-handle-cache-256');
        expect(variants[1]?.text()).toContain('options.backingFileHandleCacheEntryLimit: 23 (requested: 256)');
        expect(variants[1]?.text()).toContain('fileChunkWriteConcurrency: requested 4');
        expect(variants[2]?.text()).toContain('backing-handle-cache-1024');
        expect(variants[2]?.text()).toContain(status);
        expect(variants[2]?.text()).toContain('reason: variant runtime absent');
        expect(variants[2]?.text()).not.toContain('options.');
        await wrapper.get('[data-testid="hizofs-benchmark-copy-markdown"]').trigger('click');
        const markdown = vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0];
        expect(markdown?.split('Runtime policy application:')).toHaveLength(4);
        expect(markdown).toContain('Variant ID: backing-handle-cache-0');
        expect(markdown).toContain('options.backingFileHandleCacheEntryLimit: 13 (requested: 0)');
        expect(markdown).toContain('Variant ID: backing-handle-cache-256');
        expect(markdown).toContain('options.backingFileHandleCacheEntryLimit: 23 (requested: 256)');
        expect(markdown).toContain('Variant ID: backing-handle-cache-1024');
        expect(markdown).toContain(`\
Status: ${status}
Runtime policy application: unavailable
reason: variant runtime absent`);
        await wrapper.get('[data-testid="hizofs-benchmark-download-full"]').trigger('click');
        const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0];
        if (!(blob instanceof Blob)) throw new Error('Expected study report Blob');
        expect(await blob.text()).toBe(serializeHizoFSBenchmarkStudyFullReport({ report: study }));
        expect(study.variants.map(variant => variant.report)).toEqual(reports);
        await wrapper.get('[data-testid="hizofs-benchmark-copy-summary"]').trigger('click');
        expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(serializeHizoFSBenchmarkStudySummaryReport({ report: study }));
        expect(reports).toEqual(before);
      } finally {
        wrapper.unmount();
      }
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

  it('renders unavailable measured aggregates without inventing zero durations', async () => {
    mocks.runBenchmark.mockImplementation(async ({ configuration }) => {
      const report = createReport({ configuration, status: 'cancelled' });
      const result = report.results[0];
      if (result === undefined) throw new TypeError('missing report fixture case');
      result.parameters = {};
      result.comparison = undefined;
      for (const backend of [result.backends.rawOpfs, result.backends.hizofs]) {
        if (backend === undefined) throw new TypeError('missing report fixture backend');
        backend.sampleCount = 0;
        backend.durationMs = undefined;
        backend.operationsPerSecond = undefined;
      }
      return report;
    });
    const wrapper = mount(HizoFSBenchmarkPanel);
    await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
    await flushPromises();
    const cells = wrapper.get('[data-testid="hizofs-benchmark-report"]')
      .get('tbody tr').findAll('td');
    expect(cells[1]?.text()).toBe('\u2014');
    expect(cells[2]?.text()).toBe('\u2014');
    expect(cells[3]?.text()).toBe('\u2014');
    wrapper.unmount();
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

  it('applies its prefilled default configuration JSON unchanged and restores the explicit runtime label', async () => {
    const wrapper = mount(HizoFSBenchmarkPanel);
    const expected = createHizoFSBenchmarkPresetConfiguration({ preset: 'standard' });
    const serialized = serializeHizoFSBenchmarkConfiguration({ configuration: expected });
    try {
      await wrapper.get('[data-testid="hizofs-benchmark-copy-config"]').trigger('click');
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(serialized);
      await wrapper.get('[data-testid="hizofs-benchmark-load-config"]').trigger('click');
      expect(wrapper.get<HTMLTextAreaElement>('[data-testid="hizofs-benchmark-config-json-input"]').element.value).toBe(serialized);
      await wrapper.get('[data-testid="hizofs-benchmark-apply-config"]').trigger('click');
      expect(wrapper.find('[data-testid="hizofs-benchmark-config-json-input"]').exists()).toBe(false);
      await wrapper.get('[data-testid="hizofs-benchmark-copy-config"]').trigger('click');
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(serialized);
      await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
      await flushPromises();
      expect(mocks.runBenchmark).toHaveBeenCalledTimes(1);
      expect(mocks.runBenchmark.mock.calls[0]?.[0].configuration).toStrictEqual(expected);
    } finally {
      wrapper.unmount();
    }
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

  it.each(['run', 'clean-data'] as const)('disposes an unresponsive hosted %s Worker on unmount without unhandled cancellation', async operation => {
    const terminate = vi.fn();
    class SilentWorker extends EventTarget {
      postMessage = vi.fn();
      terminate = terminate;
    }
    vi.stubGlobal('Worker', SilentWorker);
    mocks.createClient.mockImplementationOnce(createHostedClient);
    const wrapper = mount(HizoFSBenchmarkPanel);
    await wrapper.get(`[data-testid="hizofs-benchmark-${operation}"]`).trigger('click');
    await flushPromises();

    wrapper.unmount();
    await flushPromises();

    expect(terminate).toHaveBeenCalledOnce();
  });

  it.each(['run', 'clean-data'] as const)('disposes a %s client that finishes creation after unmount without starting work', async operation => {
    const opening = Promise.withResolvers<HizoFSBenchmarkWorkerClient>();
    mocks.createClient.mockReturnValueOnce(opening.promise);
    const client = {
      runBenchmark: mocks.runBenchmark,
      cleanBenchmarkData: mocks.cleanBenchmarkData,
      cancelCurrentOperation: mocks.cancelCurrentOperation,
      dispose: mocks.dispose,
      terminate: mocks.terminate,
    };
    const wrapper = mount(HizoFSBenchmarkPanel);
    await wrapper.get(`[data-testid="hizofs-benchmark-${operation}"]`).trigger('click');
    wrapper.unmount();
    opening.resolve(client);
    await flushPromises();

    expect(mocks.runBenchmark).not.toHaveBeenCalled();
    expect(mocks.cleanBenchmarkData).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('owns distinct run and cleanup clients until both are disposed on unmount', async () => {
    const cleanup = Promise.withResolvers<void>();
    const run = Promise.withResolvers<HizoFSBenchmarkReport>();
    const cleanupClient = {
      runBenchmark: vi.fn(),
      cleanBenchmarkData: vi.fn(() => cleanup.promise),
      cancelCurrentOperation: vi.fn(async () => {}),
      dispose: vi.fn(async () => cleanup.resolve()),
      terminate: vi.fn(),
    };
    const runClient = {
      runBenchmark: vi.fn(() => run.promise),
      cleanBenchmarkData: vi.fn(async () => {}),
      cancelCurrentOperation: vi.fn(async () => {}),
      dispose: vi.fn(async () => run.resolve(createReport())),
      terminate: vi.fn(),
    };
    mocks.createClient.mockResolvedValueOnce(cleanupClient).mockResolvedValueOnce(runClient);
    const wrapper = mount(HizoFSBenchmarkPanel);
    await wrapper.get('[data-testid="hizofs-benchmark-clean-data"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
    await flushPromises();

    wrapper.unmount();
    await flushPromises();

    expect(cleanupClient.dispose).toHaveBeenCalledOnce();
    expect(runClient.dispose).toHaveBeenCalledOnce();
  });

  it('does not start cleanup when unmount wins the client handoff continuation', async () => {
    const opening = Promise.withResolvers<HizoFSBenchmarkWorkerClient>();
    mocks.createClient.mockReturnValueOnce(opening.promise);
    const wrapper = mount(HizoFSBenchmarkPanel);
    // Run unmount after openClient receives the client but before its caller resumes.
    void opening.promise.then(() => queueMicrotask(() => wrapper.unmount()));
    await wrapper.get('[data-testid="hizofs-benchmark-clean-data"]').trigger('click');
    opening.resolve({
      runBenchmark: mocks.runBenchmark,
      cleanBenchmarkData: mocks.cleanBenchmarkData,
      cancelCurrentOperation: mocks.cancelCurrentOperation,
      dispose: mocks.dispose,
      terminate: mocks.terminate,
    });
    await flushPromises();

    expect(mocks.cleanBenchmarkData).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('handles both cancellation and disposal failures when the panel unmounts', async () => {
    const run = Promise.withResolvers<HizoFSBenchmarkReport>();
    const disposalFailure = new Error('release failed');
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.createClient.mockResolvedValueOnce({
      runBenchmark: () => run.promise,
      cleanBenchmarkData: vi.fn(async () => {}),
      cancelCurrentOperation: async () => {
        throw new Error('cancel failed');
      },
      dispose: async () => {
        run.reject(new DOMException('terminated', 'AbortError'));
        throw disposalFailure;
      },
      terminate: vi.fn(),
    });
    const wrapper = mount(HizoFSBenchmarkPanel);
    try {
      await wrapper.get('[data-testid="hizofs-benchmark-run"]').trigger('click');
      await flushPromises();
      wrapper.unmount();
      await flushPromises();

      expect(logError).toHaveBeenCalledWith('Failed to dispose the HizoFS benchmark Worker', disposalFailure);
    } finally {
      logError.mockRestore();
    }
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
    const downloadReady = Promise.withResolvers<Blob | MediaSource>();
    vi.mocked(URL.createObjectURL).mockImplementationOnce(blob => {
      downloadReady.resolve(blob);
      return 'blob:benchmark-download';
    });
    await wrapper.get('[data-testid="hizofs-benchmark-download-full-zip"]').trigger('click');

    const blob = await downloadReady.promise;
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
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
    expect(wrapper.get('[data-testid="hizofs-benchmark-study-report"]').text())
      .toContain('requested chunk=');

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
