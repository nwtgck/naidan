import type {
  HizoFSBenchmarkConfiguration,
  HizoFSBenchmarkPreset,
  HizoFSBenchmarkWorkload,
} from './types';

const DEFAULT_WORKLOADS: readonly HizoFSBenchmarkWorkload[] = [
  'small_files',
  'sequential_io',
  'random_access',
  'directory_operations',
];

export function createHizoFSBenchmarkPresetConfiguration({
  preset,
}: {
  preset: Exclude<HizoFSBenchmarkPreset, 'custom'>;
}): HizoFSBenchmarkConfiguration {
  switch (preset) {
  case 'quick':
    return createConfiguration({
      preset,
      warmupIterations: 0,
      measuredIterations: 1,
      workloads: DEFAULT_WORKLOADS,
      smallFileCount: 32,
      smallFileSizeBytes: 4 * 1024,
      sequentialFileSizeBytes: 1 * 1024 * 1024,
      sequentialBlockSizeBytes: 256 * 1024,
      randomFileSizeBytes: 1 * 1024 * 1024,
      randomOperationCount: 32,
      randomBlockSizeBytes: 4 * 1024,
      directoryEntryCount: 64,
      cloneCount: 8,
      cloneSourceFileSizeBytes: 1 * 1024 * 1024,
    });
  case 'standard':
    return createConfiguration({
      preset,
      warmupIterations: 1,
      measuredIterations: 3,
      workloads: DEFAULT_WORKLOADS,
      smallFileCount: 500,
      smallFileSizeBytes: 4 * 1024,
      sequentialFileSizeBytes: 16 * 1024 * 1024,
      sequentialBlockSizeBytes: 256 * 1024,
      randomFileSizeBytes: 16 * 1024 * 1024,
      randomOperationCount: 500,
      randomBlockSizeBytes: 64 * 1024,
      directoryEntryCount: 1_000,
      cloneCount: 50,
      cloneSourceFileSizeBytes: 16 * 1024 * 1024,
    });
  case 'stress':
    return createConfiguration({
      preset,
      warmupIterations: 1,
      measuredIterations: 5,
      workloads: [...DEFAULT_WORKLOADS, 'hizofs_maintenance'],
      smallFileCount: 10_000,
      smallFileSizeBytes: 4 * 1024,
      sequentialFileSizeBytes: 128 * 1024 * 1024,
      sequentialBlockSizeBytes: 512 * 1024,
      randomFileSizeBytes: 128 * 1024 * 1024,
      randomOperationCount: 5_000,
      randomBlockSizeBytes: 64 * 1024,
      directoryEntryCount: 10_000,
      cloneCount: 100,
      cloneSourceFileSizeBytes: 64 * 1024 * 1024,
    });
  default: {
    const _ex: never = preset;
    throw new Error(`Unhandled HizoFS benchmark preset: ${String(_ex)}`);
  }
  }
}

export function estimateHizoFSBenchmarkWrittenBytes({
  configuration,
}: {
  configuration: HizoFSBenchmarkConfiguration;
}): number {
  let totalPerIteration = 0;
  const totalIterations = configuration.warmupIterations + configuration.measuredIterations;
  for (const workload of configuration.workloads) {
    const backendMultiplier = getWorkloadBackendMultiplier({
      backendMode: configuration.backendMode,
      workload,
    });
    switch (workload) {
    case 'small_files':
      totalPerIteration += backendMultiplier
        * configuration.smallFiles.count
        * configuration.smallFiles.sizeBytes;
      break;
    case 'sequential_io':
      totalPerIteration += backendMultiplier
        * (configuration.sequentialIo.fileSizeBytes + configuration.sequentialIo.blockSizeBytes);
      break;
    case 'random_access':
      totalPerIteration += backendMultiplier * (
        configuration.randomAccess.fileSizeBytes
        + configuration.randomAccess.operationCount * configuration.randomAccess.blockSizeBytes
      );
      break;
    case 'directory_operations':
    case 'bulk_operations':
      break;
    case 'hizofs_maintenance':
      totalPerIteration += backendMultiplier * (
        configuration.hizoFSMaintenance.sourceFileSizeBytes
        + configuration.hizoFSMaintenance.cloneCount
          * Math.min(configuration.randomAccess.blockSizeBytes, 256 * 1024)
      );
      break;
    default: {
      const _ex: never = workload;
      throw new Error(`Unhandled HizoFS benchmark workload: ${String(_ex)}`);
    }
    }
  }
  return totalPerIteration * Math.max(totalIterations, 1);
}

function createConfiguration({
  preset,
  warmupIterations,
  measuredIterations,
  workloads,
  smallFileCount,
  smallFileSizeBytes,
  sequentialFileSizeBytes,
  sequentialBlockSizeBytes,
  randomFileSizeBytes,
  randomOperationCount,
  randomBlockSizeBytes,
  directoryEntryCount,
  cloneCount,
  cloneSourceFileSizeBytes,
}: {
  preset: Exclude<HizoFSBenchmarkPreset, 'custom'>;
  warmupIterations: number;
  measuredIterations: number;
  workloads: readonly HizoFSBenchmarkWorkload[];
  smallFileCount: number;
  smallFileSizeBytes: number;
  sequentialFileSizeBytes: number;
  sequentialBlockSizeBytes: number;
  randomFileSizeBytes: number;
  randomOperationCount: number;
  randomBlockSizeBytes: number;
  directoryEntryCount: number;
  cloneCount: number;
  cloneSourceFileSizeBytes: number;
}): HizoFSBenchmarkConfiguration {
  return {
    backendMode: 'compare',
    preset,
    runLabel: undefined,
    randomSeed: 0x4e_61_69_64,
    warmupIterations,
    measuredIterations,
    storeLifecycle: 'reuse_without_gc',
    workloads: [...workloads],
    smallFiles: {
      count: smallFileCount,
      sizeBytes: smallFileSizeBytes,
    },
    sequentialIo: {
      fileSizeBytes: sequentialFileSizeBytes,
      blockSizeBytes: sequentialBlockSizeBytes,
    },
    randomAccess: {
      fileSizeBytes: randomFileSizeBytes,
      operationCount: randomOperationCount,
      blockSizeBytes: randomBlockSizeBytes,
    },
    directoryOperations: {
      entryCount: directoryEntryCount,
    },
    hizoFSMaintenance: {
      cloneCount,
      sourceFileSizeBytes: cloneSourceFileSizeBytes,
      garbageCollectionSweep: {
        removeConcurrency: 4,
        maximumRemovalsPerSlice: 16,
        maximumSliceDurationMs: 150,
      },
    },
    hizoFSRuntimePolicy: {
      fileChunkSize: 1024 * 1024,
      fileChunkWriteConcurrency: 2,
      fileChunkReadPrefetchConcurrency: 4,
      backingFileHandleCacheEntryLimit: 1024,
      fileChunkCacheByteLimit: 16 * 1024 * 1024 + 64 * 1024,
      fileChunkCacheEntryLimit: 2048,
      fileChunkCacheAdmission: 'read_only',
    },
    benchmarkDataRetention: 'delete_after_run',
  };
}

function getWorkloadBackendMultiplier({
  backendMode,
  workload,
}: {
  backendMode: HizoFSBenchmarkConfiguration['backendMode'];
  workload: HizoFSBenchmarkWorkload;
}): number {
  switch (workload) {
  case 'hizofs_maintenance':
    switch (backendMode) {
    case 'compare':
    case 'hizofs_only':
      return 1;
    case 'raw_opfs_only':
      return 0;
    default: {
      const _ex: never = backendMode;
      throw new Error(`Unhandled HizoFS benchmark backend mode: ${String(_ex)}`);
    }
    }
  case 'small_files':
  case 'sequential_io':
  case 'random_access':
  case 'directory_operations':
  case 'bulk_operations':
    switch (backendMode) {
    case 'compare': return 2;
    case 'hizofs_only':
    case 'raw_opfs_only':
      return 1;
    default: {
      const _ex: never = backendMode;
      throw new Error(`Unhandled HizoFS benchmark backend mode: ${String(_ex)}`);
    }
    }
  default: {
    const _ex: never = workload;
    throw new Error(`Unhandled HizoFS benchmark workload: ${String(_ex)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
