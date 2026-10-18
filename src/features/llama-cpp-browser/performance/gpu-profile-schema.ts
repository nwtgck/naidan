import { z } from 'zod';

export const gpuProfilePhaseSchema = z.enum(['prefill', 'decode', 'checkpoint', 'other']);
export type GpuProfilePhase = z.infer<typeof gpuProfilePhaseSchema>;
export const maximumGpuProfileGroups = 1024;
export const maximumPendingGpuProfilePasses = 4096;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const milliseconds = z.number().finite().nonnegative();
export const gpuProfileRowSchema = z.object({
  phase: gpuProfilePhaseSchema,
  shader: z.string().min(1).max(512),
  // A pass can contain several native dispatches after grid splitting. In that
  // case no single grid or individual-dispatch latency is claimed.
  workgroups: z.tuple([count, count, count]).optional(),
  passes: count,
  dispatches: count,
  multiDispatchPasses: count,
  totalGpuMs: milliseconds,
  meanPassMs: milliseconds,
  minimumPassMs: milliseconds,
  maximumPassMs: milliseconds,
  zeroDurationPasses: count,
}).strict();
export const gpuProfileSchema = z.object({
  version: z.literal(1),
  source: z.literal('webgpu-pass-timestamps'),
  status: z.enum(['complete', 'partial', 'unavailable']),
  // This observer reuses the upstream profiler's readback. It never submits
  // extra GPU commands, queries, maps or queue waits of its own.
  observedPasses: count,
  measuredPasses: count,
  pendingPasses: count,
  invalidPasses: count,
  droppedPasses: count,
  ungroupedPasses: count,
  ambiguousPasses: count,
  instrumentationErrors: count,
  zeroDurationPasses: count,
  totalGpuMs: milliseconds,
  precision: z.literal('browser-defined'),
  rows: z.array(gpuProfileRowSchema).max(maximumGpuProfileGroups),
}).strict();
export type GpuProfile = z.infer<typeof gpuProfileSchema>;
export type GpuProfileRow = z.infer<typeof gpuProfileRowSchema>;

export const TEST_ONLY = {
};
