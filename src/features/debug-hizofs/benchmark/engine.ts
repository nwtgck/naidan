import {
  HIZOFS_SUPERBLOCK_FILES,
  HIZOFS_UNLOCK_ENVELOPE_FILES,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentClassDirectoryName,
  parseSegmentFilename,
  parseSegmentShardDirectoryName,
  segmentIdToRelativePath,
  type SegmentClass,
} from '@/00-storage/service/hizofs/00-format';
import { AUTHENTICATED_PHYSICAL_ACCESS_REASONS } from '@/00-storage/service/hizofs/diagnostics/authenticated-store-diagnostics';
import { IMMUTABLE_BTREE_DIAGNOSTIC_OPERATIONS } from '@/00-storage/service/hizofs/diagnostics/immutable-btree-diagnostics';
import {
  createBenchmarkRuntimePolicy,
  HIZOFS_BENCHMARK_RUNTIME_PHASES,
  HIZOFS_BENCHMARK_PERSISTED_RECORD_KINDS,
} from './runtime-port';
import type {
  HizoFSBenchmarkGarbageCollectionDiagnostics,
  HizoFSBenchmarkRuntime,
  HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot,
  HizoFSBenchmarkRuntimeDiagnosticsSnapshot,
  HizoFSBenchmarkRuntimePolicy,
  HizoFSBenchmarkRuntimePort,
} from './runtime-port';
import type {
  StorageDirectoryHandle,
  StorageFileHandle,
  StorageFileSystemSession,
  StorageWritableFile,
} from '@/00-storage/service/storage-file-system/types';
import {
  hizoFSBenchmarkConfigurationSchema,
  type HizoFSBenchmarkCaseResult,
  type HizoFSBenchmarkConfiguration,
  type HizoFSBenchmarkDiagnostics,
  type HizoFSBenchmarkDiagnosticsTotals,
  type HizoFSBenchmarkLifecycleEvent,
  type HizoFSBenchmarkProgress,
  type HizoFSBenchmarkReport,
  type HizoFSBenchmarkSample,
  type HizoFSBenchmarkWorkload,
} from './types';

const BENCHMARK_ROOT_DIRECTORY_NAME = 'naidan-debug-benchmark';
const BENCHMARK_LOCK_NAME = 'naidan-debug-hizofs-benchmark-v1';
const HIZOFS_FORMAT_VERSION = 1 as const;
const BENCHMARK_IMPLEMENTATION_VERSION = 45 as const;

type BackendKind = 'raw_opfs' | 'hizofs';
type BenchmarkPhase = 'warmup' | 'measured';

type BackingStoreCounters = HizoFSBenchmarkDiagnostics['backingStore'];
type PhysicalStoreShape = HizoFSBenchmarkDiagnostics['physicalStore']['before'];
type BenchmarkApiCounters = HizoFSBenchmarkSample['apiOperations'];

type BenchmarkMemoryTracker = {
  activeBytes: number;
  sampleHighWaterBytes: number;
  sampleLargestAllocationBytes: number;
};

// These counters are updated by the backing-store proxy so diagnostics never
// read the encrypted object tree between timed cases and accidentally warm the
// following HizoFS measurement.
type HizoFSPhysicalDiagnosticTracker = {
  // Physical immutable containers. In the segmented format one path may hold
  // many authenticated logical records.
  readonly objectPaths: Set<string>;
  superblockPublications: number;
};

type BenchmarkSyncAccessHandle = {
  getSize(): number;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors FileSystemSyncAccessHandle.
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors FileSystemSyncAccessHandle.
  write(buffer: BufferSource, options?: { at?: number }): number;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors FileSystemSyncAccessHandle.
  truncate(newSize: number): void;
  flush(): void;
  close(): void;
};

type BenchmarkFileHandleWithSyncAccess = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<BenchmarkSyncAccessHandle>;
};

type BenchmarkContext = {
  readonly kind: BackendKind;
  readonly contextDirectory: FileSystemDirectoryHandle;
  readonly rawRoot: FileSystemDirectoryHandle | undefined;
  hizoFSSession: StorageFileSystemSession | undefined;
  readonly hizoFSRuntime: HizoFSBenchmarkRuntime | undefined;
  readonly hizoFSRuntimePort: HizoFSBenchmarkRuntimePort | undefined;
  readonly hizoFSBackingDirectory: FileSystemDirectoryHandle | undefined;
  readonly hizoFSPhysicalBackingDirectory: FileSystemDirectoryHandle | undefined;
  readonly counters: BackingStoreCounters | undefined;
  readonly hizoFSPhysicalDiagnostics: HizoFSPhysicalDiagnosticTracker | undefined;
  readonly hizoFSPolicy: HizoFSBenchmarkRuntimePolicy | undefined;
  readonly apiCounters: BenchmarkApiCounters;
  readonly memoryTracker: BenchmarkMemoryTracker;
};

async function runHizoFSWritableTransaction({ operation, writable }: {
  operation: () => Promise<void>;
  writable: StorageWritableFile;
}): Promise<void> {
  let commitStarted = false;
  try {
    await operation();
    commitStarted = true;
    await writable.close();
  } catch (cause: unknown) {
    if (commitStarted) throw cause;
    try {
      await writable.abort({ reason: cause });
    } catch (abortCause: unknown) {
      throw new AggregateError(
        [cause, abortCause],
        'HizoFS benchmark writable operation and abort both failed',
      );
    }
    throw cause;
  }
}

type CaseSample = {
  readonly workload: HizoFSBenchmarkWorkload;
  readonly caseId: string;
  readonly label: string;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  readonly backend: BackendKind;
  readonly sample: HizoFSBenchmarkSample;
};

type ProgressCallback = ({ progress }: { progress: HizoFSBenchmarkProgress }) => void;

type RunHizoFSBenchmarkOptions = {
  configuration: HizoFSBenchmarkConfiguration;
  onProgress: ProgressCallback;
  assertActive: () => void;
  nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
  runtimePort: HizoFSBenchmarkRuntimePort | undefined;
};

export async function runHizoFSBenchmark({
  configuration,
  onProgress,
  assertActive,
  nativeOpfsRoot,
  runtimePort,
}: RunHizoFSBenchmarkOptions): Promise<HizoFSBenchmarkReport> {
  onProgress({
    progress: {
      stage: 'preparing',
      workload: undefined,
      caseId: undefined,
      backend: undefined,
      iteration: undefined,
      completedUnits: 0,
      totalUnits: 1,
      message: 'Waiting for the exclusive benchmark lock',
    },
  });
  return runWithExclusiveBenchmarkLock({
    operation: async () => runHizoFSBenchmarkWithLockHeld({
      configuration,
      onProgress,
      assertActive,
      nativeOpfsRoot,
      runtimePort,
    }),
  });
}

async function runHizoFSBenchmarkWithLockHeld({
  configuration: rawConfiguration,
  onProgress,
  assertActive,
  nativeOpfsRoot,
  runtimePort,
}: RunHizoFSBenchmarkOptions): Promise<HizoFSBenchmarkReport> {
  const configuration = hizoFSBenchmarkConfigurationSchema.parse(rawConfiguration);
  validateBenchmarkConfiguration({ configuration });
  const hizoFSPolicy = createBenchmarkRuntimePolicy({ configuration });
  const root = nativeOpfsRoot ?? await navigator.storage.getDirectory();
  const runId = createRunId();
  const benchmarkRoot = await root.getDirectoryHandle(BENCHMARK_ROOT_DIRECTORY_NAME, { create: true });
  const runDirectoryName = `run-${runId}`;
  const runDirectory = await benchmarkRoot.getDirectoryHandle(runDirectoryName, { create: true });
  const samples: CaseSample[] = [];
  const lifecycleEvents: HizoFSBenchmarkLifecycleEvent[] = [];
  const executionOrder: HizoFSBenchmarkReport['executionOrder'] = [];
  let failure: HizoFSBenchmarkReport['failure'];
  let status: HizoFSBenchmarkReport['status'] = 'completed';
  let currentWorkload: HizoFSBenchmarkWorkload | undefined;
  let currentCaseId: string | undefined;
  let currentBackend: BackendKind | undefined;
  let currentIteration: number | undefined;
  let currentPhase: 'preparing' | 'warmup' | 'measured' | 'cleaning' = 'preparing';
  const totalUnits = calculateTotalProgressUnits({ configuration });
  let completedUnits = 0;

  const reportProgress = ({ message }: { message: string }): void => {
    onProgress({
      progress: {
        stage: getProgressStage({ phase: currentPhase }),
        workload: currentWorkload,
        caseId: currentCaseId,
        backend: currentBackend,
        iteration: currentIteration,
        completedUnits,
        totalUnits,
        message,
      },
    });
  };

  reportProgress({ message: 'Preparing isolated benchmark directories' });

  let sharedContexts: Map<BackendKind, BenchmarkContext> | undefined;
  try {
    const totalIterations = configuration.warmupIterations + configuration.measuredIterations;
    const freshPerIteration = isFreshPerIteration({
      lifecycle: configuration.storeLifecycle,
    });
    if (!freshPerIteration) {
      sharedContexts = await createBenchmarkContexts({
        configuration,
        contextDirectory: runDirectory,
        phase: 'preparing',
        iteration: undefined,
        lifecycleEvents,
        hizoFSPolicy,
        runtimePort,
      });
    }
    let benchmarkOperationFailure: unknown;
    try {
      for (let iteration = 0; iteration < totalIterations; iteration += 1) {
        assertActive();
        const phase: BenchmarkPhase = iteration < configuration.warmupIterations
          ? 'warmup'
          : 'measured';
        const measuredIteration = getReportedIteration({
          phase,
          iteration,
          warmupIterations: configuration.warmupIterations,
        });
        const order = getBackendOrder({
          configuration,
          iteration,
        });
        executionOrder.push({
          iteration: measuredIteration,
          phase,
          order: [...order],
        });

        const contexts = freshPerIteration
          ? await createBenchmarkContexts({
            configuration,
            contextDirectory: await runDirectory.getDirectoryHandle(
              `iteration-${phase}-${String(measuredIteration)}`,
              { create: true },
            ),
            phase,
            iteration: measuredIteration,
            lifecycleEvents,
            hizoFSPolicy,
            runtimePort,
          })
          : sharedContexts;
        if (contexts === undefined) throw new Error('Benchmark contexts are unavailable');

        try {
          for (const workload of configuration.workloads) {
            currentWorkload = workload;
            for (const backend of getBackendsForWorkload({ workload, order })) {
              currentBackend = backend;
              currentIteration = measuredIteration;
              currentPhase = phase;
              reportProgress({ message: `Running ${workload} on ${backend}` });
              const context = contexts.get(backend);
              if (context === undefined) {
                throw new Error(`Missing benchmark context: ${backend}`);
              }
              const nextSamples = await runWorkloadIteration({
                configuration,
                workload,
                context,
                phase,
                iteration: measuredIteration,
                randomSeed: mixSeed({
                  seed: configuration.randomSeed,
                  value: iteration * 31 + getWorkloadSeedDiscriminator({ workload }),
                }),
                assertActive,
                onCaseStart: ({ caseId }) => {
                  currentCaseId = caseId;
                  reportProgress({ message: `Running ${caseId} on ${backend}` });
                },
              });
              samples.push(...nextSamples);
              completedUnits += 1;
              reportProgress({ message: `Completed ${workload} on ${backend}` });
            }
          }
        } finally {
          if (freshPerIteration) {
            await closeBenchmarkContexts({ contexts });
          }
        }

        if (
          !freshPerIteration
          && iteration < totalIterations - 1
        ) {
          await applyBetweenIterationLifecycle({
            lifecycle: configuration.storeLifecycle,
            contexts,
            phase,
            iteration: measuredIteration,
            lifecycleEvents,
            garbageCollectionSweepPolicy:
              configuration.hizoFSMaintenance.garbageCollectionSweep,
          });
        }
      }
    } catch (cause: unknown) {
      benchmarkOperationFailure = cause;
    }
    let benchmarkCloseFailure: unknown;
    if (sharedContexts !== undefined) {
      try {
        await closeBenchmarkContexts({ contexts: sharedContexts });
      } catch (cause: unknown) {
        benchmarkCloseFailure = cause;
      }
    }
    if (benchmarkOperationFailure !== undefined) {
      if (benchmarkCloseFailure !== undefined) {
        throw new AggregateError(
          [benchmarkOperationFailure, benchmarkCloseFailure],
          'benchmark operation and context close both failed',
        );
      }
      throw benchmarkOperationFailure;
    }
    if (benchmarkCloseFailure !== undefined) throw benchmarkCloseFailure;
  } catch (error) {
    status = isAbortError({ error }) ? 'cancelled' : 'failed';
    failure = {
      workload: currentWorkload,
      caseId: currentCaseId,
      backend: currentBackend,
      iteration: currentIteration,
      errorName: getErrorName({ error }),
      errorMessage: getErrorMessage({ error }),
      errorStack: getErrorStack({ error }),
      phase: currentPhase,
    };
  }

  currentPhase = 'cleaning';
  currentWorkload = undefined;
  currentCaseId = undefined;
  currentBackend = undefined;
  currentIteration = undefined;
  reportProgress({ message: 'Cleaning benchmark data' });

  const cleanup = await cleanBenchmarkRun({
    benchmarkRoot,
    runDirectoryName,
    retention: configuration.benchmarkDataRetention,
  });

  return {
    schemaVersion: 32,
    benchmarkImplementationVersion: BENCHMARK_IMPLEMENTATION_VERSION,
    hizofsFormatVersion: HIZOFS_FORMAT_VERSION,
    reportType: 'hizofs_benchmark',
    runId,
    runLabel: configuration.runLabel,
    generatedAt: new Date().toISOString(),
    status,
    environment: {
      appVersion: __APP_VERSION__,
      userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      hardwareConcurrency: getHardwareConcurrency(),
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
        fileChunkSizeBytes: hizoFSPolicy.fileChunkSize,
        maxDirtyFileBytesPerWriter: hizoFSPolicy.maxDirtyFileBytes,
        fileChunkWriteConcurrencyPerWriter:
          hizoFSPolicy.fileChunkWriteConcurrency,
        fileChunkReadPrefetchConcurrencyPerReader:
          hizoFSPolicy.fileChunkReadPrefetchConcurrency,
        backingFileHandleCacheEntryLimitPerRuntime:
          hizoFSPolicy.backingFileHandleCacheEntryLimit,
        backingFileSnapshotCacheEntryLimitPerRuntime:
          hizoFSPolicy.backingFileSnapshotCacheEntryLimit,
        maximumPlaintextChunkWriteBytesInFlightPerWriter:
          hizoFSPolicy.fileChunkSize
          * hizoFSPolicy.fileChunkWriteConcurrency,
        maximumPlaintextChunkReadBytesInFlightPerReader:
          hizoFSPolicy.fileChunkSize
          * hizoFSPolicy.fileChunkReadPrefetchConcurrency,
        metadataObjectCacheByteLimitPerRuntime:
          hizoFSPolicy.metadataObjectCacheByteLimit,
        metadataObjectCacheEntryLimitPerRuntime:
          hizoFSPolicy.metadataObjectCacheEntryLimit,
        decodedInodeIndexPageCacheEntryLimitPerRuntime:
          hizoFSPolicy.decodedInodeIndexPageCacheEntryLimit,
        inodeIndexLeafEntryLimitPerRuntime:
          hizoFSPolicy.inodeIndexLeafEntryLimit,
        directoryIndexLeafEntryLimitPerRuntime:
          hizoFSPolicy.directoryIndexLeafEntryLimit,
        fileExtentIndexLeafEntryLimitPerRuntime:
          hizoFSPolicy.fileExtentIndexLeafEntryLimit,
        fileChunkCacheByteLimitPerRuntime:
          hizoFSPolicy.fileChunkCacheByteLimit,
        fileChunkCacheEntryLimitPerRuntime:
          hizoFSPolicy.fileChunkCacheEntryLimit,
        fileChunkCacheAdmission: hizoFSPolicy.fileChunkCacheAdmission,
      },
    },
    configuration,
    lifecycleEvents,
    executionOrder,
    results: aggregateSamples({ samples }),
    failure,
    cleanup,
  };
}

export async function cleanHizoFSBenchmarkData({
  nativeOpfsRoot,
}: {
  nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
}): Promise<void> {
  await runWithExclusiveBenchmarkLock({
    operation: async () => {
      const root = nativeOpfsRoot ?? await navigator.storage.getDirectory();
      try {
        await root.removeEntry(BENCHMARK_ROOT_DIRECTORY_NAME, { recursive: true });
      } catch (error) {
        if (isNotFoundError({ error })) return;
        throw error;
      }
    },
  });
}

async function runWithExclusiveBenchmarkLock<T>({
  operation,
}: {
  operation: () => Promise<T>;
}): Promise<T> {
  if (typeof navigator === 'undefined' || navigator.locks?.request === undefined) {
    return operation();
  }
  return navigator.locks.request(BENCHMARK_LOCK_NAME, { mode: 'exclusive' }, operation);
}

async function createBenchmarkContexts({
  configuration,
  contextDirectory,
  phase,
  iteration,
  lifecycleEvents,
  hizoFSPolicy,
  runtimePort,
}: {
  configuration: HizoFSBenchmarkConfiguration;
  contextDirectory: FileSystemDirectoryHandle;
  phase: HizoFSBenchmarkLifecycleEvent['phase'];
  iteration: number | undefined;
  lifecycleEvents: HizoFSBenchmarkLifecycleEvent[];
  hizoFSPolicy: HizoFSBenchmarkRuntimePolicy;
  runtimePort: HizoFSBenchmarkRuntimePort | undefined;
}): Promise<Map<BackendKind, BenchmarkContext>> {
  const result = new Map<BackendKind, BenchmarkContext>();
  for (const backend of getRequestedBackendKinds({ backendMode: configuration.backendMode })) {
    const startedAt = performance.now();
    switch (backend) {
    case 'raw_opfs': {
      const rawRoot = await contextDirectory.getDirectoryHandle('raw', { create: true });
      result.set('raw_opfs', {
        kind: 'raw_opfs',
        contextDirectory,
        rawRoot,
        hizoFSSession: undefined,
        hizoFSRuntime: undefined,
        hizoFSRuntimePort: runtimePort,
        hizoFSBackingDirectory: undefined,
        hizoFSPhysicalBackingDirectory: undefined,
        counters: undefined,
        hizoFSPhysicalDiagnostics: undefined,
        hizoFSPolicy: undefined,
        apiCounters: createEmptyBenchmarkApiCounters(),
        memoryTracker: createBenchmarkMemoryTracker(),
      });
      lifecycleEvents.push({
        phase,
        iteration,
        backend,
        action: 'create_context',
        durationMs: Math.max(performance.now() - startedAt, 0),
        hizoFS: undefined,
      });
      break;
    }
    case 'hizofs': {
      const backingDirectory = await contextDirectory.getDirectoryHandle('hizofs-backing', { create: true });
      const counters = createEmptyBackingStoreCounters();
      const physicalDiagnostics = createHizoFSPhysicalDiagnosticTracker();
      const countedBackingDirectory = createCountingDirectoryHandle({
        directory: backingDirectory,
        counters,
        diagnosticsMode: configuration.backingStoreDiagnosticsMode,
        relativePath: [],
        physicalDiagnostics,
      });
      if (runtimePort === undefined) {
        throw new Error('HizoFS benchmark runtime is not connected');
      }
      let runtime: HizoFSBenchmarkRuntime | undefined;
      let session: StorageFileSystemSession | undefined;
      let initializationBackingStore = createEmptyBackingStoreCounters();
      let initializationSuperblockPublications = 0;
      try {
        runtime = await runtimePort.createRuntime({
          backingDirectory: countedBackingDirectory,
          policy: hizoFSPolicy,
        });
        session = runtime.session;
        initializationBackingStore = snapshotBackingStoreCounters({ counters });
        initializationSuperblockPublications = physicalDiagnostics.superblockPublications;
        await initializeHizoFSPhysicalDiagnostics({
          backingDirectory,
          physicalDiagnostics,
        });
      } catch (error) {
        try {
          await runtime?.close();
        } catch {
          // Preserve the initialization failure; the benchmark directory remains isolated and removable.
        }
        throw error;
      }
      result.set('hizofs', {
        kind: 'hizofs',
        contextDirectory,
        rawRoot: undefined,
        hizoFSSession: session,
        hizoFSRuntime: runtime,
        hizoFSRuntimePort: runtimePort,
        hizoFSBackingDirectory: countedBackingDirectory,
        hizoFSPhysicalBackingDirectory: backingDirectory,
        counters,
        hizoFSPhysicalDiagnostics: physicalDiagnostics,
        hizoFSPolicy,
        apiCounters: createEmptyBenchmarkApiCounters(),
        memoryTracker: createBenchmarkMemoryTracker(),
      });
      lifecycleEvents.push({
        phase,
        iteration,
        backend,
        action: 'create_context',
        durationMs: Math.max(performance.now() - startedAt, 0),
        hizoFS: {
          objectsBefore: 0,
          objectsAfter: physicalDiagnostics.objectPaths.size,
          reachableObjectCount: undefined,
          unreachableObjectCount: undefined,
          removedObjectCount: undefined,
          garbageCollection: undefined,
          backingStore: initializationBackingStore,
          superblockPublications: initializationSuperblockPublications,
        },
      });
      break;
    }
    default: {
      const _ex: never = backend;
      throw new Error(`Unhandled benchmark backend: ${String(_ex)}`);
    }
    }
  }
  return result;
}

async function applyBetweenIterationLifecycle({
  lifecycle,
  contexts,
  phase,
  iteration,
  lifecycleEvents,
  garbageCollectionSweepPolicy,
}: {
  lifecycle: HizoFSBenchmarkConfiguration['storeLifecycle'];
  contexts: Map<BackendKind, BenchmarkContext>;
  phase: BenchmarkPhase;
  iteration: number;
  lifecycleEvents: HizoFSBenchmarkLifecycleEvent[];
  garbageCollectionSweepPolicy:
    HizoFSBenchmarkConfiguration['hizoFSMaintenance']['garbageCollectionSweep'];
}): Promise<void> {
  switch (lifecycle) {
  case 'reuse_without_gc':
    return;
  case 'fresh_per_iteration':
    throw new Error('Fresh-per-iteration lifecycle is handled by context replacement');
  case 'reopen_between_iterations': {
    const context = contexts.get('hizofs');
    if (
      context === undefined
      || context.hizoFSSession === undefined
      || context.hizoFSBackingDirectory === undefined
      || context.hizoFSRuntime === undefined
      || context.counters === undefined
      || context.hizoFSPhysicalDiagnostics === undefined
    ) {
      return;
    }
    const countersBefore = snapshotBackingStoreCounters({ counters: context.counters });
    const superblockPublicationsBefore = context.hizoFSPhysicalDiagnostics.superblockPublications;
    const startedAt = performance.now();
    await context.hizoFSSession.close();
    context.hizoFSSession = await context.hizoFSRuntime.reopen();
    lifecycleEvents.push({
      phase,
      iteration,
      backend: 'hizofs',
      action: 'reopen_context',
      durationMs: Math.max(performance.now() - startedAt, 0),
      hizoFS: createLifecycleObjectSnapshot({
        context,
        backingStore: subtractBackingStoreCounters({
          before: countersBefore,
          after: context.counters,
        }),
        superblockPublications: Math.max(
          context.hizoFSPhysicalDiagnostics.superblockPublications
            - superblockPublicationsBefore,
          0,
        ),
      }),
    });
    return;
  }
  case 'reuse_with_gc_between_iterations': {
    const context = contexts.get('hizofs');
    if (
      context === undefined
      || context.hizoFSBackingDirectory === undefined
      || context.hizoFSRuntime === undefined
      || context.hizoFSPhysicalDiagnostics === undefined
      || context.counters === undefined
    ) {
      return;
    }
    const objectsBefore = context.hizoFSPhysicalDiagnostics.objectPaths.size;
    const countersBefore = snapshotBackingStoreCounters({ counters: context.counters });
    const superblockPublicationsBefore = context.hizoFSPhysicalDiagnostics.superblockPublications;
    const startedAt = performance.now();
    const result = await context.hizoFSRuntime.collectGarbage({
      dryRun: false,
      sweepPolicy: garbageCollectionSweepPolicy,
      signal: undefined,
    });
    lifecycleEvents.push({
      phase,
      iteration,
      backend: 'hizofs',
      action: 'garbage_collection',
      durationMs: Math.max(performance.now() - startedAt, 0),
      hizoFS: {
        objectsBefore,
        objectsAfter: context.hizoFSPhysicalDiagnostics.objectPaths.size,
        reachableObjectCount: result.reachableObjectCount,
        unreachableObjectCount: result.unreachableObjectCount,
        removedObjectCount: result.removedObjectCount,
        garbageCollection: result.diagnostics,
        backingStore: subtractBackingStoreCounters({
          before: countersBefore,
          after: context.counters,
        }),
        superblockPublications: Math.max(
          context.hizoFSPhysicalDiagnostics.superblockPublications
            - superblockPublicationsBefore,
          0,
        ),
      },
    });
    return;
  }
  default: {
    const _ex: never = lifecycle;
    throw new Error(`Unhandled benchmark store lifecycle: ${String(_ex)}`);
  }
  }
}

function isFreshPerIteration({
  lifecycle,
}: {
  lifecycle: HizoFSBenchmarkConfiguration['storeLifecycle'];
}): boolean {
  switch (lifecycle) {
  case 'fresh_per_iteration':
    return true;
  case 'reuse_without_gc':
  case 'reuse_with_gc_between_iterations':
  case 'reopen_between_iterations':
    return false;
  default: {
    const _ex: never = lifecycle;
    throw new Error(`Unhandled benchmark store lifecycle: ${String(_ex)}`);
  }
  }
}

function createLifecycleObjectSnapshot({
  context,
  backingStore,
  superblockPublications,
}: {
  context: BenchmarkContext;
  backingStore: BackingStoreCounters;
  superblockPublications: number;
}): HizoFSBenchmarkLifecycleEvent['hizoFS'] {
  const objectCount = context.hizoFSPhysicalDiagnostics?.objectPaths.size ?? 0;
  return {
    objectsBefore: objectCount,
    objectsAfter: objectCount,
    reachableObjectCount: undefined,
    unreachableObjectCount: undefined,
    removedObjectCount: undefined,
    garbageCollection: undefined,
    backingStore,
    superblockPublications,
  };
}

async function closeBenchmarkContexts({
  contexts,
}: {
  contexts: ReadonlyMap<BackendKind, BenchmarkContext>;
}): Promise<void> {
  let firstError: unknown;
  for (const context of contexts.values()) {
    try {
      await closeBenchmarkContext({ context });
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

async function closeBenchmarkContext({
  context,
}: {
  context: BenchmarkContext;
}): Promise<void> {
  await context.hizoFSRuntime?.close();
}

function getBackendOrder({
  configuration,
  iteration,
}: {
  configuration: HizoFSBenchmarkConfiguration;
  iteration: number;
}): readonly BackendKind[] {
  switch (configuration.backendMode) {
  case 'raw_opfs_only':
    return ['raw_opfs'];
  case 'hizofs_only':
    return ['hizofs'];
  case 'compare':
    return iteration % 2 === 0
      ? ['raw_opfs', 'hizofs']
      : ['hizofs', 'raw_opfs'];
  default: {
    const _ex: never = configuration.backendMode;
    throw new Error(`Unhandled benchmark backend mode: ${String(_ex)}`);
  }
  }
}

function getBackendsForWorkload({
  workload,
  order,
}: {
  workload: HizoFSBenchmarkWorkload;
  order: readonly BackendKind[];
}): readonly BackendKind[] {
  switch (workload) {
  case 'hizofs_maintenance':
    return order.filter(backend => backend === 'hizofs');
  case 'small_files':
  case 'sequential_io':
  case 'random_access':
  case 'directory_operations':
  case 'bulk_operations':
    return order;
  default: {
    const _ex: never = workload;
    throw new Error(`Unhandled benchmark workload: ${String(_ex)}`);
  }
  }
}

async function runWorkloadIteration({
  configuration,
  workload,
  context,
  phase,
  iteration,
  randomSeed,
  assertActive,
  onCaseStart,
}: {
  configuration: HizoFSBenchmarkConfiguration;
  workload: HizoFSBenchmarkWorkload;
  context: BenchmarkContext;
  phase: BenchmarkPhase;
  iteration: number;
  randomSeed: number;
  assertActive: () => void;
  onCaseStart: ({ caseId }: { caseId: string }) => void;
}): Promise<readonly CaseSample[]> {
  switch (workload) {
  case 'small_files':
    return runSmallFilesWorkload({
      configuration,
      context,
      phase,
      iteration,
      randomSeed,
      assertActive,
      onCaseStart,
    });
  case 'sequential_io':
    return runSequentialIoWorkload({
      configuration,
      context,
      phase,
      iteration,
      randomSeed,
      assertActive,
      onCaseStart,
    });
  case 'random_access':
    return runRandomAccessWorkload({
      configuration,
      context,
      phase,
      iteration,
      randomSeed,
      assertActive,
      onCaseStart,
    });
  case 'directory_operations':
    return runDirectoryOperationsWorkload({
      configuration,
      context,
      phase,
      iteration,
      assertActive,
      onCaseStart,
    });
  case 'bulk_operations':
    return runBulkOperationsWorkload({
      configuration,
      context,
      phase,
      iteration,
      assertActive,
      onCaseStart,
    });
  case 'hizofs_maintenance':
    return runHizoFSMaintenanceWorkload({
      configuration,
      context,
      phase,
      iteration,
      randomSeed,
      assertActive,
      onCaseStart,
    });
  default: {
    const _ex: never = workload;
    throw new Error(`Unhandled HizoFS benchmark workload: ${String(_ex)}`);
  }
  }
}

async function runSmallFilesWorkload({
  configuration,
  context,
  phase,
  iteration,
  randomSeed,
  assertActive,
  onCaseStart,
}: {
  configuration: HizoFSBenchmarkConfiguration;
  context: BenchmarkContext;
  phase: BenchmarkPhase;
  iteration: number;
  randomSeed: number;
  assertActive: () => void;
  onCaseStart: ({ caseId }: { caseId: string }) => void;
}): Promise<readonly CaseSample[]> {
  const directoryName = `small-files-${phase}-${String(iteration)}`;
  const directory = await createBackendDirectory({ context, name: directoryName });
  const data = createPatternBytes({ size: configuration.smallFiles.sizeBytes, seed: randomSeed });
  const parameters = {
    fileCount: configuration.smallFiles.count,
    fileSizeBytes: configuration.smallFiles.sizeBytes,
  };
  const samples: CaseSample[] = [];

  onCaseStart({ caseId: 'small_files_create_empty' });
  samples.push(await measureCase({
    context,
    workload: 'small_files',
    caseId: 'small_files_create_empty',
    label: 'Create empty small files',
    parameters,
    phase,
    iteration,
    operationCount: configuration.smallFiles.count,
    bytesProcessed: 0,
    operation: async () => {
      for (let index = 0; index < configuration.smallFiles.count; index += 1) {
        assertActive();
        await createEmptyBackendFile({
          context,
          directory,
          name: smallFileName({ index }),
        });
      }
      return 0;
    },
  }));

  onCaseStart({ caseId: 'small_files_write_existing' });
  samples.push(await measureCase({
    context,
    workload: 'small_files',
    caseId: 'small_files_write_existing',
    label: 'Write existing small files',
    parameters,
    phase,
    iteration,
    operationCount: configuration.smallFiles.count,
    bytesProcessed: configuration.smallFiles.count * configuration.smallFiles.sizeBytes,
    operation: async () => {
      for (let index = 0; index < configuration.smallFiles.count; index += 1) {
        assertActive();
        await writeBackendFile({
          context,
          directory,
          name: smallFileName({ index }),
          create: false,
          bytes: data,
          keepExistingData: false,
          position: 0,
        });
      }
      return 0;
    },
  }));

  onCaseStart({ caseId: 'small_files_read' });
  samples.push(await measureCase({
    context,
    workload: 'small_files',
    caseId: 'small_files_read',
    label: 'Read small files',
    parameters,
    phase,
    iteration,
    operationCount: configuration.smallFiles.count,
    bytesProcessed: configuration.smallFiles.count * configuration.smallFiles.sizeBytes,
    operation: async () => {
      let checksum = 0;
      for (let index = 0; index < configuration.smallFiles.count; index += 1) {
        assertActive();
        checksum = addChecksum({
          checksum,
          value: await readBackendFile({
            context,
            directory,
            name: smallFileName({ index }),
            blockSizeBytes: Math.max(configuration.smallFiles.sizeBytes, 1),
            assertActive,
          }),
        });
      }
      return checksum;
    },
  }));

  onCaseStart({ caseId: 'small_files_delete' });
  samples.push(await measureCase({
    context,
    workload: 'small_files',
    caseId: 'small_files_delete',
    label: 'Delete small-file directory recursively',
    parameters,
    phase,
    iteration,
    operationCount: configuration.smallFiles.count,
    bytesProcessed: 0,
    operation: async () => {
      await removeBackendEntry({
        context,
        directory: await getBackendRoot({ context }),
        name: directoryName,
        recursive: true,
      });
      return 0;
    },
  }));
  return samples;
}

async function runSequentialIoWorkload({
  configuration,
  context,
  phase,
  iteration,
  randomSeed,
  assertActive,
  onCaseStart,
}: {
  configuration: HizoFSBenchmarkConfiguration;
  context: BenchmarkContext;
  phase: BenchmarkPhase;
  iteration: number;
  randomSeed: number;
  assertActive: () => void;
  onCaseStart: ({ caseId }: { caseId: string }) => void;
}): Promise<readonly CaseSample[]> {
  const directoryName = `sequential-${phase}-${String(iteration)}`;
  const directory = await createBackendDirectory({ context, name: directoryName });
  const fileName = 'payload.bin';
  const block = createPatternBytes({
    size: configuration.sequentialIo.blockSizeBytes,
    seed: randomSeed,
  });
  const parameters = {
    fileSizeBytes: configuration.sequentialIo.fileSizeBytes,
    blockSizeBytes: configuration.sequentialIo.blockSizeBytes,
  };
  const samples: CaseSample[] = [];

  onCaseStart({ caseId: 'sequential_write' });
  samples.push(await measureCase({
    context,
    workload: 'sequential_io',
    caseId: 'sequential_write',
    label: 'Sequential file write',
    parameters,
    phase,
    iteration,
    operationCount: Math.ceil(configuration.sequentialIo.fileSizeBytes / block.byteLength),
    bytesProcessed: configuration.sequentialIo.fileSizeBytes,
    operation: async () => {
      await writeBackendFileByBlocks({
        context,
        directory,
        name: fileName,
        sizeBytes: configuration.sequentialIo.fileSizeBytes,
        block,
        keepExistingData: false,
        startPosition: 0,
        assertActive,
      });
      return 0;
    },
  }));

  onCaseStart({ caseId: 'sequential_read' });
  samples.push(await measureCase({
    context,
    workload: 'sequential_io',
    caseId: 'sequential_read',
    label: 'Sequential file read',
    parameters,
    phase,
    iteration,
    operationCount: Math.ceil(configuration.sequentialIo.fileSizeBytes / block.byteLength),
    bytesProcessed: configuration.sequentialIo.fileSizeBytes,
    operation: async () => readBackendFile({
      context,
      directory,
      name: fileName,
      blockSizeBytes: configuration.sequentialIo.blockSizeBytes,
      assertActive,
    }),
  }));

  onCaseStart({ caseId: 'sequential_append' });
  samples.push(await measureCase({
    context,
    workload: 'sequential_io',
    caseId: 'sequential_append',
    label: 'Append one block',
    parameters,
    phase,
    iteration,
    operationCount: 1,
    bytesProcessed: block.byteLength,
    operation: async () => {
      await writeBackendFile({
        context,
        directory,
        name: fileName,
        create: false,
        bytes: block,
        keepExistingData: true,
        position: configuration.sequentialIo.fileSizeBytes,
      });
      return 0;
    },
  }));

  onCaseStart({ caseId: 'sequential_truncate' });
  samples.push(await measureCase({
    context,
    workload: 'sequential_io',
    caseId: 'sequential_truncate',
    label: 'Truncate file to half size',
    parameters,
    phase,
    iteration,
    operationCount: 1,
    bytesProcessed: 0,
    operation: async () => {
      await truncateBackendFile({
        context,
        directory,
        name: fileName,
        size: Math.floor(configuration.sequentialIo.fileSizeBytes / 2),
      });
      return 0;
    },
  }));

  await removeBackendEntry({
    context,
    directory: await getBackendRoot({ context }),
    name: directoryName,
    recursive: true,
  });
  return samples;
}

async function runRandomAccessWorkload({
  configuration,
  context,
  phase,
  iteration,
  randomSeed,
  assertActive,
  onCaseStart,
}: {
  configuration: HizoFSBenchmarkConfiguration;
  context: BenchmarkContext;
  phase: BenchmarkPhase;
  iteration: number;
  randomSeed: number;
  assertActive: () => void;
  onCaseStart: ({ caseId }: { caseId: string }) => void;
}): Promise<readonly CaseSample[]> {
  const directoryName = `random-${phase}-${String(iteration)}`;
  const directory = await createBackendDirectory({ context, name: directoryName });
  const fileName = 'payload.bin';
  const block = createPatternBytes({
    size: configuration.randomAccess.blockSizeBytes,
    seed: randomSeed,
  });
  await writeBackendFileByBlocks({
    context,
    directory,
    name: fileName,
    sizeBytes: configuration.randomAccess.fileSizeBytes,
    block,
    keepExistingData: false,
    startPosition: 0,
    assertActive,
  });
  const positions = createRandomPositions({
    seed: randomSeed,
    count: configuration.randomAccess.operationCount,
    fileSizeBytes: configuration.randomAccess.fileSizeBytes,
    blockSizeBytes: configuration.randomAccess.blockSizeBytes,
  });
  const parameters = {
    fileSizeBytes: configuration.randomAccess.fileSizeBytes,
    operationCount: configuration.randomAccess.operationCount,
    blockSizeBytes: configuration.randomAccess.blockSizeBytes,
    uniqueBlockPositions: new Set(positions).size,
    hizoFSChunkSizeBytes: configuration.hizoFSRuntimePolicy.fileChunkSize,
    uniqueHizoFSChunks: new Set(
      positions.map(position => Math.floor(
        position / configuration.hizoFSRuntimePolicy.fileChunkSize,
      )),
    ).size,
  };
  const samples: CaseSample[] = [];

  onCaseStart({ caseId: 'random_read' });
  samples.push(await measureCase({
    context,
    workload: 'random_access',
    caseId: 'random_read',
    label: 'Random block reads',
    parameters,
    phase,
    iteration,
    operationCount: positions.length,
    bytesProcessed: positions.length * block.byteLength,
    operation: async () => randomReadBackendFile({
      context,
      directory,
      name: fileName,
      positions,
      blockSizeBytes: block.byteLength,
      assertActive,
    }),
  }));

  onCaseStart({ caseId: 'random_write' });
  samples.push(await measureCase({
    context,
    workload: 'random_access',
    caseId: 'random_write',
    label: 'Random block writes in one writable session',
    parameters,
    phase,
    iteration,
    operationCount: positions.length,
    bytesProcessed: positions.length * block.byteLength,
    operation: async () => {
      await randomWriteBackendFile({
        context,
        directory,
        name: fileName,
        positions,
        block,
        assertActive,
      });
      return 0;
    },
  }));

  await removeBackendEntry({
    context,
    directory: await getBackendRoot({ context }),
    name: directoryName,
    recursive: true,
  });
  return samples;
}

async function runDirectoryOperationsWorkload({
  configuration,
  context,
  phase,
  iteration,
  assertActive,
  onCaseStart,
}: {
  configuration: HizoFSBenchmarkConfiguration;
  context: BenchmarkContext;
  phase: BenchmarkPhase;
  iteration: number;
  assertActive: () => void;
  onCaseStart: ({ caseId }: { caseId: string }) => void;
}): Promise<readonly CaseSample[]> {
  const directoryName = `directory-${phase}-${String(iteration)}`;
  const root = await getBackendRoot({ context });
  const parameters = { entryCount: configuration.directoryOperations.entryCount };
  const samples: CaseSample[] = [];

  onCaseStart({ caseId: 'directory_create_entries' });
  samples.push(await measureCase({
    context,
    workload: 'directory_operations',
    caseId: 'directory_create_entries',
    label: 'Create directory entries',
    parameters,
    phase,
    iteration,
    operationCount: configuration.directoryOperations.entryCount,
    bytesProcessed: 0,
    operation: async () => {
      const directory = await createBackendDirectory({ context, name: directoryName });
      for (let index = 0; index < configuration.directoryOperations.entryCount; index += 1) {
        assertActive();
        await createEmptyBackendFile({
          context,
          directory,
          name: directoryEntryName({ index }),
        });
      }
      return 0;
    },
  }));
  const directory = await getBackendDirectory({ context, directory: root, name: directoryName });

  onCaseStart({ caseId: 'directory_lookup' });
  samples.push(await measureCase({
    context,
    workload: 'directory_operations',
    caseId: 'directory_lookup',
    label: 'Lookup directory entries',
    parameters,
    phase,
    iteration,
    operationCount: configuration.directoryOperations.entryCount,
    bytesProcessed: 0,
    operation: async () => {
      let checksum = 0;
      for (let index = 0; index < configuration.directoryOperations.entryCount; index += 1) {
        assertActive();
        await getBackendFile({
          context,
          directory,
          name: directoryEntryName({ index }),
          create: false,
        });
        checksum = (checksum + index) >>> 0;
      }
      return checksum;
    },
  }));

  onCaseStart({ caseId: 'directory_list' });
  samples.push(await measureCase({
    context,
    workload: 'directory_operations',
    caseId: 'directory_list',
    label: 'List directory entries',
    parameters,
    phase,
    iteration,
    operationCount: configuration.directoryOperations.entryCount,
    bytesProcessed: 0,
    operation: async () => {
      let count = 0;
      for await (const _entry of listBackendEntries({ context, directory })) {
        assertActive();
        count += 1;
      }
      return count >>> 0;
    },
  }));

  onCaseStart({ caseId: 'directory_recursive_delete' });
  samples.push(await measureCase({
    context,
    workload: 'directory_operations',
    caseId: 'directory_recursive_delete',
    label: 'Delete directory recursively',
    parameters,
    phase,
    iteration,
    operationCount: configuration.directoryOperations.entryCount,
    bytesProcessed: 0,
    operation: async () => {
      await removeBackendEntry({
        context,
        directory: root,
        name: directoryName,
        recursive: true,
      });
      return 0;
    },
  }));
  return samples;
}

async function runBulkOperationsWorkload({
  configuration,
  context,
  phase,
  iteration,
  assertActive,
  onCaseStart,
}: {
  configuration: HizoFSBenchmarkConfiguration;
  context: BenchmarkContext;
  phase: BenchmarkPhase;
  iteration: number;
  assertActive: () => void;
  onCaseStart: ({ caseId }: { caseId: string }) => void;
}): Promise<readonly CaseSample[]> {
  const entryCount = configuration.directoryOperations.entryCount;
  const parameters = { entryCount };
  const samples: CaseSample[] = [];
  const root = await getBackendRoot({ context });
  const directoryName = `bulk-per-operation-${phase}-${String(iteration)}`;
  const directory = await createBackendDirectory({
    context,
    name: directoryName,
  });

  onCaseStart({ caseId: 'bulk_create_empty_files_per_operation' });
  samples.push(await measureCase({
    context,
    workload: 'bulk_operations',
    caseId: 'bulk_create_empty_files_per_operation',
    label: 'Create empty files with one commit per entry',
    parameters,
    phase,
    iteration,
    operationCount: entryCount,
    bytesProcessed: 0,
    operation: async () => {
      for (let index = 0; index < entryCount; index += 1) {
        assertActive();
        await createEmptyBackendFile({
          context,
          directory,
          name: directoryEntryName({ index }),
        });
      }
      return 0;
    },
  }));
  await removeBackendEntry({
    context,
    directory: root,
    name: directoryName,
    recursive: true,
  });

  switch (context.kind) {
  case 'raw_opfs':
    return samples;
  case 'hizofs':
    break;
  default: {
    const _ex: never = context.kind;
    throw new Error(`Unhandled bulk benchmark backend: ${String(_ex)}`);
  }
  }
  if (context.hizoFSPolicy === undefined) {
    throw new Error('HizoFS bulk benchmark policy is unavailable');
  }
  const isolatedDirectory = await context.contextDirectory.getDirectoryHandle(
    `bulk-one-commit-${phase}-${String(iteration)}`,
    { create: true },
  );
  const isolatedContexts = await createBenchmarkContexts({
    configuration: {
      ...configuration,
      backendMode: 'hizofs_only',
      workloads: ['bulk_operations'],
    },
    contextDirectory: isolatedDirectory,
    phase,
    iteration,
    lifecycleEvents: [],
    hizoFSPolicy: context.hizoFSPolicy,
    runtimePort: context.hizoFSRuntimePort,
  });
  try {
    const bulkContext = isolatedContexts.get('hizofs');
    if (bulkContext?.hizoFSSession === undefined) {
      throw new Error('Isolated HizoFS bulk benchmark session is unavailable');
    }
    const apiCounterBaseline = { ...bulkContext.apiCounters };
    const builder = await bulkContext.hizoFSRuntime?.createBulkBuilder();
    bulkContext.apiCounters.bulkBuilderCreates += 1;
    if (builder === undefined) {
      throw new Error('Expected the isolated HizoFS bulk builder');
    }
    onCaseStart({ caseId: 'bulk_create_empty_files_one_commit' });
    samples.push(await measureCase({
      context: bulkContext,
      workload: 'bulk_operations',
      caseId: 'bulk_create_empty_files_one_commit',
      label: 'Create empty files with one bulk commit',
      parameters,
      phase,
      iteration,
      operationCount: entryCount,
      bytesProcessed: 0,
      apiCounterBaseline,
      operation: async () => {
        try {
          for (let index = 0; index < entryCount; index += 1) {
            assertActive();
            bulkContext.apiCounters.bulkEntryCreates += 1;
            await builder.createEmptyFile({
              name: directoryEntryName({ index }),
            });
          }
          bulkContext.apiCounters.bulkCommits += 1;
          await builder.commit();
          return 0;
        } catch (error) {
          await builder.abort({ reason: error });
          throw error;
        }
      },
    }));
    await builder.targetDirectory.getFileHandle({
      name: directoryEntryName({ index: 0 }),
      create: false,
    });
    await builder.targetDirectory.getFileHandle({
      name: directoryEntryName({ index: entryCount - 1 }),
      create: false,
    });
  } finally {
    await closeBenchmarkContexts({ contexts: isolatedContexts });
  }
  return samples;
}

async function runHizoFSMaintenanceWorkload({
  configuration,
  context,
  phase,
  iteration,
  randomSeed,
  assertActive,
  onCaseStart,
}: {
  configuration: HizoFSBenchmarkConfiguration;
  context: BenchmarkContext;
  phase: BenchmarkPhase;
  iteration: number;
  randomSeed: number;
  assertActive: () => void;
  onCaseStart: ({ caseId }: { caseId: string }) => void;
}): Promise<readonly CaseSample[]> {
  if (
    context.kind !== 'hizofs'
    || context.hizoFSSession === undefined
    || context.hizoFSPhysicalBackingDirectory === undefined
    || context.hizoFSRuntime === undefined
  ) {
    return [];
  }
  const directoryName = `maintenance-${phase}-${String(iteration)}`;
  const directory = await context.hizoFSSession.root.getDirectoryHandle({
    name: directoryName,
    create: true,
  });
  const sourceName = 'source.bin';
  const block = createPatternBytes({
    size: Math.min(configuration.randomAccess.blockSizeBytes, 256 * 1024),
    seed: randomSeed,
  });
  await writeBackendFileByBlocks({
    context,
    directory,
    name: sourceName,
    sizeBytes: configuration.hizoFSMaintenance.sourceFileSizeBytes,
    block,
    keepExistingData: false,
    startPosition: 0,
    assertActive,
  });
  const foregroundProbeName = `foreground-probe-${phase}-${String(iteration)}.bin`;
  await writeBackendFile({
    context,
    directory: await getBackendRoot({ context }),
    name: foregroundProbeName,
    create: true,
    bytes: new Uint8Array([1]),
    keepExistingData: false,
    position: 0,
  });
  const parameters = {
    cloneCount: configuration.hizoFSMaintenance.cloneCount,
    sourceFileSizeBytes: configuration.hizoFSMaintenance.sourceFileSizeBytes,
    cowWriteBlockSizeBytes: block.byteLength,
    foregroundProbeOperationLimit: 10_000,
  };
  const samples: CaseSample[] = [];

  onCaseStart({ caseId: 'hizofs_reflink_clone' });
  samples.push(await measureCase({
    context,
    workload: 'hizofs_maintenance',
    caseId: 'hizofs_reflink_clone',
    label: 'Create whole-file reflink clones',
    parameters,
    phase,
    iteration,
    operationCount: configuration.hizoFSMaintenance.cloneCount,
    bytesProcessed: 0,
    operation: async () => {
      for (let index = 0; index < configuration.hizoFSMaintenance.cloneCount; index += 1) {
        assertActive();
        context.apiCounters.cloneCalls += 1;
        await directory.cloneFile({
          name: sourceName,
          destination: directory,
          newName: `clone-${String(index).padStart(6, '0')}.bin`,
          replace: false,
        });
      }
      return 0;
    },
  }));

  onCaseStart({ caseId: 'hizofs_clone_cow_write' });
  samples.push(await measureCase({
    context,
    workload: 'hizofs_maintenance',
    caseId: 'hizofs_clone_cow_write',
    label: 'Write one block into each clone',
    parameters,
    phase,
    iteration,
    operationCount: configuration.hizoFSMaintenance.cloneCount,
    bytesProcessed: configuration.hizoFSMaintenance.cloneCount * block.byteLength,
    operation: async () => {
      for (let index = 0; index < configuration.hizoFSMaintenance.cloneCount; index += 1) {
        assertActive();
        await writeBackendFile({
          context,
          directory,
          name: `clone-${String(index).padStart(6, '0')}.bin`,
          create: false,
          bytes: block,
          keepExistingData: true,
          position: 0,
        });
      }
      return 0;
    },
  }));

  onCaseStart({ caseId: 'hizofs_integrity_scan' });
  samples.push(await measureCase({
    context,
    workload: 'hizofs_maintenance',
    caseId: 'hizofs_integrity_scan',
    label: 'Reachability scan without deletion',
    parameters,
    phase,
    iteration,
    operationCount: 1,
    bytesProcessed: 0,
    operation: async () => {
      const result = await context.hizoFSRuntime!.collectGarbage({
        dryRun: true,
        sweepPolicy: configuration.hizoFSMaintenance.garbageCollectionSweep,
        signal: undefined,
      });
      return {
        checksum: (result.reachableObjectCount + result.unreachableObjectCount) >>> 0,
        garbageCollection: result.diagnostics,
        foregroundLatency: undefined,
      };
    },
  }));

  await context.hizoFSSession.root.removeEntry({
    name: directoryName,
    recursive: true,
  });

  onCaseStart({ caseId: 'hizofs_garbage_collection' });
  samples.push(await measureCase({
    context,
    workload: 'hizofs_maintenance',
    caseId: 'hizofs_garbage_collection',
    label: 'Garbage collection after clone deletion',
    parameters,
    phase,
    iteration,
    operationCount: 1,
    bytesProcessed: 0,
    operation: async () => {
      let collectionSettled = false;
      const collection = context.hizoFSRuntime!.collectGarbage({
        dryRun: false,
        sweepPolicy: configuration.hizoFSMaintenance.garbageCollectionSweep,
        signal: undefined,
      });
      void collection.then(
        () => {
          collectionSettled = true;
        },
        () => {
          collectionSettled = true;
        },
      );
      const foregroundLatencies: number[] = [];
      let foregroundChecksum = 0;
      do {
        assertActive();
        const foregroundStartedAt = performance.now();
        foregroundChecksum = addChecksum({
          checksum: foregroundChecksum,
          value: await readBackendFile({
            context,
            directory: await getBackendRoot({ context }),
            name: foregroundProbeName,
            blockSizeBytes: 1,
            assertActive,
          }),
        });
        foregroundLatencies.push(Math.max(
          performance.now() - foregroundStartedAt,
          0,
        ));
        await yieldToBenchmarkEventLoop();
      } while (!collectionSettled && foregroundLatencies.length < 10_000);
      const result = await collection;
      return {
        checksum: addChecksum({
          checksum: result.removedObjectCount >>> 0,
          value: foregroundChecksum,
        }),
        garbageCollection: result.diagnostics,
        foregroundLatency: summarizeForegroundLatencies({
          durationsMs: foregroundLatencies,
        }),
      };
    },
  }));
  return samples;
}

type BenchmarkCaseOperationResult = number | {
  readonly checksum: number;
  readonly garbageCollection: HizoFSBenchmarkGarbageCollectionDiagnostics;
  readonly foregroundLatency: HizoFSBenchmarkSample['foregroundLatency'];
};

async function measureCase({
  context,
  workload,
  caseId,
  label,
  parameters,
  phase,
  iteration,
  operationCount,
  bytesProcessed,
  apiCounterBaseline,
  operation,
}: {
  context: BenchmarkContext;
  workload: HizoFSBenchmarkWorkload;
  caseId: string;
  label: string;
  parameters: Readonly<Record<string, string | number | boolean>>;
  phase: BenchmarkPhase;
  iteration: number;
  operationCount: number;
  bytesProcessed: number;
  apiCounterBaseline?: BenchmarkApiCounters;
  operation: () => Promise<BenchmarkCaseOperationResult>;
}): Promise<CaseSample> {
  // Resource high-water marks are live gauges rather than cumulative counters.
  // Reset only their maxima at the public-case boundary so each sample reports
  // its own bounded working set without disturbing any live reservations.
  context.hizoFSRuntime?.diagnostics.resetResourceHighWaterMarks();
  const before = readHizoFSDiagnosticBaseline({ context });
  // Some product-owned setup operations establish a valid capability before
  // duration and storage diagnostics begin. Their public API calls still
  // belong to the case, so callers may capture the API baseline before setup.
  const apiBefore = { ...(apiCounterBaseline ?? context.apiCounters) };
  beginMemoryMeasurement({ tracker: context.memoryTracker });
  const startedAt = performance.now();
  const operationResult = await operation();
  const acceptedAt = performance.now();
  let settlementDurationMs: number | undefined;
  switch (context.kind) {
  case 'hizofs': {
    const runtime = context.hizoFSRuntime;
    if (runtime === undefined) {
      throw new TypeError('HizoFS benchmark context has no runtime to sync');
    }
    const settlementStartedAt = performance.now();
    await runtime.settleAcceptedGeneration();
    settlementDurationMs = Math.max(performance.now() - settlementStartedAt, 0);
    break;
  }
  case 'raw_opfs':
    settlementDurationMs = undefined;
    break;
  default: {
    const _ex: never = context.kind;
    throw new Error(`Unhandled benchmark context: ${String(_ex)}`);
  }
  }
  const checksum = typeof operationResult === 'number'
    ? operationResult
    : operationResult.checksum;
  const garbageCollection = typeof operationResult === 'number'
    ? undefined
    : operationResult.garbageCollection;
  const foregroundLatency = typeof operationResult === 'number'
    ? undefined
    : operationResult.foregroundLatency;
  const acceptedDurationMs = Math.max(acceptedAt - startedAt, 0);
  const durationMs = Math.max(performance.now() - startedAt, 0);
  const after = readHizoFSDiagnosticBaseline({ context });
  return {
    workload,
    caseId,
    label,
    parameters,
    backend: context.kind,
    sample: {
      iteration,
      phase,
      includedInAggregates: phase === 'measured',
      acceptedDurationMs,
      settlementDurationMs,
      durationMs,
      operationCount,
      bytesProcessed,
      checksum,
      apiOperations: subtractBenchmarkApiCounters({
        before: apiBefore,
        after: context.apiCounters,
      }),
      memory: readMemoryDiagnostics({ tracker: context.memoryTracker }),
      hizoFSDiagnostics: createHizoFSDiagnostics({
        before,
        after,
        plaintextBytesProcessed: bytesProcessed,
        operationCount,
      }),
      garbageCollection,
      foregroundLatency,
    },
  };
}

type HizoFSDiagnosticSnapshot = {
  readonly counters: BackingStoreCounters;
  readonly objectCount: number;
  readonly physicalStoreShape: PhysicalStoreShape;
  readonly superblockPublications: number;
  readonly runtime: HizoFSBenchmarkRuntimeDiagnosticsSnapshot;
};

function readHizoFSDiagnosticBaseline({
  context,
}: {
  context: BenchmarkContext;
}): HizoFSDiagnosticSnapshot | undefined {
  if (
    context.kind !== 'hizofs'
    || context.counters === undefined
    || context.hizoFSPhysicalDiagnostics === undefined
    || context.hizoFSRuntime === undefined
  ) {
    return undefined;
  }
  return {
    counters: snapshotBackingStoreCounters({ counters: context.counters }),
    objectCount: context.hizoFSPhysicalDiagnostics.objectPaths.size,
    physicalStoreShape: snapshotPhysicalStoreShape({
      objectPaths: context.hizoFSPhysicalDiagnostics.objectPaths,
    }),
    superblockPublications: context.hizoFSPhysicalDiagnostics.superblockPublications,
    runtime: context.hizoFSRuntime.diagnostics.snapshot(),
  };
}

function createHizoFSDiagnostics({
  before,
  after,
  plaintextBytesProcessed,
  operationCount,
}: {
  before: HizoFSDiagnosticSnapshot | undefined;
  after: HizoFSDiagnosticSnapshot | undefined;
  plaintextBytesProcessed: number;
  operationCount: number;
}): HizoFSBenchmarkDiagnostics | undefined {
  if (before === undefined || after === undefined) return undefined;
  const counters = subtractBackingStoreCounters({ before: before.counters, after: after.counters });
  const runtime = subtractHizoFSRuntimeDiagnostics({
    before: before.runtime,
    after: after.runtime,
  });
  const commitMaterializations = fileSystemCommitMaterializations({ runtime });
  return {
    backingStore: counters,
    objects: {
      before: before.objectCount,
      after: after.objectCount,
      created: Math.max(after.objectCount - before.objectCount, 0),
      removed: Math.max(before.objectCount - after.objectCount, 0),
    },
    physicalStore: {
      before: before.physicalStoreShape,
      after: after.physicalStoreShape,
    },
    commits: {
      superblockPublications: Math.max(after.superblockPublications - before.superblockPublications, 0),
    },
    crypto: {
      plaintextBytesProcessed,
      ciphertextBytesWritten: counters.bytesWritten,
    },
    runtime,
    amplification: {
      backingReadBytesPerLogicalByte: ratioOptional({
        numerator: counters.bytesRead,
        denominator: plaintextBytesProcessed,
      }),
      backingWriteBytesPerLogicalByte: ratioOptional({
        numerator: counters.bytesWritten,
        denominator: plaintextBytesProcessed,
      }),
      objectCreatesPerOperation: ratioOptional({
        numerator: Math.max(after.objectCount - before.objectCount, 0),
        denominator: operationCount,
      }),
      commitMaterializationsPerOperation: commitMaterializations === undefined
        ? undefined
        : ratioOptional({ numerator: commitMaterializations, denominator: operationCount }),
      superblockPublicationsPerOperation: ratioOptional({
        numerator: Math.max(after.superblockPublications - before.superblockPublications, 0),
        denominator: operationCount,
      }),
    },
  };
}

function fileSystemCommitMaterializations({ runtime }: {
  runtime: HizoFSBenchmarkDiagnostics['runtime'];
}): number | undefined {
  switch (runtime.type) {
  case 'measured': return runtime.records.file_system_commit.writeOperations;
  case 'unavailable': return undefined;
  default: return runtime satisfies never;
  }
}

function unavailableRuntimeDiagnostics({ reason }: {
  reason: string;
}): HizoFSBenchmarkRuntimeDiagnosticsSnapshot {
  return {
    schemaVersion: 9,
    type: 'unavailable',
    reason,
  };
}

function subtractHizoFSRuntimeDiagnostics({
  before,
  after,
}: {
  before: HizoFSBenchmarkRuntimeDiagnosticsSnapshot;
  after: HizoFSBenchmarkRuntimeDiagnosticsSnapshot;
}): HizoFSBenchmarkRuntimeDiagnosticsSnapshot {
  switch (after.type) {
  case 'unavailable': return after;
  case 'measured': break;
  default: return after satisfies never;
  }
  switch (before.type) {
  case 'unavailable':
    return unavailableRuntimeDiagnostics({
      reason: `runtime diagnostics baseline unavailable: ${before.reason}`,
    });
  case 'measured': break;
  default: return before satisfies never;
  }
  return {
    schemaVersion: 9,
    type: 'measured',
    phases: Object.fromEntries(
      HIZOFS_BENCHMARK_RUNTIME_PHASES.map(phase => [
        phase,
        {
          operationCount: Math.max(
            after.phases[phase].operationCount - before.phases[phase].operationCount,
            0,
          ),
          totalDurationMs: Math.max(
            after.phases[phase].totalDurationMs - before.phases[phase].totalDurationMs,
            0,
          ),
        },
      ]),
    ) as HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['phases'],
    records: Object.fromEntries(
      HIZOFS_BENCHMARK_PERSISTED_RECORD_KINDS.map(kind => {
        const beforeRecord = before.records[kind];
        const afterRecord = after.records[kind];
        return [
          kind,
          {
            readOperations: Math.max(afterRecord.readOperations - beforeRecord.readOperations, 0),
            writeOperations: Math.max(afterRecord.writeOperations - beforeRecord.writeOperations, 0),
            cacheHits: Math.max(afterRecord.cacheHits - beforeRecord.cacheHits, 0),
            cacheMisses: Math.max(afterRecord.cacheMisses - beforeRecord.cacheMisses, 0),
            plaintextBytesRead: Math.max(
              afterRecord.plaintextBytesRead - beforeRecord.plaintextBytesRead,
              0,
            ),
            plaintextBytesWritten: Math.max(
              afterRecord.plaintextBytesWritten - beforeRecord.plaintextBytesWritten,
              0,
            ),
            physicalBytesRead: Math.max(
              afterRecord.physicalBytesRead - beforeRecord.physicalBytesRead,
              0,
            ),
            physicalBytesWritten: Math.max(
              afterRecord.physicalBytesWritten - beforeRecord.physicalBytesWritten,
              0,
            ),
          },
        ];
      }),
    ) as HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['records'],
    caches: {
      metadata: subtractHizoFSRuntimeCacheDiagnostics({
        before: before.caches.metadata,
        after: after.caches.metadata,
      }),
      mutationMetadata: subtractHizoFSRuntimeCacheDiagnostics({
        before: before.caches.mutationMetadata,
        after: after.caches.mutationMetadata,
      }),
      fileChunk: subtractHizoFSRuntimeCacheDiagnostics({
        before: before.caches.fileChunk,
        after: after.caches.fileChunk,
      }),
      backingFileHandle: subtractHizoFSRuntimeCacheDiagnostics({
        before: before.caches.backingFileHandle,
        after: after.caches.backingFileHandle,
      }),
      backingFileSnapshot: subtractHizoFSRuntimeCacheDiagnostics({
        before: before.caches.backingFileSnapshot,
        after: after.caches.backingFileSnapshot,
      }),
      decodedInodeIndexPage: subtractHizoFSRuntimeCacheDiagnostics({
        before: before.caches.decodedInodeIndexPage,
        after: after.caches.decodedInodeIndexPage,
      }),
    },
    resources: {
      writerDirtyChunks: copyHizoFSRuntimeResourceDiagnostics({
        after: after.resources.writerDirtyChunks,
      }),
      writerPendingChunkWrites: copyHizoFSRuntimeResourceDiagnostics({
        after: after.resources.writerPendingChunkWrites,
      }),
      readerPrefetch: copyHizoFSRuntimeResourceDiagnostics({
        after: after.resources.readerPrefetch,
      }),
    },
    coordinator: {
      activeStateCacheHits: Math.max(
        after.coordinator.activeStateCacheHits - before.coordinator.activeStateCacheHits,
        0,
      ),
      durableReloads: Math.max(
        after.coordinator.durableReloads - before.coordinator.durableReloads,
        0,
      ),
      leadershipAcquisitions: Math.max(
        after.coordinator.leadershipAcquisitions - before.coordinator.leadershipAcquisitions,
        0,
      ),
      failovers: Math.max(after.coordinator.failovers - before.coordinator.failovers, 0),
      localRequests: Math.max(
        after.coordinator.localRequests - before.coordinator.localRequests,
        0,
      ),
      remoteRequests: Math.max(
        after.coordinator.remoteRequests - before.coordinator.remoteRequests,
        0,
      ),
    },
    indexes: Object.fromEntries(IMMUTABLE_BTREE_DIAGNOSTIC_OPERATIONS.map(operation => [operation,
      subtractHizoFSRuntimeIndexDiagnostics({
        before: before.indexes[operation],
        after: after.indexes[operation],
      }),
    ])) as HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['indexes'],
    inodeLeafLookup: subtractHizoFSRuntimeInodeLeafLookupDiagnostics({
      after: after.inodeLeafLookup,
      before: before.inodeLeafLookup,
    }),
    mutation: {
      abandoned: Math.max(after.mutation.abandoned - before.mutation.abandoned, 0),
      completed: Math.max(after.mutation.completed - before.mutation.completed, 0),
      failed: Math.max(after.mutation.failed - before.mutation.failed, 0),
      overlapping: Math.max(after.mutation.overlapping - before.mutation.overlapping, 0),
      getFileSize: subtractHizoFSRuntimeScopedAccessDiagnostics({
        before: before.mutation.getFileSize,
        after: after.mutation.getFileSize,
      }),
      physicalAccessReasons: Object.fromEntries(
        AUTHENTICATED_PHYSICAL_ACCESS_REASONS.map(reason => [reason, {
          getFileSize: subtractHizoFSRuntimeScopedAccessDiagnostics({
            before: before.mutation.physicalAccessReasons[reason].getFileSize,
            after: after.mutation.physicalAccessReasons[reason].getFileSize,
          }),
          readExact: subtractHizoFSRuntimeScopedAccessDiagnostics({
            before: before.mutation.physicalAccessReasons[reason].readExact,
            after: after.mutation.physicalAccessReasons[reason].readExact,
          }),
        }]),
      ) as HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['mutation']['physicalAccessReasons'],
      readExact: subtractHizoFSRuntimeScopedAccessDiagnostics({
        before: before.mutation.readExact,
        after: after.mutation.readExact,
      }),
    },
    publication: {
      completed: Math.max(after.publication.completed - before.publication.completed, 0),
      overlapping: Math.max(after.publication.overlapping - before.publication.overlapping, 0),
      getFileSize: subtractHizoFSRuntimeScopedAccessDiagnostics({
        before: before.publication.getFileSize,
        after: after.publication.getFileSize,
      }),
      readExact: subtractHizoFSRuntimeScopedAccessDiagnostics({
        before: before.publication.readExact,
        after: after.publication.readExact,
      }),
    },
    segmentWriters: {
      data: subtractHizoFSRuntimeSegmentWriterDiagnostics({
        before: before.segmentWriters.data,
        after: after.segmentWriters.data,
      }),
      metadata: subtractHizoFSRuntimeSegmentWriterDiagnostics({
        before: before.segmentWriters.metadata,
        after: after.segmentWriters.metadata,
      }),
      relocation: subtractHizoFSRuntimeSegmentWriterDiagnostics({
        before: before.segmentWriters.relocation,
        after: after.segmentWriters.relocation,
      }),
    },
  };
}

function subtractHizoFSRuntimeIndexDiagnostics({
  before,
  after,
}: {
  before: HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['indexes']['update'];
  after: HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['indexes']['update'];
}): HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['indexes']['update'] {
  return {
    inputMutations: Math.max(after.inputMutations - before.inputMutations, 0),
    maximumPageLevel: after.maximumPageLevel,
    operations: Math.max(after.operations - before.operations, 0),
    pageReads: Math.max(after.pageReads - before.pageReads, 0),
    pageWrites: Math.max(after.pageWrites - before.pageWrites, 0),
    rootCollapses: Math.max(after.rootCollapses - before.rootCollapses, 0),
    splitOperations: Math.max(after.splitOperations - before.splitOperations, 0),
    splitOutputPages: Math.max(after.splitOutputPages - before.splitOutputPages, 0),
    unchangedPageReuses: Math.max(
      after.unchangedPageReuses - before.unchangedPageReuses,
      0,
    ),
  };
}

function subtractHizoFSRuntimeScopedAccessDiagnostics({
  before,
  after,
}: {
  before: HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['publication']['getFileSize'];
  after: HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['publication']['getFileSize'];
}): HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['publication']['getFileSize'] {
  return {
    duplicateOperations: Math.max(after.duplicateOperations - before.duplicateOperations, 0),
    maximumOperationsPerScope: after.maximumOperationsPerScope,
    operations: Math.max(after.operations - before.operations, 0),
    observedUniqueTargets: Math.max(after.observedUniqueTargets - before.observedUniqueTargets, 0),
    truncatedScopes: Math.max(after.truncatedScopes - before.truncatedScopes, 0),
    unclassifiedOperations: Math.max(after.unclassifiedOperations - before.unclassifiedOperations, 0),
  };
}

function subtractHizoFSRuntimeSegmentWriterDiagnostics({
  before,
  after,
}: {
  before: HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['segmentWriters']['metadata'];
  after: HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['segmentWriters']['metadata'];
}): HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['segmentWriters']['metadata'] {
  return {
    appendOperations: Math.max(after.appendOperations - before.appendOperations, 0),
    appendReadBackVerifications: Math.max(after.appendReadBackVerifications - before.appendReadBackVerifications, 0),
    appendedFrameBytes: Math.max(after.appendedFrameBytes - before.appendedFrameBytes, 0),
    appendedRecords: Math.max(after.appendedRecords - before.appendedRecords, 0),
    multiRecordAppendOperations: Math.max(
      after.multiRecordAppendOperations - before.multiRecordAppendOperations,
      0,
    ),
    created: Math.max(after.created - before.created, 0),
    descriptorValidations: Math.max(after.descriptorValidations - before.descriptorValidations, 0),
    rollovers: Math.max(after.rollovers - before.rollovers, 0),
    trustedTailMatches: Math.max(after.trustedTailMatches - before.trustedTailMatches, 0),
    trustedTailMismatches: Math.max(after.trustedTailMismatches - before.trustedTailMismatches, 0),
  };
}

function subtractHizoFSRuntimeCacheDiagnostics({
  before,
  after,
}: {
  before: HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['caches']['metadata'];
  after: HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['caches']['metadata'];
}): HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['caches']['metadata'] {
  return {
    hits: Math.max(after.hits - before.hits, 0),
    misses: Math.max(after.misses - before.misses, 0),
    evictions: Math.max(after.evictions - before.evictions, 0),
    currentBytes: after.currentBytes,
    maximumBytes: after.maximumBytes,
    currentEntries: after.currentEntries,
    maximumEntries: after.maximumEntries,
  };
}

function copyHizoFSRuntimeResourceDiagnostics({
  after,
}: {
  after: HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['resources']['writerDirtyChunks'];
}): HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['resources']['writerDirtyChunks'] {
  // Resource counters are live gauges. Their high-water marks are reset at the
  // case boundary, so retain the post-case current value and case-local maximum
  // instead of subtracting them like cumulative counters.
  return { ...after };
}

function aggregateSamples({
  samples,
}: {
  samples: readonly CaseSample[];
}): HizoFSBenchmarkReport['results'] {
  const cases = new Map<string, {
    workload: HizoFSBenchmarkWorkload;
    caseId: string;
    label: string;
    parameters: Readonly<Record<string, string | number | boolean>>;
    rawOpfs: HizoFSBenchmarkSample[];
    hizofs: HizoFSBenchmarkSample[];
  }>();
  for (const sample of samples) {
    const key = `${sample.workload}:${sample.caseId}`;
    let entry = cases.get(key);
    if (entry === undefined) {
      entry = {
        workload: sample.workload,
        caseId: sample.caseId,
        label: sample.label,
        parameters: sample.parameters,
        rawOpfs: [],
        hizofs: [],
      };
      cases.set(key, entry);
    }
    switch (sample.backend) {
    case 'raw_opfs':
      entry.rawOpfs.push(sample.sample);
      break;
    case 'hizofs':
      entry.hizofs.push(sample.sample);
      break;
    default: {
      const _ex: never = sample.backend;
      throw new Error(`Unhandled benchmark backend: ${String(_ex)}`);
    }
    }
  }

  return [...cases.values()].map(entry => {
    const rawOpfs = summarizeBackendSamples({ samples: entry.rawOpfs });
    const hizofs = summarizeBackendSamples({ samples: entry.hizofs });
    return {
      workload: entry.workload,
      caseId: entry.caseId,
      label: entry.label,
      parameters: entry.parameters,
      backends: { rawOpfs, hizofs },
      comparison: rawOpfs === undefined || hizofs === undefined
        ? undefined
        : {
          durationRatio: ratioOptional({
            numerator: hizofs.durationMs.median,
            denominator: rawOpfs.durationMs.median,
          }),
          operationsPerSecondRatio: ratioOptional({
            numerator: hizofs.operationsPerSecond,
            denominator: rawOpfs.operationsPerSecond,
          }),
          throughputRatio: ratioOptional({
            numerator: hizofs.throughputBytesPerSecond,
            denominator: rawOpfs.throughputBytesPerSecond,
          }),
        },
    } satisfies HizoFSBenchmarkCaseResult;
  });
}

function summarizeBackendSamples({
  samples,
}: {
  samples: readonly HizoFSBenchmarkSample[];
}): HizoFSBenchmarkCaseResult['backends']['rawOpfs'] {
  if (samples.length === 0) return undefined;
  const measured = samples.filter(sample => sample.includedInAggregates);
  if (measured.length === 0) return undefined;
  const durations = measured.map(sample => sample.durationMs).sort((left, right) => left - right);
  const operationRates = measured
    .filter(sample => sample.operationCount > 0 && sample.durationMs > 0)
    .map(sample => sample.operationCount / (sample.durationMs / 1000));
  const throughputRates = measured
    .filter(sample => sample.bytesProcessed > 0 && sample.durationMs > 0)
    .map(sample => sample.bytesProcessed / (sample.durationMs / 1000));
  return {
    sampleCount: measured.length,
    durationMs: {
      median: median({ values: durations }),
      p95: percentile({ sortedValues: durations, percentile: 0.95 }),
      minimum: durations[0] ?? 0,
      maximum: durations.at(-1) ?? 0,
    },
    operationsPerSecond: operationRates.length === 0
      ? undefined
      : median({ values: operationRates }),
    throughputBytesPerSecond: throughputRates.length === 0
      ? undefined
      : median({ values: throughputRates }),
    apiOperationTotals: aggregateBenchmarkApiCounters({ samples: measured }),
    memoryHighWater: aggregateBenchmarkMemoryDiagnostics({ samples: measured }),
    hizoFSDiagnosticsTotals: aggregateHizoFSDiagnosticsTotals({ samples: measured }),
    samples: [...samples],
  };
}

function aggregateBenchmarkApiCounters({
  samples,
}: {
  samples: readonly HizoFSBenchmarkSample[];
}): BenchmarkApiCounters {
  const total = createEmptyBenchmarkApiCounters();
  for (const sample of samples) {
    total.directoryHandleLookups += sample.apiOperations.directoryHandleLookups;
    total.directoryCreates += sample.apiOperations.directoryCreates;
    total.fileHandleLookups += sample.apiOperations.fileHandleLookups;
    total.fileCreates += sample.apiOperations.fileCreates;
    total.writableOpens += sample.apiOperations.writableOpens;
    total.writeCalls += sample.apiOperations.writeCalls;
    total.truncateCalls += sample.apiOperations.truncateCalls;
    total.readableOpens += sample.apiOperations.readableOpens;
    total.readCalls += sample.apiOperations.readCalls;
    total.directoryLists += sample.apiOperations.directoryLists;
    total.removeCalls += sample.apiOperations.removeCalls;
    total.cloneCalls += sample.apiOperations.cloneCalls;
    total.bulkBuilderCreates += sample.apiOperations.bulkBuilderCreates;
    total.bulkEntryCreates += sample.apiOperations.bulkEntryCreates;
    total.bulkCommits += sample.apiOperations.bulkCommits;
  }
  return total;
}

function aggregateBenchmarkMemoryDiagnostics({
  samples,
}: {
  samples: readonly HizoFSBenchmarkSample[];
}): HizoFSBenchmarkSample['memory'] {
  return {
    maximumTrackedBytes: Math.max(...samples.map(sample => sample.memory.maximumTrackedBytes), 0),
    largestTrackedAllocationBytes: Math.max(
      ...samples.map(sample => sample.memory.largestTrackedAllocationBytes),
      0,
    ),
    scope: 'benchmark_harness_buffers_only',
  };
}

function addBackingDirectoryPathCounters({
  target,
  source,
}: {
  target: BackingStoreCounters['pathAttribution']['directoryHandleLookups'];
  source: BackingStoreCounters['pathAttribution']['directoryHandleLookups'];
}): void {
  target.root += source.root;
  target.segmentRoot += source.segmentRoot;
  target.segmentClass += source.segmentClass;
  target.segmentShard += source.segmentShard;
  target.other += source.other;
}

function addBackingFilePathCounters({
  target,
  source,
}: {
  target: BackingStoreCounters['pathAttribution']['fileHandleLookups'];
  source: BackingStoreCounters['pathAttribution']['fileHandleLookups'];
}): void {
  target.superblock += source.superblock;
  target.unlockEnvelope += source.unlockEnvelope;
  target.metadataSegment += source.metadataSegment;
  target.dataSegment += source.dataSegment;
  target.relocationSegment += source.relocationSegment;
  target.other += source.other;
}

function addBackingStoreCounters({
  target,
  source,
}: {
  target: BackingStoreCounters;
  source: BackingStoreCounters;
}): void {
  target.directoryHandleLookups += source.directoryHandleLookups;
  target.directoryHandleCreateRequests += source.directoryHandleCreateRequests;
  target.fileHandleLookups += source.fileHandleLookups;
  target.fileHandleCreateRequests += source.fileHandleCreateRequests;
  target.fileSnapshotOperations += source.fileSnapshotOperations;
  target.readOperations += source.readOperations;
  target.writeOperations += source.writeOperations;
  target.removeOperations += source.removeOperations;
  target.listOperations += source.listOperations;
  target.listEntriesMaterialized += source.listEntriesMaterialized;
  target.bytesRead += source.bytesRead;
  target.bytesWritten += source.bytesWritten;
  addBackingDirectoryPathCounters({
    target: target.pathAttribution.directoryHandleLookups,
    source: source.pathAttribution.directoryHandleLookups,
  });
  addBackingDirectoryPathCounters({
    target: target.pathAttribution.directoryHandleCreateRequests,
    source: source.pathAttribution.directoryHandleCreateRequests,
  });
  addBackingFilePathCounters({
    target: target.pathAttribution.fileHandleLookups,
    source: source.pathAttribution.fileHandleLookups,
  });
  addBackingFilePathCounters({
    target: target.pathAttribution.fileHandleCreateRequests,
    source: source.pathAttribution.fileHandleCreateRequests,
  });
  addBackingFilePathCounters({
    target: target.pathAttribution.fileSnapshotOperations,
    source: source.pathAttribution.fileSnapshotOperations,
  });
  addBackingDirectoryPathCounters({
    target: target.pathAttribution.listOperations,
    source: source.pathAttribution.listOperations,
  });
  addBackingDirectoryPathCounters({
    target: target.pathAttribution.listEntriesMaterialized,
    source: source.pathAttribution.listEntriesMaterialized,
  });
}

function aggregateHizoFSDiagnosticsTotals({
  samples,
}: {
  samples: readonly HizoFSBenchmarkSample[];
}): HizoFSBenchmarkDiagnosticsTotals | undefined {
  const diagnostics = samples
    .map(sample => sample.hizoFSDiagnostics)
    .filter((value): value is HizoFSBenchmarkDiagnostics => value !== undefined);
  if (diagnostics.length === 0) return undefined;

  const backingStore = createEmptyBackingStoreCounters();
  let created = 0;
  let removed = 0;
  let superblockPublications = 0;
  let plaintextBytesProcessed = 0;
  let ciphertextBytesWritten = 0;
  let operationCount = 0;
  for (const diagnostic of diagnostics) {
    addBackingStoreCounters({
      target: backingStore,
      source: diagnostic.backingStore,
    });
    created += diagnostic.objects.created;
    removed += diagnostic.objects.removed;
    superblockPublications += diagnostic.commits.superblockPublications;
    plaintextBytesProcessed += diagnostic.crypto.plaintextBytesProcessed;
    ciphertextBytesWritten += diagnostic.crypto.ciphertextBytesWritten;
  }
  for (const sample of samples) operationCount += sample.operationCount;
  const runtime = aggregateHizoFSRuntimeDiagnostics({
    diagnostics: diagnostics.map(diagnostic => diagnostic.runtime),
  });
  const commitMaterializations = fileSystemCommitMaterializations({ runtime });

  return {
    backingStore,
    objectChanges: { created, removed },
    commits: { superblockPublications },
    crypto: { plaintextBytesProcessed, ciphertextBytesWritten },
    runtime,
    amplification: {
      backingReadBytesPerLogicalByte: ratioOptional({
        numerator: backingStore.bytesRead,
        denominator: plaintextBytesProcessed,
      }),
      backingWriteBytesPerLogicalByte: ratioOptional({
        numerator: backingStore.bytesWritten,
        denominator: plaintextBytesProcessed,
      }),
      objectCreatesPerOperation: ratioOptional({
        numerator: created,
        denominator: operationCount,
      }),
      commitMaterializationsPerOperation: commitMaterializations === undefined
        ? undefined
        : ratioOptional({ numerator: commitMaterializations, denominator: operationCount }),
      superblockPublicationsPerOperation: ratioOptional({
        numerator: superblockPublications,
        denominator: operationCount,
      }),
    },
  };
}

function aggregateHizoFSRuntimeDiagnostics({
  diagnostics,
}: {
  diagnostics: readonly HizoFSBenchmarkRuntimeDiagnosticsSnapshot[];
}): HizoFSBenchmarkRuntimeDiagnosticsSnapshot {
  const last = diagnostics.at(-1);
  if (last === undefined) {
    throw new Error('HizoFS runtime diagnostics aggregate requires at least one sample');
  }
  const unavailable = diagnostics.find((value): value is Extract<
    HizoFSBenchmarkRuntimeDiagnosticsSnapshot,
    { readonly type: 'unavailable' }
  > => value.type === 'unavailable');
  if (unavailable !== undefined) return unavailable;
  const measured = diagnostics as readonly HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot[];
  const current = measured.at(-1);
  if (current === undefined) {
    throw new Error('HizoFS measured runtime diagnostics aggregate requires at least one sample');
  }
  return {
    schemaVersion: 9,
    type: 'measured',
    phases: Object.fromEntries(
      HIZOFS_BENCHMARK_RUNTIME_PHASES.map(phase => [
        phase,
        {
          operationCount: measured.reduce(
            (sum, value) => sum + value.phases[phase].operationCount,
            0,
          ),
          totalDurationMs: measured.reduce(
            (sum, value) => sum + value.phases[phase].totalDurationMs,
            0,
          ),
        },
      ]),
    ) as HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['phases'],
    records: Object.fromEntries(
      HIZOFS_BENCHMARK_PERSISTED_RECORD_KINDS.map(kind => [
        kind,
        {
          readOperations: measured.reduce(
            (sum, value) => sum + value.records[kind].readOperations,
            0,
          ),
          writeOperations: measured.reduce(
            (sum, value) => sum + value.records[kind].writeOperations,
            0,
          ),
          cacheHits: measured.reduce(
            (sum, value) => sum + value.records[kind].cacheHits,
            0,
          ),
          cacheMisses: measured.reduce(
            (sum, value) => sum + value.records[kind].cacheMisses,
            0,
          ),
          plaintextBytesRead: measured.reduce(
            (sum, value) => sum + value.records[kind].plaintextBytesRead,
            0,
          ),
          plaintextBytesWritten: measured.reduce(
            (sum, value) => sum + value.records[kind].plaintextBytesWritten,
            0,
          ),
          physicalBytesRead: measured.reduce(
            (sum, value) => sum + value.records[kind].physicalBytesRead,
            0,
          ),
          physicalBytesWritten: measured.reduce(
            (sum, value) => sum + value.records[kind].physicalBytesWritten,
            0,
          ),
        },
      ]),
    ) as HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['records'],
    caches: {
      metadata: aggregateHizoFSRuntimeCacheDiagnostics({
        diagnostics: measured.map(value => value.caches.metadata),
        current: current.caches.metadata,
      }),
      mutationMetadata: aggregateHizoFSRuntimeCacheDiagnostics({
        diagnostics: measured.map(value => value.caches.mutationMetadata),
        current: current.caches.mutationMetadata,
      }),
      fileChunk: aggregateHizoFSRuntimeCacheDiagnostics({
        diagnostics: measured.map(value => value.caches.fileChunk),
        current: current.caches.fileChunk,
      }),
      backingFileHandle: aggregateHizoFSRuntimeCacheDiagnostics({
        diagnostics: measured.map(value => value.caches.backingFileHandle),
        current: current.caches.backingFileHandle,
      }),
      backingFileSnapshot: aggregateHizoFSRuntimeCacheDiagnostics({
        diagnostics: measured.map(value => value.caches.backingFileSnapshot),
        current: current.caches.backingFileSnapshot,
      }),
      decodedInodeIndexPage: aggregateHizoFSRuntimeCacheDiagnostics({
        diagnostics: measured.map(value => value.caches.decodedInodeIndexPage),
        current: current.caches.decodedInodeIndexPage,
      }),
    },
    resources: {
      writerDirtyChunks: aggregateHizoFSRuntimeResourceDiagnostics({
        diagnostics: measured.map(value => value.resources.writerDirtyChunks),
        current: current.resources.writerDirtyChunks,
      }),
      writerPendingChunkWrites: aggregateHizoFSRuntimeResourceDiagnostics({
        diagnostics: measured.map(value => value.resources.writerPendingChunkWrites),
        current: current.resources.writerPendingChunkWrites,
      }),
      readerPrefetch: aggregateHizoFSRuntimeResourceDiagnostics({
        diagnostics: measured.map(value => value.resources.readerPrefetch),
        current: current.resources.readerPrefetch,
      }),
    },
    coordinator: {
      activeStateCacheHits: measured.reduce(
        (sum, value) => sum + value.coordinator.activeStateCacheHits,
        0,
      ),
      durableReloads: measured.reduce(
        (sum, value) => sum + value.coordinator.durableReloads,
        0,
      ),
      leadershipAcquisitions: measured.reduce(
        (sum, value) => sum + value.coordinator.leadershipAcquisitions,
        0,
      ),
      failovers: measured.reduce((sum, value) => sum + value.coordinator.failovers, 0),
      localRequests: measured.reduce(
        (sum, value) => sum + value.coordinator.localRequests,
        0,
      ),
      remoteRequests: measured.reduce(
        (sum, value) => sum + value.coordinator.remoteRequests,
        0,
      ),
    },
    indexes: Object.fromEntries(IMMUTABLE_BTREE_DIAGNOSTIC_OPERATIONS.map(operation => [operation,
      aggregateHizoFSRuntimeIndexDiagnostics({
        diagnostics: measured.map(value => value.indexes[operation]),
      }),
    ])) as HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['indexes'],
    inodeLeafLookup: aggregateHizoFSRuntimeInodeLeafLookupDiagnostics({
      diagnostics: measured.map(value => value.inodeLeafLookup),
    }),
    mutation: {
      abandoned: measured.reduce((sum, value) => sum + value.mutation.abandoned, 0),
      completed: measured.reduce((sum, value) => sum + value.mutation.completed, 0),
      failed: measured.reduce((sum, value) => sum + value.mutation.failed, 0),
      overlapping: measured.reduce((sum, value) => sum + value.mutation.overlapping, 0),
      getFileSize: aggregateHizoFSRuntimeScopedAccessDiagnostics({
        diagnostics: measured.map(value => value.mutation.getFileSize),
      }),
      physicalAccessReasons: Object.fromEntries(
        AUTHENTICATED_PHYSICAL_ACCESS_REASONS.map(reason => [reason, {
          getFileSize: aggregateHizoFSRuntimeScopedAccessDiagnostics({
            diagnostics: measured.map(value => value.mutation.physicalAccessReasons[reason].getFileSize),
          }),
          readExact: aggregateHizoFSRuntimeScopedAccessDiagnostics({
            diagnostics: measured.map(value => value.mutation.physicalAccessReasons[reason].readExact),
          }),
        }]),
      ) as HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['mutation']['physicalAccessReasons'],
      readExact: aggregateHizoFSRuntimeScopedAccessDiagnostics({
        diagnostics: measured.map(value => value.mutation.readExact),
      }),
    },
    publication: {
      completed: measured.reduce((sum, value) => sum + value.publication.completed, 0),
      overlapping: measured.reduce((sum, value) => sum + value.publication.overlapping, 0),
      getFileSize: aggregateHizoFSRuntimeScopedAccessDiagnostics({
        diagnostics: measured.map(value => value.publication.getFileSize),
      }),
      readExact: aggregateHizoFSRuntimeScopedAccessDiagnostics({
        diagnostics: measured.map(value => value.publication.readExact),
      }),
    },
    segmentWriters: {
      data: aggregateHizoFSRuntimeSegmentWriterDiagnostics({
        diagnostics: measured.map(value => value.segmentWriters.data),
      }),
      metadata: aggregateHizoFSRuntimeSegmentWriterDiagnostics({
        diagnostics: measured.map(value => value.segmentWriters.metadata),
      }),
      relocation: aggregateHizoFSRuntimeSegmentWriterDiagnostics({
        diagnostics: measured.map(value => value.segmentWriters.relocation),
      }),
    },
  };
}

function aggregateHizoFSRuntimeIndexDiagnostics({
  diagnostics,
}: {
  diagnostics: readonly HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['indexes']['update'][];
}): HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['indexes']['update'] {
  return {
    inputMutations: diagnostics.reduce((sum, value) => sum + value.inputMutations, 0),
    maximumPageLevel: Math.max(...diagnostics.map(value => value.maximumPageLevel)),
    operations: diagnostics.reduce((sum, value) => sum + value.operations, 0),
    pageReads: diagnostics.reduce((sum, value) => sum + value.pageReads, 0),
    pageWrites: diagnostics.reduce((sum, value) => sum + value.pageWrites, 0),
    rootCollapses: diagnostics.reduce((sum, value) => sum + value.rootCollapses, 0),
    splitOperations: diagnostics.reduce((sum, value) => sum + value.splitOperations, 0),
    splitOutputPages: diagnostics.reduce((sum, value) => sum + value.splitOutputPages, 0),
    unchangedPageReuses: diagnostics.reduce(
      (sum, value) => sum + value.unchangedPageReuses,
      0,
    ),
  };
}

function subtractHizoFSRuntimeInodeLeafLookupDiagnostics({
  after,
  before,
}: {
  after: HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['inodeLeafLookup'];
  before: HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['inodeLeafLookup'];
}): HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['inodeLeafLookup'] {
  return {
    branchPageDecodes: Math.max(after.branchPageDecodes - before.branchPageDecodes, 0),
    branchPageBytesDecoded: Math.max(
      after.branchPageBytesDecoded - before.branchPageBytesDecoded,
      0,
    ),
    decodedEntryBytes: Math.max(after.decodedEntryBytes - before.decodedEntryBytes, 0),
    indexBuilds: Math.max(after.indexBuilds - before.indexBuilds, 0),
    indexBytesCreated: Math.max(after.indexBytesCreated - before.indexBytesCreated, 0),
    indexedEntries: Math.max(after.indexedEntries - before.indexedEntries, 0),
    indexedPageBytes: Math.max(after.indexedPageBytes - before.indexedPageBytes, 0),
    selectiveEntryHits: Math.max(after.selectiveEntryHits - before.selectiveEntryHits, 0),
    selectiveEntryMisses: Math.max(after.selectiveEntryMisses - before.selectiveEntryMisses, 0),
    skippedPageBytes: Math.max(after.skippedPageBytes - before.skippedPageBytes, 0),
  };
}

function aggregateHizoFSRuntimeInodeLeafLookupDiagnostics({
  diagnostics,
}: {
  diagnostics: readonly HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['inodeLeafLookup'][];
}): HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['inodeLeafLookup'] {
  return {
    branchPageDecodes: diagnostics.reduce((sum, value) => sum + value.branchPageDecodes, 0),
    branchPageBytesDecoded: diagnostics.reduce(
      (sum, value) => sum + value.branchPageBytesDecoded,
      0,
    ),
    decodedEntryBytes: diagnostics.reduce((sum, value) => sum + value.decodedEntryBytes, 0),
    indexBuilds: diagnostics.reduce((sum, value) => sum + value.indexBuilds, 0),
    indexBytesCreated: diagnostics.reduce((sum, value) => sum + value.indexBytesCreated, 0),
    indexedEntries: diagnostics.reduce((sum, value) => sum + value.indexedEntries, 0),
    indexedPageBytes: diagnostics.reduce((sum, value) => sum + value.indexedPageBytes, 0),
    selectiveEntryHits: diagnostics.reduce((sum, value) => sum + value.selectiveEntryHits, 0),
    selectiveEntryMisses: diagnostics.reduce((sum, value) => sum + value.selectiveEntryMisses, 0),
    skippedPageBytes: diagnostics.reduce((sum, value) => sum + value.skippedPageBytes, 0),
  };
}

function aggregateHizoFSRuntimeScopedAccessDiagnostics({
  diagnostics,
}: {
  diagnostics: readonly HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['publication']['getFileSize'][];
}): HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['publication']['getFileSize'] {
  return {
    duplicateOperations: diagnostics.reduce((sum, value) => sum + value.duplicateOperations, 0),
    maximumOperationsPerScope: Math.max(...diagnostics.map(value => value.maximumOperationsPerScope)),
    operations: diagnostics.reduce((sum, value) => sum + value.operations, 0),
    observedUniqueTargets: diagnostics.reduce((sum, value) => sum + value.observedUniqueTargets, 0),
    truncatedScopes: diagnostics.reduce((sum, value) => sum + value.truncatedScopes, 0),
    unclassifiedOperations: diagnostics.reduce((sum, value) => sum + value.unclassifiedOperations, 0),
  };
}

function aggregateHizoFSRuntimeSegmentWriterDiagnostics({
  diagnostics,
}: {
  diagnostics: readonly HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['segmentWriters']['metadata'][];
}): HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['segmentWriters']['metadata'] {
  return {
    appendOperations: diagnostics.reduce((sum, value) => sum + value.appendOperations, 0),
    appendReadBackVerifications: diagnostics.reduce((sum, value) => sum + value.appendReadBackVerifications, 0),
    appendedFrameBytes: diagnostics.reduce((sum, value) => sum + value.appendedFrameBytes, 0),
    appendedRecords: diagnostics.reduce((sum, value) => sum + value.appendedRecords, 0),
    multiRecordAppendOperations: diagnostics.reduce(
      (sum, value) => sum + value.multiRecordAppendOperations,
      0,
    ),
    created: diagnostics.reduce((sum, value) => sum + value.created, 0),
    descriptorValidations: diagnostics.reduce((sum, value) => sum + value.descriptorValidations, 0),
    rollovers: diagnostics.reduce((sum, value) => sum + value.rollovers, 0),
    trustedTailMatches: diagnostics.reduce((sum, value) => sum + value.trustedTailMatches, 0),
    trustedTailMismatches: diagnostics.reduce((sum, value) => sum + value.trustedTailMismatches, 0),
  };
}

function aggregateHizoFSRuntimeCacheDiagnostics({
  diagnostics,
  current,
}: {
  diagnostics: readonly HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['caches']['metadata'][];
  current: HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['caches']['metadata'];
}): HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['caches']['metadata'] {
  return {
    hits: diagnostics.reduce((sum, value) => sum + value.hits, 0),
    misses: diagnostics.reduce((sum, value) => sum + value.misses, 0),
    evictions: diagnostics.reduce((sum, value) => sum + value.evictions, 0),
    currentBytes: current.currentBytes,
    maximumBytes: Math.max(...diagnostics.map(value => value.maximumBytes)),
    currentEntries: current.currentEntries,
    maximumEntries: Math.max(...diagnostics.map(value => value.maximumEntries)),
  };
}

function aggregateHizoFSRuntimeResourceDiagnostics({
  diagnostics,
  current,
}: {
  diagnostics: readonly HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['resources']['writerDirtyChunks'][];
  current: HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['resources']['writerDirtyChunks'];
}): HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot['resources']['writerDirtyChunks'] {
  return {
    currentBytes: current.currentBytes,
    maximumBytes: Math.max(...diagnostics.map(value => value.maximumBytes)),
    currentOperations: current.currentOperations,
    maximumOperations: Math.max(...diagnostics.map(value => value.maximumOperations)),
  };
}

async function getBackendRoot({
  context,
}: {
  context: BenchmarkContext;
}): Promise<FileSystemDirectoryHandle | StorageDirectoryHandle> {
  switch (context.kind) {
  case 'raw_opfs':
    if (context.rawRoot === undefined) throw new Error('Raw OPFS benchmark root is unavailable');
    return context.rawRoot;
  case 'hizofs':
    if (context.hizoFSSession === undefined) throw new Error('HizoFS benchmark session is unavailable');
    return context.hizoFSSession.root;
  default: {
    const _ex: never = context.kind;
    throw new Error(`Unhandled benchmark context: ${String(_ex)}`);
  }
  }
}

async function createBackendDirectory({
  context,
  name,
}: {
  context: BenchmarkContext;
  name: string;
}): Promise<FileSystemDirectoryHandle | StorageDirectoryHandle> {
  return getBackendDirectory({
    context,
    directory: await getBackendRoot({ context }),
    name,
    create: true,
  });
}

async function getBackendDirectory({
  context,
  directory,
  name,
  create = false,
}: {
  context: BenchmarkContext;
  directory: FileSystemDirectoryHandle | StorageDirectoryHandle;
  name: string;
  create?: boolean;
}): Promise<FileSystemDirectoryHandle | StorageDirectoryHandle> {
  context.apiCounters.directoryHandleLookups += 1;
  if (create) context.apiCounters.directoryCreates += 1;
  switch (context.kind) {
  case 'raw_opfs':
    return (directory as FileSystemDirectoryHandle).getDirectoryHandle(name, { create });
  case 'hizofs':
    return (directory as StorageDirectoryHandle).getDirectoryHandle({ name, create });
  default: {
    const _ex: never = context.kind;
    throw new Error(`Unhandled benchmark context: ${String(_ex)}`);
  }
  }
}

async function getBackendFile({
  context,
  directory,
  name,
  create,
}: {
  context: BenchmarkContext;
  directory: FileSystemDirectoryHandle | StorageDirectoryHandle;
  name: string;
  create: boolean;
}): Promise<FileSystemFileHandle | StorageFileHandle> {
  context.apiCounters.fileHandleLookups += 1;
  if (create) context.apiCounters.fileCreates += 1;
  switch (context.kind) {
  case 'raw_opfs':
    return (directory as FileSystemDirectoryHandle).getFileHandle(name, { create });
  case 'hizofs':
    return (directory as StorageDirectoryHandle).getFileHandle({ name, create });
  default: {
    const _ex: never = context.kind;
    throw new Error(`Unhandled benchmark context: ${String(_ex)}`);
  }
  }
}

async function createEmptyBackendFile({
  context,
  directory,
  name,
}: {
  context: BenchmarkContext;
  directory: FileSystemDirectoryHandle | StorageDirectoryHandle;
  name: string;
}): Promise<void> {
  await getBackendFile({ context, directory, name, create: true });
}

async function writeBackendFile({
  context,
  directory,
  name,
  create,
  bytes,
  keepExistingData,
  position,
}: {
  context: BenchmarkContext;
  directory: FileSystemDirectoryHandle | StorageDirectoryHandle;
  name: string;
  create: boolean;
  bytes: Uint8Array;
  keepExistingData: boolean;
  position: number;
}): Promise<void> {
  const file = await getBackendFile({ context, directory, name, create });
  context.apiCounters.writableOpens += 1;
  retainTrackedBytes({ tracker: context.memoryTracker, byteLength: bytes.byteLength });
  try {
    switch (context.kind) {
    case 'raw_opfs': {
      const writable = await (file as FileSystemFileHandle).createWritable({ keepExistingData });
      try {
        await writable.seek(position);
        context.apiCounters.writeCalls += 1;
        await writeRawOpfsBytes({
          writable,
          bytes,
          memoryTracker: context.memoryTracker,
        });
        await writable.close();
      } catch (error) {
        await writable.abort(error);
        throw error;
      }
      break;
    }
    case 'hizofs': {
      const writable = await (file as StorageFileHandle).createWritable({ keepExistingData });
      await runHizoFSWritableTransaction({
        operation: async () => {
          context.apiCounters.writeCalls += 1;
          await writable.write({ position, data: bytes });
        },
        writable,
      });
      break;
    }
    default: {
      const _ex: never = context.kind;
      throw new Error(`Unhandled benchmark context: ${String(_ex)}`);
    }
    }
  } finally {
    releaseTrackedBytes({ tracker: context.memoryTracker, byteLength: bytes.byteLength });
  }
}

async function writeBackendFileByBlocks({
  context,
  directory,
  name,
  sizeBytes,
  block,
  keepExistingData,
  startPosition,
  assertActive,
}: {
  context: BenchmarkContext;
  directory: FileSystemDirectoryHandle | StorageDirectoryHandle;
  name: string;
  sizeBytes: number;
  block: Uint8Array;
  keepExistingData: boolean;
  startPosition: number;
  assertActive: () => void;
}): Promise<void> {
  const file = await getBackendFile({ context, directory, name, create: true });
  context.apiCounters.writableOpens += 1;
  retainTrackedBytes({ tracker: context.memoryTracker, byteLength: block.byteLength });
  try {
    switch (context.kind) {
    case 'raw_opfs': {
      const writable = await (file as FileSystemFileHandle).createWritable({ keepExistingData });
      try {
        let written = 0;
        while (written < sizeBytes) {
          assertActive();
          const length = Math.min(block.byteLength, sizeBytes - written);
          await writable.seek(startPosition + written);
          context.apiCounters.writeCalls += 1;
          await writeRawOpfsBytes({
            writable,
            bytes: length === block.byteLength ? block : block.subarray(0, length),
            memoryTracker: context.memoryTracker,
          });
          written += length;
        }
        await writable.close();
      } catch (error) {
        await writable.abort(error);
        throw error;
      }
      break;
    }
    case 'hizofs': {
      const writable = await (file as StorageFileHandle).createWritable({ keepExistingData });
      await runHizoFSWritableTransaction({
        operation: async () => {
          let written = 0;
          while (written < sizeBytes) {
            assertActive();
            const length = Math.min(block.byteLength, sizeBytes - written);
            await writable.write({
              position: startPosition + written,
              data: length === block.byteLength ? block : block.subarray(0, length),
            });
            context.apiCounters.writeCalls += 1;
            written += length;
          }
        },
        writable,
      });
      break;
    }
    default: {
      const _ex: never = context.kind;
      throw new Error(`Unhandled benchmark context: ${String(_ex)}`);
    }
    }
  } finally {
    releaseTrackedBytes({ tracker: context.memoryTracker, byteLength: block.byteLength });
  }
}

async function readBackendFile({
  context,
  directory,
  name,
  blockSizeBytes,
  assertActive,
}: {
  context: BenchmarkContext;
  directory: FileSystemDirectoryHandle | StorageDirectoryHandle;
  name: string;
  blockSizeBytes: number;
  assertActive: () => void;
}): Promise<number> {
  const file = await getBackendFile({ context, directory, name, create: false });
  context.apiCounters.readableOpens += 1;
  switch (context.kind) {
  case 'raw_opfs': {
    const blob = await (file as FileSystemFileHandle).getFile();
    let checksum = 0;
    for (let position = 0; position < blob.size; position += blockSizeBytes) {
      assertActive();
      const bytes = new Uint8Array(await blob.slice(position, position + blockSizeBytes).arrayBuffer());
      context.apiCounters.readCalls += 1;
      retainTrackedBytes({ tracker: context.memoryTracker, byteLength: bytes.byteLength });
      try {
        checksum = addChecksum({ checksum, value: checksumBytes({ bytes }) });
      } finally {
        releaseTrackedBytes({ tracker: context.memoryTracker, byteLength: bytes.byteLength });
      }
    }
    return checksum;
  }
  case 'hizofs': {
    const readable = await (file as StorageFileHandle).openReadable({ mimeType: 'application/octet-stream' });
    const buffer = new Uint8Array(Math.max(blockSizeBytes, 1));
    retainTrackedBytes({ tracker: context.memoryTracker, byteLength: buffer.byteLength });
    let position = 0;
    let checksum = 0;
    try {
      while (position < readable.size) {
        assertActive();
        const { bytesRead } = await readable.read({
          buffer,
          offset: 0,
          length: Math.min(buffer.byteLength, readable.size - position),
          position,
          signal: undefined,
        });
        context.apiCounters.readCalls += 1;
        if (bytesRead === 0) break;
        checksum = addChecksum({
          checksum,
          value: checksumBytes({ bytes: buffer.subarray(0, bytesRead) }),
        });
        position += bytesRead;
      }
    } finally {
      try {
        await readable.close();
      } finally {
        releaseTrackedBytes({ tracker: context.memoryTracker, byteLength: buffer.byteLength });
      }
    }
    return checksum;
  }
  default: {
    const _ex: never = context.kind;
    throw new Error(`Unhandled benchmark context: ${String(_ex)}`);
  }
  }
}

async function randomReadBackendFile({
  context,
  directory,
  name,
  positions,
  blockSizeBytes,
  assertActive,
}: {
  context: BenchmarkContext;
  directory: FileSystemDirectoryHandle | StorageDirectoryHandle;
  name: string;
  positions: readonly number[];
  blockSizeBytes: number;
  assertActive: () => void;
}): Promise<number> {
  const file = await getBackendFile({ context, directory, name, create: false });
  context.apiCounters.readableOpens += 1;
  switch (context.kind) {
  case 'raw_opfs': {
    const blob = await (file as FileSystemFileHandle).getFile();
    let checksum = 0;
    for (const position of positions) {
      assertActive();
      const bytes = new Uint8Array(await blob.slice(position, position + blockSizeBytes).arrayBuffer());
      context.apiCounters.readCalls += 1;
      retainTrackedBytes({ tracker: context.memoryTracker, byteLength: bytes.byteLength });
      try {
        checksum = addChecksum({ checksum, value: checksumBytes({ bytes }) });
      } finally {
        releaseTrackedBytes({ tracker: context.memoryTracker, byteLength: bytes.byteLength });
      }
    }
    return checksum;
  }
  case 'hizofs': {
    const readable = await (file as StorageFileHandle).openReadable({ mimeType: 'application/octet-stream' });
    const buffer = new Uint8Array(blockSizeBytes);
    retainTrackedBytes({ tracker: context.memoryTracker, byteLength: buffer.byteLength });
    let checksum = 0;
    try {
      for (const position of positions) {
        assertActive();
        const { bytesRead } = await readable.read({
          buffer,
          offset: 0,
          length: blockSizeBytes,
          position,
          signal: undefined,
        });
        context.apiCounters.readCalls += 1;
        checksum = addChecksum({
          checksum,
          value: checksumBytes({ bytes: buffer.subarray(0, bytesRead) }),
        });
      }
    } finally {
      try {
        await readable.close();
      } finally {
        releaseTrackedBytes({ tracker: context.memoryTracker, byteLength: buffer.byteLength });
      }
    }
    return checksum;
  }
  default: {
    const _ex: never = context.kind;
    throw new Error(`Unhandled benchmark context: ${String(_ex)}`);
  }
  }
}

async function randomWriteBackendFile({
  context,
  directory,
  name,
  positions,
  block,
  assertActive,
}: {
  context: BenchmarkContext;
  directory: FileSystemDirectoryHandle | StorageDirectoryHandle;
  name: string;
  positions: readonly number[];
  block: Uint8Array;
  assertActive: () => void;
}): Promise<void> {
  const file = await getBackendFile({ context, directory, name, create: false });
  context.apiCounters.writableOpens += 1;
  retainTrackedBytes({ tracker: context.memoryTracker, byteLength: block.byteLength });
  try {
    switch (context.kind) {
    case 'raw_opfs': {
      const writable = await (file as FileSystemFileHandle).createWritable({ keepExistingData: true });
      try {
        for (const position of positions) {
          assertActive();
          await writable.seek(position);
          context.apiCounters.writeCalls += 1;
          await writeRawOpfsBytes({
            writable,
            bytes: block,
            memoryTracker: context.memoryTracker,
          });
        }
        await writable.close();
      } catch (error) {
        await writable.abort(error);
        throw error;
      }
      break;
    }
    case 'hizofs': {
      const writable = await (file as StorageFileHandle).createWritable({ keepExistingData: true });
      await runHizoFSWritableTransaction({
        operation: async () => {
          for (const position of positions) {
            assertActive();
            context.apiCounters.writeCalls += 1;
            await writable.write({ position, data: block });
          }
        },
        writable,
      });
      break;
    }
    default: {
      const _ex: never = context.kind;
      throw new Error(`Unhandled benchmark context: ${String(_ex)}`);
    }
    }
  } finally {
    releaseTrackedBytes({ tracker: context.memoryTracker, byteLength: block.byteLength });
  }
}

async function truncateBackendFile({
  context,
  directory,
  name,
  size,
}: {
  context: BenchmarkContext;
  directory: FileSystemDirectoryHandle | StorageDirectoryHandle;
  name: string;
  size: number;
}): Promise<void> {
  const file = await getBackendFile({ context, directory, name, create: false });
  context.apiCounters.writableOpens += 1;
  context.apiCounters.truncateCalls += 1;
  switch (context.kind) {
  case 'raw_opfs': {
    const writable = await (file as FileSystemFileHandle).createWritable({ keepExistingData: true });
    try {
      await writable.truncate(size);
      await writable.close();
    } catch (error) {
      await writable.abort(error);
      throw error;
    }
    break;
  }
  case 'hizofs': {
    const writable = await (file as StorageFileHandle).createWritable({ keepExistingData: true });
    await runHizoFSWritableTransaction({
      operation: async () => await writable.truncate({ size }),
      writable,
    });
    break;
  }
  default: {
    const _ex: never = context.kind;
    throw new Error(`Unhandled benchmark context: ${String(_ex)}`);
  }
  }
}

async function writeRawOpfsBytes({
  writable,
  bytes,
  memoryTracker,
}: {
  writable: FileSystemWritableFileStream;
  bytes: Uint8Array;
  memoryTracker: BenchmarkMemoryTracker;
}): Promise<void> {
  const exactBuffer = toExactArrayBuffer({ bytes });
  retainTrackedBytes({ tracker: memoryTracker, byteLength: exactBuffer.byteLength });
  try {
    await writable.write(exactBuffer);
  } finally {
    releaseTrackedBytes({ tracker: memoryTracker, byteLength: exactBuffer.byteLength });
  }
}

function listBackendEntries({
  context,
  directory,
}: {
  context: BenchmarkContext;
  directory: FileSystemDirectoryHandle | StorageDirectoryHandle;
}): AsyncIterable<unknown> {
  context.apiCounters.directoryLists += 1;
  switch (context.kind) {
  case 'raw_opfs':
    return (directory as FileSystemDirectoryHandle).entries();
  case 'hizofs':
    return (directory as StorageDirectoryHandle).entries();
  default: {
    const _ex: never = context.kind;
    throw new Error(`Unhandled benchmark context: ${String(_ex)}`);
  }
  }
}

async function removeBackendEntry({
  context,
  directory,
  name,
  recursive,
}: {
  context: BenchmarkContext;
  directory: FileSystemDirectoryHandle | StorageDirectoryHandle;
  name: string;
  recursive: boolean;
}): Promise<void> {
  context.apiCounters.removeCalls += 1;
  switch (context.kind) {
  case 'raw_opfs':
    await (directory as FileSystemDirectoryHandle).removeEntry(name, { recursive });
    break;
  case 'hizofs':
    await (directory as StorageDirectoryHandle).removeEntry({ name, recursive });
    break;
  default: {
    const _ex: never = context.kind;
    throw new Error(`Unhandled benchmark context: ${String(_ex)}`);
  }
  }
}

async function cleanBenchmarkRun({
  benchmarkRoot,
  runDirectoryName,
  retention,
}: {
  benchmarkRoot: FileSystemDirectoryHandle;
  runDirectoryName: string;
  retention: HizoFSBenchmarkConfiguration['benchmarkDataRetention'];
}): Promise<HizoFSBenchmarkReport['cleanup']> {
  switch (retention) {
  case 'keep_after_run':
    return {
      attempted: false,
      completed: false,
      retainedByConfiguration: true,
      remainingPaths: [`${BENCHMARK_ROOT_DIRECTORY_NAME}/${runDirectoryName}`],
    };
  case 'delete_after_run':
    try {
      await benchmarkRoot.removeEntry(runDirectoryName, { recursive: true });
      return {
        attempted: true,
        completed: true,
        retainedByConfiguration: false,
        remainingPaths: [],
      };
    } catch {
      return {
        attempted: true,
        completed: false,
        retainedByConfiguration: false,
        remainingPaths: [`${BENCHMARK_ROOT_DIRECTORY_NAME}/${runDirectoryName}`],
      };
    }
  default: {
    const _ex: never = retention;
    throw new Error(`Unhandled benchmark data retention: ${String(_ex)}`);
  }
  }
}

function calculateTotalProgressUnits({
  configuration,
}: {
  configuration: HizoFSBenchmarkConfiguration;
}): number {
  const iterations = configuration.warmupIterations + configuration.measuredIterations;
  const requestedBackends = getRequestedBackendKinds({ backendMode: configuration.backendMode });
  let perIteration = 0;
  for (const workload of configuration.workloads) {
    switch (workload) {
    case 'hizofs_maintenance':
      if (requestedBackends.includes('hizofs')) perIteration += 1;
      break;
    case 'small_files':
    case 'sequential_io':
    case 'random_access':
    case 'directory_operations':
    case 'bulk_operations':
      perIteration += requestedBackends.length;
      break;
    default: {
      const _ex: never = workload;
      throw new Error(`Unhandled benchmark workload: ${String(_ex)}`);
    }
    }
  }
  return Math.max(iterations * perIteration, 1);
}

function getProgressStage({
  phase,
}: {
  phase: 'preparing' | 'warmup' | 'measured' | 'cleaning';
}): HizoFSBenchmarkProgress['stage'] {
  switch (phase) {
  case 'preparing': return 'preparing';
  case 'warmup': return 'warmup';
  case 'measured': return 'measuring';
  case 'cleaning': return 'cleaning';
  default: {
    const _ex: never = phase;
    throw new Error(`Unhandled benchmark phase: ${String(_ex)}`);
  }
  }
}

function getReportedIteration({
  phase,
  iteration,
  warmupIterations,
}: {
  phase: BenchmarkPhase;
  iteration: number;
  warmupIterations: number;
}): number {
  switch (phase) {
  case 'warmup': return iteration;
  case 'measured': return iteration - warmupIterations;
  default: {
    const _ex: never = phase;
    throw new Error(`Unhandled benchmark phase: ${String(_ex)}`);
  }
  }
}

function getRequestedBackendKinds({
  backendMode,
}: {
  backendMode: HizoFSBenchmarkConfiguration['backendMode'];
}): readonly BackendKind[] {
  switch (backendMode) {
  case 'compare': return ['raw_opfs', 'hizofs'];
  case 'hizofs_only': return ['hizofs'];
  case 'raw_opfs_only': return ['raw_opfs'];
  default: {
    const _ex: never = backendMode;
    throw new Error(`Unhandled benchmark backend mode: ${String(_ex)}`);
  }
  }
}

function createRunId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function createPatternBytes({ size, seed }: { size: number; seed: number }): Uint8Array {
  const result = new Uint8Array(size);
  let state = seed >>> 0;
  for (let index = 0; index < result.byteLength; index += 1) {
    state = xorshift32({ state });
    result[index] = state & 0xff;
  }
  return result;
}

function createRandomPositions({
  seed,
  count,
  fileSizeBytes,
  blockSizeBytes,
}: {
  seed: number;
  count: number;
  fileSizeBytes: number;
  blockSizeBytes: number;
}): readonly number[] {
  const maximumPosition = Math.max(fileSizeBytes - blockSizeBytes, 0);
  const blockCount = Math.max(Math.floor(maximumPosition / blockSizeBytes) + 1, 1);
  const result: number[] = [];
  let state = seed >>> 0;
  for (let index = 0; index < count; index += 1) {
    state = xorshift32({ state });
    result.push((state % blockCount) * blockSizeBytes);
  }
  return result;
}

function getWorkloadSeedDiscriminator({
  workload,
}: {
  workload: HizoFSBenchmarkWorkload;
}): number {
  switch (workload) {
  case 'small_files': return 1;
  case 'sequential_io': return 2;
  case 'random_access': return 3;
  case 'directory_operations': return 4;
  case 'bulk_operations': return 5;
  case 'hizofs_maintenance': return 6;
  default: {
    const _ex: never = workload;
    throw new Error(`Unhandled benchmark workload: ${String(_ex)}`);
  }
  }
}

function xorshift32({ state }: { state: number }): number {
  let next = state || 0x9e37_79b9;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function mixSeed({ seed, value }: { seed: number; value: number }): number {
  return xorshift32({ state: (seed ^ value ^ 0x85eb_ca6b) >>> 0 });
}

function checksumBytes({ bytes }: { bytes: Uint8Array }): number {
  let checksum = 0;
  for (const byte of bytes) checksum = (checksum + byte) >>> 0;
  return checksum;
}

function addChecksum({ checksum, value }: { checksum: number; value: number }): number {
  return (checksum + value) >>> 0;
}

function smallFileName({ index }: { index: number }): string {
  return `file-${String(index).padStart(8, '0')}.bin`;
}

function directoryEntryName({ index }: { index: number }): string {
  return `entry-${String(index).padStart(8, '0')}`;
}

function percentile({
  sortedValues,
  percentile: target,
}: {
  sortedValues: readonly number[];
  percentile: number;
}): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(Math.ceil(target * sortedValues.length) - 1, sortedValues.length - 1);
  return sortedValues[Math.max(index, 0)] ?? 0;
}

function summarizeForegroundLatencies({
  durationsMs,
}: {
  durationsMs: readonly number[];
}): NonNullable<HizoFSBenchmarkSample['foregroundLatency']> {
  const sortedDurationsMs = [...durationsMs].sort((left, right) => left - right);
  return {
    operationCount: sortedDurationsMs.length,
    durationMs: {
      median: median({ values: sortedDurationsMs }),
      p95: percentile({ sortedValues: sortedDurationsMs, percentile: 0.95 }),
      minimum: sortedDurationsMs[0] ?? 0,
      maximum: sortedDurationsMs.at(-1) ?? 0,
    },
  };
}

async function yieldToBenchmarkEventLoop(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

function median({ values }: { values: readonly number[] }): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function ratioOptional({
  numerator,
  denominator,
}: {
  numerator: number | undefined;
  denominator: number | undefined;
}): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator === 0) return undefined;
  return numerator / denominator;
}

function createEmptyBackingDirectoryPathCounters(): BackingStoreCounters['pathAttribution']['directoryHandleLookups'] {
  return {
    root: 0,
    segmentRoot: 0,
    segmentClass: 0,
    segmentShard: 0,
    other: 0,
  };
}

function createEmptyBackingFilePathCounters(): BackingStoreCounters['pathAttribution']['fileHandleLookups'] {
  return {
    superblock: 0,
    unlockEnvelope: 0,
    metadataSegment: 0,
    dataSegment: 0,
    relocationSegment: 0,
    other: 0,
  };
}

function snapshotBackingDirectoryPathCounters({
  counters,
}: {
  counters: BackingStoreCounters['pathAttribution']['directoryHandleLookups'];
}): BackingStoreCounters['pathAttribution']['directoryHandleLookups'] {
  return {
    root: counters.root,
    segmentRoot: counters.segmentRoot,
    segmentClass: counters.segmentClass,
    segmentShard: counters.segmentShard,
    other: counters.other,
  };
}

function snapshotBackingFilePathCounters({
  counters,
}: {
  counters: BackingStoreCounters['pathAttribution']['fileHandleLookups'];
}): BackingStoreCounters['pathAttribution']['fileHandleLookups'] {
  return {
    superblock: counters.superblock,
    unlockEnvelope: counters.unlockEnvelope,
    metadataSegment: counters.metadataSegment,
    dataSegment: counters.dataSegment,
    relocationSegment: counters.relocationSegment,
    other: counters.other,
  };
}

function snapshotBackingStoreCounters({
  counters,
}: {
  counters: BackingStoreCounters;
}): BackingStoreCounters {
  return {
    directoryHandleLookups: counters.directoryHandleLookups,
    directoryHandleCreateRequests: counters.directoryHandleCreateRequests,
    fileHandleLookups: counters.fileHandleLookups,
    fileHandleCreateRequests: counters.fileHandleCreateRequests,
    fileSnapshotOperations: counters.fileSnapshotOperations,
    readOperations: counters.readOperations,
    writeOperations: counters.writeOperations,
    removeOperations: counters.removeOperations,
    listOperations: counters.listOperations,
    listEntriesMaterialized: counters.listEntriesMaterialized,
    bytesRead: counters.bytesRead,
    bytesWritten: counters.bytesWritten,
    pathAttribution: {
      directoryHandleLookups: snapshotBackingDirectoryPathCounters({
        counters: counters.pathAttribution.directoryHandleLookups,
      }),
      directoryHandleCreateRequests: snapshotBackingDirectoryPathCounters({
        counters: counters.pathAttribution.directoryHandleCreateRequests,
      }),
      fileHandleLookups: snapshotBackingFilePathCounters({
        counters: counters.pathAttribution.fileHandleLookups,
      }),
      fileHandleCreateRequests: snapshotBackingFilePathCounters({
        counters: counters.pathAttribution.fileHandleCreateRequests,
      }),
      fileSnapshotOperations: snapshotBackingFilePathCounters({
        counters: counters.pathAttribution.fileSnapshotOperations,
      }),
      listOperations: snapshotBackingDirectoryPathCounters({
        counters: counters.pathAttribution.listOperations,
      }),
      listEntriesMaterialized: snapshotBackingDirectoryPathCounters({
        counters: counters.pathAttribution.listEntriesMaterialized,
      }),
    },
  };
}

function createEmptyBackingStoreCounters(): BackingStoreCounters {
  return {
    directoryHandleLookups: 0,
    directoryHandleCreateRequests: 0,
    fileHandleLookups: 0,
    fileHandleCreateRequests: 0,
    fileSnapshotOperations: 0,
    readOperations: 0,
    writeOperations: 0,
    removeOperations: 0,
    listOperations: 0,
    listEntriesMaterialized: 0,
    bytesRead: 0,
    bytesWritten: 0,
    pathAttribution: {
      directoryHandleLookups: createEmptyBackingDirectoryPathCounters(),
      directoryHandleCreateRequests: createEmptyBackingDirectoryPathCounters(),
      fileHandleLookups: createEmptyBackingFilePathCounters(),
      fileHandleCreateRequests: createEmptyBackingFilePathCounters(),
      fileSnapshotOperations: createEmptyBackingFilePathCounters(),
      listOperations: createEmptyBackingDirectoryPathCounters(),
      listEntriesMaterialized: createEmptyBackingDirectoryPathCounters(),
    },
  };
}

function createEmptyBenchmarkApiCounters(): BenchmarkApiCounters {
  return {
    directoryHandleLookups: 0,
    directoryCreates: 0,
    fileHandleLookups: 0,
    fileCreates: 0,
    writableOpens: 0,
    writeCalls: 0,
    truncateCalls: 0,
    readableOpens: 0,
    readCalls: 0,
    directoryLists: 0,
    removeCalls: 0,
    cloneCalls: 0,
    bulkBuilderCreates: 0,
    bulkEntryCreates: 0,
    bulkCommits: 0,
  };
}

function subtractBenchmarkApiCounters({
  before,
  after,
}: {
  before: BenchmarkApiCounters;
  after: BenchmarkApiCounters;
}): BenchmarkApiCounters {
  return {
    directoryHandleLookups: Math.max(after.directoryHandleLookups - before.directoryHandleLookups, 0),
    directoryCreates: Math.max(after.directoryCreates - before.directoryCreates, 0),
    fileHandleLookups: Math.max(after.fileHandleLookups - before.fileHandleLookups, 0),
    fileCreates: Math.max(after.fileCreates - before.fileCreates, 0),
    writableOpens: Math.max(after.writableOpens - before.writableOpens, 0),
    writeCalls: Math.max(after.writeCalls - before.writeCalls, 0),
    truncateCalls: Math.max(after.truncateCalls - before.truncateCalls, 0),
    readableOpens: Math.max(after.readableOpens - before.readableOpens, 0),
    readCalls: Math.max(after.readCalls - before.readCalls, 0),
    directoryLists: Math.max(after.directoryLists - before.directoryLists, 0),
    removeCalls: Math.max(after.removeCalls - before.removeCalls, 0),
    cloneCalls: Math.max(after.cloneCalls - before.cloneCalls, 0),
    bulkBuilderCreates: Math.max(
      after.bulkBuilderCreates - before.bulkBuilderCreates,
      0,
    ),
    bulkEntryCreates: Math.max(
      after.bulkEntryCreates - before.bulkEntryCreates,
      0,
    ),
    bulkCommits: Math.max(after.bulkCommits - before.bulkCommits, 0),
  };
}

function createBenchmarkMemoryTracker(): BenchmarkMemoryTracker {
  return {
    activeBytes: 0,
    sampleHighWaterBytes: 0,
    sampleLargestAllocationBytes: 0,
  };
}

function beginMemoryMeasurement({
  tracker,
}: {
  tracker: BenchmarkMemoryTracker;
}): void {
  tracker.sampleHighWaterBytes = tracker.activeBytes;
  tracker.sampleLargestAllocationBytes = 0;
}

function retainTrackedBytes({
  tracker,
  byteLength,
}: {
  tracker: BenchmarkMemoryTracker;
  byteLength: number;
}): void {
  tracker.activeBytes += byteLength;
  tracker.sampleHighWaterBytes = Math.max(tracker.sampleHighWaterBytes, tracker.activeBytes);
  tracker.sampleLargestAllocationBytes = Math.max(tracker.sampleLargestAllocationBytes, byteLength);
}

function releaseTrackedBytes({
  tracker,
  byteLength,
}: {
  tracker: BenchmarkMemoryTracker;
  byteLength: number;
}): void {
  tracker.activeBytes = Math.max(tracker.activeBytes - byteLength, 0);
}

function readMemoryDiagnostics({
  tracker,
}: {
  tracker: BenchmarkMemoryTracker;
}): HizoFSBenchmarkSample['memory'] {
  return {
    maximumTrackedBytes: tracker.sampleHighWaterBytes,
    largestTrackedAllocationBytes: tracker.sampleLargestAllocationBytes,
    scope: 'benchmark_harness_buffers_only',
  };
}

function subtractBackingDirectoryPathCounters({
  before,
  after,
}: {
  before: BackingStoreCounters['pathAttribution']['directoryHandleLookups'];
  after: BackingStoreCounters['pathAttribution']['directoryHandleLookups'];
}): BackingStoreCounters['pathAttribution']['directoryHandleLookups'] {
  return {
    root: Math.max(after.root - before.root, 0),
    segmentRoot: Math.max(after.segmentRoot - before.segmentRoot, 0),
    segmentClass: Math.max(after.segmentClass - before.segmentClass, 0),
    segmentShard: Math.max(after.segmentShard - before.segmentShard, 0),
    other: Math.max(after.other - before.other, 0),
  };
}

function subtractBackingFilePathCounters({
  before,
  after,
}: {
  before: BackingStoreCounters['pathAttribution']['fileHandleLookups'];
  after: BackingStoreCounters['pathAttribution']['fileHandleLookups'];
}): BackingStoreCounters['pathAttribution']['fileHandleLookups'] {
  return {
    superblock: Math.max(after.superblock - before.superblock, 0),
    unlockEnvelope: Math.max(after.unlockEnvelope - before.unlockEnvelope, 0),
    metadataSegment: Math.max(after.metadataSegment - before.metadataSegment, 0),
    dataSegment: Math.max(after.dataSegment - before.dataSegment, 0),
    relocationSegment: Math.max(after.relocationSegment - before.relocationSegment, 0),
    other: Math.max(after.other - before.other, 0),
  };
}

function subtractBackingStoreCounters({
  before,
  after,
}: {
  before: BackingStoreCounters;
  after: BackingStoreCounters;
}): BackingStoreCounters {
  return {
    directoryHandleLookups: Math.max(after.directoryHandleLookups - before.directoryHandleLookups, 0),
    directoryHandleCreateRequests: Math.max(
      after.directoryHandleCreateRequests - before.directoryHandleCreateRequests,
      0,
    ),
    fileHandleLookups: Math.max(after.fileHandleLookups - before.fileHandleLookups, 0),
    fileHandleCreateRequests: Math.max(
      after.fileHandleCreateRequests - before.fileHandleCreateRequests,
      0,
    ),
    fileSnapshotOperations: Math.max(
      after.fileSnapshotOperations - before.fileSnapshotOperations,
      0,
    ),
    readOperations: Math.max(after.readOperations - before.readOperations, 0),
    writeOperations: Math.max(after.writeOperations - before.writeOperations, 0),
    removeOperations: Math.max(after.removeOperations - before.removeOperations, 0),
    listOperations: Math.max(after.listOperations - before.listOperations, 0),
    listEntriesMaterialized: Math.max(
      after.listEntriesMaterialized - before.listEntriesMaterialized,
      0,
    ),
    bytesRead: Math.max(after.bytesRead - before.bytesRead, 0),
    bytesWritten: Math.max(after.bytesWritten - before.bytesWritten, 0),
    pathAttribution: {
      directoryHandleLookups: subtractBackingDirectoryPathCounters({
        before: before.pathAttribution.directoryHandleLookups,
        after: after.pathAttribution.directoryHandleLookups,
      }),
      directoryHandleCreateRequests: subtractBackingDirectoryPathCounters({
        before: before.pathAttribution.directoryHandleCreateRequests,
        after: after.pathAttribution.directoryHandleCreateRequests,
      }),
      fileHandleLookups: subtractBackingFilePathCounters({
        before: before.pathAttribution.fileHandleLookups,
        after: after.pathAttribution.fileHandleLookups,
      }),
      fileHandleCreateRequests: subtractBackingFilePathCounters({
        before: before.pathAttribution.fileHandleCreateRequests,
        after: after.pathAttribution.fileHandleCreateRequests,
      }),
      fileSnapshotOperations: subtractBackingFilePathCounters({
        before: before.pathAttribution.fileSnapshotOperations,
        after: after.pathAttribution.fileSnapshotOperations,
      }),
      listOperations: subtractBackingDirectoryPathCounters({
        before: before.pathAttribution.listOperations,
        after: after.pathAttribution.listOperations,
      }),
      listEntriesMaterialized: subtractBackingDirectoryPathCounters({
        before: before.pathAttribution.listEntriesMaterialized,
        after: after.pathAttribution.listEntriesMaterialized,
      }),
    },
  };
}

function classifyBackingDirectoryPath({ relativePath }: {
  relativePath: readonly string[];
}): keyof BackingStoreCounters['pathAttribution']['directoryHandleLookups'] {
  if (relativePath.length === 0) return 'root';
  if (relativePath[0] !== 'segments') return 'other';
  if (relativePath.length === 1) return 'segmentRoot';
  switch (relativePath[1]) {
  case 'metadata':
  case 'data':
  case 'relocation':
    break;
  default:
    return 'other';
  }
  if (relativePath.length === 2) return 'segmentClass';
  if (relativePath.length === 3) return 'segmentShard';
  return 'other';
}

function classifyBackingFilePath({ relativePath }: {
  relativePath: readonly string[];
}): keyof BackingStoreCounters['pathAttribution']['fileHandleLookups'] {
  if (relativePath.length === 1) {
    const [name] = relativePath;
    if (HIZOFS_SUPERBLOCK_FILES.some(candidate => candidate === name)) return 'superblock';
    if (HIZOFS_UNLOCK_ENVELOPE_FILES.some(candidate => candidate === name)) return 'unlockEnvelope';
    return 'other';
  }
  if (relativePath.length !== 4 || relativePath[0] !== 'segments') return 'other';
  switch (relativePath[1]) {
  case 'metadata': return 'metadataSegment';
  case 'data': return 'dataSegment';
  case 'relocation': return 'relocationSegment';
  default: return 'other';
  }
}

function incrementBackingPathCounter<TPathKind extends string>({
  counters,
  diagnosticsMode,
  pathKind,
}: {
  counters: Record<TPathKind, number>;
  diagnosticsMode: HizoFSBenchmarkConfiguration['backingStoreDiagnosticsMode'];
  pathKind: TPathKind;
}): void {
  switch (diagnosticsMode) {
  case 'basic':
    return;
  case 'detailed':
    counters[pathKind] += 1;
    return;
  default: {
    const _ex: never = diagnosticsMode;
    throw new Error(`Unhandled backing-store diagnostics mode: ${String(_ex)}`);
  }
  }
}

function createCountingDirectoryHandle({
  directory,
  counters,
  diagnosticsMode,
  relativePath,
  physicalDiagnostics,
}: {
  directory: FileSystemDirectoryHandle;
  counters: BackingStoreCounters;
  diagnosticsMode: HizoFSBenchmarkConfiguration['backingStoreDiagnosticsMode'];
  relativePath: readonly string[];
  physicalDiagnostics: HizoFSPhysicalDiagnosticTracker;
}): FileSystemDirectoryHandle {
  return new Proxy(directory, {
    get(target, property) {
      switch (property) {
      case 'getDirectoryHandle':
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements FileSystemDirectoryHandle.getDirectoryHandle.
        return async (name: string, options?: FileSystemGetDirectoryOptions) => {
          const targetPath = [...relativePath, name];
          const pathKind = classifyBackingDirectoryPath({ relativePath: targetPath });
          counters.directoryHandleLookups += 1;
          incrementBackingPathCounter({
            diagnosticsMode,
            counters: counters.pathAttribution.directoryHandleLookups,
            pathKind,
          });
          if (options?.create === true) {
            counters.directoryHandleCreateRequests += 1;
            incrementBackingPathCounter({
              diagnosticsMode,
              counters: counters.pathAttribution.directoryHandleCreateRequests,
              pathKind,
            });
          }
          return createCountingDirectoryHandle({
            directory: await target.getDirectoryHandle(name, options),
            counters,
            diagnosticsMode,
            relativePath: targetPath,
            physicalDiagnostics,
          });
        };
      case 'getFileHandle':
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements FileSystemDirectoryHandle.getFileHandle.
        return async (name: string, options?: FileSystemGetFileOptions) => {
          const targetPath = [...relativePath, name];
          const pathKind = classifyBackingFilePath({ relativePath: targetPath });
          counters.fileHandleLookups += 1;
          incrementBackingPathCounter({
            diagnosticsMode,
            counters: counters.pathAttribution.fileHandleLookups,
            pathKind,
          });
          if (options?.create === true) {
            counters.fileHandleCreateRequests += 1;
            incrementBackingPathCounter({
              diagnosticsMode,
              counters: counters.pathAttribution.fileHandleCreateRequests,
              pathKind,
            });
          }
          return createCountingFileHandle({
            file: await target.getFileHandle(name, options),
            counters,
            diagnosticsMode,
            relativePath: targetPath,
            physicalDiagnostics,
          });
        };
      case 'removeEntry':
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements FileSystemDirectoryHandle.removeEntry.
        return async (name: string, options?: FileSystemRemoveOptions) => {
          counters.removeOperations += 1;
          await target.removeEntry(name, options);
          recordRemovedPhysicalPath({
            relativePath: [...relativePath, name],
            physicalDiagnostics,
          });
        };
      case 'entries':
        return () => {
          counters.listOperations += 1;
          incrementBackingPathCounter({
            diagnosticsMode,
            counters: counters.pathAttribution.listOperations,
            pathKind: classifyBackingDirectoryPath({ relativePath }),
          });
          return wrapDirectoryEntries({
            entries: target.entries(),
            counters,
            diagnosticsMode,
            relativePath,
            physicalDiagnostics,
          });
        };
      case 'values':
        return () => {
          counters.listOperations += 1;
          incrementBackingPathCounter({
            diagnosticsMode,
            counters: counters.pathAttribution.listOperations,
            pathKind: classifyBackingDirectoryPath({ relativePath }),
          });
          return wrapDirectoryValues({
            values: target.values(),
            counters,
            diagnosticsMode,
            relativePath,
            physicalDiagnostics,
          });
        };
      case 'keys':
        return () => {
          counters.listOperations += 1;
          incrementBackingPathCounter({
            diagnosticsMode,
            counters: counters.pathAttribution.listOperations,
            pathKind: classifyBackingDirectoryPath({ relativePath }),
          });
          return wrapDirectoryKeys({
            keys: target.keys(),
            counters,
            diagnosticsMode,
            relativePath,
          });
        };
      default: {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      }
    },
  });
}

function createCountingFileHandle({
  file,
  counters,
  diagnosticsMode,
  relativePath,
  physicalDiagnostics,
}: {
  file: FileSystemFileHandle;
  counters: BackingStoreCounters;
  diagnosticsMode: HizoFSBenchmarkConfiguration['backingStoreDiagnosticsMode'];
  relativePath: readonly string[];
  physicalDiagnostics: HizoFSPhysicalDiagnosticTracker;
}): FileSystemFileHandle {
  return new Proxy(file, {
    get(target, property) {
      switch (property) {
      case 'getFile':
        return async () => {
          const file = await target.getFile();
          counters.fileSnapshotOperations += 1;
          incrementBackingPathCounter({
            diagnosticsMode,
            counters: counters.pathAttribution.fileSnapshotOperations,
            pathKind: classifyBackingFilePath({ relativePath }),
          });
          return createCountingBlob({ blob: file, counters });
        };
      case 'createWritable':
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements FileSystemFileHandle.createWritable.
        return async (options?: FileSystemCreateWritableOptions) => {
          counters.writeOperations += 1;
          const writable = await target.createWritable(options);
          return createCountingWritable({
            writable,
            counters,
            onCommitted: () => recordCommittedPhysicalWrite({
              relativePath,
              physicalDiagnostics,
            }),
          });
        };
      case 'createSyncAccessHandle': {
        const createSyncAccessHandle = (target as BenchmarkFileHandleWithSyncAccess)
          .createSyncAccessHandle;
        if (createSyncAccessHandle === undefined) return undefined;
        return async () => createCountingSyncAccessHandle({
          handle: await createSyncAccessHandle.call(target),
          counters,
          onCommitted: () => recordCommittedPhysicalWrite({
            relativePath,
            physicalDiagnostics,
          }),
        });
      }
      default: {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      }
    },
  });
}

function createCountingBlob<TBlob extends Blob>({
  blob,
  counters,
}: {
  blob: TBlob;
  counters: BackingStoreCounters;
}): TBlob {
  return new Proxy(blob, {
    get(target, property) {
      switch (property) {
      case 'arrayBuffer':
        return async () => {
          const buffer = await target.arrayBuffer();
          recordBackingStoreRead({ counters, byteLength: buffer.byteLength });
          return buffer;
        };
      case 'bytes': {
        const bytes = (target as Blob & {
          bytes?: () => Promise<Uint8Array>;
        }).bytes;
        if (bytes === undefined) return undefined;
        return async () => {
          const value = await bytes.call(target);
          recordBackingStoreRead({ counters, byteLength: value.byteLength });
          return value;
        };
      }
      case 'slice':
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements Blob.slice.
        return (start?: number, end?: number, contentType?: string) => createCountingBlob({
          blob: target.slice(start, end, contentType),
          counters,
        });
      case 'stream':
        return () => {
          counters.readOperations += 1;
          return target.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              counters.bytesRead += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }));
        };
      case 'text':
        return async () => {
          const value = await target.text();
          recordBackingStoreRead({ counters, byteLength: target.size });
          return value;
        };
      default: {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      }
    },
  });
}

function recordBackingStoreRead({ counters, byteLength }: {
  counters: BackingStoreCounters;
  byteLength: number;
}): void {
  counters.readOperations += 1;
  counters.bytesRead += byteLength;
}

function createCountingWritable({
  writable,
  counters,
  onCommitted,
}: {
  writable: FileSystemWritableFileStream;
  counters: BackingStoreCounters;
  onCommitted: () => void;
}): FileSystemWritableFileStream {
  let committed = false;
  return new Proxy(writable, {
    get(target, property) {
      if (property === 'write') {
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements FileSystemWritableFileStream.write.
        return async (data: FileSystemWriteChunkType) => {
          counters.bytesWritten += getWriteChunkByteLength({ data });
          await target.write(data);
        };
      }
      if (property === 'close') {
        return async () => {
          await target.close();
          if (!committed) {
            committed = true;
            onCommitted();
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}


function createCountingSyncAccessHandle({
  handle,
  counters,
  onCommitted,
}: {
  handle: BenchmarkSyncAccessHandle;
  counters: BackingStoreCounters;
  onCommitted: () => void;
}): BenchmarkSyncAccessHandle {
  return new Proxy(handle, {
    get(target, property) {
      switch (property) {
      case 'read':
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements FileSystemSyncAccessHandle.read.
        return (buffer: ArrayBufferView, options?: { at?: number }) => {
          const read = target.read(buffer, options);
          recordBackingStoreRead({ counters, byteLength: read });
          return read;
        };
      case 'write':
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements FileSystemSyncAccessHandle.write.
        return (buffer: BufferSource, options?: { at?: number }) => {
          const written = target.write(buffer, options);
          counters.writeOperations += 1;
          counters.bytesWritten += written;
          return written;
        };
      case 'flush':
        return () => {
          target.flush();
          onCommitted();
        };
      default: {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      }
    },
  });
}

async function* wrapDirectoryEntries({
  entries,
  counters,
  diagnosticsMode,
  relativePath,
  physicalDiagnostics,
}: {
  entries: AsyncIterableIterator<[string, FileSystemHandle]>;
  counters: BackingStoreCounters;
  diagnosticsMode: HizoFSBenchmarkConfiguration['backingStoreDiagnosticsMode'];
  relativePath: readonly string[];
  physicalDiagnostics: HizoFSPhysicalDiagnosticTracker;
}): AsyncIterableIterator<[string, FileSystemHandle]> {
  for await (const [name, handle] of entries) {
    recordBackingListEntryMaterialized({ counters, diagnosticsMode, relativePath });
    yield [name, wrapCountingHandle({
      handle,
      counters,
      diagnosticsMode,
      relativePath: [...relativePath, name],
      physicalDiagnostics,
    })];
  }
}

async function* wrapDirectoryValues({
  values,
  counters,
  diagnosticsMode,
  relativePath,
  physicalDiagnostics,
}: {
  values: AsyncIterableIterator<FileSystemHandle>;
  counters: BackingStoreCounters;
  diagnosticsMode: HizoFSBenchmarkConfiguration['backingStoreDiagnosticsMode'];
  relativePath: readonly string[];
  physicalDiagnostics: HizoFSPhysicalDiagnosticTracker;
}): AsyncIterableIterator<FileSystemHandle> {
  for await (const handle of values) {
    recordBackingListEntryMaterialized({ counters, diagnosticsMode, relativePath });
    yield wrapCountingHandle({
      handle,
      counters,
      diagnosticsMode,
      relativePath: [...relativePath, handle.name],
      physicalDiagnostics,
    });
  }
}

async function* wrapDirectoryKeys({
  keys,
  counters,
  diagnosticsMode,
  relativePath,
}: {
  keys: AsyncIterableIterator<string>;
  counters: BackingStoreCounters;
  diagnosticsMode: HizoFSBenchmarkConfiguration['backingStoreDiagnosticsMode'];
  relativePath: readonly string[];
}): AsyncIterableIterator<string> {
  for await (const name of keys) {
    recordBackingListEntryMaterialized({ counters, diagnosticsMode, relativePath });
    yield name;
  }
}

function recordBackingListEntryMaterialized({
  counters,
  diagnosticsMode,
  relativePath,
}: {
  counters: BackingStoreCounters;
  diagnosticsMode: HizoFSBenchmarkConfiguration['backingStoreDiagnosticsMode'];
  relativePath: readonly string[];
}): void {
  counters.listEntriesMaterialized += 1;
  incrementBackingPathCounter({
    counters: counters.pathAttribution.listEntriesMaterialized,
    diagnosticsMode,
    pathKind: classifyBackingDirectoryPath({ relativePath }),
  });
}

function wrapCountingHandle({
  handle,
  counters,
  diagnosticsMode,
  relativePath,
  physicalDiagnostics,
}: {
  handle: FileSystemHandle;
  counters: BackingStoreCounters;
  diagnosticsMode: HizoFSBenchmarkConfiguration['backingStoreDiagnosticsMode'];
  relativePath: readonly string[];
  physicalDiagnostics: HizoFSPhysicalDiagnosticTracker;
}): FileSystemHandle {
  const kind = handle.kind;
  switch (kind) {
  case 'directory':
    return createCountingDirectoryHandle({
      directory: handle as FileSystemDirectoryHandle,
      counters,
      diagnosticsMode,
      relativePath,
      physicalDiagnostics,
    });
  case 'file':
    return createCountingFileHandle({
      file: handle as FileSystemFileHandle,
      counters,
      diagnosticsMode,
      relativePath,
      physicalDiagnostics,
    });
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled filesystem handle kind: ${String(_ex)}`);
  }
  }
}

function getWriteChunkByteLength({ data }: { data: FileSystemWriteChunkType }): number {
  if (typeof data === 'string') return new TextEncoder().encode(data).byteLength;
  if (data instanceof Blob) return data.size;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (typeof data === 'object' && data !== null && 'data' in data && data.data !== undefined && data.data !== null) {
    return getWriteChunkByteLength({ data: data.data });
  }
  return 0;
}

type CanonicalTrackedSegmentPath = Readonly<{
  physicalPath: string;
  segmentClass: SegmentClass;
  shard: string;
}>;

function parseCanonicalTrackedSegmentPath({
  relativePath,
}: {
  relativePath: readonly string[];
}): CanonicalTrackedSegmentPath | undefined {
  const [segmentRoot, segmentClassDirectory, shardDirectory, segmentFilename, ...unexpected] = relativePath;
  if (
    unexpected.length !== 0
    || segmentRoot !== HIZOFS_V1_FORMAT_CONSTANTS.container.segmentDirectoryName
    || segmentClassDirectory === undefined
    || shardDirectory === undefined
    || segmentFilename === undefined
  ) {
    return undefined;
  }
  try {
    const segmentClass = parseSegmentClassDirectoryName({ value: segmentClassDirectory });
    const shard = parseSegmentShardDirectoryName({ value: shardDirectory });
    const segmentId = parseSegmentFilename({ value: segmentFilename });
    const physicalPath = relativePath.join('/');
    if (physicalPath !== segmentIdToRelativePath({ id: segmentId, segmentClass })) return undefined;
    return { physicalPath, segmentClass, shard };
  } catch {
    return undefined;
  }
}

function snapshotPhysicalStoreShape({
  objectPaths,
}: {
  objectPaths: ReadonlySet<string>;
}): PhysicalStoreShape {
  const segmentFiles = { metadata: 0, data: 0 };
  const segmentShards = {
    metadata: new Set<string>(),
    data: new Set<string>(),
  };
  for (const objectPath of objectPaths) {
    const tracked = parseCanonicalTrackedSegmentPath({ relativePath: objectPath.split('/') });
    if (tracked === undefined) continue;
    segmentFiles[tracked.segmentClass] += 1;
    segmentShards[tracked.segmentClass].add(tracked.shard);
  }
  const metadataFiles = segmentFiles.metadata;
  const dataFiles = segmentFiles.data;
  const metadataShards = segmentShards.metadata.size;
  const dataShards = segmentShards.data.size;
  return {
    segmentFiles: {
      metadata: metadataFiles,
      data: dataFiles,
      total: metadataFiles + dataFiles,
    },
    segmentShards: {
      metadata: metadataShards,
      data: dataShards,
      total: metadataShards + dataShards,
    },
  };
}

function createHizoFSPhysicalDiagnosticTracker(): HizoFSPhysicalDiagnosticTracker {
  return {
    objectPaths: new Set<string>(),
    superblockPublications: 0,
  };
}

async function initializeHizoFSPhysicalDiagnostics({
  backingDirectory,
  physicalDiagnostics,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  physicalDiagnostics: HizoFSPhysicalDiagnosticTracker;
}): Promise<void> {
  physicalDiagnostics.objectPaths.clear();
  try {
    const segmentRootName = HIZOFS_V1_FORMAT_CONSTANTS.container.segmentDirectoryName;
    const segmentsDirectory = await backingDirectory.getDirectoryHandle(segmentRootName);
    for (const segmentClass of ['metadata', 'data'] as const satisfies readonly SegmentClass[]) {
      const segmentClassDirectory = HIZOFS_V1_FORMAT_CONSTANTS.container.segmentClassDirectories[segmentClass];
      let typeDirectory: FileSystemDirectoryHandle;
      try {
        typeDirectory = await segmentsDirectory.getDirectoryHandle(segmentClassDirectory);
      } catch (error) {
        if (isNotFoundError({ error })) continue;
        throw error;
      }
      for await (const [shardName, shardHandle] of typeDirectory.entries()) {
        switch (shardHandle.kind) {
        case 'file':
          continue;
        case 'directory':
          for await (
            const [segmentName, segmentHandle]
            of (shardHandle as FileSystemDirectoryHandle).entries()
          ) {
            switch (segmentHandle.kind) {
            case 'file': {
              const tracked = parseCanonicalTrackedSegmentPath({
                relativePath: [segmentRootName, segmentClassDirectory, shardName, segmentName],
              });
              if (tracked !== undefined) physicalDiagnostics.objectPaths.add(tracked.physicalPath);
              break;
            }
            case 'directory':
              break;
            default: {
              const _ex: never = segmentHandle;
              throw new Error(
                `Unhandled segment entry kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`,
              );
            }
            }
          }
          break;
        default: {
          const _ex: never = shardHandle;
          throw new Error(
            `Unhandled segment shard kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`,
          );
        }
        }
      }
    }
  } catch (error) {
    if (!isNotFoundError({ error })) throw error;
  }
  physicalDiagnostics.superblockPublications = 0;
}

function recordCommittedPhysicalWrite({
  relativePath,
  physicalDiagnostics,
}: {
  relativePath: readonly string[];
  physicalDiagnostics: HizoFSPhysicalDiagnosticTracker;
}): void {
  if (isSuperblockPublicationMarkerPath({ relativePath })) {
    // A successful logical publication converges both A/B copies. Count one
    // canonical copy as the completion marker so physical redundancy does not
    // double the logical Commit-publication diagnostic.
    physicalDiagnostics.superblockPublications += 1;
    return;
  }
  const trackedSegment = parseCanonicalTrackedSegmentPath({ relativePath });
  if (trackedSegment !== undefined) {
    physicalDiagnostics.objectPaths.add(trackedSegment.physicalPath);
  }
}

function recordRemovedPhysicalPath({
  relativePath,
  physicalDiagnostics,
}: {
  relativePath: readonly string[];
  physicalDiagnostics: HizoFSPhysicalDiagnosticTracker;
}): void {
  const physicalPath = relativePath.join('/');
  for (const objectPath of physicalDiagnostics.objectPaths) {
    if (objectPath === physicalPath || objectPath.startsWith(`${physicalPath}/`)) {
      physicalDiagnostics.objectPaths.delete(objectPath);
    }
  }
}

function isSuperblockPublicationMarkerPath({
  relativePath,
}: {
  relativePath: readonly string[];
}): boolean {
  return relativePath.length === 1
    && relativePath[0] === HIZOFS_SUPERBLOCK_FILES[0];
}

function validateBenchmarkConfiguration({
  configuration,
}: {
  configuration: HizoFSBenchmarkConfiguration;
}): void {
  if (configuration.sequentialIo.blockSizeBytes > configuration.sequentialIo.fileSizeBytes) {
    throw new Error('Sequential benchmark block size must not exceed the file size');
  }
  if (configuration.randomAccess.blockSizeBytes > configuration.randomAccess.fileSizeBytes) {
    throw new Error('Random-access benchmark block size must not exceed the file size');
  }
  if (
    !getRequestedBackendKinds({ backendMode: configuration.backendMode }).includes('hizofs')
    && configuration.workloads.includes('hizofs_maintenance')
  ) {
    throw new Error('HizoFS maintenance workload requires the HizoFS backend');
  }
}

function getHardwareConcurrency(): number | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const value = navigator.hardwareConcurrency;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : error instanceof Error
      && (error.name === 'NotFoundError' || error.message.startsWith('NotFoundError'));
}

function getErrorName({ error }: { error: unknown }): string {
  if (typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string') {
    return error.name;
  }
  return 'UnknownError';
}

function getErrorMessage({ error }: { error: unknown }): string {
  if (error instanceof AggregateError) {
    const nested = error.errors.map((cause) => getErrorMessage({ error: cause }));
    return nested.length === 0
      ? error.message
      : `${error.message}: ${nested.join('; ')}`;
  }
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

function getErrorStack({ error }: { error: unknown }): string | undefined {
  return typeof error === 'object' && error !== null && 'stack' in error && typeof error.stack === 'string'
    ? error.stack
    : undefined;
}

function isAbortError({ error }: { error: unknown }): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function toExactArrayBuffer({ bytes }: { readonly bytes: Uint8Array }): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createEmptyBackingStoreCounters,
  aggregateSamples,
  createRandomPositions,
  createPatternBytes,
  createCountingDirectoryHandle,
  createCountingSyncAccessHandle,
  parseCanonicalTrackedSegmentPath,
  snapshotPhysicalStoreShape,
};
