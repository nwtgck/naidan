import { describe, expect, it } from 'vitest';
import { parseSegmentId, segmentIdToRelativePath } from '@/00-storage/service/hizofs/00-format';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { createHizoFSBenchmarkPresetConfiguration } from './presets';
import {
  hizoFSBenchmarkReportSchema,
  type HizoFSBenchmarkConfiguration,
} from './types';
import { cleanHizoFSBenchmarkData, runHizoFSBenchmark, TEST_ONLY } from './engine';
import { createInMemoryBenchmarkRuntimePort } from './test-support/in-memory-runtime-port';


async function runTestBenchmark({
  configuration,
  onProgress,
  assertActive,
  nativeOpfsRoot,
}: Omit<Parameters<typeof runHizoFSBenchmark>[0], 'runtimePort'>) {
  const { port } = createInMemoryBenchmarkRuntimePort();
  return runHizoFSBenchmark({
    configuration,
    onProgress,
    assertActive,
    nativeOpfsRoot,
    runtimePort: port,
  });
}

function createTinyConfiguration(): HizoFSBenchmarkConfiguration {
  return {
    ...createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
    backingStoreDiagnosticsMode: 'detailed',
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

  it('tracks only canonical V1 Segment paths and derives exact physical shape', () => {
    const metadataPath = segmentIdToRelativePath({
      id: parseSegmentId({ bytes: new Uint8Array(16).fill(1) }),
      segmentClass: 'metadata',
    });
    const dataPath = segmentIdToRelativePath({
      id: parseSegmentId({ bytes: new Uint8Array(16).fill(2) }),
      segmentClass: 'data',
    });
    expect(TEST_ONLY.parseCanonicalTrackedSegmentPath({
      relativePath: metadataPath.split('/'),
    })).toMatchObject({
      physicalPath: metadataPath,
      segmentClass: 'metadata',
      shard: '01',
    });
    expect(TEST_ONLY.parseCanonicalTrackedSegmentPath({
      relativePath: dataPath.split('/'),
    })).toMatchObject({
      physicalPath: dataPath,
      segmentClass: 'data',
      shard: '02',
    });
    expect(TEST_ONLY.parseCanonicalTrackedSegmentPath({
      relativePath: metadataPath.replace(/[^/]+$/u, 'legacy.seg').split('/'),
    })).toBeUndefined();
    expect(TEST_ONLY.parseCanonicalTrackedSegmentPath({
      relativePath: ['segments', 'relocation', '01', 'legacy.seg'],
    })).toBeUndefined();

    expect(TEST_ONLY.snapshotPhysicalStoreShape({
      objectPaths: new Set([metadataPath, dataPath, 'segments/metadata/01/legacy.seg']),
    })).toEqual({
      segmentFiles: { metadata: 1, data: 1, total: 2 },
      segmentShards: { metadata: 1, data: 1, total: 2 },
    });
  });

  it('fails closed when the production runtime capability is not connected', async () => {
    const report = await runHizoFSBenchmark({
      configuration: {
        ...createTinyConfiguration(),
        backendMode: 'hizofs_only',
      },
      onProgress: () => undefined,
      assertActive: () => undefined,
      nativeOpfsRoot: new MockFileSystemDirectoryHandle({ name: 'opfs-root' }),
      runtimePort: undefined,
    });

    expect(report).toMatchObject({
      status: 'failed',
      failure: {
        errorMessage: 'HizoFS benchmark runtime is not connected',
      },
      cleanup: {
        attempted: true,
      },
    });
  });

  it('counts random-access segment reads, writes, and durable flushes', () => {
    const physical = new Uint8Array(16);
    let physicalSize = 0;
    let committed = 0;
    const counters = TEST_ONLY.createEmptyBackingStoreCounters();
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

  it('separates file snapshots from materialized blob reads', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const source = await root.getFileHandle('value.bin', { create: true });
    const writable = await source.createWritable();
    await writable.write(new Uint8Array([1, 2, 3, 4]));
    await writable.close();
    const counters = TEST_ONLY.createEmptyBackingStoreCounters();
    const countedRoot = TEST_ONLY.createCountingDirectoryHandle({
      directory: root,
      counters,
      diagnosticsMode: 'detailed',
      relativePath: [],
      physicalDiagnostics: {
        objectPaths: new Set<string>(),
        superblockPublications: 0,
      },
    });

    await countedRoot.getDirectoryHandle('created', { create: true });
    await countedRoot.getFileHandle('created.bin', { create: true });
    const segments = await countedRoot.getDirectoryHandle('segments', { create: true });
    const metadata = await segments.getDirectoryHandle('metadata', { create: true });
    const shard = await metadata.getDirectoryHandle('ab', { create: true });
    const segment = await shard.getFileHandle('segment.enc', { create: true });
    await segment.getFile();
    await Array.fromAsync(shard.keys());
    const snapshot = await (await countedRoot.getFileHandle('value.bin')).getFile();
    expect(counters).toMatchObject({
      directoryHandleLookups: 4,
      directoryHandleCreateRequests: 4,
      fileHandleLookups: 3,
      fileHandleCreateRequests: 2,
      fileSnapshotOperations: 2,
      listEntriesMaterialized: 1,
      readOperations: 0,
      bytesRead: 0,
      pathAttribution: {
        directoryHandleLookups: {
          segmentRoot: 1,
          segmentClass: 1,
          segmentShard: 1,
          other: 1,
        },
        fileHandleLookups: {
          metadataSegment: 1,
          other: 2,
        },
        fileSnapshotOperations: {
          metadataSegment: 1,
          other: 1,
        },
        listOperations: {
          segmentShard: 1,
        },
        listEntriesMaterialized: {
          segmentShard: 1,
        },
      },
    });
    expect(new Uint8Array(await snapshot.slice(1, 3).arrayBuffer()))
      .toEqual(new Uint8Array([2, 3]));
    expect(counters).toMatchObject({
      fileSnapshotOperations: 2,
      readOperations: 1,
      bytesRead: 2,
    });
  });


  it('keeps basic backing counters while omitting path attribution', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const counters = TEST_ONLY.createEmptyBackingStoreCounters();
    const countedRoot = TEST_ONLY.createCountingDirectoryHandle({
      directory: root,
      counters,
      diagnosticsMode: 'basic',
      relativePath: [],
      physicalDiagnostics: {
        objectPaths: new Set<string>(),
        superblockPublications: 0,
      },
    });

    const segments = await countedRoot.getDirectoryHandle('segments', { create: true });
    const metadata = await segments.getDirectoryHandle('metadata', { create: true });
    const shard = await metadata.getDirectoryHandle('ab', { create: true });
    await shard.getFileHandle('segment.enc', { create: true });
    await Array.fromAsync(shard.keys());

    expect(counters).toMatchObject({
      directoryHandleLookups: 3,
      directoryHandleCreateRequests: 3,
      fileHandleLookups: 1,
      fileHandleCreateRequests: 1,
      listOperations: 1,
      listEntriesMaterialized: 1,
    });
    expect(counters.pathAttribution).toEqual({
      directoryHandleLookups: {
        root: 0, segmentRoot: 0, segmentClass: 0, segmentShard: 0, other: 0,
      },
      directoryHandleCreateRequests: {
        root: 0, segmentRoot: 0, segmentClass: 0, segmentShard: 0, other: 0,
      },
      fileHandleLookups: {
        superblock: 0, unlockEnvelope: 0, metadataSegment: 0,
        dataSegment: 0, relocationSegment: 0, other: 0,
      },
      fileHandleCreateRequests: {
        superblock: 0, unlockEnvelope: 0, metadataSegment: 0,
        dataSegment: 0, relocationSegment: 0, other: 0,
      },
      fileSnapshotOperations: {
        superblock: 0, unlockEnvelope: 0, metadataSegment: 0,
        dataSegment: 0, relocationSegment: 0, other: 0,
      },
      listOperations: {
        root: 0, segmentRoot: 0, segmentClass: 0, segmentShard: 0, other: 0,
      },
      listEntriesMaterialized: {
        root: 0, segmentRoot: 0, segmentClass: 0, segmentShard: 0, other: 0,
      },
    });
  });

  it('compares isolated HizoFS and raw OPFS workloads and deletes run data', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const progressMessages: string[] = [];

    const report = await runTestBenchmark({
      configuration: createTinyConfiguration(),
      onProgress: ({ progress }) => progressMessages.push(progress.message),
      assertActive: () => {},
      nativeOpfsRoot: root,
    });
    expect(() => hizoFSBenchmarkReportSchema.parse(report)).not.toThrow();

    expect(report.status).toBe('completed');
    expect(report.measurementModel).toEqual({
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
        fileChunkSizeBytes: 256 * 1024,
        maxDirtyFileBytesPerWriter: 16 * 1024 * 1024,
        fileChunkWriteConcurrencyPerWriter: 2,
        fileChunkReadPrefetchConcurrencyPerReader: 4,
        backingFileHandleCacheEntryLimitPerRuntime: 1024,
        backingFileSnapshotCacheEntryLimitPerRuntime: 128,
        maximumPlaintextChunkWriteBytesInFlightPerWriter: 512 * 1024,
        fileDataAppendBatchFrameByteLimitPerWriter: 4 * 1024 * 1024,
        fileDataAppendBatchRecordLimitPerWriter: 128,
        fileExtentMutationBatchEntryLimitPerWriter: 64,
        maximumPlaintextChunkReadBytesInFlightPerReader: 1024 * 1024,
        metadataObjectCacheByteLimitPerRuntime: 8 * 1024 * 1024,
        metadataObjectCacheEntryLimitPerRuntime: 16 * 1024,
        decodedInodeIndexPageCacheEntryLimitPerRuntime: 128,
        inodeIndexLeafEntryLimitPerRuntime: 32,
        directoryIndexLeafEntryLimitPerRuntime: 64,
        fileExtentIndexLeafEntryLimitPerRuntime: 32,
        fileChunkCacheByteLimitPerRuntime: 16 * 1024 * 1024 + 64 * 1024,
        fileChunkCacheEntryLimitPerRuntime: 2048,
        fileChunkCacheAdmission: 'read',
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
      backingStore: {
        directoryHandleLookups: expect.any(Number),
        directoryHandleCreateRequests: expect.any(Number),
        fileHandleLookups: expect.any(Number),
        fileHandleCreateRequests: expect.any(Number),
        writeOperations: 6,
      },
      objects: { created: 3 },
      commits: { superblockPublications: 3 },
      amplification: {
        commitMaterializationsPerOperation: 1,
        objectCreatesPerOperation: 1,
      },
      runtime: {
        phases: {
          object_encrypt: { operationCount: expect.any(Number) },
          physical_close_file: { operationCount: expect.any(Number) },
          commit_publication: { operationCount: expect.any(Number) },
        },
        records: {
          inode_table_page: { writeOperations: 3 },
          directory_page: { writeOperations: 3 },
          file_system_commit: { writeOperations: 3 },
        },
        coordinator: {
          activeStateCacheHits: expect.any(Number),
          durableReloads: expect.any(Number),
          leadershipAcquisitions: expect.any(Number),
          failovers: 0,
          localRequests: expect.any(Number),
          remoteRequests: 0,
        },
        indexes: {
          update: {
            inputMutations: 3,
            maximumPageLevel: 1,
            operations: 3,
            pageReads: 3,
            pageWrites: 3,
          },
        },
      },
    });
    const createBackingStoreDiagnostics = createResult?.backends.hizofs?.samples[0]
      ?.hizoFSDiagnostics?.backingStore;
    expect(createBackingStoreDiagnostics?.directoryHandleLookups).toBeGreaterThan(0);
    expect(createBackingStoreDiagnostics?.directoryHandleCreateRequests).toBeGreaterThan(0);
    expect(createBackingStoreDiagnostics?.fileHandleLookups).toBeGreaterThan(0);
    expect(createBackingStoreDiagnostics?.fileHandleCreateRequests).toBeGreaterThan(0);
    expect(createBackingStoreDiagnostics?.pathAttribution.directoryHandleLookups.segmentRoot)
      .toBeGreaterThan(0);
    expect(createBackingStoreDiagnostics?.pathAttribution.directoryHandleLookups.segmentClass)
      .toBeGreaterThan(0);
    expect(createBackingStoreDiagnostics?.pathAttribution.directoryHandleLookups.segmentShard)
      .toBeGreaterThan(0);
    expect(createBackingStoreDiagnostics?.pathAttribution.fileHandleLookups.metadataSegment)
      .toBeGreaterThan(0);
    expect(createBackingStoreDiagnostics?.pathAttribution.fileHandleLookups.superblock)
      .toBeGreaterThan(0);
    expect(createBackingStoreDiagnostics?.listEntriesMaterialized).toBe(
      Object.values(
        createBackingStoreDiagnostics?.pathAttribution.listEntriesMaterialized ?? {},
      ).reduce((total, value) => total + value, 0),
    );
    const createDiagnostics = createResult?.backends.hizofs?.samples[0]?.hizoFSDiagnostics;
    if (createDiagnostics === undefined) {
      throw new TypeError('expected create diagnostics');
    }
    expect(
      createDiagnostics.physicalStore.after.segmentFiles.total
      - createDiagnostics.physicalStore.before.segmentFiles.total,
    ).toBe(createDiagnostics.objects.created);
    expect(createDiagnostics.physicalStore.after.segmentFiles.metadata)
      .toBeGreaterThan(createDiagnostics.physicalStore.before.segmentFiles.metadata);
    expect(createDiagnostics.physicalStore.after.segmentShards.total)
      .toBeGreaterThanOrEqual(createDiagnostics.physicalStore.before.segmentShards.total);
    const createRuntimeDiagnostics = createResult?.backends.hizofs?.samples[0]
      ?.hizoFSDiagnostics?.runtime;
    expect(createRuntimeDiagnostics?.type).toBe('measured');
    if (createRuntimeDiagnostics?.type !== 'measured') {
      throw new TypeError('expected measured runtime diagnostics');
    }
    expect(createRuntimeDiagnostics.coordinator.activeStateCacheHits).toBeGreaterThan(0);
    expect(createRuntimeDiagnostics.indexes.update).toMatchObject({
      inputMutations: 3,
      maximumPageLevel: 1,
      operations: 3,
      pageReads: 3,
      pageWrites: 3,
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
        ?.hizoFSDiagnostics?.amplification.commitMaterializationsPerOperation,
    ).toBeGreaterThan(0);
    expect(
      writeResult?.backends.hizofs?.samples[0]
        ?.hizoFSDiagnostics?.amplification.superblockPublicationsPerOperation,
    ).toBeGreaterThan(0);
    expect(
      writeResult?.backends.hizofs
        ?.hizoFSDiagnosticsTotals?.amplification.commitMaterializationsPerOperation,
    ).toBeGreaterThan(0);
    expect(
      writeResult?.backends.hizofs
        ?.hizoFSDiagnosticsTotals?.amplification.superblockPublicationsPerOperation,
    ).toBeGreaterThan(0);
    expect(
      report.results[0]?.backends.hizofs?.samples[0]
        ?.hizoFSDiagnostics?.commits.superblockPublications,
    ).toBeGreaterThan(0);
    const firstRuntimeDiagnostics = report.results[0]?.backends.hizofs?.samples[0]
      ?.hizoFSDiagnostics?.runtime;
    expect(firstRuntimeDiagnostics?.type).toBe('measured');
    if (firstRuntimeDiagnostics?.type !== 'measured') {
      throw new TypeError('expected measured runtime diagnostics');
    }
    expect(firstRuntimeDiagnostics.records.file_system_commit.writeOperations).toBeGreaterThan(0);
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

    const report = await runTestBenchmark({
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

    const report = await runTestBenchmark({
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

    const report = await runTestBenchmark({
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

    const report = await runTestBenchmark({
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
    const firstRuntime = samples[0]?.hizoFSDiagnostics?.runtime;
    const secondRuntime = samples[1]?.hizoFSDiagnostics?.runtime;
    expect(firstRuntime?.type).toBe('measured');
    expect(secondRuntime?.type).toBe('measured');
    if (firstRuntime?.type !== 'measured' || secondRuntime?.type !== 'measured') {
      throw new TypeError('expected measured runtime diagnostics');
    }
    expect(firstRuntime.records.file_system_commit.writeOperations).toBeGreaterThan(0);
    expect(secondRuntime.records.file_system_commit.writeOperations).toBeGreaterThan(0);
    expect(firstRuntime.indexes.update.maximumPageLevel).toBe(1);
    expect(secondRuntime.indexes.update.maximumPageLevel).toBe(1);
    expect(createResult?.backends.hizofs?.hizoFSDiagnosticsTotals?.runtime).toMatchObject({
      type: 'measured',
      indexes: {
        update: {
          inputMutations: 6,
          maximumPageLevel: 1,
          operations: 6,
          pageReads: 6,
          pageWrites: 6,
        },
      },
    });
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

    const report = await runTestBenchmark({
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

    const report = await runTestBenchmark({
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

    const report = await runTestBenchmark({
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

    const report = await runTestBenchmark({
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
