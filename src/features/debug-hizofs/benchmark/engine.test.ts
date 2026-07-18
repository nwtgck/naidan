import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { createHizoFSBenchmarkPresetConfiguration } from './presets';
import {
  hizoFSBenchmarkReportSchema,
  type HizoFSBenchmarkConfiguration,
} from './types';
import { cleanHizoFSBenchmarkData, runHizoFSBenchmark, TEST_ONLY } from './engine';

function createTinyConfiguration(): HizoFSBenchmarkConfiguration {
  return {
    ...createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
    backendMode: 'compare' as const,
    workloads: ['small_files'],
    smallFiles: {
      count: 3,
      sizeBytes: 32,
    },
    measuredIterations: 1,
    warmupIterations: 0,
  };
}

describe('HizoFS benchmark engine', () => {

  it('counts random-access segment reads, writes, and durable flushes', () => {
    const physical = new Uint8Array(16);
    let physicalSize = 0;
    let committed = 0;
    const counters = {
      readOperations: 0,
      writeOperations: 0,
      removeOperations: 0,
      listOperations: 0,
      bytesRead: 0,
      bytesWritten: 0,
    };
    const handle = TEST_ONLY.createCountingSyncAccessHandle({
      handle: {
        getSize: () => physicalSize,
        read: (buffer, options) => {
          const destination = new Uint8Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength,
          );
          const offset = options?.at ?? 0;
          const length = Math.min(destination.byteLength, physicalSize - offset);
          destination.set(physical.subarray(offset, offset + length));
          return length;
        },
        write: (buffer, options) => {
          const source = ArrayBuffer.isView(buffer)
            ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
            : new Uint8Array(buffer);
          const offset = options?.at ?? 0;
          physical.set(source, offset);
          physicalSize = Math.max(physicalSize, offset + source.byteLength);
          return source.byteLength;
        },
        truncate: (newSize) => {
          physicalSize = newSize;
        },
        flush: () => {},
        close: () => {},
      },
      counters,
      onCommitted: () => {
        committed += 1;
      },
    });

    expect(handle.write(new Uint8Array([4, 5, 6]), { at: 2 })).toBe(3);
    const result = new Uint8Array(3);
    expect(handle.read(result, { at: 2 })).toBe(3);
    handle.flush();

    expect(result).toEqual(new Uint8Array([4, 5, 6]));
    expect(counters).toMatchObject({
      readOperations: 1,
      writeOperations: 1,
      bytesRead: 3,
      bytesWritten: 3,
    });
    expect(committed).toBe(1);
  });

  it('compares isolated HizoFS and raw OPFS workloads and deletes run data', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const progressMessages: string[] = [];

    const report = await runHizoFSBenchmark({
      configuration: createTinyConfiguration(),
      onProgress: ({ progress }) => progressMessages.push(progress.message),
      assertActive: () => {},
      nativeOpfsRoot: root,
    });
    expect(() => hizoFSBenchmarkReportSchema.parse(report)).not.toThrow();

    expect(report.status).toBe('completed');
    expect(report.measurementModel).toEqual({
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
        fileChunkWriteConcurrencyPerWriter: 4,
        fileChunkReadPrefetchConcurrencyPerReader: 4,
        backingFileHandleCacheEntryLimitPerRuntime: 1024,
        backingFileSnapshotCacheEntryLimitPerRuntime: 128,
        maximumPlaintextChunkWriteBytesInFlightPerWriter: 1024 * 1024,
        maximumPlaintextChunkReadBytesInFlightPerReader: 1024 * 1024,
        metadataObjectCacheByteLimitPerRuntime: 8 * 1024 * 1024,
        metadataObjectCacheEntryLimitPerRuntime: 16 * 1024,
        fileChunkCacheByteLimitPerRuntime: 16 * 1024 * 1024 + 64 * 1024,
        fileChunkCacheEntryLimitPerRuntime: 2048,
        fileChunkCacheAdmission: 'read_only',
      },
    });
    expect(report.results.map(result => result.caseId)).toEqual([
      'small_files_create_empty',
      'small_files_write_existing',
      'small_files_read',
      'small_files_delete',
    ]);
    const readResult = report.results.find(result => result.caseId === 'small_files_read');
    expect(readResult?.backends.rawOpfs?.samples[0]?.checksum)
      .toBe(readResult?.backends.hizofs?.samples[0]?.checksum);
    for (const result of report.results) {
      expect(result.backends.rawOpfs?.sampleCount).toBe(1);
      expect(result.backends.hizofs?.sampleCount).toBe(1);
      expect(result.comparison?.durationRatio).toBeGreaterThanOrEqual(0);
    }
    expect(report.results[0]?.backends.hizofs?.hizoFSDiagnosticsTotals)
      .toMatchObject({
        backingStore: {
          readOperations: expect.any(Number),
          writeOperations: expect.any(Number),
        },
        commits: {
          superblockPublications: expect.any(Number),
        },
      });
    expect(report.results[0]?.backends.hizofs?.samples[0]?.hizoFSDiagnostics)
      .toMatchObject({
        backingStore: {
          readOperations: expect.any(Number),
          writeOperations: expect.any(Number),
        },
        commits: {
          superblockPublications: expect.any(Number),
        },
      });
    const createResult = report.results.find(
      result => result.caseId === 'small_files_create_empty',
    );
    expect(createResult?.backends.hizofs?.samples[0]?.hizoFSDiagnostics).toMatchObject({
      backingStore: { writeOperations: 6 },
      objects: { created: 0 },
      commits: { superblockPublications: 3 },
      amplification: { objectCreatesPerOperation: 0 },
      runtime: {
        phases: {
          object_encrypt: { operationCount: expect.any(Number) },
          backing_close_random_access: { operationCount: expect.any(Number) },
          commit_publication: { operationCount: expect.any(Number) },
        },
        records: {
          file_inode: { writeOperations: 3 },
          directory_inode: { writeOperations: 3 },
          commit: { writeOperations: 3 },
          superblock: { writeOperations: 3 },
        },
      },
    });
    const writeResult = report.results.find(
      result => result.caseId === 'small_files_write_existing',
    );
    expect(createResult?.backends.hizofs?.samples[0]?.apiOperations).toMatchObject({
      fileCreates: 3,
      writableOpens: 0,
    });
    expect(writeResult?.backends.hizofs?.samples[0]?.apiOperations).toMatchObject({
      fileCreates: 0,
      writableOpens: 3,
      writeCalls: 3,
    });
    expect(writeResult?.backends.hizofs?.samples[0]?.memory).toEqual({
      maximumTrackedBytes: 32,
      largestTrackedAllocationBytes: 32,
      scope: 'benchmark_harness_buffers_only',
    });
    expect(writeResult?.backends.rawOpfs?.samples[0]?.memory).toEqual({
      maximumTrackedBytes: 64,
      largestTrackedAllocationBytes: 32,
      scope: 'benchmark_harness_buffers_only',
    });
    expect(
      writeResult?.backends.hizofs?.samples[0]
        ?.hizoFSDiagnostics?.amplification.superblockPublicationsPerOperation,
    ).toBeGreaterThan(0);
    expect(
      writeResult?.backends.hizofs
        ?.hizoFSDiagnosticsTotals?.amplification.superblockPublicationsPerOperation,
    ).toBeGreaterThan(0);
    expect(
      report.results[0]?.backends.hizofs?.samples[0]
        ?.hizoFSDiagnostics?.commits.superblockPublications,
    ).toBeGreaterThan(0);
    expect(
      report.results[0]?.backends.hizofs?.samples[0]
        ?.hizoFSDiagnostics?.runtime.records.commit.writeOperations,
    ).toBeGreaterThan(0);
    expect(report.cleanup).toEqual({
      attempted: true,
      completed: true,
      retainedByConfiguration: false,
      remainingPaths: [],
    });
    const benchmarkRoot = await root.getDirectoryHandle('naidan-debug-benchmark');
    expect([...(await collectNames({ directory: benchmarkRoot }))]).toEqual([]);
    expect(progressMessages).toContain('Cleaning benchmark data');
  });

  it('removes retained benchmark runs through the explicit cleanup operation', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const configuration: HizoFSBenchmarkConfiguration = {
      ...createTinyConfiguration(),
      benchmarkDataRetention: 'keep_after_run',
    };

    const report = await runHizoFSBenchmark({
      configuration,
      onProgress: () => {},
      assertActive: () => {},
      nativeOpfsRoot: root,
    });

    expect(report.cleanup).toEqual({
      attempted: false,
      completed: false,
      retainedByConfiguration: true,
      remainingPaths: [`naidan-debug-benchmark/run-${report.runId}`],
    });

    await cleanHizoFSBenchmarkData({ nativeOpfsRoot: root });
    await expect(root.getDirectoryHandle('naidan-debug-benchmark'))
      .rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('returns a cancelled report and cleans the isolated run', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    let activeChecks = 0;

    const report = await runHizoFSBenchmark({
      configuration: createTinyConfiguration(),
      onProgress: () => {},
      assertActive: () => {
        activeChecks += 1;
        throw new DOMException('cancelled', 'AbortError');
      },
      nativeOpfsRoot: root,
    });

    expect(activeChecks).toBeGreaterThan(0);
    expect(report.status).toBe('cancelled');
    expect(report.failure).toMatchObject({
      errorName: 'AbortError',
    });
    expect(report.cleanup.completed).toBe(true);
  });

  it('creates fresh stores per iteration without carrying object growth forward', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const configuration: HizoFSBenchmarkConfiguration = {
      ...createTinyConfiguration(),
      backendMode: 'hizofs_only',
      measuredIterations: 2,
      storeLifecycle: 'fresh_per_iteration',
    };

    const report = await runHizoFSBenchmark({
      configuration,
      onProgress: () => {},
      assertActive: () => {},
      nativeOpfsRoot: root,
    });

    const createEvents = report.lifecycleEvents.filter(
      event => event.backend === 'hizofs' && event.action === 'create_context',
    );
    expect(createEvents).toHaveLength(2);
    expect(createEvents.map(event => event.iteration)).toEqual([0, 1]);
    expect(createEvents[0]?.hizoFS?.objectsAfter)
      .toBe(createEvents[1]?.hizoFS?.objectsAfter);
  });

  it('records accumulated object growth when a store is reused without garbage collection', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const configuration: HizoFSBenchmarkConfiguration = {
      ...createTinyConfiguration(),
      backendMode: 'hizofs_only',
      measuredIterations: 2,
      storeLifecycle: 'reuse_without_gc',
    };

    const report = await runHizoFSBenchmark({
      configuration,
      onProgress: () => {},
      assertActive: () => {},
      nativeOpfsRoot: root,
    });

    const createResult = report.results.find(
      result => result.caseId === 'small_files_create_empty',
    );
    const samples = createResult?.backends.hizofs?.samples
      .filter(sample => sample.includedInAggregates) ?? [];
    expect(samples).toHaveLength(2);
    expect(samples[1]?.hizoFSDiagnostics?.objects.before)
      .toBeGreaterThanOrEqual(samples[0]?.hizoFSDiagnostics?.objects.before ?? 0);
    expect(samples[0]?.hizoFSDiagnostics?.runtime.records.commit.writeOperations)
      .toBeGreaterThan(0);
    expect(samples[1]?.hizoFSDiagnostics?.runtime.records.commit.writeOperations)
      .toBeGreaterThan(0);
    expect(report.lifecycleEvents.filter(event => event.action === 'garbage_collection'))
      .toHaveLength(0);
  });

  it('records structural garbage-collection diagnostics between reused iterations', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const configuration: HizoFSBenchmarkConfiguration = {
      ...createTinyConfiguration(),
      backendMode: 'hizofs_only',
      measuredIterations: 2,
      storeLifecycle: 'reuse_with_gc_between_iterations',
    };

    const report = await runHizoFSBenchmark({
      configuration,
      onProgress: () => {},
      assertActive: () => {},
      nativeOpfsRoot: root,
    });

    const gcEvents = report.lifecycleEvents.filter(
      event => event.action === 'garbage_collection',
    );
    expect(gcEvents).toHaveLength(1);
    expect(gcEvents[0]?.hizoFS).toMatchObject({
      reachableObjectCount: expect.any(Number),
      unreachableObjectCount: expect.any(Number),
      removedObjectCount: expect.any(Number),
      garbageCollection: {
        configuredRemoveConcurrency: 4,
        configuredMaximumRemovalsPerSlice: 16,
        configuredMaximumSliceDurationMs: 150,
        sweepSliceCount: expect.any(Number),
        maximumPauseDurationMs: expect.any(Number),
        maximumRemovesInFlight: expect.any(Number),
        changedSegmentCount: expect.any(Number),
      },
      backingStore: {
        readOperations: expect.any(Number),
        removeOperations: expect.any(Number),
      },
      superblockPublications: expect.any(Number),
    });
    expect(gcEvents[0]?.hizoFS?.unreachableObjectCount).toBeGreaterThan(0);
    expect(gcEvents[0]?.hizoFS?.removedObjectCount).toBeLessThanOrEqual(
      gcEvents[0]?.hizoFS?.unreachableObjectCount ?? 0,
    );
    expect(gcEvents[0]?.hizoFS?.objectsAfter)
      .toBeLessThanOrEqual(gcEvents[0]?.hizoFS?.objectsBefore ?? 0);
  });

  it('reopens the same HizoFS store between iterations without resetting object state', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const configuration: HizoFSBenchmarkConfiguration = {
      ...createTinyConfiguration(),
      backendMode: 'hizofs_only',
      measuredIterations: 2,
      storeLifecycle: 'reopen_between_iterations',
    };

    const report = await runHizoFSBenchmark({
      configuration,
      onProgress: () => {},
      assertActive: () => {},
      nativeOpfsRoot: root,
    });

    expect(report.status).toBe('completed');
    const reopenEvents = report.lifecycleEvents.filter(
      event => event.action === 'reopen_context',
    );
    expect(reopenEvents).toHaveLength(1);
    expect(reopenEvents[0]?.hizoFS?.objectsAfter)
      .toBe(reopenEvents[0]?.hizoFS?.objectsBefore);
    expect(reopenEvents[0]?.hizoFS?.backingStore.readOperations).toBeGreaterThan(0);
  });

  it('records per-sample garbage-collection pause and slice diagnostics', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const configuration: HizoFSBenchmarkConfiguration = {
      ...createTinyConfiguration(),
      backendMode: 'hizofs_only',
      workloads: ['hizofs_maintenance'],
      warmupIterations: 0,
      measuredIterations: 1,
      storeLifecycle: 'fresh_per_iteration',
      hizoFSMaintenance: {
        cloneCount: 4,
        sourceFileSizeBytes: 32,
        garbageCollectionSweep: {
          removeConcurrency: 2,
          maximumRemovalsPerSlice: 3,
          maximumSliceDurationMs: 10,
        },
      },
    };

    const report = await runHizoFSBenchmark({
      configuration,
      onProgress: () => {},
      assertActive: () => {},
      nativeOpfsRoot: root,
    });

    const gcResult = report.results.find(
      result => result.caseId === 'hizofs_garbage_collection',
    );
    const diagnostics = gcResult?.backends.hizofs?.samples[0]?.garbageCollection;
    const foregroundLatency = gcResult?.backends.hizofs?.samples[0]
      ?.foregroundLatency;
    expect(diagnostics).toMatchObject({
      configuredRemoveConcurrency: 2,
      configuredMaximumRemovalsPerSlice: 3,
      configuredMaximumSliceDurationMs: 10,
      sweepSliceCount: expect.any(Number),
      maximumPauseDurationMs: expect.any(Number),
      maximumRemovesInFlight: expect.any(Number),
    });
    expect(foregroundLatency).toMatchObject({
      operationCount: expect.any(Number),
      durationMs: {
        median: expect.any(Number),
        p95: expect.any(Number),
        maximum: expect.any(Number),
      },
    });
    expect(foregroundLatency?.operationCount).toBeGreaterThan(0);
    expect(() => hizoFSBenchmarkReportSchema.parse(report)).not.toThrow();
  });

  it('compares per-entry commits with one fresh-target bulk commit', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const entryCount = 5;
    const configuration: HizoFSBenchmarkConfiguration = {
      ...createTinyConfiguration(),
      workloads: ['bulk_operations'],
      directoryOperations: { entryCount },
      storeLifecycle: 'fresh_per_iteration',
    };

    const report = await runHizoFSBenchmark({
      configuration,
      onProgress: () => {},
      assertActive: () => {},
      nativeOpfsRoot: root,
    });

    expect(() => hizoFSBenchmarkReportSchema.parse(report)).not.toThrow();
    const perOperation = report.results.find(
      result => result.caseId === 'bulk_create_empty_files_per_operation',
    );
    const bulk = report.results.find(
      result => result.caseId === 'bulk_create_empty_files_one_commit',
    );
    expect(perOperation?.backends.rawOpfs).toBeDefined();
    expect(perOperation?.backends.hizofs).toBeDefined();
    expect(bulk?.backends.rawOpfs).toBeUndefined();
    expect(bulk?.backends.hizofs).toBeDefined();

    const perOperationSample = perOperation?.backends.hizofs?.samples[0];
    const bulkSample = bulk?.backends.hizofs?.samples[0];
    expect(perOperationSample?.operationCount).toBe(entryCount);
    expect(perOperationSample?.hizoFSDiagnostics?.commits.superblockPublications)
      .toBe(entryCount);
    expect(bulkSample?.operationCount).toBe(entryCount);
    expect(bulkSample?.apiOperations).toMatchObject({
      bulkBuilderCreates: 1,
      bulkEntryCreates: entryCount,
      bulkCommits: 1,
    });
    expect(bulkSample?.hizoFSDiagnostics?.commits.superblockPublications).toBe(1);
    expect(
      bulkSample?.hizoFSDiagnostics?.amplification
        .superblockPublicationsPerOperation,
    ).toBe(1 / entryCount);
  });

});

async function collectNames({
  directory,
}: {
  directory: FileSystemDirectoryHandle;
}): Promise<readonly string[]> {
  const result: string[] = [];
  for await (const [name] of directory.entries()) result.push(name);
  return result;
}
