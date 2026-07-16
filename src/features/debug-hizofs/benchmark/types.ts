import { z } from 'zod';

export const hizoFSBenchmarkBackendModeSchema = z.union([
  z.literal('compare'),
  z.literal('hizofs_only'),
  z.literal('raw_opfs_only'),
]);

export const hizoFSBenchmarkPresetSchema = z.union([
  z.literal('quick'),
  z.literal('standard'),
  z.literal('stress'),
  z.literal('custom'),
]);

export const hizoFSBenchmarkWorkloadSchema = z.union([
  z.literal('small_files'),
  z.literal('sequential_io'),
  z.literal('random_access'),
  z.literal('directory_operations'),
  z.literal('hizofs_maintenance'),
]);

export const hizoFSBenchmarkConfigurationSchema = z.object({
  backendMode: hizoFSBenchmarkBackendModeSchema,
  preset: hizoFSBenchmarkPresetSchema,
  runLabel: z.union([z.string().max(200), z.undefined()]),
  randomSeed: z.number().int().min(1).max(0xffff_ffff),
  warmupIterations: z.number().int().min(0).max(5),
  measuredIterations: z.number().int().min(1).max(20),
  workloads: z.array(hizoFSBenchmarkWorkloadSchema).min(1),
  smallFiles: z.object({
    count: z.number().int().min(1).max(100_000),
    sizeBytes: z.number().int().min(0).max(16 * 1024 * 1024),
  }),
  sequentialIo: z.object({
    fileSizeBytes: z.number().int().min(1).max(4 * 1024 * 1024 * 1024),
    blockSizeBytes: z.number().int().min(1024).max(16 * 1024 * 1024),
  }),
  randomAccess: z.object({
    fileSizeBytes: z.number().int().min(1).max(4 * 1024 * 1024 * 1024),
    operationCount: z.number().int().min(1).max(1_000_000),
    blockSizeBytes: z.number().int().min(1).max(16 * 1024 * 1024),
  }),
  directoryOperations: z.object({
    entryCount: z.number().int().min(1).max(100_000),
  }),
  hizoFSMaintenance: z.object({
    cloneCount: z.number().int().min(1).max(10_000),
    sourceFileSizeBytes: z.number().int().min(1).max(1024 * 1024 * 1024),
  }),
  benchmarkDataRetention: z.union([
    z.literal('delete_after_run'),
    z.literal('keep_after_run'),
  ]),
}).strict();

const benchmarkParametersSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

const durationSummarySchema = z.object({
  median: z.number().nonnegative(),
  p95: z.number().nonnegative(),
  minimum: z.number().nonnegative(),
  maximum: z.number().nonnegative(),
}).strict();

const hizoFSBackingStoreCountersSchema = z.object({
  readOperations: z.number().int().nonnegative(),
  writeOperations: z.number().int().nonnegative(),
  removeOperations: z.number().int().nonnegative(),
  listOperations: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
}).strict();

const hizoFSBenchmarkDiagnosticsSchema = z.object({
  backingStore: hizoFSBackingStoreCountersSchema,
  objects: z.object({
    before: z.number().int().nonnegative(),
    after: z.number().int().nonnegative(),
    created: z.number().int(),
    removed: z.number().int(),
  }).strict(),
  commits: z.object({
    superblockPublications: z.number().int().nonnegative(),
  }).strict(),
  crypto: z.object({
    plaintextBytesProcessed: z.number().int().nonnegative(),
    ciphertextBytesWritten: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const hizoFSBenchmarkDiagnosticsTotalsSchema = z.object({
  backingStore: hizoFSBackingStoreCountersSchema,
  objectChanges: z.object({
    created: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  }).strict(),
  commits: z.object({
    superblockPublications: z.number().int().nonnegative(),
  }).strict(),
  crypto: z.object({
    plaintextBytesProcessed: z.number().int().nonnegative(),
    ciphertextBytesWritten: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const benchmarkSampleSchema = z.object({
  iteration: z.number().int().nonnegative(),
  phase: z.union([z.literal('warmup'), z.literal('measured')]),
  includedInAggregates: z.boolean(),
  durationMs: z.number().nonnegative(),
  operationCount: z.number().int().nonnegative(),
  bytesProcessed: z.number().int().nonnegative(),
  checksum: z.number().int().nonnegative(),
  hizoFSDiagnostics: z.union([hizoFSBenchmarkDiagnosticsSchema, z.undefined()]),
}).strict();

const benchmarkBackendCaseResultSchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  durationMs: durationSummarySchema,
  operationsPerSecond: z.union([z.number().nonnegative(), z.undefined()]),
  throughputBytesPerSecond: z.union([z.number().nonnegative(), z.undefined()]),
  hizoFSDiagnosticsTotals: z.union([hizoFSBenchmarkDiagnosticsTotalsSchema, z.undefined()]),
  samples: z.array(benchmarkSampleSchema),
}).strict();

const benchmarkCaseResultSchema = z.object({
  workload: hizoFSBenchmarkWorkloadSchema,
  caseId: z.string(),
  label: z.string(),
  parameters: benchmarkParametersSchema,
  backends: z.object({
    rawOpfs: z.union([benchmarkBackendCaseResultSchema, z.undefined()]),
    hizofs: z.union([benchmarkBackendCaseResultSchema, z.undefined()]),
  }).strict(),
  comparison: z.union([
    z.object({
      durationRatio: z.union([z.number().nonnegative(), z.undefined()]),
      operationsPerSecondRatio: z.union([z.number().nonnegative(), z.undefined()]),
      throughputRatio: z.union([z.number().nonnegative(), z.undefined()]),
    }).strict(),
    z.undefined(),
  ]),
}).strict();

export const hizoFSBenchmarkProgressSchema = z.object({
  stage: z.union([
    z.literal('preparing'),
    z.literal('warmup'),
    z.literal('measuring'),
    z.literal('cleaning'),
  ]),
  workload: z.union([hizoFSBenchmarkWorkloadSchema, z.undefined()]),
  caseId: z.union([z.string(), z.undefined()]),
  backend: z.union([z.literal('raw_opfs'), z.literal('hizofs'), z.undefined()]),
  iteration: z.union([z.number().int().nonnegative(), z.undefined()]),
  completedUnits: z.number().int().nonnegative(),
  totalUnits: z.number().int().positive(),
  message: z.string(),
}).strict();

export const hizoFSBenchmarkReportSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkImplementationVersion: z.literal(1),
  hizofsFormatVersion: z.literal(1),
  reportType: z.literal('hizofs_benchmark'),
  runId: z.string(),
  runLabel: z.union([z.string(), z.undefined()]),
  generatedAt: z.string(),
  status: z.union([
    z.literal('completed'),
    z.literal('cancelled'),
    z.literal('failed'),
  ]),
  environment: z.object({
    appVersion: z.string(),
    userAgent: z.string(),
    crossOriginIsolated: z.boolean(),
    hardwareConcurrency: z.union([z.number().int().positive(), z.undefined()]),
  }).strict(),
  configuration: hizoFSBenchmarkConfigurationSchema,
  executionOrder: z.array(z.object({
    iteration: z.number().int().nonnegative(),
    phase: z.union([z.literal('warmup'), z.literal('measured')]),
    order: z.array(z.union([z.literal('raw_opfs'), z.literal('hizofs')])),
  }).strict()),
  results: z.array(benchmarkCaseResultSchema),
  failure: z.union([
    z.object({
      workload: z.union([hizoFSBenchmarkWorkloadSchema, z.undefined()]),
      caseId: z.union([z.string(), z.undefined()]),
      backend: z.union([z.literal('raw_opfs'), z.literal('hizofs'), z.undefined()]),
      iteration: z.union([z.number().int().nonnegative(), z.undefined()]),
      errorName: z.string(),
      errorMessage: z.string(),
      errorStack: z.union([z.string(), z.undefined()]),
      phase: z.string(),
    }).strict(),
    z.undefined(),
  ]),
  cleanup: z.object({
    attempted: z.boolean(),
    completed: z.boolean(),
    retainedByConfiguration: z.boolean(),
    remainingPaths: z.array(z.string()),
  }).strict(),
}).strict();

export type HizoFSBenchmarkBackendMode = z.infer<typeof hizoFSBenchmarkBackendModeSchema>;
export type HizoFSBenchmarkPreset = z.infer<typeof hizoFSBenchmarkPresetSchema>;
export type HizoFSBenchmarkWorkload = z.infer<typeof hizoFSBenchmarkWorkloadSchema>;
export type HizoFSBenchmarkConfiguration = z.infer<typeof hizoFSBenchmarkConfigurationSchema>;
export type HizoFSBenchmarkProgress = z.infer<typeof hizoFSBenchmarkProgressSchema>;
export type HizoFSBenchmarkReport = z.infer<typeof hizoFSBenchmarkReportSchema>;
export type HizoFSBenchmarkCaseResult = HizoFSBenchmarkReport['results'][number];
export type HizoFSBenchmarkBackendCaseResult = NonNullable<
  HizoFSBenchmarkCaseResult['backends']['rawOpfs']
>;
export type HizoFSBenchmarkSample = HizoFSBenchmarkBackendCaseResult['samples'][number];
export type HizoFSBenchmarkDiagnostics = NonNullable<HizoFSBenchmarkSample['hizoFSDiagnostics']>;
export type HizoFSBenchmarkDiagnosticsTotals = NonNullable<
  HizoFSBenchmarkBackendCaseResult['hizoFSDiagnosticsTotals']
>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
