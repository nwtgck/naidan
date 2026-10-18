import { z } from 'zod';

const countersSchema = z.object({
  n_reused: z.number().int().nonnegative(),
  n_reallocs_same: z.number().int().nonnegative(),
  n_reallocs_diff: z.number().int().nonnegative(),
}).strict();

export const nativeGraphCountersSchema = z.object({
  method: z.literal('llama-perf-context'),
  before: countersSchema.optional(),
  after: countersSchema.optional(),
  errors: z.number().int().nonnegative(),
}).strict();
export type NativeGraphCounters = z.infer<typeof nativeGraphCountersSchema>;
export const TEST_ONLY = {
};
