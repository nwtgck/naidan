import { z } from 'zod';
import { profileSchema } from './types';

export const memoryCheckpointSchema = z.enum(['runtime-ready', 'before-model-load', 'model-loaded', 'model-load-failed', 'context-ready', 'prefill-start', 'prefill-complete', 'decode', 'generation-complete', 'generation-interrupted', 'generation-cleaned', 'model-released', 'runtime-released']);
export type MemoryCheckpoint = z.infer<typeof memoryCheckpointSchema>;
export const memoryDiagnosticSchema = z.object({
  kind: z.literal('naidan-llama-cpp-memory'),
  instanceId: z.string().min(1).max(128),
  profile: profileSchema,
  checkpoint: memoryCheckpointSchema,
  capacityBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.number().finite().nonnegative(),
}).strict();
export type MemoryDiagnostic = z.infer<typeof memoryDiagnosticSchema>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
