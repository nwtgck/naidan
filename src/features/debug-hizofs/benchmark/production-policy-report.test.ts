import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserHizoFSBenchmarkApplicationRuntime,
  type BrowserHizoFSBenchmarkApplicationRuntime,
} from '@/00-storage/service/hizofs/worker-entry';
import { createHizoFSBenchmarkPresetConfiguration } from './presets';
import { createProductionHizoFSBenchmarkRuntimePort } from './production-runtime-port';
import { createBenchmarkRuntimePolicy } from './runtime-port';
import { hizoFSBenchmarkReportSchema } from './types';

vi.mock('@/00-storage/service/hizofs/worker-entry', () => ({
  createBrowserHizoFSBenchmarkApplicationRuntime: vi.fn(),
}));

const applicationRuntime: BrowserHizoFSBenchmarkApplicationRuntime = {
  get session(): BrowserHizoFSBenchmarkApplicationRuntime['session'] {
    throw new Error('report-only test must not access a filesystem session');
  },
  async close() {},
  async createBulkBuilder() {
    throw new Error('report-only test must not start a workload');
  },
  async settleAcceptedGeneration() {
    throw new Error('report-only test must not publish');
  },
  async reopen() {
    throw new Error('report-only test must not reopen');
  },
  resetRuntimeDiagnosticsHighWaterMarks() {},
  snapshotRuntimeDiagnostics() {
    throw new Error('report-only test must not read diagnostics');
  },
};

beforeEach(() => {
  vi.mocked(createBrowserHizoFSBenchmarkApplicationRuntime).mockReset();
  vi.mocked(createBrowserHizoFSBenchmarkApplicationRuntime).mockResolvedValue(applicationRuntime);
});

describe('production benchmark policy reporting', () => {
  it('reports exactly the three option groups passed to the production owner', async () => {
    const configuration = createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' });
    const policy = {
      ...createBenchmarkRuntimePolicy({ configuration }),
      backingFileHandleCacheEntryLimit: 13,
      decodedInodeIndexPageCacheEntryLimit: 17,
      metadataObjectCacheByteLimit: 4096,
      metadataObjectCacheEntryLimit: 19,
    };
    const backingDirectory = {} as FileSystemDirectoryHandle;
    const runtime = await createProductionHizoFSBenchmarkRuntimePort().createRuntime({ backingDirectory, policy });
    const call = vi.mocked(createBrowserHizoFSBenchmarkApplicationRuntime).mock.calls[0]?.[0];
    expect(call).toEqual({
      backingDirectory,
      backingFileHandleCacheEntryLimit: 13,
      decodedInodeIndexPageCacheEntryLimit: 17,
      metadataRecordCachePolicy: { maximumBytes: 4096, maximumEntries: 19 },
    });
    expect(runtime.policyApplication).toEqual({
      type: 'production_options',
      options: {
        backingFileHandleCacheEntryLimit: call?.backingFileHandleCacheEntryLimit,
        decodedInodeIndexPageCacheEntryLimit: call?.decodedInodeIndexPageCacheEntryLimit,
        metadataRecordCachePolicy: call?.metadataRecordCachePolicy,
      },
      notAppliedConfigurationFields: [
        'fileChunkSize', 'fileChunkWriteConcurrency', 'fileChunkReadPrefetchConcurrency',
        'fileChunkCacheByteLimit', 'fileChunkCacheEntryLimit', 'fileChunkCacheAdmission',
      ],
    });
    expect(hizoFSBenchmarkReportSchema.shape.measurementModel.shape.hizoFSRuntimePolicy
      .shape.application.safeParse(runtime.policyApplication).success).toBe(true);
  });

  it('does not apply ignored requests or modify the requested configuration', async () => {
    const configuration = createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' });
    configuration.hizoFSRuntimePolicy.fileChunkSize = 16 * 1024 * 1024;
    configuration.hizoFSRuntimePolicy.fileChunkWriteConcurrency = 16;
    configuration.hizoFSRuntimePolicy.fileChunkReadPrefetchConcurrency = 16;
    configuration.hizoFSRuntimePolicy.fileChunkCacheByteLimit = 0;
    configuration.hizoFSRuntimePolicy.fileChunkCacheEntryLimit = 0;
    configuration.hizoFSRuntimePolicy.fileChunkCacheAdmission = 'read_write';
    const before = structuredClone(configuration);
    const runtime = await createProductionHizoFSBenchmarkRuntimePort().createRuntime({
      backingDirectory: {} as FileSystemDirectoryHandle,
      policy: createBenchmarkRuntimePolicy({ configuration }),
    });
    const call = vi.mocked(createBrowserHizoFSBenchmarkApplicationRuntime).mock.calls[0]?.[0];
    expect(Object.keys(call ?? {}).sort()).toEqual([
      'backingDirectory', 'backingFileHandleCacheEntryLimit',
      'decodedInodeIndexPageCacheEntryLimit', 'metadataRecordCachePolicy',
    ]);
    expect(runtime.policyApplication.type).toBe('production_options');
    expect(configuration).toEqual(before);
  });
});
