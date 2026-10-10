import { z } from 'zod';

export const checkpointPhaseSchema = z.enum(['boundary-tokenize', 'capture-position', 'capture-size', 'capture-allocation', 'capture-readback',
  'restore-memory', 'restore-write', 'restore-trim', 'restore-verify']);
export const checkpointPerformanceSchema = z.object({
  captureAttempts: z.number().int().nonnegative(),
  restoreAttempts: z.number().int().nonnegative(),
  retainedRestoredCaptures: z.number().int().nonnegative(),
  phases: z.array(z.object({ phase: checkpointPhaseSchema, visits: z.number().int().positive(), elapsedMs: z.number().finite().nonnegative() }).strict()).max(9),
}).strict();
export type CheckpointPerformance = z.infer<typeof checkpointPerformanceSchema>;
export type CheckpointPhase = z.infer<typeof checkpointPhaseSchema>;
export const TEST_ONLY = {
};
