import { InMemoryOpfsDirectoryHandle } from '@/00-storage/service/test-support/in-memory-opfs';
import { cleanHizoFSBenchmarkData, runHizoFSBenchmark } from '@/features/debug-hizofs/benchmark/engine';
import { createHizoFSBenchmarkPresetConfiguration } from '@/features/debug-hizofs/benchmark/presets';
import { createProductionHizoFSBenchmarkRuntimePort } from '@/features/debug-hizofs/benchmark/production-runtime-port';
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
    for (let index = 0; index < entryCount; index += 1) {
      await runtime.session.root.getFileHandle({ create: true, name: `metadata-${index}` });
    }

    const beforeClose = runtime.diagnostics.snapshot();
    expect(beforeClose.type).toBe('measured');
    if (beforeClose.type !== 'measured') throw new Error('production diagnostics are unavailable');
    expect(beforeClose.caches.metadata.hits).toBeGreaterThan(beforeClose.caches.metadata.misses);
    expect(beforeClose.caches.metadata.currentEntries).toBeGreaterThan(0);
    // A disabled cache requires more than 400 exact reads for this fixed workload.
    // Keep the bound loose enough to measure structural amplification, not host timing.
    expect(beforeClose.phases.physical_read_exact.operationCount).toBeLessThan(entryCount * 20);

    await runtime.close();
    const afterClose = runtime.diagnostics.snapshot();
    expect(afterClose.type).toBe('measured');
    if (afterClose.type !== 'measured') throw new Error('production diagnostics are unavailable');
    expect(afterClose.caches.metadata).toMatchObject({ currentBytes: 0, currentEntries: 0 });
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
    expect(runtimeDiagnostics.phases.physical_read_exact.operationCount).toBeGreaterThan(0);
    expect(Object.values(runtimeDiagnostics.records).some(counter => counter.readOperations > 0)).toBe(true);
    expect(runtimeDiagnostics.caches.metadata.hits).toBeGreaterThan(0);
    expect(runtimeDiagnostics.caches.metadata.misses).toBeGreaterThan(0);
    expect(runtimeDiagnostics.caches.metadata.currentEntries).toBeGreaterThan(0);
  });

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

    expect(report.status).toBe('completed');
    expect(report.failure).toBeUndefined();
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
