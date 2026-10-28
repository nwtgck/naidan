import { z } from 'zod';
import { visionBf16StorageObservationSchema } from '@/features/llama-cpp-browser/runtime/vision-bf16-storage-schema';

export const visionStageSchema = z.enum(['projector-load', 'image-decode', 'image-tokenize', 'image-evaluate', 'media-encode', 'media-decode']);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const milliseconds = z.number().finite().nonnegative();
export const visionDiagnosticSchema = z.object({
  version: z.literal(1),
  captureStatus: z.enum(['observed', 'unavailable']),
  storagePolicy: z.enum(['runtime-default', 'legacy-expand', 'retain-checked']),
  storage: visionBf16StorageObservationSchema.optional(),
  storageComparison: z.literal('unavailable'),
  pureLmPrefill: z.literal('unavailable'),
  physicalMemoryPeak: z.literal('unavailable'),
  outcome: z.enum(['completed', 'failed', 'aborted']),
  // A request-local clock. Native elapsed values use the helper's integer ms clock.
  rows: z.array(z.object({
    ordinal: count,
    observedMs: milliseconds,
    event: z.enum(['operation-start', 'operation-complete']),
    stage: visionStageSchema,
    nativeElapsedMs: milliseconds.optional(),
    imageIndex: count.optional(),
    imageCount: count.optional(),
    imageWidth: count.optional(),
    imageHeight: count.optional(),
    batchIndex: count.optional(),
    batchCount: count.optional(),
    batchTokens: count.optional(),
    tokens: count.optional(),
    positions: count.optional(),
    nextPosition: count.optional(),
    statusCode: z.number().int().optional(),
  }).strict()).max(512),
  droppedRows: count,
  pendingOperations: count,
  unmatchedCompletions: count,
  clockAnomalies: count,
  nativeFailures: z.array(z.object({
    event: z.enum(['native-error', 'failed']).optional(),
    stage: z.string().max(64).optional(),
    failureKind: z.string().max(64).optional(),
    requestedBytes: count.optional(),
    statusCode: z.number().int().optional(),
  }).strict()).max(16),
  droppedFailures: count,
  // Capacity and requested API bytes are observations, never live/physical memory.
  memorySamples: count,
  wasmCapacityMaxObservedBytes: count.optional(),
  files: z.array(z.object({
    role: z.enum(['model', 'projector']),
    relativePath: z.string().max(1024),
    bytes: count,
    lastModified: count,
    storageKind: z.enum(['opfs', 'host', 'temp']),
    registrationRevision: count.optional(),
    contentIdentity: z.literal('unverified'),
  }).strict()).max(128),
  droppedFiles: count,
}).strict();
export type VisionDiagnostic = z.infer<typeof visionDiagnosticSchema>;

/** Zero counters in this fallback represent missing evidence, never measured zero work. */
export function unavailableVisionDiagnostic({ outcome }: { outcome: VisionDiagnostic['outcome'] }): VisionDiagnostic {
  return {
    version: 1,
    captureStatus: 'unavailable',
    storagePolicy: 'runtime-default',
    storageComparison: 'unavailable',
    pureLmPrefill: 'unavailable',
    physicalMemoryPeak: 'unavailable',
    outcome,
    rows: [],
    droppedRows: 0,
    pendingOperations: 0,
    unmatchedCompletions: 0,
    clockAnomalies: 0,
    nativeFailures: [],
    droppedFailures: 0,
    memorySamples: 0,
    files: [],
    droppedFiles: 0,
  };
}

export const TEST_ONLY = {
};
