import { z } from 'zod';

// Ephemeral Worker messages, never persisted. Keep native uint64 values exact
// across the transport and UI; these categories must not be added into VRAM.
const uint64Schema = z.string().refine(value => /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n);
const capacitySchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const imageEngineSnapshotSchema = z.object({
  type: z.literal('naidan-image-engine-snapshot-v1'),
  collectedAt: capacitySchema,
  profile: z.string().min(1).max(80),
  source: z.string().regex(/^[a-f0-9]{40}$/),
  modelVersion: z.string().max(256),
  wasmCapacityBytes: capacitySchema,
  fileReadCacheBytes: capacitySchema,
  runtime: z.object({
    nThreads: z.number().int(), runnersReady: z.boolean(), eagerLoad: z.boolean(),
    mmap: z.boolean(), prefetch: z.boolean(), segmentedCompute: z.boolean(), autoFit: z.boolean(),
  }).strict(),
  memory: z.object({
    registeredTensorCount: uint64Schema, registeredTensorBytes: uint64Schema,
    managerHostBufferCount: uint64Schema, managerHostBufferBytes: uint64Schema,
    managerDeviceBufferCount: uint64Schema, managerDeviceBufferBytes: uint64Schema,
    trackedRuntimeCpuBytes: uint64Schema, trackedRuntimeNonCpuBytes: uint64Schema,
    trackedRuntimeUnknownBytes: uint64Schema, saturated: z.boolean(),
  }).strict(),
  // Requested context configuration, not proof of node/device placement.
  requested: z.object({
    nThreads: z.number().int(), computeBackend: z.string().max(512), paramsBackend: z.string().max(512),
    maxVram: z.string().max(512), flashAttention: z.boolean(), diffusionFlashAttention: z.boolean(),
    bf16WeightType: z.enum(['f16', 'f32', 'other']), conditioningCacheSize: z.number().int(),
  }).strict(),
}).strict();
export type ImageEngineSnapshot = z.infer<typeof imageEngineSnapshotSchema>;
export const imageEngineInspectionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), snapshot: imageEngineSnapshotSchema }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.enum(['not-loaded', 'busy', 'unsupported', 'released']) }).strict(),
  z.object({ status: z.literal('failed'), message: z.string().max(1024), disposition: z.enum(['retryable', 'retire-worker']) }).strict(),
]);
export type ImageEngineInspection = z.infer<typeof imageEngineInspectionSchema>;

export const TEST_ONLY = {
};
