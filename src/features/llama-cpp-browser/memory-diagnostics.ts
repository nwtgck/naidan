import { z } from 'zod';
import { profileSchema } from './types';

export const memoryCheckpointSchema = z.enum(['runtime-ready', 'before-model-load', 'model-loaded', 'model-load-failed', 'context-ready', 'prefill-start', 'prefill-complete', 'decode', 'generation-complete', 'generation-interrupted', 'generation-cleaned', 'model-released', 'runtime-released']);
export type MemoryCheckpoint = z.infer<typeof memoryCheckpointSchema>;
const gpuCapabilitySnapshotSchema = z.object({
  capture: z.enum(['device-created', 'retained-device']),
  adapterVendor: z.discriminatedUnion('status', [
    z.object({ status: z.literal('available'), value: z.string().max(256), length: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), truncated: z.boolean() }).strict(),
    z.object({ status: z.literal('unavailable'), reason: z.enum(['adapter-unavailable', 'info-unavailable', 'vendor-unavailable', 'invalid-type', 'read-failed']) }).strict(),
  ]),
  wgslLanguageFeatures: z.discriminatedUnion('status', [
    z.object({ status: z.literal('available'), packed_4x8_integer_dot_product: z.boolean() }).strict(),
    z.object({ status: z.literal('unavailable'), reason: z.enum(['gpu-unavailable', 'property-unavailable', 'invalid-value', 'read-failed']) }).strict(),
  ]),
}).strict();
export type GpuCapabilitySnapshot = z.infer<typeof gpuCapabilitySnapshotSchema>;
// Only metadata exposed by the adapter/device actually selected by the runtime.
const gpuMetadataSchema = z.object({
  // Optional for older exports and requests without diagnostic observation.
  capabilitySnapshot: gpuCapabilitySnapshotSchema.optional(),
  adapterInfo: z.object({
    vendor: z.string().min(1).max(256).optional(),
    architecture: z.string().min(1).max(256).optional(),
    device: z.string().min(1).max(256).optional(),
    description: z.string().min(1).max(256).optional(),
    subgroupMinSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    subgroupMaxSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict().optional(),
  fallbackAdapter: z.boolean().optional(),
  adapterFeatures: z.array(z.string().max(128)).max(128).optional(),
  deviceFeatures: z.array(z.string().max(128)).max(128).optional(),
  deviceLimits: z.record(z.string().max(64), z.number().finite().nonnegative()).optional(),
}).strict();
export type GpuMetadata = z.infer<typeof gpuMetadataSchema>;
// Wall time until EXISTING completion promises settle, never GPU kernel time.
const gpuQueueSchema = z.object({
  submitCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  completionWaitCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  completionWaitResolved: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  completionWaitRejected: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  completionWaitPending: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  completionWaitUnobserved: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  completionWaitDurationMs: z.number().finite().nonnegative().optional(),
  longestCompletionWaitDurationMs: z.number().finite().nonnegative().optional(),
}).strict();
export type GpuQueueObservation = z.infer<typeof gpuQueueSchema>;

// Requested API traffic, not live allocation or physical GPU memory.
const gpuRequestsSchema = z.object({
  metadata: gpuMetadataSchema.optional(),
  queue: gpuQueueSchema.optional(),
  bufferCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bufferBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  writeCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  writeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  largestWriteBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  writesAtLeast4MiB: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type GpuRequests = z.infer<typeof gpuRequestsSchema>;

export const memoryDiagnosticSchema = z.object({
  kind: z.literal('naidan-llama-cpp-memory'),
  instanceId: z.string().min(1).max(128),
  profile: profileSchema,
  checkpoint: memoryCheckpointSchema,
  gpuRequests: gpuRequestsSchema.optional(),
  capacityBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.number().finite().nonnegative(),
}).strict();
export type MemoryDiagnostic = z.infer<typeof memoryDiagnosticSchema>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
