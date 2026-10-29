import { z } from 'zod';

export const earlyGenerationTimingLimit = 16;

/** Stage residence in Worker wall time, not native-call or GPU durations.
 * Overlap includes delivery. Nonzero clockAnomalies invalidates timing precision.
 * Ordinals are separate for sampler intervals and combined serial/overlap decode
 * intervals, not token IDs or a single shared sequence. Both closure boundaries
 * can close failed/aborted work; neither proves a completed native call. */
export const earlyGenerationTimingSchema = z.object({
  version: z.literal(1),
  limit: z.literal(earlyGenerationTimingLimit),
  stageIntervals: z.array(z.object({
    stage: z.enum(['native-sample', 'generation-overlap', 'generation-decode']),
    ordinal: z.number().int().min(1).max(earlyGenerationTimingLimit),
    sampleCountAtStart: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    startMs: z.number().finite().nonnegative(),
    elapsedMs: z.number().finite().nonnegative(),
    closedBy: z.enum(['stage-transition', 'request-finish']),
  }).strict()).max(earlyGenerationTimingLimit * 2),
  samples: z.array(z.object({
    ordinal: z.number().int().min(1).max(earlyGenerationTimingLimit),
    atMs: z.number().finite().nonnegative(),
  }).strict()).max(earlyGenerationTimingLimit),
  intervalsTruncated: z.boolean(),
  samplesTruncated: z.boolean(),
  clockAnomalies: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export type EarlyGenerationTiming = z.infer<typeof earlyGenerationTimingSchema>;

export const TEST_ONLY = {
};
