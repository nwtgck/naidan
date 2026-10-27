import { z } from 'zod';
import { q8KernelBenchmarkProgressSchema } from './q8-kernel-schema';
import { q8DiagnosticWorkerResultSchema } from './q8-diagnostic-worker-types';

/** Kept outside model trials: repeated, warm synthetic weights cannot estimate
 * a model's streaming throughput or be included in its tok/s comparison. */
export const q8DiagnosticObservationSchema = z.object({
  status: z.enum(['running', 'completed', 'unavailable', 'failed', 'cancelled']),
  startedMs: z.number().finite().nonnegative(),
  elapsedMs: z.number().finite().nonnegative().optional(),
  hiddenObserved: z.boolean(),
  progress: q8KernelBenchmarkProgressSchema.optional(),
  result: q8DiagnosticWorkerResultSchema.optional(),
  error: z.string().max(1000).optional(),
}).strict();

export type Q8DiagnosticObservation = z.infer<typeof q8DiagnosticObservationSchema>;

export const TEST_ONLY = {
};
