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
  case 'diagnostics_overhead':
    return createDiagnosticsOverheadStudy({ baseConfiguration });
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
    studyImplementationVersion: 9,
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

  // WHY: a policy study is useful only when the requested value reaches the
  // product runtime. Running variants for disconnected controls wastes browser
  // time and can falsely imply that equal results compare real implementations.
  // Add a control back here only when production-runtime-port wires it through.
  return [0, 256, 1024, 4096].map(entryLimit => createVariant({
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

function createLargeWriteStudy({
  baseConfiguration,
}: {
  baseConfiguration: HizoFSBenchmarkConfiguration;
}): readonly HizoFSBenchmarkStudyVariant[] {
  const studyBase = createStudyBaseConfiguration({
    baseConfiguration,
    backendMode: 'hizofs_only',
    workloads: ['sequential_io'],
    warmupIterations: 0,
    measuredIterations: 1,
    storeLifecycle: 'fresh_per_iteration',
  });
  // Chunk-write concurrency is not currently a product runtime control. Keep
  // large-write coverage, but do not rerun the same implementation four times
  // under labels that only change an ineffective requested value.
  return [
    createVariant({
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
    }),
    createVariant({
      studyKind: 'large_write',
      variantId: 'sequential-write-256mib',
      label: 'Sequential I/O with a 256 MiB file',
      configuration: {
        ...studyBase,
        sequentialIo: {
          fileSizeBytes: 256 * 1024 * 1024,
          blockSizeBytes: 256 * 1024,
        },
      },
    }),
  ];
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

function createDiagnosticsOverheadStudy({
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
    measuredIterations: Math.min(baseConfiguration.measuredIterations, 3),
    storeLifecycle: 'fresh_per_iteration',
  });
  return ([
    { mode: 'basic' as const, label: 'Basic backing-store counters' },
    { mode: 'detailed' as const, label: 'Detailed backing-store attribution' },
  ]).map(({ mode, label }) => createVariant({
    studyKind: 'diagnostics_overhead',
    variantId: mode,
    label,
    configuration: {
      ...studyBase,
      backingStoreDiagnosticsMode: mode,
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
