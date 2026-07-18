import {
  hizoFSBenchmarkConfigurationSchema,
  hizoFSBenchmarkStudyReportSchema,
  type HizoFSBenchmarkConfiguration,
  type HizoFSBenchmarkReport,
  type HizoFSBenchmarkStudyKind,
  type HizoFSBenchmarkStudyReport,
  type HizoFSBenchmarkWorkload,
} from './types';

export type HizoFSBenchmarkStudyVariant = {
  readonly variantId: string;
  readonly label: string;
  readonly configuration: HizoFSBenchmarkConfiguration;
};

const NORMAL_LIFECYCLE_WORKLOADS: readonly HizoFSBenchmarkWorkload[] = [
  'small_files',
  'sequential_io',
  'random_access',
  'directory_operations',
];

export function createHizoFSBenchmarkStudyPlan({
  studyKind,
  baseConfiguration: rawBaseConfiguration,
}: {
  studyKind: HizoFSBenchmarkStudyKind;
  baseConfiguration: HizoFSBenchmarkConfiguration;
}): readonly HizoFSBenchmarkStudyVariant[] {
  const baseConfiguration = hizoFSBenchmarkConfigurationSchema.parse(
    rawBaseConfiguration,
  );
  switch (studyKind) {
  case 'policy_matrix':
    return createPolicyMatrix({ baseConfiguration });
  case 'large_write':
    return createLargeWriteStudy({ baseConfiguration });
  case 'lifecycle_matrix':
    return createLifecycleMatrix({ baseConfiguration });
  case 'bulk_transaction':
    return createBulkTransactionStudy({ baseConfiguration });
  case 'garbage_collection_policy':
    return createGarbageCollectionPolicyStudy({ baseConfiguration });
  default: {
    const _ex: never = studyKind;
    throw new Error(`Unhandled HizoFS benchmark study: ${String(_ex)}`);
  }
  }
}

export function createHizoFSBenchmarkStudyReport({
  studyId,
  studyKind,
  generatedAt,
  baseConfiguration,
  plannedVariantCount,
  variants,
}: {
  studyId: string;
  studyKind: HizoFSBenchmarkStudyKind;
  generatedAt: string;
  baseConfiguration: HizoFSBenchmarkConfiguration;
  plannedVariantCount: number;
  variants: readonly {
    readonly variantId: string;
    readonly label: string;
    readonly report: HizoFSBenchmarkReport;
  }[];
}): HizoFSBenchmarkStudyReport {
  if (variants.length > plannedVariantCount) {
    throw new Error('HizoFS benchmark study has more variants than planned');
  }
  const variantIds = new Set<string>();
  for (const variant of variants) {
    if (variantIds.has(variant.variantId)) {
      throw new Error(`Duplicate HizoFS benchmark study variant: ${variant.variantId}`);
    }
    variantIds.add(variant.variantId);
  }
  const status = getStudyStatus({
    plannedVariantCount,
    reports: variants.map(variant => variant.report),
  });
  return hizoFSBenchmarkStudyReportSchema.parse({
    schemaVersion: 1,
    studyImplementationVersion: 4,
    reportType: 'hizofs_benchmark_study',
    studyId,
    studyKind,
    generatedAt,
    status,
    baseConfiguration,
    plannedVariantCount,
    completedVariantCount: variants.filter(variant => (
      variant.report.status === 'completed'
    )).length,
    variants,
  });
}

function createPolicyMatrix({
  baseConfiguration,
}: {
  baseConfiguration: HizoFSBenchmarkConfiguration;
}): readonly HizoFSBenchmarkStudyVariant[] {
  const studyBase = createStudyBaseConfiguration({
    baseConfiguration,
    backendMode: 'hizofs_only',
    workloads: ['sequential_io'],
    warmupIterations: Math.min(baseConfiguration.warmupIterations, 1),
    measuredIterations: Math.min(baseConfiguration.measuredIterations, 3),
    storeLifecycle: 'fresh_per_iteration',
  });
  const variants: HizoFSBenchmarkStudyVariant[] = [];

  for (const concurrency of [1, 2, 4, 8] as const) {
    variants.push(createVariant({
      studyKind: 'policy_matrix',
      variantId: `write-concurrency-${String(concurrency)}`,
      label: `Chunk write concurrency ${String(concurrency)}`,
      configuration: {
        ...studyBase,
        workloads: ['sequential_io'],
        hizoFSRuntimePolicy: {
          ...studyBase.hizoFSRuntimePolicy,
          fileChunkWriteConcurrency: concurrency,
        },
      },
    }));
  }

  for (const concurrency of [1, 2, 4, 8] as const) {
    variants.push(createVariant({
      studyKind: 'policy_matrix',
      variantId: `read-prefetch-${String(concurrency)}`,
      label: `Sequential read prefetch ${String(concurrency)}`,
      configuration: {
        ...studyBase,
        workloads: ['sequential_io'],
        hizoFSRuntimePolicy: {
          ...studyBase.hizoFSRuntimePolicy,
          fileChunkReadPrefetchConcurrency: concurrency,
        },
      },
    }));
  }

  for (const entryLimit of [0, 256, 1024, 4096] as const) {
    variants.push(createVariant({
      studyKind: 'policy_matrix',
      variantId: `backing-handle-cache-${String(entryLimit)}`,
      label: `Backing file-handle cache ${String(entryLimit)}`,
      configuration: {
        ...studyBase,
        workloads: ['sequential_io', 'random_access'],
        hizoFSRuntimePolicy: {
          ...studyBase.hizoFSRuntimePolicy,
          backingFileHandleCacheEntryLimit: entryLimit,
        },
      },
    }));
  }

  const chunkCacheVariants = [
    {
      variantId: 'chunk-cache-disabled',
      label: 'File chunk cache disabled',
      byteLimit: 0,
      entryLimit: 0,
      admission: 'read_only' as const,
    },
    {
      variantId: 'chunk-cache-8mib-read-only',
      label: 'File chunk cache 8 MiB, read only',
      byteLimit: 8 * 1024 * 1024,
      entryLimit: 1024,
      admission: 'read_only' as const,
    },
    {
      variantId: 'chunk-cache-16mib-read-only',
      label: 'File chunk cache 16 MiB, read only',
      byteLimit: 16 * 1024 * 1024,
      entryLimit: 2048,
      admission: 'read_only' as const,
    },
    {
      variantId: 'chunk-cache-32mib-read-only',
      label: 'File chunk cache 32 MiB, read only',
      byteLimit: 32 * 1024 * 1024,
      entryLimit: 4096,
      admission: 'read_only' as const,
    },
    {
      variantId: 'chunk-cache-8mib-read-write',
      label: 'File chunk cache 8 MiB, read and write',
      byteLimit: 8 * 1024 * 1024,
      entryLimit: 1024,
      admission: 'read_write' as const,
    },
  ];
  for (const chunkCache of chunkCacheVariants) {
    variants.push(createVariant({
      studyKind: 'policy_matrix',
      variantId: chunkCache.variantId,
      label: chunkCache.label,
      configuration: {
        ...studyBase,
        workloads: ['random_access'],
        hizoFSRuntimePolicy: {
          ...studyBase.hizoFSRuntimePolicy,
          fileChunkCacheByteLimit: chunkCache.byteLimit,
          fileChunkCacheEntryLimit: chunkCache.entryLimit,
          fileChunkCacheAdmission: chunkCache.admission,
        },
      },
    }));
  }

  return variants;
}

function createLargeWriteStudy({
  baseConfiguration,
}: {
  baseConfiguration: HizoFSBenchmarkConfiguration;
}): readonly HizoFSBenchmarkStudyVariant[] {
  const studyBase = createStudyBaseConfiguration({
    baseConfiguration,
    backendMode: 'compare',
    workloads: ['sequential_io'],
    warmupIterations: 0,
    measuredIterations: Math.min(baseConfiguration.measuredIterations, 3),
    storeLifecycle: 'fresh_per_iteration',
  });
  const variants: HizoFSBenchmarkStudyVariant[] = [createVariant({
    studyKind: 'large_write',
    variantId: 'sequential-write-64mib',
    label: 'Sequential I/O with a 64 MiB file',
    configuration: {
      ...studyBase,
      sequentialIo: {
        fileSizeBytes: 64 * 1024 * 1024,
        blockSizeBytes: 256 * 1024,
      },
    },
  })];
  for (const concurrency of [1, 2, 4, 8] as const) {
    variants.push(createVariant({
      studyKind: 'large_write',
      variantId: `sequential-write-256mib-concurrency-${String(concurrency)}`,
      label: `Sequential 256 MiB write with concurrency ${String(concurrency)}`,
      configuration: {
        ...studyBase,
        sequentialIo: {
          fileSizeBytes: 256 * 1024 * 1024,
          blockSizeBytes: 256 * 1024,
        },
        hizoFSRuntimePolicy: {
          ...studyBase.hizoFSRuntimePolicy,
          fileChunkWriteConcurrency: concurrency,
        },
      },
    }));
  }
  return variants;
}

function createLifecycleMatrix({
  baseConfiguration,
}: {
  baseConfiguration: HizoFSBenchmarkConfiguration;
}): readonly HizoFSBenchmarkStudyVariant[] {
  const selectedNormalWorkloads = baseConfiguration.workloads.filter(
    workload => NORMAL_LIFECYCLE_WORKLOADS.includes(workload),
  );
  const studyBase = createStudyBaseConfiguration({
    baseConfiguration,
    backendMode: 'hizofs_only',
    workloads: selectedNormalWorkloads.length === 0
      ? [...NORMAL_LIFECYCLE_WORKLOADS]
      : selectedNormalWorkloads,
    warmupIterations: Math.min(baseConfiguration.warmupIterations, 1),
    measuredIterations: Math.min(Math.max(baseConfiguration.measuredIterations, 2), 3),
    storeLifecycle: 'reuse_without_gc',
  });
  return [
    {
      storeLifecycle: 'reuse_without_gc' as const,
      label: 'Reuse without garbage collection',
    },
    {
      storeLifecycle: 'fresh_per_iteration' as const,
      label: 'Fresh store per iteration',
    },
    {
      storeLifecycle: 'reuse_with_gc_between_iterations' as const,
      label: 'Reuse with garbage collection between iterations',
    },
    {
      storeLifecycle: 'reopen_between_iterations' as const,
      label: 'Reopen between iterations',
    },
  ].map(({ storeLifecycle, label }) => createVariant({
    studyKind: 'lifecycle_matrix',
    variantId: storeLifecycle,
    label,
    configuration: {
      ...studyBase,
      storeLifecycle,
    },
  }));
}

function createBulkTransactionStudy({
  baseConfiguration,
}: {
  baseConfiguration: HizoFSBenchmarkConfiguration;
}): readonly HizoFSBenchmarkStudyVariant[] {
  return [createVariant({
    studyKind: 'bulk_transaction',
    variantId: 'empty-files-one-commit',
    label: 'Empty files: per-operation commits versus one bulk commit',
    configuration: createStudyBaseConfiguration({
      baseConfiguration,
      backendMode: 'compare',
      workloads: ['bulk_operations'],
      warmupIterations: Math.min(baseConfiguration.warmupIterations, 1),
      measuredIterations: Math.min(baseConfiguration.measuredIterations, 3),
      storeLifecycle: 'fresh_per_iteration',
    }),
  })];
}

function createGarbageCollectionPolicyStudy({
  baseConfiguration,
}: {
  baseConfiguration: HizoFSBenchmarkConfiguration;
}): readonly HizoFSBenchmarkStudyVariant[] {
  const studyBase = createStudyBaseConfiguration({
    baseConfiguration: {
      ...baseConfiguration,
      hizoFSMaintenance: {
        ...baseConfiguration.hizoFSMaintenance,
        cloneCount: Math.max(baseConfiguration.hizoFSMaintenance.cloneCount, 100),
      },
    },
    backendMode: 'hizofs_only',
    workloads: ['hizofs_maintenance'],
    warmupIterations: 0,
    measuredIterations: 1,
    storeLifecycle: 'fresh_per_iteration',
  });
  const variants: HizoFSBenchmarkStudyVariant[] = [];
  for (const removeConcurrency of [1, 2, 4, 8] as const) {
    variants.push(createVariant({
      studyKind: 'garbage_collection_policy',
      variantId: `remove-concurrency-${String(removeConcurrency)}`,
      label: `GC remove concurrency ${String(removeConcurrency)}`,
      configuration: {
        ...studyBase,
        hizoFSMaintenance: {
          ...studyBase.hizoFSMaintenance,
          garbageCollectionSweep: {
            ...studyBase.hizoFSMaintenance.garbageCollectionSweep,
            removeConcurrency,
          },
        },
      },
    }));
  }
  for (const maximumRemovalsPerSlice of [32, 64, 128] as const) {
    variants.push(createVariant({
      studyKind: 'garbage_collection_policy',
      variantId: `slice-removals-${String(maximumRemovalsPerSlice)}`,
      label: `GC maximum ${String(maximumRemovalsPerSlice)} removals per slice`,
      configuration: {
        ...studyBase,
        hizoFSMaintenance: {
          ...studyBase.hizoFSMaintenance,
          garbageCollectionSweep: {
            ...studyBase.hizoFSMaintenance.garbageCollectionSweep,
            removeConcurrency: 4,
            maximumRemovalsPerSlice,
          },
        },
      },
    }));
  }
  for (const maximumSliceDurationMs of [50, 500] as const) {
    variants.push(createVariant({
      studyKind: 'garbage_collection_policy',
      variantId: `slice-duration-${String(maximumSliceDurationMs)}ms`,
      label: `GC ${String(maximumSliceDurationMs)} ms soft slice budget`,
      configuration: {
        ...studyBase,
        hizoFSMaintenance: {
          ...studyBase.hizoFSMaintenance,
          garbageCollectionSweep: {
            ...studyBase.hizoFSMaintenance.garbageCollectionSweep,
            removeConcurrency: 4,
            maximumRemovalsPerSlice: 16,
            maximumSliceDurationMs,
          },
        },
      },
    }));
  }
  variants.push(createVariant({
    studyKind: 'garbage_collection_policy',
    variantId: 'large-candidate-set',
    label: 'GC large candidate set with foreground latency probes',
    configuration: {
      ...studyBase,
      hizoFSMaintenance: {
        ...studyBase.hizoFSMaintenance,
        cloneCount: Math.max(studyBase.hizoFSMaintenance.cloneCount, 1000),
        garbageCollectionSweep: {
          removeConcurrency: 4,
          maximumRemovalsPerSlice: 16,
          maximumSliceDurationMs: 150,
        },
      },
    },
  }));
  return variants;
}

function createStudyBaseConfiguration({
  baseConfiguration,
  backendMode,
  workloads,
  warmupIterations,
  measuredIterations,
  storeLifecycle,
}: {
  baseConfiguration: HizoFSBenchmarkConfiguration;
  backendMode: HizoFSBenchmarkConfiguration['backendMode'];
  workloads: readonly HizoFSBenchmarkWorkload[];
  warmupIterations: number;
  measuredIterations: number;
  storeLifecycle: HizoFSBenchmarkConfiguration['storeLifecycle'];
}): HizoFSBenchmarkConfiguration {
  return hizoFSBenchmarkConfigurationSchema.parse({
    ...baseConfiguration,
    backendMode,
    preset: 'custom',
    warmupIterations,
    measuredIterations,
    storeLifecycle,
    workloads: [...workloads],
    benchmarkDataRetention: 'delete_after_run',
  });
}

function createVariant({
  studyKind,
  variantId,
  label,
  configuration,
}: {
  studyKind: HizoFSBenchmarkStudyKind;
  variantId: string;
  label: string;
  configuration: HizoFSBenchmarkConfiguration;
}): HizoFSBenchmarkStudyVariant {
  return {
    variantId,
    label,
    configuration: hizoFSBenchmarkConfigurationSchema.parse({
      ...configuration,
      runLabel: createVariantRunLabel({
        baseRunLabel: configuration.runLabel,
        studyKind,
        variantId,
      }),
    }),
  };
}

function createVariantRunLabel({
  baseRunLabel,
  studyKind,
  variantId,
}: {
  baseRunLabel: string | undefined;
  studyKind: HizoFSBenchmarkStudyKind;
  variantId: string;
}): string {
  const suffix = `${studyKind}/${variantId}`;
  if (baseRunLabel === undefined || baseRunLabel.length === 0) return suffix;
  const separator = ' / ';
  const maximumBaseLength = Math.max(200 - separator.length - suffix.length, 0);
  if (maximumBaseLength === 0) return suffix.slice(0, 200);
  return `${baseRunLabel.slice(0, maximumBaseLength)}${separator}${suffix}`;
}

function getStudyStatus({
  plannedVariantCount,
  reports,
}: {
  plannedVariantCount: number;
  reports: readonly HizoFSBenchmarkReport[];
}): HizoFSBenchmarkStudyReport['status'] {
  if (reports.some(report => report.status === 'failed')) return 'failed';
  if (
    reports.some(report => report.status === 'cancelled')
    || reports.length < plannedVariantCount
  ) {
    return 'cancelled';
  }
  return 'completed';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
