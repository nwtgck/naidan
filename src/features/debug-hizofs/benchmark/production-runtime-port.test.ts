import { HizoFSRuntimeDiagnosticsUnavailableError } from '@/00-storage/service/hizofs/diagnostics/runtime-diagnostics';
import { InMemoryOpfsDirectoryHandle } from '@/00-storage/service/test-support/in-memory-opfs';
import { cleanHizoFSBenchmarkData, runHizoFSBenchmark } from '@/features/debug-hizofs/benchmark/engine';
import { createHizoFSBenchmarkPresetConfiguration } from '@/features/debug-hizofs/benchmark/presets';
import { createProductionHizoFSBenchmarkRuntimePort, TEST_ONLY } from '@/features/debug-hizofs/benchmark/production-runtime-port';
import { createBenchmarkRuntimePolicy } from '@/features/debug-hizofs/benchmark/runtime-port';
import type { HizoFSBenchmarkConfiguration } from '@/features/debug-hizofs/benchmark/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let originalLocks: LockManager;

function createTestBrowserLockManager(): LockManager {
  const held = new Set<string>();
  const request = async <T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (callback === undefined) throw new Error('browser lock callback is required');
    held.add(name);
    try {
      return await callback({ name, mode: 'exclusive' } as Lock);
    } finally {
      held.delete(name);
    }
  };
  return {
    query: async () => ({
      held: [...held].map(name => ({ clientId: 'test', mode: 'exclusive' as const, name })),
      pending: [],
    }),
    request: request as LockManager['request'],
  } as LockManager;
}

beforeEach(() => {
  originalLocks = navigator.locks;
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: createTestBrowserLockManager(),
  });
});

afterEach(() => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: originalLocks,
  });
});

describe('production HizoFS benchmark runtime port', () => {
  it('reports centralized diagnostics recording failure as unavailable', () => {
    const diagnostics = TEST_ONLY.measuredRuntimeDiagnostics({
      resetHighWaterMarks: () => undefined,
      snapshotRuntimeDiagnostics: () => {
        throw new HizoFSRuntimeDiagnosticsUnavailableError();
      },
    });

    expect(diagnostics.snapshot()).toEqual({
      reason: 'runtime diagnostics recording failed',
      schemaVersion: 9,
      type: 'unavailable',
    });
  });

  it('does not hide non-diagnostics snapshot failures', () => {
    const diagnostics = TEST_ONLY.measuredRuntimeDiagnostics({
      resetHighWaterMarks: () => undefined,
      snapshotRuntimeDiagnostics: () => {
        throw new Error('unexpected snapshot failure');
      },
    });

    expect(() => diagnostics.snapshot()).toThrow('unexpected snapshot failure');
  });

  it('preserves data across a normal authenticated reopen', async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: 'worker', name: 'opfs-root' });
    const configuration = createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' });
    const runtime = await createProductionHizoFSBenchmarkRuntimePort().createRuntime({
      backingDirectory: root as unknown as FileSystemDirectoryHandle,
      policy: createBenchmarkRuntimePolicy({ configuration }),
    });

    const file = await runtime.session.root.getFileHandle({
      name: 'persisted.txt',
      create: true,
    });
    const writable = await file.createWritable({ keepExistingData: false });
    await writable.write({
      position: 0,
      data: new TextEncoder().encode('persisted through reopen'),
    });
    await writable.close();
    await runtime.session.close();

    const reopened = await runtime.reopen();
    const reopenedFile = await reopened.root.getFileHandle({
      name: 'persisted.txt',
      create: false,
    });
    const readable = await reopenedFile.openReadable({ mimeType: 'text/plain' });
    try {
      await expect(new Response(readable.stream({
        start: 0,
        end: undefined,
        signal: undefined,
      })).text()).resolves.toBe('persisted through reopen');
    } finally {
      await readable.close();
      await runtime.close();
    }
  });

  it('publishes explicit bulk entries into a fresh public target', async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: 'worker', name: 'opfs-root' });
    const configuration = createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' });
    const runtime = await createProductionHizoFSBenchmarkRuntimePort().createRuntime({
      backingDirectory: root as unknown as FileSystemDirectoryHandle,
      policy: createBenchmarkRuntimePolicy({ configuration }),
    });
    try {
      const builder = await runtime.createBulkBuilder();
      expect(builder).toBeDefined();
      if (builder === undefined) throw new Error('production explicit bulk builder is unavailable');
      await builder.createEmptyFile({ name: 'bulk-a' });
      await builder.createEmptyFile({ name: 'bulk-b' });
      await builder.commit();
      await expect(builder.targetDirectory.getFileHandle({ create: false, name: 'bulk-a' }))
        .resolves.toBeDefined();
      await expect(builder.targetDirectory.getFileHandle({ create: false, name: 'bulk-b' }))
        .resolves.toBeDefined();
    } finally {
      await runtime.close();
    }
  });


  it('bounds repeated authenticated metadata reads and releases retained plaintext on close', async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: 'worker', name: 'opfs-root' });
    const configuration = createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' });
    const runtime = await createProductionHizoFSBenchmarkRuntimePort().createRuntime({
      backingDirectory: root as unknown as FileSystemDirectoryHandle,
      policy: createBenchmarkRuntimePolicy({ configuration }),
    });
    const entryCount = 16;
    const beforeOperations = runtime.diagnostics.snapshot();
    expect(beforeOperations.type).toBe('measured');
    if (beforeOperations.type !== 'measured') throw new Error('production diagnostics are unavailable');
    for (let index = 0; index < entryCount; index += 1) {
      await runtime.session.root.getFileHandle({ create: true, name: `metadata-${index}` });
    }
    await runtime.settleAcceptedGeneration();

    const beforeClose = runtime.diagnostics.snapshot();
    expect(beforeClose.type).toBe('measured');
    if (beforeClose.type !== 'measured') throw new Error('production diagnostics are unavailable');
    expect(beforeClose.caches.metadata.hits).toBeGreaterThan(beforeClose.caches.metadata.misses);
    expect(beforeClose.caches.metadata.currentEntries).toBeGreaterThan(0);
    // A disabled cache requires more than 400 exact reads for this fixed workload.
    // Keep the bound loose enough to measure structural amplification, not host timing.
    expect(beforeClose.phases.physical_read_exact.operationCount).toBeLessThan(entryCount * 20);
    expect(beforeClose.mutation.completed - beforeOperations.mutation.completed).toBe(entryCount);
    expect(beforeClose.segmentWriters.metadata.created - beforeOperations.segmentWriters.metadata.created)
      .toBe(1);
    expect(beforeClose.publication.getFileSize.operations - beforeOperations.publication.getFileSize.operations)
      .toBe(0);
    expect(beforeClose.publication.readExact.operations - beforeOperations.publication.readExact.operations)
      .toBe(0);

    await runtime.close();
    const afterClose = runtime.diagnostics.snapshot();
    expect(afterClose.type).toBe('measured');
    if (afterClose.type !== 'measured') throw new Error('production diagnostics are unavailable');
    expect(afterClose.caches.metadata).toMatchObject({ currentBytes: 0, currentEntries: 0 });
  }, 15_000);


  it('reuses authenticated metadata within one writable mutation and releases its plaintext', async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: 'worker', name: 'opfs-root' });
    const configuration = createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' });
    const runtime = await createProductionHizoFSBenchmarkRuntimePort().createRuntime({
      backingDirectory: root as unknown as FileSystemDirectoryHandle,
      policy: createBenchmarkRuntimePolicy({ configuration }),
    });
    try {
      const file = await runtime.session.root.getFileHandle({ name: 'mutation-cache.bin', create: true });
      const before = runtime.diagnostics.snapshot();
      expect(before.type).toBe('measured');
      if (before.type !== 'measured') throw new Error('production diagnostics are unavailable');

      const writable = await file.createWritable({ keepExistingData: false });
      await writable.write({ position: 0, data: new Uint8Array(4096).fill(1) });
      await writable.write({ position: 4096, data: new Uint8Array(4096).fill(2) });
      await writable.write({ position: 8192, data: new Uint8Array(4096).fill(3) });
      await writable.close();
      await runtime.settleAcceptedGeneration();

      const after = runtime.diagnostics.snapshot();
      expect(after.type).toBe('measured');
      if (after.type !== 'measured') throw new Error('production diagnostics are unavailable');
      expect(after.mutation.completed - before.mutation.completed).toBe(1);
      expect(after.mutation.failed - before.mutation.failed).toBe(0);
      expect(after.caches.mutationMetadata.hits - before.caches.mutationMetadata.hits)
        .toBeGreaterThan(0);
      expect(after.caches.mutationMetadata.misses - before.caches.mutationMetadata.misses)
        .toBeGreaterThan(0);
      expect(after.caches.mutationMetadata).toMatchObject({ currentBytes: 0, currentEntries: 0 });
      expect(after.caches.mutationMetadata.maximumEntries).toBeGreaterThan(0);
      expect(after.caches.metadata.hits - before.caches.metadata.hits).toBeGreaterThan(0);
      expect(after.mutation.physicalAccessReasons.append_read_back.readExact.operations
        - before.mutation.physicalAccessReasons.append_read_back.readExact.operations).toBeGreaterThan(0);
      expect(after.mutation.physicalAccessReasons.authenticated_record_resolution.readExact.operations
        - before.mutation.physicalAccessReasons.authenticated_record_resolution.readExact.operations).toBeGreaterThan(0);
      expect(after.segmentWriters.metadata.trustedTailMismatches
        - before.segmentWriters.metadata.trustedTailMismatches).toBe(0);

      const readable = await file.openReadable({ mimeType: 'application/octet-stream' });
      try {
        const bytes = new Uint8Array(await new Response(readable.stream({
          start: 0,
          end: undefined,
          signal: undefined,
        })).arrayBuffer());
        expect(bytes.byteLength).toBe(12_288);
        expect(bytes[0]).toBe(1);
        expect(bytes[4096]).toBe(2);
        expect(bytes[8192]).toBe(3);
      } finally {
        await readable.close();
      }
    } finally {
      await runtime.close();
    }
  }, 15_000);


  it('applies the reported metadata cache policy to the production runtime', async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: 'worker', name: 'opfs-root' });
    const configuration = createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' });
    const policy = {
      ...createBenchmarkRuntimePolicy({ configuration }),
      metadataObjectCacheByteLimit: 0,
      metadataObjectCacheEntryLimit: 0,
    };
    const runtime = await createProductionHizoFSBenchmarkRuntimePort().createRuntime({
      backingDirectory: root as unknown as FileSystemDirectoryHandle,
      policy,
    });
    try {
      await runtime.session.root.getFileHandle({ create: true, name: 'uncached' });
      const snapshot = runtime.diagnostics.snapshot();
      expect(snapshot.type).toBe('measured');
      if (snapshot.type !== 'measured') throw new Error('production diagnostics are unavailable');
      expect(snapshot.caches.metadata).toMatchObject({
        currentBytes: 0,
        currentEntries: 0,
        hits: 0,
      });
      expect(snapshot.caches.metadata.misses).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });

  it('revokes reopen after the isolated runtime closes', async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: 'worker', name: 'opfs-root' });
    const configuration = createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' });
    const runtime = await createProductionHizoFSBenchmarkRuntimePort().createRuntime({
      backingDirectory: root as unknown as FileSystemDirectoryHandle,
      policy: createBenchmarkRuntimePolicy({ configuration }),
    });
    await runtime.close();

    await expect(runtime.reopen()).rejects.toThrow('cannot reopen a closed HizoFS benchmark runtime');
  });

  it('runs an isolated real HizoFS workload without a disconnected-runtime failure', async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: 'worker', name: 'opfs-root' });
    const configuration: HizoFSBenchmarkConfiguration = {
      ...createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
      backendMode: 'hizofs_only' as const,
      warmupIterations: 0,
      measuredIterations: 1,
      workloads: ['small_files'],
      smallFiles: { count: 1, sizeBytes: 16 },
    };

    const report = await runHizoFSBenchmark({
      configuration,
      onProgress: () => undefined,
      assertActive: () => undefined,
      nativeOpfsRoot: root as unknown as FileSystemDirectoryHandle,
      runtimePort: createProductionHizoFSBenchmarkRuntimePort(),
    });

    expect(report.status).toBe('completed');
    expect(report.failure).toBeUndefined();
    expect(report.cleanup).toMatchObject({ attempted: true, completed: true });
    const benchmarkRoot = await root.getDirectoryHandle('naidan-debug-benchmark');
    const remainingRunNames: string[] = [];
    for await (const [name] of benchmarkRoot.entries()) remainingRunNames.push(name);
    expect(remainingRunNames).toEqual([]);
    const sample = report.results.find(result => result.caseId === 'small_files_create_empty')
      ?.backends.hizofs?.samples[0];
    const runtimeDiagnostics = sample?.hizoFSDiagnostics?.runtime;
    expect(runtimeDiagnostics?.type).toBe('measured');
    if (runtimeDiagnostics?.type !== 'measured') {
      throw new Error('production HizoFS runtime diagnostics are unavailable');
    }
    expect(runtimeDiagnostics.mutation).toMatchObject({
      abandoned: 0,
      completed: 1,
      failed: 0,
      overlapping: 0,
      getFileSize: {
        duplicateOperations: 1,
        operations: 2,
        observedUniqueTargets: 1,
      },
      physicalAccessReasons: {
        append_read_back: {
          readExact: { duplicateOperations: 0, operations: 2, observedUniqueTargets: 2 },
        },
        authenticated_record_resolution: {
          readExact: { duplicateOperations: 0, operations: 0, observedUniqueTargets: 0 },
        },
        segment_descriptor: {
          getFileSize: { duplicateOperations: 0, operations: 0, observedUniqueTargets: 0 },
          readExact: { duplicateOperations: 0, operations: 0, observedUniqueTargets: 0 },
        },
        trusted_tail: {
          getFileSize: { duplicateOperations: 1, operations: 2, observedUniqueTargets: 1 },
        },
      },
      readExact: {
        duplicateOperations: 0,
        operations: 2,
        observedUniqueTargets: 2,
      },
    });
    expect(runtimeDiagnostics.publication).toMatchObject({
      completed: 1,
      overlapping: 0,
      getFileSize: {
        duplicateOperations: 0,
        operations: 0,
        observedUniqueTargets: 0,
      },
      readExact: {
        duplicateOperations: 0,
        operations: 0,
        observedUniqueTargets: 0,
      },
    });
    expect(runtimeDiagnostics.indexes.update).toMatchObject({
      inputMutations: expect.any(Number),
      operations: expect.any(Number),
      pageReads: expect.any(Number),
      pageWrites: expect.any(Number),
    });
    expect(runtimeDiagnostics.indexes.update.operations).toBeGreaterThan(0);
    expect(runtimeDiagnostics.indexes.update.pageReads).toBeGreaterThan(0);
    expect(runtimeDiagnostics.indexes.get.operations).toBeGreaterThan(0);
    expect(runtimeDiagnostics.indexes.get.pageReads).toBeGreaterThan(0);
    expect(runtimeDiagnostics.caches.decodedInodeIndexPage.hits).toBeGreaterThan(0);
    expect(runtimeDiagnostics.inodeLeafLookup.indexBuilds).toBeGreaterThan(0);
    expect(runtimeDiagnostics.inodeLeafLookup.selectiveEntryHits).toBeGreaterThan(0);
    expect(runtimeDiagnostics.inodeLeafLookup.decodedEntryBytes).toBeGreaterThan(0);
    expect(runtimeDiagnostics.inodeLeafLookup.skippedPageBytes).toBeGreaterThan(0);
    expect(runtimeDiagnostics.indexes.validate_structure).toMatchObject({
      operations: 0,
      pageReads: 0,
    });
    expect(runtimeDiagnostics.segmentWriters.metadata).toMatchObject({
      appendOperations: 2,
      appendReadBackVerifications: 2,
      created: 0,
      descriptorValidations: 0,
      trustedTailMatches: 2,
      trustedTailMismatches: 0,
    });
    expect(runtimeDiagnostics.phases.physical_read_exact.operationCount).toBeGreaterThan(0);
    expect(runtimeDiagnostics.phases.physical_list.operationCount).toBe(0);
    expect(Object.values(runtimeDiagnostics.records).some(counter => counter.readOperations > 0)).toBe(true);
    expect(runtimeDiagnostics.caches.metadata.hits).toBeGreaterThan(0);
    expect(runtimeDiagnostics.caches.metadata.misses).toBeGreaterThan(0);
    expect(runtimeDiagnostics.caches.metadata.currentEntries).toBeGreaterThan(0);
    expect(runtimeDiagnostics.caches.mutationMetadata).toMatchObject({
      currentBytes: 0,
      currentEntries: 0,
      hits: 0,
      misses: 1,
    });
    expect(runtimeDiagnostics.caches.mutationMetadata.maximumEntries).toBe(1);
    expect(Object.values(runtimeDiagnostics.records).reduce((sum, counter) => sum + counter.cacheHits, 0))
      .toBe(runtimeDiagnostics.caches.metadata.hits + runtimeDiagnostics.caches.mutationMetadata.hits);
    expect(Object.values(runtimeDiagnostics.records).reduce((sum, counter) => sum + counter.cacheMisses, 0))
      .toBe(runtimeDiagnostics.caches.metadata.misses + runtimeDiagnostics.caches.mutationMetadata.misses);
  });

  it('reuses validated namespace successor proofs after Directory tree promotion', async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: 'worker', name: 'opfs-root' });
    const configuration: HizoFSBenchmarkConfiguration = {
      ...createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
      backendMode: 'hizofs_only' as const,
      warmupIterations: 0,
      measuredIterations: 1,
      workloads: ['small_files'],
      smallFiles: { count: 160, sizeBytes: 16 },
    };

    const report = await runHizoFSBenchmark({
      configuration,
      onProgress: () => undefined,
      assertActive: () => undefined,
      nativeOpfsRoot: root as unknown as FileSystemDirectoryHandle,
      runtimePort: createProductionHizoFSBenchmarkRuntimePort(),
    });

    expect(report.failure).toBeUndefined();
    expect(report.status).toBe('completed');
    const measuredRuntime = (caseId: string) => {
      const runtime = report.results.find(result => result.caseId === caseId)
        ?.backends.hizofs?.samples[0]?.hizoFSDiagnostics?.runtime;
      expect(runtime?.type).toBe('measured');
      if (runtime?.type !== 'measured') throw new Error(`${caseId} diagnostics are unavailable`);
      return runtime;
    };
    expect(measuredRuntime('small_files_create_empty').indexes.validate_structure).toMatchObject({
      operations: 1,
      pageReads: 1,
    });
    for (const caseId of ['small_files_write_existing', 'small_files_read']) {
      const runtime = measuredRuntime(caseId);
      expect(runtime.indexes.validate_structure).toMatchObject({
        operations: 0,
        pageReads: 0,
      });
      expect(runtime.caches.decodedInodeIndexPage.hits).toBeGreaterThan(0);
      expect(runtime.caches.decodedInodeIndexPage.currentEntries).toBeGreaterThan(0);
      expect(runtime.inodeLeafLookup.selectiveEntryHits).toBeGreaterThan(0);
      expect(runtime.inodeLeafLookup.skippedPageBytes).toBeGreaterThan(0);
    }
  }, 30_000);

  it('runs the explicit bulk benchmark as one measured publication', async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: 'worker', name: 'opfs-root' });
    const entryCount = 3;
    const configuration: HizoFSBenchmarkConfiguration = {
      ...createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
      backendMode: 'hizofs_only' as const,
      warmupIterations: 0,
      measuredIterations: 1,
      workloads: ['bulk_operations'],
      directoryOperations: { entryCount },
      storeLifecycle: 'fresh_per_iteration',
    };

    const report = await runHizoFSBenchmark({
      configuration,
      onProgress: () => undefined,
      assertActive: () => undefined,
      nativeOpfsRoot: root as unknown as FileSystemDirectoryHandle,
      runtimePort: createProductionHizoFSBenchmarkRuntimePort(),
    });

    expect(report.status).toBe('completed');
    expect(report.failure).toBeUndefined();
    const sample = report.results.find(
      result => result.caseId === 'bulk_create_empty_files_one_commit',
    )?.backends.hizofs?.samples[0];
    expect(sample?.operationCount).toBe(entryCount);
    expect(sample?.apiOperations).toMatchObject({
      bulkBuilderCreates: 1,
      bulkEntryCreates: entryCount,
      bulkCommits: 1,
    });
    expect(sample?.hizoFSDiagnostics?.commits.superblockPublications).toBe(1);
  });

  it('runs every public benchmark case through the production HizoFS runtime', async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: 'worker', name: 'opfs-root' });
    const configuration: HizoFSBenchmarkConfiguration = {
      ...createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
      backendMode: 'hizofs_only' as const,
      warmupIterations: 0,
      measuredIterations: 1,
    };

    const report = await runHizoFSBenchmark({
      configuration,
      onProgress: () => undefined,
      assertActive: () => undefined,
      nativeOpfsRoot: root as unknown as FileSystemDirectoryHandle,
      runtimePort: createProductionHizoFSBenchmarkRuntimePort(),
    });

    expect(report.failure).toBeUndefined();
    expect(report.status).toBe('completed');
    expect(report.cleanup).toMatchObject({ attempted: true, completed: true });
    expect(report.results.map(({ caseId }) => caseId)).toEqual([
      'small_files_create_empty',
      'small_files_write_existing',
      'small_files_read',
      'small_files_delete',
      'sequential_write',
      'sequential_read',
      'sequential_append',
      'sequential_truncate',
      'random_read',
      'random_write',
      'directory_create_entries',
      'directory_lookup',
      'directory_list',
      'directory_recursive_delete',
    ]);
    expect(report.results.every(result => result.backends.hizofs?.sampleCount === 1)).toBe(true);
    const smallFileWriteRuntime = report.results.find(result => result.caseId === 'small_files_write_existing')
      ?.backends.hizofs?.samples[0]?.hizoFSDiagnostics?.runtime;
    expect(smallFileWriteRuntime?.type).toBe('measured');
    if (smallFileWriteRuntime?.type !== 'measured') {
      throw new Error('small-file write structural diagnostics are unavailable');
    }
    expect(smallFileWriteRuntime.indexes.validate_structure).toMatchObject({
      operations: 0,
      pageReads: 0,
    });
    expect(smallFileWriteRuntime.phases.physical_provision_directory_hierarchy.operationCount).toBe(0);
    const randomWriteSample = report.results.find(result => result.caseId === 'random_write')
      ?.backends.hizofs?.samples[0];
    const randomWriteRuntime = randomWriteSample?.hizoFSDiagnostics?.runtime;
    expect(randomWriteRuntime?.type).toBe('measured');
    if (randomWriteRuntime?.type !== 'measured') {
      throw new Error('random-write structural diagnostics are unavailable');
    }
    expect(randomWriteRuntime.indexes.update.operations)
      .toBe(configuration.randomAccess.operationCount + 1);
    expect(randomWriteRuntime.indexes.update.inputMutations)
      .toBe(configuration.randomAccess.operationCount + 1);
  }, 30_000);

  it('retains an isolated production run only by configuration and removes it explicitly', async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: 'worker', name: 'opfs-root' });
    const configuration: HizoFSBenchmarkConfiguration = {
      ...createHizoFSBenchmarkPresetConfiguration({ preset: 'quick' }),
      backendMode: 'hizofs_only' as const,
      benchmarkDataRetention: 'keep_after_run' as const,
      warmupIterations: 0,
      measuredIterations: 1,
      workloads: ['small_files'],
      smallFiles: { count: 1, sizeBytes: 16 },
    };

    const report = await runHizoFSBenchmark({
      configuration,
      onProgress: () => undefined,
      assertActive: () => undefined,
      nativeOpfsRoot: root as unknown as FileSystemDirectoryHandle,
      runtimePort: createProductionHizoFSBenchmarkRuntimePort(),
    });

    expect(report.cleanup).toEqual({
      attempted: false,
      completed: false,
      retainedByConfiguration: true,
      remainingPaths: [`naidan-debug-benchmark/run-${report.runId}`],
    });
    const benchmarkRoot = await root.getDirectoryHandle('naidan-debug-benchmark');
    await expect(benchmarkRoot.getDirectoryHandle(`run-${report.runId}`)).resolves.toBeDefined();

    await cleanHizoFSBenchmarkData({
      nativeOpfsRoot: root as unknown as FileSystemDirectoryHandle,
    });
    await expect(root.getDirectoryHandle('naidan-debug-benchmark'))
      .rejects.toMatchObject({ name: 'NotFoundError' });
  });
});
